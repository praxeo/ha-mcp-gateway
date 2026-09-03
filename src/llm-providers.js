// ============================================================================
// llm-providers.js — provider adapters for the chat agent's LLM calls.
//
// Two wire formats are supported:
//
//   "chat"      — OpenAI-style POST /v1/chat/completions. Fireworks (GLM 5.3
//                 and every model this gateway ran before it) speaks this.
//   "responses" — OpenAI-style POST /v1/responses. Meta's Model API
//                 (api.meta.ai, Muse Spark) recommends this surface; it is the
//                 only one that carries reasoning replay across tool rounds.
//
// The Durable Object's conversation history and its native tool loop both work
// in ONE canonical shape: Chat Completions messages. This module translates at
// the wire only — messages in, provider request out; provider response in,
// Chat-Completions-shaped response out. That keeps `runNativeToolLoop`,
// `chat_history` in DO storage, and the stored-history format identical across
// providers, so the model can be swapped mid-conversation.
//
// Everything here is pure and side-effect free so it can be unit tested
// without a network. Keep the stubs in test/llm-providers.test.js in sync.
// ============================================================================

// Wire formats.
export const LLM_APIS = new Set(["chat", "responses"]);

// Reasoning effort levels, union across providers. Each provider clamps to
// what it actually accepts (see clampEffortForProvider).
export const LLM_REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh"
]);

// Per-provider facts: which env var holds the key, the default wire format,
// and the default endpoint per format. `endpoint` in the resolved config still
// wins when set explicitly.
export const LLM_PROVIDERS = {
  fireworks: {
    key_env: "FIREWORKS_API_KEY",
    default_api: "chat",
    endpoints: {
      chat: "https://api.fireworks.ai/inference/v1/chat/completions"
    },
    // Fireworks rejects efforts outside this set.
    efforts: new Set(["none", "low", "medium", "high"]),
    label: "Fireworks"
  },
  meta: {
    key_env: "MODEL_API_KEY",
    default_api: "responses",
    endpoints: {
      chat: "https://api.meta.ai/v1/chat/completions",
      responses: "https://api.meta.ai/v1/responses"
    },
    efforts: new Set(["none", "minimal", "low", "medium", "high", "xhigh"]),
    label: "Meta Model API"
  }
};

export function isKnownProvider(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(LLM_PROVIDERS, name);
}

// Resolve the endpoint for a provider/api pair. An explicit endpoint always
// wins; otherwise fall back to the provider's default for that wire format.
export function endpointFor(provider, api, explicit) {
  if (typeof explicit === "string" && /^https?:\/\//.test(explicit)) return explicit;
  const p = LLM_PROVIDERS[provider];
  if (!p) return null;
  return p.endpoints[api] || p.endpoints[p.default_api] || null;
}

// Providers disagree on which effort levels exist. Narrow to the nearest
// supported level rather than sending one the provider will 400 on.
export function clampEffortForProvider(provider, effort) {
  const p = LLM_PROVIDERS[provider];
  if (!p) return effort;
  if (p.efforts.has(effort)) return effort;
  // Walk toward the middle: an unsupported extreme becomes the nearest level
  // the provider does support, never silently "off".
  const ladder = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const idx = ladder.indexOf(effort);
  if (idx === -1) return p.efforts.has("high") ? "high" : "medium";
  for (let d = 1; d < ladder.length; d++) {
    const down = ladder[idx - d];
    const up = ladder[idx + d];
    if (down && p.efforts.has(down)) return down;
    if (up && p.efforts.has(up)) return up;
  }
  return "medium";
}

// ── Reasoning tiers ────────────────────────────────────────────────────────
// The UI exposes two positions and the request carries one of them. Quick is
// the default on every page load; High is a per-session opt-in for forensic
// and trend questions, where the extra reasoning is worth the wait.
export const LLM_TIERS = {
  quick: "low",
  high: "high"
};

export function effortForTier(tier, fallback) {
  if (typeof tier === "string" && Object.prototype.hasOwnProperty.call(LLM_TIERS, tier)) {
    return LLM_TIERS[tier];
  }
  return fallback;
}

// ── Tool schema translation ────────────────────────────────────────────────
// Chat Completions nests the definition under `function`; the Responses API
// puts the same fields at the top level of the tool object.
//
// `strict` defaults to TRUE on the Responses API, which requires a strict-mode
// JSON Schema (every property required, additionalProperties:false). The agent
// tool schemas are ordinary permissive schemas with optional properties, so
// strict must be set false explicitly or every request is rejected.
export function chatToolsToResponsesTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => {
    const fn = (t && t.function) || {};
    return {
      type: "function",
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
      strict: false
    };
  });
}

