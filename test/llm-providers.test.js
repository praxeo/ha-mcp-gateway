// Tests for src/llm-providers.js — the wire-format adapters.
//
// These import the real module (it is pure and side-effect free), so unlike
// the stub-copy suites there is nothing here to keep in sync.
//
// What matters most: the Responses API is only reachable through this
// translation layer, and a mistake in it fails at runtime against a live house.
// The round-trip test at the bottom is the load-bearing one — it walks a full
// tool-calling turn out to the wire and back.

import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDERS,
  LLM_APIS,
  isKnownProvider,
  endpointFor,
  clampEffortForProvider,
  chatToolsToResponsesTools,
  chatMessagesToResponsesInput,
  buildResponsesBody,
  responsesToChatCompletion,
  stripProviderInternals,
  effortForTier
} from "../src/llm-providers.js";

describe("provider registry", () => {
  it("knows fireworks and meta, and nothing else", () => {
    expect(isKnownProvider("fireworks")).toBe(true);
    expect(isKnownProvider("meta")).toBe(true);
    expect(isKnownProvider("openai")).toBe(false);
    expect(isKnownProvider(null)).toBe(false);
  });

  it("maps each provider to its own API key env var", () => {
    expect(LLM_PROVIDERS.fireworks.key_env).toBe("FIREWORKS_API_KEY");
    expect(LLM_PROVIDERS.meta.key_env).toBe("MODEL_API_KEY");
  });

  it("supports exactly the two wire formats", () => {
    expect([...LLM_APIS].sort()).toEqual(["chat", "responses"]);
  });
});

describe("endpointFor", () => {
  it("derives the endpoint from provider and wire format", () => {
    expect(endpointFor("fireworks", "chat", null))
      .toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(endpointFor("meta", "responses", null)).toBe("https://api.meta.ai/v1/responses");
    expect(endpointFor("meta", "chat", null)).toBe("https://api.meta.ai/v1/chat/completions");
  });

  it("lets an explicit endpoint win", () => {
    expect(endpointFor("meta", "responses", "https://proxy.example/v1/responses"))
      .toBe("https://proxy.example/v1/responses");
  });

  it("ignores a non-URL explicit value", () => {
    expect(endpointFor("meta", "responses", "not-a-url")).toBe("https://api.meta.ai/v1/responses");
  });

  it("falls back to the provider default format when the pair has no endpoint", () => {
    // fireworks has no responses endpoint — fall back rather than return null
    expect(endpointFor("fireworks", "responses", null))
      .toBe("https://api.fireworks.ai/inference/v1/chat/completions");
  });

  it("returns null for an unknown provider", () => {
    expect(endpointFor("nope", "chat", null)).toBeNull();
  });
});

describe("clampEffortForProvider", () => {
  it("passes through efforts the provider supports", () => {
    expect(clampEffortForProvider("meta", "xhigh")).toBe("xhigh");
    expect(clampEffortForProvider("meta", "minimal")).toBe("minimal");
    expect(clampEffortForProvider("fireworks", "high")).toBe("high");
  });

  it("narrows an effort Fireworks does not accept to the nearest one it does", () => {
    // Fireworks has no xhigh — the nearest supported level is high, not "off"
    expect(clampEffortForProvider("fireworks", "xhigh")).toBe("high");
    // ...and no minimal — nearest is low or none, never something higher
    expect(["low", "none"]).toContain(clampEffortForProvider("fireworks", "minimal"));
  });

  it("never silently disables reasoning when clamping down from high", () => {
    expect(clampEffortForProvider("fireworks", "xhigh")).not.toBe("none");
  });

  it("falls back sensibly on an unknown effort", () => {
    expect(["high", "medium"]).toContain(clampEffortForProvider("fireworks", "bogus"));
  });
});

describe("chatToolsToResponsesTools", () => {
  const chatTools = [{
    type: "function",
    function: {
      name: "call_service",
      description: "Call a Home Assistant service",
      parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] }
    }
  }];

  it("flattens the nested function definition to the top level", () => {
    const [t] = chatToolsToResponsesTools(chatTools);
    expect(t.type).toBe("function");
    expect(t.name).toBe("call_service");
    expect(t.description).toBe("Call a Home Assistant service");
    expect(t.parameters).toEqual(chatTools[0].function.parameters);
    expect(t.function).toBeUndefined();
  });

  it("sets strict false — the agent schemas are not strict-mode compatible", () => {
    // strict defaults to true on the Responses API, which would reject every
    // schema that has optional properties. This is the whole ballgame.
    const [t] = chatToolsToResponsesTools(chatTools);
    expect(t.strict).toBe(false);
  });

  it("handles a missing or non-array tools list", () => {
    expect(chatToolsToResponsesTools(null)).toEqual([]);
    expect(chatToolsToResponsesTools(undefined)).toEqual([]);
  });
});

