# PATCHES.md — chat/monitor split + transport hardening

Surgical patches to fix three problems in `ha-mcp-gateway`:

1. **action_hallucination regex false-positives** on narrative state changes (autonomous heartbeat retry-loops itself)
2. **MiniMax API calls have no timeout** + `max_tokens: 65536` — causes silent hangs that surface as iOS Safari "Load failed" errors
3. **Monolithic system prompt** shared between chat and autonomous heartbeat — chat path inherits pattern-inference brain it doesn't need

Apply patches in the order listed. Commit per file. Do not refactor anything not explicitly called out.

---

## File 1 — `src/agent-tools.js`

### Patch 1.1 — Add `CHAT_ALLOWED_TOOL_NAMES` export

Add at the end of the file (after the existing `NATIVE_AGENT_TOOLS` export):

```js
// Names of tools the CHAT profile is allowed to expose to MiniMax.
// save_memory and save_observation are intentionally excluded — confirmed
// facts and patterns get picked up by the autonomous heartbeat from the
// unified timeline. Removing the temptation makes chat replies tighter.
export const CHAT_ALLOWED_TOOL_NAMES = new Set([
  "call_service",
  "ai_send_notification",
  "get_state",
  "get_logbook",
  "render_template",
  "vector_search"
]);
```

If `agent-tools.js` uses CommonJS instead of ES modules, swap to `module.exports.CHAT_ALLOWED_TOOL_NAMES = ...`. Match the existing style.

**Commit:** `patch: add CHAT_ALLOWED_TOOL_NAMES export for chat-profile tool surface`

---

## File 2 — `src/ha-websocket.js`

### Patch 2.1 — Import the new constant

At the top of `src/ha-websocket.js`, find the existing import from `agent-tools.js` and add `CHAT_ALLOWED_TOOL_NAMES`:

```js
import { NATIVE_AGENT_TOOLS, NATIVE_TOOL_NAMES, NATIVE_ACTION_TOOL_NAMES, CHAT_ALLOWED_TOOL_NAMES } from "./agent-tools.js";
```

Adjust to match the existing import shape exactly.

### Patch 2.2 — Add a channel-key sanitizer

Add as a module-level helper near the top of `src/ha-websocket.js`, outside the class:

```js
function sanitizeChannelKey(from) {
  if (!from || typeof from !== "string") return "default";
  const cleaned = from.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.substring(0, 64) || "default";
}
```

### Patch 2.3 — Replace `callMiniMaxWithTools`

Find the existing method and replace entirely. Adds AbortController + timeout, makes max_tokens caller-controlled with sane default:

```js
async callMiniMaxWithTools(messages, tools, maxTokens = 4096, timeoutMs = 45000) {
  const body = {
    model: "MiniMax-M2.7-highspeed",
    messages,
    tools,
    max_tokens: maxTokens,
    temperature: 0,
    reasoning_split: true
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.minimax.io/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.env.MINIMAX_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`MiniMax API ${response.status}: ${errText.substring(0, 200)}`);
    }
    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`MiniMax API timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