// ── Message translation: canonical chat messages → Responses input items ───
//
// System messages become `instructions` (the Responses API's dedicated slot),
// which also keeps them out of the per-turn input array and preserves the
// stable prefix used for prompt caching.
//
// Assistant turns can carry three things at once — reasoning, text, and tool
// calls — which Chat Completions packs into one message and the Responses API
// splits into separate items. `_reasoning_items` is where the adapter stashes
// the provider's own reasoning objects on the way out so they can be replayed
// verbatim on the next round; the model needs its own prior reasoning back to
// continue a tool chain coherently.
export function chatMessagesToResponsesInput(messages) {
  const input = [];
  const instructionParts = [];

  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;

    if (m.role === "system" || m.role === "developer") {
      if (typeof m.content === "string" && m.content) instructionParts.push(m.content);
      continue;
    }

    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
      });
      continue;
    }

    if (m.role === "assistant") {
      // Reasoning first — it must precede the calls it produced.
      for (const item of Array.isArray(m._reasoning_items) ? m._reasoning_items : []) {
        input.push(normalizeReasoningItem(item));
      }
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (typeof m.content === "string" && m.content.trim()) {
        const msg = {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }]
        };
        // Assistant text that precedes a function_call is intermediate
        // commentary, and the API rejects it (HTTP 400) if replayed as an
        // ordinary final answer. Text with no call following it IS the final
        // answer and must carry no phase.
        if (toolCalls.length) msg.phase = "commentary";
        input.push(msg);
      }
      for (const tc of toolCalls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function && tc.function.name,
          arguments: (tc.function && tc.function.arguments) || "{}"
        });
      }
      continue;
    }

    // user (and anything else) — an input message
    input.push({
      type: "message",
      role: m.role || "user",
      content: [{
        type: "input_text",
        text: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
      }]
    });
  }

  return {
    instructions: instructionParts.join("\n\n"),
    input: dropOrphanReasoning(input)
  };
}

// A reasoning input item must carry a `summary` array even when empty, and its
// `id` is optional on replay because `encrypted_content` carries the state.
// Anything else on the item is dropped: replaying a bare id without the
// encrypted content is rejected as a missing/expired reference.
export function normalizeReasoningItem(item) {
  const out = { type: "reasoning", summary: Array.isArray(item?.summary) ? item.summary : [] };
  if (item && typeof item.encrypted_content === "string") out.encrypted_content = item.encrypted_content;
  if (item && typeof item.id === "string") out.id = item.id;
  return out;
}

// Every reasoning item must be followed by an assistant message or a
// function_call before the next user/system/developer message, or the request
// is rejected (HTTP 400). Rather than fabricate an assistant turn the model
// never produced, drop the orphan — dropping reasoning is explicitly allowed
// and costs only that turn's chain of thought.
export function dropOrphanReasoning(input) {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item && item.type === "reasoning") {
      const next = input[i + 1];
      const ok = next && (
        next.type === "function_call" ||
        (next.type === "message" && next.role === "assistant") ||
        next.type === "reasoning"
      );
      if (!ok) continue;
    }
    out.push(item);
  }
  // A run of reasoning items is only valid if the run itself ends in a message
  // or a call; walk backwards once to clear a trailing run.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && out[i].type === "reasoning") out.splice(i, 1);
    else break;
  }
  return out;
}