describe("chatMessagesToResponsesInput", () => {
  it("lifts system messages into instructions, out of the input array", () => {
    const { instructions, input } = chatMessagesToResponsesInput([
      { role: "system", content: "You are Ranger." },
      { role: "user", content: "Lock the front door" }
    ]);
    expect(instructions).toBe("You are Ranger.");
    expect(input).toHaveLength(1);
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Lock the front door" }]
    });
  });

  it("joins multiple system messages", () => {
    const { instructions } = chatMessagesToResponsesInput([
      { role: "system", content: "A" },
      { role: "developer", content: "B" }
    ]);
    expect(instructions).toBe("A\n\nB");
  });

  it("converts assistant tool_calls into function_call items", () => {
    const { input } = chatMessagesToResponsesInput([
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "get_state", arguments: '{"entity_id":"lock.front"}' }
        }]
      }
    ]);
    expect(input).toEqual([{
      type: "function_call",
      call_id: "call_1",
      name: "get_state",
      arguments: '{"entity_id":"lock.front"}'
    }]);
  });

  it("converts tool results into function_call_output keyed by call id", () => {
    const { input } = chatMessagesToResponsesInput([
      { role: "tool", tool_call_id: "call_1", content: '{"state":"locked"}' }
    ]);
    expect(input).toEqual([{
      type: "function_call_output",
      call_id: "call_1",
      output: '{"state":"locked"}'
    }]);
  });

  it("replays reasoning items before the calls they produced", () => {
    const { input } = chatMessagesToResponsesInput([
      {
        role: "assistant",
        content: "",
        _reasoning_items: [{ type: "reasoning", encrypted_content: "abc123" }],
        tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }]
      }
    ]);
    expect(input[0].type).toBe("reasoning");
    expect(input[0].encrypted_content).toBe("abc123");
    expect(input[1].type).toBe("function_call");
  });

  it("emits both text and tool calls when an assistant turn has both", () => {
    const { input } = chatMessagesToResponsesInput([
      {
        role: "assistant",
        content: "Checking that now.",
        tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }]
      }
    ]);
    expect(input.map((i) => i.type)).toEqual(["message", "function_call"]);
  });

  it("tags assistant text preceding a tool call as commentary", () => {
    // Replaying that text as an ordinary final answer immediately before a
    // function_call is rejected with HTTP 400 — the server will not silently
    // reinterpret it.
    const { input } = chatMessagesToResponsesInput([
      {
        role: "assistant",
        content: "Let me check the weather first.",
        tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }]
      }
    ]);
    expect(input[0].phase).toBe("commentary");
  });

  it("leaves a final answer with no phase", () => {
    const { input } = chatMessagesToResponsesInput([
      { role: "assistant", content: "All five locks are locked." }
    ]);
    expect(input[0].phase).toBeUndefined();
  });

  it("drops a reasoning item that would sit directly before a user message", () => {
    // The API rejects that ordering; dropping the orphan is explicitly allowed
    // and costs only that turn's chain of thought.
    const { input } = chatMessagesToResponsesInput([
      { role: "assistant", content: "", _reasoning_items: [{ type: "reasoning", encrypted_content: "x" }] },
      { role: "user", content: "still there?" }
    ]);
    expect(input.map((i) => i.type)).toEqual(["message"]);
    expect(input[0].role).toBe("user");
  });

  it("drops a trailing reasoning item with nothing after it", () => {
    const { input } = chatMessagesToResponsesInput([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", _reasoning_items: [{ type: "reasoning", encrypted_content: "x" }] }
    ]);
    expect(input.map((i) => i.type)).toEqual(["message"]);
  });

  it("keeps reasoning that is followed by an assistant message", () => {
    const { input } = chatMessagesToResponsesInput([
      { role: "assistant", content: "Done.", _reasoning_items: [{ type: "reasoning", encrypted_content: "x" }] }
    ]);
    expect(input.map((i) => i.type)).toEqual(["reasoning", "message"]);
  });

  it("always gives a replayed reasoning item a summary array", () => {
    // Required on input even when empty.
    const { input } = chatMessagesToResponsesInput([
      {
        role: "assistant",
        content: "",
        _reasoning_items: [{ type: "reasoning", encrypted_content: "x" }],
        tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }]
      }
    ]);
    expect(input[0].summary).toEqual([]);
  });

  it("omits an empty assistant message rather than sending a blank turn", () => {
    const { input } = chatMessagesToResponsesInput([{ role: "assistant", content: "   " }]);
    expect(input).toEqual([]);
  });

  it("stringifies non-string content", () => {
    const { input } = chatMessagesToResponsesInput([{ role: "user", content: { a: 1 } }]);
    expect(input[0].content[0].text).toBe('{"a":1}');
  });

  it("types user text as input_text and replayed assistant text as output_text", () => {
    const { input } = chatMessagesToResponsesInput([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]);
    expect(input[0].content[0].type).toBe("input_text");
    expect(input[1].content[0].type).toBe("output_text");
  });

  it("skips malformed entries instead of throwing", () => {
    const { input } = chatMessagesToResponsesInput([null, undefined, "nope", { role: "user", content: "ok" }]);
    expect(input).toHaveLength(1);
  });
});