```

### Patch 2.4 — Replace `runNativeToolLoop`

Adds three options: `allowedTools`, `hallucinationGuard`, `maxTokens`. Tightens the action-claim regex to first-person constructions only. Skips guard when explicitly disabled or when the model's prose disclaims action:

```js
async runNativeToolLoop(initialMessages, options = {}) {
  const {
    maxIterations = 8,
    systemPrompt = null,
    onEvent = null,
    allowedTools = NATIVE_AGENT_TOOLS,
    hallucinationGuard = true,
    maxTokens = 4096
  } = options;
  const messages = [...initialMessages];
  if (systemPrompt && (messages.length === 0 || messages[0].role !== "system")) {
    messages.unshift({ role: "system", content: systemPrompt });
  }
  const actionsTaken = [];
  const stripThink = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const safeEmit = (evt) => { try { if (onEvent) onEvent(evt); } catch {} };

  for (let iter = 0; iter < maxIterations; iter++) {
    let response;
    safeEmit({ type: "thinking" });
    try {
      response = await this.callMiniMaxWithTools(messages, allowedTools, maxTokens);
    } catch (err) {
      this.logAI("error", "Native loop API call failed: " + err.message, { iteration: iter }, "native_loop");
      safeEmit({ type: "error", message: err.message });
      return {
        reply: "I couldn't reach the model — " + err.message,
        actions_taken: actionsTaken,
        messages,
        error: err.message,
        iterations: iter
      };
    }
    const assistantMsg = response.choices?.[0]?.message;
    if (!assistantMsg) {
      this.logAI("error", "Native loop: no assistant message in response", { iteration: iter, debug_keys: Object.keys(response || {}) }, "native_loop");
      safeEmit({ type: "error", message: "empty_response" });
      return {
        reply: "I didn't get a usable response from the model.",
        actions_taken: actionsTaken,
        messages,
        error: "empty_response",
        iterations: iter
      };
    }
    messages.push(assistantMsg);
    const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];
    if (toolCalls.length === 0) {
      const cleaned = stripThink(assistantMsg.content);

      // First-person action claim only — narration like "the lights are
      // turning off" no longer false-positives. Completion idioms ("Done.",
      // "Closing it now") still trigger. Disclaim phrases short-circuit.
      const firstPersonClaim = /\b(?:i'?m|i\s+am|i'?ll|i\s+will|let\s+me|going\s+to|i\s+just|i'?ve|i\s+have)\s+(?:now\s+|just\s+)?(?:open|clos|turn|lock|unlock|set|activat|dim|start|stop)/i;
      const completionClaim = /^(?:done\b|closing\s+it\s+now|opening\s+it\s+now|on\s+it\b|locked\b|unlocked\b|closed\b|opened\b|turned\s+(?:on|off)\b)/i;
      const explicitNoAction = /\b(?:no\s+action|nothing\s+to\s+act|not\s+acting|won'?t\s+act|no\s+tool|standing\s+by|just\s+observing|monitoring\s+only|heartbeat\s+only)\b/i;

      const looksLikeClaim = firstPersonClaim.test(cleaned) || completionClaim.test(cleaned.trim());
      const disclaimsAction = explicitNoAction.test(cleaned);

      if (
        hallucinationGuard &&
        actionsTaken.length === 0 &&
        looksLikeClaim &&
        !disclaimsAction
      ) {
        this.logAI(
          "action_hallucination",
          `Claim without tool call — forcing retry: "${cleaned.substring(0, 150)}"`,
          { iteration: iter },
          "native_loop"
        );
        messages.push({
          role: "user",
          content: 'You just said you performed an action (e.g. "I\'m closing the garage", "Done — locked") but did not emit a tool_call. That is a hallucination. Call the appropriate tool NOW to actually do what you said. If you truly cannot or should not act, reply plainly saying so — do not claim completion.'
        });
        safeEmit({ type: "thinking" });
        continue;
      }
      safeEmit({ type: "reply", text: cleaned });
      return {
        reply: cleaned,
        actions_taken: actionsTaken,
        messages,
        iterations: iter + 1
      };
    }
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const argsRaw = tc.function?.arguments || "{}";
      let args = {};
      let parseError = null;
      try {
        args = JSON.parse(argsRaw);
      } catch (parseErr) {
        parseError = parseErr.message;
        this.logAI("action_error", `Native loop: failed to parse args for ${name}: ${parseErr.message}`, { tool: name, raw: argsRaw.substring(0, 300) }, "native_loop");
      }
      const evtLabel = name === "call_service" && args.domain && args.service ? `${args.domain}.${args.service}` : name;
      safeEmit({ type: "tool_call", name, label: evtLabel, args });
      let result;
      if (parseError) {
        result = { error: "Invalid JSON arguments: " + parseError };
      } else if (!NATIVE_TOOL_NAMES.has(name)) {
        result = { error: `Unknown tool: ${name}` };
      } else if (NATIVE_ACTION_TOOL_NAMES.has(name)) {
        result = await this.executeAIAction({ action: name, ...args }, "native_loop");
        if (!result.error) actionsTaken.push(name);
      } else {
        result = await this.executeNativeTool(name, args);
      }
      safeEmit({ type: "tool_result", name, ok: !result?.error });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: typeof result === "string" ? result : JSON.stringify(result)
      });
    }
  }
  this.logAI(
    "iteration_ceiling_synthesize",
    `${maxIterations} iterations hit; forcing synthesis call`,
    { actions_taken: actionsTaken },
    "native_loop"
  );
  safeEmit({ type: "thinking" });
  messages.push({
    role: "user",
    content: "You've gathered enough information. STOP using tools and compose a final reply now from what you already have. No more tool calls. Reply in prose only."
  });
  try {
    const finalResp = await this.callMiniMaxWithTools(messages, [], maxTokens);
    const finalMsg = finalResp.choices?.[0]?.message;
    if (finalMsg) messages.push(finalMsg);
    const cleaned = stripThink(finalMsg?.content || "");
    if (cleaned) {
      safeEmit({ type: "reply", text: cleaned });
      return {
        reply: cleaned,
        actions_taken: actionsTaken,
        messages,
        iterations: maxIterations,
        synthesized: true
      };
    }
    this.logAI("iteration_ceiling_synthesize_empty", "Synthesis call returned empty content", { actions_taken: actionsTaken }, "native_loop");
  } catch (err) {
    this.logAI("error", "Synthesis fallback failed: " + err.message, { actions_taken: actionsTaken }, "native_loop");
  }
  safeEmit({ type: "error", message: "max_iterations_exceeded" });
  return {
    reply: "I hit my iteration ceiling without finishing — actions so far: " + (actionsTaken.length > 0 ? actionsTaken.join(", ") : "none") + ". Re-ask if you need me to continue.",
    actions_taken: actionsTaken,
    messages,
    error: "max_iterations_exceeded",
    iterations: maxIterations
  };
}
```

### Patch 2.5 — Add `getChatSystemPrompt` method

Add this **new** method on the `HAWebSocket` class, right before `getNativeAgentSystemPrompt`:

```js
getChatSystemPrompt(ctx) {
  const {
    timeline = "",
    contextEntities = [],
    from = "default",
    semanticMemories = [],
    semanticObservations = [],
    climatePreamble = ""
  } = ctx;
  const stateHealth = {
    ws_connected: this.connected,
    ws_authenticated: this.authenticated,
    states_ready: this.statesReady,
    last_pong_age_seconds: this.lastPongAt ? Math.round((Date.now() - this.lastPongAt) / 1e3) : null,
    cached_entity_count: this.stateCache.size
  };
  const SCORE_FLOOR = 0.65;
  const relevantMemories = semanticMemories.filter(m => typeof m.score === "number" && m.score >= SCORE_FLOOR);
  const relevantObservations = semanticObservations.filter(o => typeof o.score === "number" && o.score >= SCORE_FLOOR);
  return `${this.getAgentContext()}

You are answering a chat from "${from}". Be concise. Take action when asked. If you took an action, say what you did plainly, past tense, one sentence. If a question needs the timeline or live state, USE THE TOOLS — don't guess.

GATEWAY HEALTH:
${JSON.stringify(stateHealth, null, 1)}

TOOLS — attached to this request. Invoke them directly. The turn you emit NO tool calls is your final reply.
- call_service — execute any HA service (lights, locks, covers, climate, scripts, scenes). Use for destructive/irreversible actions too.
- ai_send_notification — push to phone AND log to timeline. Reserve for security events, aux heat >5000W sustained, leaks, unexpected entry.
- get_state — single entity's full state when the snapshot below lacks detail.
- get_logbook — historical entries. ALWAYS pass tz_offset="-05:00" for Central time.
- render_template — Jinja2 in HA context (area_name, device_attr, expand, state_attr).
- vector_search — semantic search across entities, automations, scripts, scenes, areas, services, your memories, your observations. Use when something isn't in the snapshot below.

COMMITMENT RULE: If your reply says you did something ("opening the garage", "turning off the lights"), you MUST have invoked the corresponding tool. Saying you did something you didn't is a lie.

QUICK FACTS:
- climate.t6_pro_z_wave_programmable_thermostat_2 = main level INCLUDING MBR
- climate.t6_pro_z_wave_programmable_thermostat = basement
- Smoke/CO detectors are NOT in HA — don't reference their state.
- Automation editing via call_service returns 405 on this instance — tell John to edit in HA UI (Settings → Automations).
- Timestamps in your replies MUST be Central, "H:MM AM/PM" or "MMM D, H:MM AM/PM". Never UTC, ISO 8601, or Z-suffix — even if get_logbook returns those.
${climatePreamble ? "\n" + climatePreamble + "\n" : ""}
UNIFIED TIMELINE — recent events (chat, state changes, your past actions). Already pre-formatted in Central time:

${timeline || "Timeline is empty."}

${relevantMemories.length > 0 ? `RELEVANT MEMORIES (semantic top-matches for this turn):
${relevantMemories.map((m) => "- [score " + m.score.toFixed(2) + "] " + (m.friendly_name || "")).join("\n")}

` : ""}${relevantObservations.length > 0 ? `RELEVANT OBSERVATIONS (semantic top-matches for this turn):
${relevantObservations.map((o) => "- [score " + o.score.toFixed(2) + "] " + (o.friendly_name || "")).join("\n")}

` : ""}RELEVANT ENTITIES (${contextEntities.length}, semantic top-K from live state cache) — an entity not here may still exist; use vector_search or get_state to probe. state=null means HA hasn't reported a value. Don't invent entity_ids or fabricate timestamps for events you didn't witness.

${JSON.stringify(contextEntities, null, 1)}`;
}
```

### Patch 2.6 — Replace `chatWithAgentNative`

Full replacement. Switches to the chat prompt, per-channel history, profile-driven loop call, lower top-K context, lower max iterations:

```js
async chatWithAgentNative(message, from = "default", onEvent = null) {
  const now = new Date();
  const now_str = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const channelKey = sanitizeChannelKey(from);
  const historyKey = `chat_history:${channelKey}`;

  const conversationHistory = await this.state.storage.get(historyKey) || [];
  this.logAI("chat_user", `${from}: ${message}`, { from, message, channel: channelKey });
  const timeline = this._buildNativeTimeline();

  // Chat profile uses tighter top-K than autonomous (10 vs 15) to keep
  // prompt focused. Override the default by passing topK.
  const {
    entities: contextEntities,
    memories: semanticMemories,
    observations: semanticObservations
  } = await this._buildNativeContextEntities(message, { entityTopK: 10 });

  const climatePreamble = await this._buildClimatePreambleIfNeeded(message, "chat_native");

  const systemPrompt = this.getChatSystemPrompt({
    timeline,
    contextEntities,
    semanticMemories,
    semanticObservations,
    from,
    climatePreamble: climatePreamble || ""
  });

  const initialMessages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: `Current time: ${now_str}\n\n${message}` }
  ];

  try {
    const oldHistoryLen = conversationHistory.length;
    const result = await this.runNativeToolLoop(initialMessages, {
      maxIterations: 6,
      onEvent,
      allowedTools: NATIVE_AGENT_TOOLS.filter(t => CHAT_ALLOWED_TOOL_NAMES.has(t.function.name)),
      hallucinationGuard: true,
      maxTokens: 4096
    });
    const reply = result.reply && result.reply.trim() || "Done.";
    this.logAI("chat_reply", reply.substring(0, 300), { from, full_reply: reply, channel: channelKey }, "native_loop");

    const TOOL_CONTENT_CAP = 4000;
    const loopAdditions = result.messages.slice(1 + oldHistoryLen + 1).map((m) => {
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > TOOL_CONTENT_CAP) {
        return { ...m, content: m.content.substring(0, TOOL_CONTENT_CAP) + "…[truncated]" };
      }
      return m;
    });
    while (loopAdditions.length > 0) {
      const last = loopAdditions[loopAdditions.length - 1];
      const pendingTools = last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
      if (last.role === "assistant" && !pendingTools) break;
      loopAdditions.pop();
    }
    const endsCleanly = loopAdditions.length > 0
      && loopAdditions[loopAdditions.length - 1].role === "assistant"
      && !loopAdditions[loopAdditions.length - 1].tool_calls?.length;
    if (!endsCleanly) {
      loopAdditions.push({ role: "assistant", content: reply });
    }
    const nextHistory = [
      ...conversationHistory,
      { role: "user", content: `[${from}]: ${message}` },
      ...loopAdditions
    ];
    const MAX_TURNS = 10;
    const userIdxs = [];
    for (let i = 0; i < nextHistory.length; i++) {
      if (nextHistory[i].role === "user") userIdxs.push(i);
    }
    if (userIdxs.length > MAX_TURNS) {
      nextHistory.splice(0, userIdxs[userIdxs.length - MAX_TURNS]);
    }
    const HISTORY_BYTE_CAP = 110000;
    while (nextHistory.length > 2 && JSON.stringify(nextHistory).length > HISTORY_BYTE_CAP) {
      nextHistory.shift();
    }
    await this.state.storage.put(historyKey, nextHistory);
    this.logAI(
      "chat",
      `done | exec=${result.actions_taken.length} iter=${result.iterations}${result.error ? " err=" + result.error : ""}`,
      {
        actions_executed: result.actions_taken.length,
        from,
        channel: channelKey,
        iterations: result.iterations,
        context_size: contextEntities.length,
        ...result.error ? { error: result.error } : {}
      },
      "native_loop"
    );
    await this.persistLog();
    return {
      reply,
      actions_taken: result.actions_taken,
      ...result.error ? { error: result.error } : {}
    };
  } catch (err) {
    this.logAI("chat_error", err.message, { from, channel: channelKey }, "native_loop");
    return { error: "AI failed: " + err.message };
  }
}
```

> **Note:** `_buildNativeContextEntities` currently doesn't take a `topK` option — find its signature and add an optional `options = {}` parameter that destructures `{ entityTopK }` and uses it as the entity-search `top_k` (defaulting to whatever the existing default is, likely 15). It's a one-line change inside that function. If you can't find a clean spot, leave it alone — chat will use the existing default and that's fine.

### Patch 2.7 — Update `runAIAgentNative` loop call

Find the existing `runNativeToolLoop` call in `runAIAgentNative` and replace its options object:

```js
const result = await this.runNativeToolLoop(
  [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ],
  {
    maxIterations: 8,
    allowedTools: NATIVE_AGENT_TOOLS,
    hallucinationGuard: false,
    maxTokens: 8192
  }
);
```

### Patch 2.8 — Replace the `/ai_chat_stream` DO route handler

Find the `case "/ai_chat_stream":` block in the DO's request router and replace:

```js
case "/ai_chat_stream": {
  const body = await request.json();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (chunk) => writer.write(encoder.encode(chunk)).catch(() => {});

  // Immediate first byte — tells iOS Safari the server is alive before
  // any model latency. Without this, the first wire activity is the
  // 3s keepalive or the model's first event, whichever is sooner.
  write(`data: ${JSON.stringify({ type: "started" })}\n\n`);

  // 3s keepalive (was 8s). iOS Safari on cellular drops longer-idle streams.
  const keepalive = setInterval(() => write(":\n\n"), 3000);

  this.chatWithAgent(body.message, body.from || "default", (event) => {
    write(`data: ${JSON.stringify(event)}\n\n`);
  }).then(() => {
    clearInterval(keepalive);
    writer.close();
  }).catch((err) => {
    write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
    clearInterval(keepalive);
    writer.close();
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}
```

**Commit:** `patch: chat/monitor split + MiniMax timeout + SSE transport hardening`

---

## File 3 — `src/worker.js`

### Patch 3.1 — CHAT_HTML: handle `started` event

Find the SSE event-handling chain in the embedded `CHAT_HTML` (currently begins `if (evt.type === 'thinking')`). Prepend a no-op handler for `started`:

```js
if (evt.type === 'started') {
  // server alive — no UI action needed
} else if (evt.type === 'thinking') {
  showStatus('Thinking…');
} else if (evt.type === 'tool_call') {
  showStatus('⚡ ' + (evt.label || evt.name) + '…');
} else if (evt.type === 'tool_result') {
  showStatus((evt.ok ? '✓ ' : '✗ ') + evt.name);
} else if (evt.type === 'reply') {
  typing.classList.remove('active');
  clearStatus();
  addMsg('agent', evt.text || 'No response.');
} else if (evt.type === 'error') {
  typing.classList.remove('active');
  clearStatus();
  addMsg('error', evt.message || 'Agent error');
}
```

This is inside the existing `for (const line of lines)` parse loop — keep that scope.

### Patch 3.2 — CHAT_HTML: client-side auto-retry on fetch rejection

Replace the `} catch (err) {` block at the bottom of the `sendMessage()` function (the one that currently just calls `addMsg('error', 'Failed to reach agent: ' + err.message)`):

```js
} catch (err) {
  const retryable = /load failed|network|fetch/i.test(err.message || '');
  if (retryable && !window.__chatRetried) {
    window.__chatRetried = true;
    showStatus('Reconnecting…');
    try {
      const resp2 = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ message: text })
      });
      if (resp2.ok && resp2.body) {
        const reader = resp2.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let evt;
            try { evt = JSON.parse(line.slice(6)); } catch { continue; }
            if (evt.type === 'started') {
              // server alive
            } else if (evt.type === 'thinking') {
              showStatus('Thinking…');
            } else if (evt.type === 'tool_call') {
              showStatus('⚡ ' + (evt.label || evt.name) + '…');
            } else if (evt.type === 'tool_result') {
              showStatus((evt.ok ? '✓ ' : '✗ ') + evt.name);
            } else if (evt.type === 'reply') {
              typing.classList.remove('active');
              clearStatus();
              addMsg('agent', evt.text || 'No response.');
            } else if (evt.type === 'error') {
              typing.classList.remove('active');
              clearStatus();
              addMsg('error', evt.message || 'Agent error');
            }
          }
        }
        typing.classList.remove('active');
        clearStatus();
        window.__chatRetried = false;
        sendBtn.disabled = false;
        input.focus();
        return;
      }
    } catch (err2) {
      // fall through to error display
    }
    window.__chatRetried = false;
  }
  typing.classList.remove('active');
  clearStatus();
  addMsg('error', 'Failed to reach agent: ' + err.message);
}
```

The retry block intentionally duplicates the read loop. Do not refactor it into a helper function — keep the patch surface minimal.

### Patch 3.3 — CHAT_HTML: reset retry budget per turn

At the top of `sendMessage()`, just below where `sendBtn.disabled = true;` is set, add:

```js
window.__chatRetried = false;
```

This resets the per-turn retry budget so each new user message gets one fresh retry.

**Commit:** `patch: CHAT_HTML started event + auto-retry on iOS Safari Load failed`

---

## Deploy

After all three commits land:

```powershell
cd C:\Users\obert\ha-mcp-gateway
wrangler deploy --dry-run
```

If dry-run is clean, the human (not Claude Code) runs the real deploy:

```powershell
wrangler deploy
```

---

## Verification (first 30 minutes after deploy)

1. **Chat round-trip works** — send a chat from the iOS UI, confirm reply renders without "Load failed".

2. **Per-channel history** — send `Use vector_search to find dock lighting entities. Top 5.` from web. Open WhatsApp, send `What did I just ask you?`. WhatsApp should NOT have visibility into the web turn (because chat_history is partitioned). The unified timeline still does — that's fine and correct.

3. **Hallucination guard quiet on autonomous** — pull `ai_log` count=200 after 30 minutes, confirm zero `action_hallucination` entries from `source: native_loop` autonomous decisions.

4. **Hallucination guard live on chat** — manual test: ask `Pretend to close the garage but don't actually do it.` Reply should either invoke the tool OR explicitly disclaim ("I won't act"). If it says "Closing it now" without a tool call, the guard fires (visible as `action_hallucination` in log) — that's working correctly.

5. **Timeout firing** — if any `MiniMax API timeout after 45000ms` events appear, that's MiniMax actually hanging and the timeout catching it — desired diagnostic signal.

6. **Iteration ceiling** — chat should hit 6 iterations rarely. If `iteration_ceiling_synthesize` events spike, the chat profile is too tight; bump to 8.

---

## What to do if you get stuck

- File targets are `src/agent-tools.js`, `src/ha-websocket.js`, `src/worker.js`. Not the `dist/` bundle.
- `_buildNativeContextEntities` needs a small extension to accept `{ entityTopK }`. If you can't find a clean spot, leave the default and skip the override — chat will use 15 entities instead of 10. Not blocking.
- `getAgentContext()` is the existing method that produces the "ARCHITECTURE / about you" preamble. The chat prompt reuses it — don't duplicate or rewrite it.
- If ES module vs CommonJS syntax for `agent-tools.js` is unclear, match whatever the existing `NATIVE_AGENT_TOOLS` export uses.
- Don't refactor anything not explicitly listed. The duplicated SSE read loop in CHAT_HTML retry is intentional.
- If a patch's "old code" snippet doesn't appear in the source as-written, STOP and ask — don't pattern-match aggressively.