// ── Request building ───────────────────────────────────────────────────────
export function buildResponsesBody({ model, messages, tools, maxTokens, effort, summary, cacheKey }) {
  const { instructions, input } = chatMessagesToResponsesInput(messages);
  const body = {
    model,
    input,
    // Stateless: this gateway keeps its own history in DO storage, so there is
    // no reason for the provider to persist conversations. `include` then
    // returns the encrypted reasoning blob that makes multi-turn reasoning
    // replay work without that server-side state. (These two cannot be
    // combined with previous_response_id — pick one source of prior context.)
    store: false,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true
  };
  if (instructions) body.instructions = instructions;
  if (Array.isArray(tools) && tools.length) body.tools = chatToolsToResponsesTools(tools);
  if (Number.isFinite(maxTokens)) body.max_output_tokens = maxTokens;
  // Muse Spark rejects effort "none" outright, and omitting the block entirely
  // is the documented way to leave reasoning at the model's own default.
  if (effort && effort !== "none") {
    body.reasoning = { effort };
    // Muse Spark's raw chain of thought is encrypted and carries no visible
    // text, so without a summary there is literally nothing to show in the
    // UI's reasoning panel. The summary is the only human-readable form.
    if (summary) body.reasoning.summary = summary;
  }
  // Groups requests so the long, byte-identical system+tools prefix stays warm
  // in the provider's prompt cache — the Responses-API counterpart to the
  // Fireworks session-affinity header.
  if (cacheKey) body.prompt_cache_key = cacheKey;
  // NOTE: temperature/top_p are deliberately NOT set. Muse Spark is tuned for
  // its defaults and performs best there; the chat-format branch still sends
  // temperature 0 because that is right for the models it serves.
  return body;
}

// ── Response translation: Responses output → Chat Completions shape ────────
// Note: Responses output messages carry no `reasoning_content` — that field is
// a Chat Completions concept. It is synthesized here from the reasoning items'
// summaries so the rest of the gateway (SSE `reasoning` events, the UI panel)
// keeps working unchanged across providers.
// The tool loop reads `choices[0].message` and `usage.{prompt,completion}_tokens`,
// so normalize to exactly that. Reasoning arrives as its own output items;
// their text is surfaced as `reasoning_content` (what the SSE stream and the
// UI's reasoning panel already consume) and the raw items are kept on
// `_reasoning_items` for replay.
export function responsesToChatCompletion(data) {
  const output = Array.isArray(data && data.output) ? data.output : [];
  const toolCalls = [];
  const reasoningItems = [];
  const textParts = [];
  const reasoningParts = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      });
      continue;
    }

    if (item.type === "reasoning") {
      reasoningItems.push(item);
      // Muse Spark's raw chain of thought is encrypted and the reasoning item
      // carries no visible content, so `summary` is normally the only readable
      // text here. `content` is still read for providers that do expose it.
      for (const sroot of Array.isArray(item.summary) ? item.summary : []) {
        if (sroot && typeof sroot.text === "string") reasoningParts.push(sroot.text);
      }
      for (const c of Array.isArray(item.content) ? item.content : []) {
        if (c && typeof c.text === "string") reasoningParts.push(c.text);
      }
      continue;
    }

    if (item.type === "message") {
      // Commentary and final-answer text are merged into one content string.
      // The replay side re-derives `phase` from whether tool calls follow, so
      // the distinction survives the round trip without being stored.
      const content = item.content;
      if (typeof content === "string") {
        textParts.push(content);
      } else {
        for (const c of Array.isArray(content) ? content : []) {
          if (c && typeof c.text === "string") textParts.push(c.text);
        }
      }
    }
  }

  // Some responses also expose a flattened convenience field; prefer the
  // assembled items but fall back to it when no message item was emitted.
  let text = textParts.join("");
  if (!text && typeof data?.output_text === "string") text = data.output_text;

  const message = { role: "assistant", content: text || "" };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join("\n");
  if (reasoningItems.length) message._reasoning_items = reasoningItems;

  const u = (data && data.usage) || {};
  return {
    choices: [{ message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: u.total_tokens || 0,
      prompt_tokens_details: {
        cached_tokens: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0
      },
      completion_tokens_details: {
        reasoning_tokens: (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0
      }
    }
  };
}

// Strip provider-specific baggage before a message is persisted to history.
// Encrypted reasoning blobs are large, single-turn, and provider-bound: keeping
// them would bloat every later prompt and break a provider switch mid-thread.
export function stripProviderInternals(message) {
  if (!message || typeof message !== "object") return message;
  const { _reasoning_items, ...rest } = message;
  return rest;
}