describe("buildResponsesBody", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" }
  ];

  it("builds a stateless request that can still replay reasoning", () => {
    const body = buildResponsesBody({ model: "muse-spark-1.3-contributor", messages, maxTokens: 4096, effort: "low" });
    expect(body.model).toBe("muse-spark-1.3-contributor");
    expect(body.store).toBe(false);
    expect(body.include).toContain("reasoning.encrypted_content");
    expect(body.instructions).toBe("sys");
    expect(body.max_output_tokens).toBe(4096);
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("uses max_output_tokens, never the chat-format max_tokens", () => {
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 512 });
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_output_tokens).toBe(512);
  });

  it("omits the reasoning block entirely when no effort is given", () => {
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 100, effort: null });
    expect(body.reasoning).toBeUndefined();
  });

  it("omits the reasoning block for effort 'none' — Muse Spark rejects it", () => {
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 100, effort: "none" });
    expect(body.reasoning).toBeUndefined();
  });

  it("asks for a reasoning summary when one is requested", () => {
    // Muse Spark's raw reasoning is encrypted and has no visible text, so the
    // summary is the only thing that can populate the UI's reasoning panel.
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 100, effort: "low", summary: "auto" });
    expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("sets a prompt cache key when given one", () => {
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 100, cacheKey: "ha-mcp-gateway" });
    expect(body.prompt_cache_key).toBe("ha-mcp-gateway");
  });

  it("never sends temperature or top_p — Muse Spark is tuned for its defaults", () => {
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 100, effort: "low" });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it("does not combine encrypted replay with previous_response_id", () => {
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 100 });
    expect(body.previous_response_id).toBeUndefined();
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("omits tools when none are supplied", () => {
    const body = buildResponsesBody({ model: "m", messages, maxTokens: 100 });
    expect(body.tools).toBeUndefined();
  });
});

describe("responsesToChatCompletion", () => {
  it("maps a plain text response", () => {
    const out = responsesToChatCompletion({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "All locked." }] }],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 }
    });
    expect(out.choices[0].message.content).toBe("All locked.");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage.prompt_tokens).toBe(100);
    expect(out.usage.completion_tokens).toBe(5);
  });

  it("maps function_call output into chat-shaped tool_calls", () => {
    const out = responsesToChatCompletion({
      output: [{ type: "function_call", call_id: "c1", name: "get_state", arguments: '{"entity_id":"lock.front"}' }]
    });
    const tc = out.choices[0].message.tool_calls[0];
    expect(tc.id).toBe("c1");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("get_state");
    expect(tc.function.arguments).toBe('{"entity_id":"lock.front"}');
    expect(out.choices[0].finish_reason).toBe("tool_calls");
  });

  it("stringifies tool arguments that arrive as an object", () => {
    const out = responsesToChatCompletion({
      output: [{ type: "function_call", call_id: "c1", name: "f", arguments: { a: 1 } }]
    });
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
  });

  it("reads reasoning text from the summary, which is all Muse Spark exposes", () => {
    const out = responsesToChatCompletion({
      output: [{
        type: "reasoning",
        encrypted_content: "blob",
        summary: [{ type: "summary_text", text: "Checked both locks." }]
      }]
    });
    expect(out.choices[0].message.reasoning_content).toBe("Checked both locks.");
    expect(out.choices[0].message._reasoning_items[0].encrypted_content).toBe("blob");
  });

  it("surfaces reasoning text and keeps the raw items for replay", () => {
    const out = responsesToChatCompletion({
      output: [
        { type: "reasoning", encrypted_content: "blob", content: [{ type: "reasoning_text", text: "thinking..." }] },
        { type: "message", content: [{ type: "output_text", text: "Done." }] }
      ]
    });
    expect(out.choices[0].message.reasoning_content).toBe("thinking...");
    expect(out.choices[0].message._reasoning_items).toHaveLength(1);
    expect(out.choices[0].message._reasoning_items[0].encrypted_content).toBe("blob");
  });

  it("reads cached and reasoning token details", () => {
    const out = responsesToChatCompletion({
      output: [],
      usage: {
        input_tokens: 900,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 800 },
        output_tokens_details: { reasoning_tokens: 40 }
      }
    });
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(800);
    expect(out.usage.completion_tokens_details.reasoning_tokens).toBe(40);
  });

  it("falls back to output_text when no message item is present", () => {
    const out = responsesToChatCompletion({ output: [], output_text: "fallback" });
    expect(out.choices[0].message.content).toBe("fallback");
  });

  it("returns an empty assistant message rather than throwing on junk", () => {
    expect(responsesToChatCompletion(null).choices[0].message.content).toBe("");
    expect(responsesToChatCompletion({}).choices[0].message.content).toBe("");
  });

  it("handles multiple parallel tool calls in one response", () => {
    const out = responsesToChatCompletion({
      output: [
        { type: "function_call", call_id: "a", name: "f1", arguments: "{}" },
        { type: "function_call", call_id: "b", name: "f2", arguments: "{}" }
      ]
    });
    expect(out.choices[0].message.tool_calls).toHaveLength(2);
  });
});

describe("stripProviderInternals", () => {
  it("removes the replay blobs but keeps everything the history needs", () => {
    const stripped = stripProviderInternals({
      role: "assistant",
      content: "Done.",
      tool_calls: [{ id: "c1" }],
      reasoning_content: "text",
      _reasoning_items: [{ type: "reasoning", encrypted_content: "huge" }]
    });
    expect(stripped._reasoning_items).toBeUndefined();
    expect(stripped.content).toBe("Done.");
    expect(stripped.tool_calls).toHaveLength(1);
    expect(stripped.reasoning_content).toBe("text");
  });

  it("passes through non-objects unharmed", () => {
    expect(stripProviderInternals(null)).toBeNull();
  });
});

describe("full tool-calling round trip", () => {
  // The path an actual turn takes: the model asks for a tool, the gateway
  // answers, and the follow-up request must carry the call, its result, and
  // the model's own reasoning back in the right order.
  it("survives out-to-the-wire and back with reasoning replay intact", () => {
    const systemAndUser = [
      { role: "system", content: "You are Ranger." },
      { role: "user", content: "Is the front door locked?" }
    ];

    // Round 1 — provider asks for a tool call.
    const round1 = responsesToChatCompletion({
      output: [
        { type: "reasoning", encrypted_content: "enc-1", content: [{ type: "reasoning_text", text: "need state" }] },
        { type: "function_call", call_id: "call_abc", name: "get_state", arguments: '{"entity_id":"lock.front_door"}' }
      ],
      usage: { input_tokens: 1200, output_tokens: 30 }
    });
    const assistantMsg = round1.choices[0].message;
    expect(assistantMsg.tool_calls).toHaveLength(1);

    // The loop echoes the assistant message and appends the tool result.
    const messages = [
      ...systemAndUser,
      assistantMsg,
      { role: "tool", tool_call_id: "call_abc", content: '{"state":"locked"}' }
    ];

    // Round 2 — that history goes back out over the wire.
    const body = buildResponsesBody({ model: "muse-spark-1.3-contributor", messages, maxTokens: 4096, effort: "low" });

    expect(body.instructions).toBe("You are Ranger.");
    expect(body.input.map((i) => i.type)).toEqual([
      "message",           // the user's question
      "reasoning",         // replayed, before the call it produced
      "function_call",     // what the model asked for
      "function_call_output" // what the gateway answered
    ]);
    expect(body.input[1].encrypted_content).toBe("enc-1");
    expect(body.input[2].call_id).toBe("call_abc");
    expect(body.input[3].call_id).toBe("call_abc");
    expect(body.input[3].output).toBe('{"state":"locked"}');

    // And what gets persisted afterwards carries no provider-bound blobs.
    const persisted = stripProviderInternals(assistantMsg);
    expect(persisted._reasoning_items).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("enc-1");
  });
});

describe("effortForTier", () => {
  it("maps the UI's two positions to reasoning effort", () => {
    expect(effortForTier("quick")).toBe("low");
    expect(effortForTier("high")).toBe("high");
  });

  it("falls back for an absent or unknown tier", () => {
    expect(effortForTier(undefined, null)).toBeNull();
    expect(effortForTier("turbo", "low")).toBe("low");
    expect(effortForTier(null, "medium")).toBe("medium");
  });
});
