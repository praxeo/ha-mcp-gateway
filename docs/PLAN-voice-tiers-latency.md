# Plan — faster, more accurate Ranger: model tiers, voice, GUI

Status: **plan only, nothing implemented.** Written 2026-09-03 against `main`
at `40444c9`. Every file/line reference was checked against that commit.
Numbers in §1 come from the live `ai_log` (`chat_timing_ms` rows, Aug 31 –
Sep 3, 2026).

Sections: 1 Where the time goes · 2 Latency · 3 Intelligence tiers + OpenAI ·
4 Accuracy (fewer mistakes) · 5 Voice commands · 6 GUI · 7 Telemetry & eval ·
8 Sequencing (which phases need a DO rename) · 9 Open questions for John.

---

## 1. Where the time actually goes (measured)

16 LLM turns + 6 fast-path turns in the log window.

| Metric | Value |
|---|---|
| Fast-path cover command, end to end | 167–247 ms |
| LLM turn, total (median / min / max) | **18.9 s** / 5.1 s / 55.4 s |
| Share of a turn spent inside the Fireworks tool loop | 95 % |
| Vectorize context build (`vectorize_context`) | ~0.75 s |
| DO storage read, prompt build | ≤ 6 ms |
| Server time-to-first-token (median) | 0.8 s (0.4–1.9 s; one 5.5 s cold outlier) |
| Completion tokens per LLM iteration (median) | **719** (58–2 558) |
| Output speed, GLM 5.3 on Fireworks | **~67 tok/s** (37–134) |
| Prompt tokens, first iteration (median) | 19 k (10.7 k at start of an evening → 30 k by the end) |
| Prefix-cache hit on the *first* iteration of a turn | 4 of 16 turns |
| Iterations per turn | 1–3 |

The arithmetic that matters: **719 tokens ÷ 67 tok/s ≈ 10.7 s per iteration.**
Almost all of those tokens are `reasoning_content` (effort `high`), not the
visible reply. TTFT and context build are small. Cross-turn prefix caching
mostly misses (Fireworks' passive cache evicts between turns minutes apart), but
that costs prefill time, not the generation time that dominates.

Three things also showed up in the same log window that are correctness bugs,
not latency (details in §4):

- `chat_error: Values cannot be larger than 131072 bytes` — **3 times in one
  evening** (139–148 KB). The reply was delivered but history was not saved, so
  the next turn lost the thread.
- "Turn beside lamp off" (STT mis-hearing "bedside") took 9.2 s and one full
  LLM round for a single `light.turn_off`.
- "What doors are unlocked" → model answered, user said "no, that doesn't make
  sense", model re-polled and corrected itself. 24 s + 23 s for a question the
  `stateCache` can answer in 0 ms.

So the levers, in order of payoff: **(a)** stop generating 700 reasoning tokens
for simple turns (tiers), **(b)** stream so perceived latency = TTFT, **(c)**
answer deterministic commands/status from the cache with no LLM at all,
**(d)** fix the history overflow so the agent stops forgetting.

---

## 2. Latency

### L1 — Token streaming (biggest perceived win, no model change)

Today no call uses `stream: true` (`callLLMWithTools`, `src/ha-websocket.js:4354`,
does `await response.json()`); the browser gets `started` → `thinking` → silence
→ one atomic `reply`. Perceived latency equals total latency.

Plan:
- `callLLMWithTools` gets a `stream: true` mode that parses the provider's SSE,
  accumulates `content` / `reasoning_content` / `tool_calls` deltas, and calls
  `onDelta({type:"reasoning"|"content", text})`.
- `runNativeToolLoop` forwards deltas as new SSE events `delta` (content) and
  `reasoning_delta`. Keep the final `reply` event **authoritative**: the UI
  replaces the streamed bubble text with `reply.text` when it arrives. This keeps
  the hallucination guard (`ha-websocket.js:4488`), `stripThink`, and
  `_reformatToolResultTimestamps` semantics intact — a guard retry simply
  overwrites the bubble.
- Tool-call iterations still buffer (nothing useful to show), but the reasoning
  panel fills live, which reads as progress.
- Perceived latency for a chat-only turn drops from ~11 s to ~1–2 s (TTFT +
  reasoning time when effort is low).

Both Fireworks and OpenAI Chat Completions stream in the same
`choices[0].delta` shape; the Responses API (§3) streams typed events — the
adapter normalizes.

### L2 — Fewer reasoning tokens by default

`reasoning_effort: "high"` (`ha-websocket.js:214`) is the default for every
turn, including "when will it rain again?" (181 tokens, 4.5 s — that one was
fine) and "what's the status of the house?" (591 tokens, 10.9 s). The tier
system in §3 makes this per-request. Expected: Standard tier at effort `low`
roughly halves generation time on the same model; Quick tier at `none` on a
250 tok/s model brings single-tool turns to ~2–3 s.

Also extend the effort enum. `LLM_REASONING_EFFORTS` (`ha-websocket.js:78`) is
`low|medium|high|none`; add `minimal` and `xhigh` (OpenAI accepts
`none|minimal|low|medium|high|xhigh|max`; Fireworks accepts `low|medium|high`
and maps `none`). Provider adapter clamps to what the provider supports.

### L3 — Parallelize the pre-LLM phase (~0.75 s → ~0.3 s)

`storage.get(history)` (`ha-websocket.js:5048`), `_buildNativeContextEntities`
(`:5062`) and `_buildClimatePreambleIfNeeded` (`:5065`) are three serial awaits
that share no inputs. `Promise.all` them. Inside `_buildNativeContextEntities`
the embedding call (`:2830`) is serial before four parallel Vectorize queries —
unavoidable, but the Quick tier can skip retrieval entirely when the request
matched a grammar intent (§5) and only needs the snapshot.

### L4 — Extend the post-tool short-circuit

`ha-websocket.js:4592-4645` already skips the wrap-up LLM call for a single
`light.*` / `switch.*` / `lock.*` / `scene.turn_on` call and synthesizes
"Done — X." Extend the allow-list to `cover.*`, `climate.set_temperature`
(synthesize "Set main level to 71°."), `script.turn_on`, `fan.*`,
`media_player.*` volume/pause, and `schedule_action` ("Scheduled: X at 8:05 PM").
Each extension saves one full iteration (~5–10 s at effort high).

### L5 — Deterministic answers for status questions (no LLM)

The `HOUSE_STATE_SNAPSHOT` (`_buildHouseStateSnapshot`, `ha-websocket.js:368`)
already renders locks, covers, climate, presence, power, Tesla from
`stateCache`. Add a read fast path next to `_tryDeterministicFastPath`:
short questions that match a narrow grammar ("what doors are unlocked", "is
the house locked", "is the garage open", "who's home", "what's the temperature
inside", "is the Tesla charging/plugged in") get a templated answer in <100 ms.
Anything with forensic markers or that doesn't match cleanly falls through to
the LLM exactly as today. This is the same bail-guard discipline the cover
fast path uses (`ha-websocket.js:480-513`), and it fixes the "unlocked doors"
mistake at the root: the answer is the truth table, not a paraphrase.

### L6 — Persisted history bloat

Prompt tokens grew 10.7 k → 30 k across one evening because every assistant
message in history carries its `reasoning_content` (preserved by
`sanitizeMessagesForLLM`, `ha-websocket.js:3026`, and stored via
`loopAdditions`, `:5199`). Fireworks needs `reasoning_content` **within** a
tool-loop turn; it does not need it from prior turns. Strip it (or cap it at
~300 chars) when building `nextHistory` (`:5218`). Cuts prefill, cuts the
110 KB cap pressure (§4 A1), and makes cross-provider history portable (§3).

### L7 — STT latency is unmeasured

`/transcribe` (`src/worker.js:2407`) has no timing, no timeout, and the UI has no
timer. Add `stt_ms` (client) and a `Server-Timing` header (worker) so the
voice round-trip can be seen. Scribe v2 batch on a 3-second clip is typically
~1 s; if measurements show >1.5 s, Scribe v2 Realtime (WebSocket, ~150 ms) is
the upgrade — but it needs a browser-side WS with a scoped ElevenLabs token,
so measure first.

---

## 3. Intelligence tiers + OpenAI

### The toggle

Three tiers plus Auto. Every request carries `tier` (UI → `/chat` body →
Worker whitelist at `src/worker.js:2531` → DO `/ai_chat_stream` → `chatWithAgent`
→ `runNativeToolLoop`), and the DO resolves it to a concrete
`{provider, endpoint, model, reasoning}`.

| Tier | Job | Recommended model | Reasoning | Target |
|---|---|---|---|---|
| ⚡ **Quick** | single commands, status reads, scheduling, "turn X on for an hour" | DeepSeek V4 Flash on Fireworks (`deepseek-v4-flash-0731`, $0.22 / $0.66 per M, ~256 tok/s, 0.6 s TTFT) — ran V17–V26 and handled the tool chain | `none` | < 3 s |
| ● **Standard** | default; multi-step reads, weather, memory, anything not obviously trivial | GLM 5.3 (today's model) | `effort: low` (try `medium` if quality drops) | < 8 s |
| ◆ **Deep** | forensic / "trends over the last few days" / debugging HA / anything with `query_*` tools | GPT-5.6 Sol via OpenAI Responses API, or GLM 5.3 at `high` if OpenAI isn't added | `high` | quality over speed |
| **Auto** (default) | router below picks | | | |

Alternative Quick candidates, for the record: GPT-5.6 Luna ($0.20 / $1.20,
~0.7 s TTFT, ~90 tok/s — cheaper than Terra but *slower output* than DeepSeek
V4 Flash), GLM 5.2 Fast (230 tok/s but $2.10 / $6.60), GLM 5.3 Flash ($0.15 /
$0.50 but only ~41 tok/s per Artificial Analysis — cheap, not fast).

### Router (Auto)

Ordered, first match wins; all pure functions in a new `src/tier-router.js`
with vitest coverage like the fast-path tests:

1. Cover fast path / status fast path / intent grammar (§5) → **no LLM**.
2. Explicit UI tier → use it.
3. Forensic markers (the existing regex at `ha-websocket.js:486`: when /
   history / how often / last time / summarize / explain …) or trend words
   (trend, habit, pattern, why, debug, root cause, "last N days") → **Deep**.
4. Short imperative (≤ 12 words, starts with a verb, one clause) or a state
   question that missed the status grammar → **Quick**.
5. Everything else → **Standard**.

**Escalation** keeps Auto safe: if a Quick-tier turn (a) returns a tool error,
(b) exceeds 2 iterations, or (c) ends without a tool call on an imperative
request, re-run the same turn at Standard and emit an SSE `escalated` event so
the UI can show "↑ standard". Misrouting then costs seconds, not correctness.

### Config shape (extends the V29 runtime config, no rename to change it)

```json
{
  "default_tier": "auto",
  "tiers": {
    "quick":    { "provider": "fireworks", "model": "accounts/fireworks/models/deepseek-v4-flash-0731", "reasoning_mode": "none" },
    "standard": { "provider": "fireworks", "model": "accounts/fireworks/models/glm-5p3", "reasoning_mode": "effort", "reasoning_effort": "low" },
    "deep":     { "provider": "openai", "api": "responses", "model": "gpt-5.6-sol", "reasoning_mode": "effort", "reasoning_effort": "high" }
  }
}
```

- `resolveLLMConfig` (`ha-websocket.js:100`) gains `tier` resolution; the
  existing flat keys (`model`, `reasoning_mode`, …) stay valid and mean
  "standard", so the current override keeps working.
- `sanitizeLLMConfigPatch` (`:151`) allow-list grows: `provider` (`fireworks|openai`),
  `api` (`chat|responses`), `default_tier`, `tiers.*`. Keys, never secrets.
- `GET /admin/llm-config` reports the resolved table per tier.
- Per-turn telemetry gains `tier`, `tier_source` (`ui|router|escalated`),
  `provider`, `model` — today the model is not logged at all.

### Provider adapter — what's Fireworks-coupled today

Adding OpenAI is not just an endpoint change. These are the coupling points
(all single choke points, so it's tractable):

| Coupling | Where |
|---|---|
| `Authorization: Bearer ${env.FIREWORKS_API_KEY}` hardcoded | `ha-websocket.js:3106`, `:4372`; guard at `:3183` |
| `x-session-affinity` header (Fireworks replica pinning) | `:3107`, `:4373` |
| `fireworks-*` perf headers → `server_ttft_ms` | `_extractPerfHeaders` `:3040`, `_normalizePerf` `:3057` |
| `thinking: {type:"enabled"}` mode (OpenAI 400s on it) | `applyReasoningToBody` `:134` |
| `reasoning_content` echoed on assistant messages (OpenAI rejects unknown fields) | `sanitizeMessagesForLLM` `:3019` |
| Error strings / field names `fireworks_ms`, `fireworks_tool_loop` | `:4380`, `:4387`, `:5178` |

Plan: new `src/llm-providers.js` exporting `buildRequest(cfg, messages, tools,
opts)`, `parseResponse`, `parseStream` for two adapters —

- **`fireworks-chat`**: today's code, moved.
- **`openai-responses`**: required for GPT-5.6 with tools *and* reasoning.
  OpenAI's `/v1/chat/completions` rejects function tools combined with any
  `reasoning_effort` other than `none` for the 5.6 family ("use /v1/responses
  or set reasoning_effort to 'none'"). Responses API differences the adapter
  owns: `input` items instead of `messages`; flat tool schema
  `{type:"function", name, parameters}`; tool results as
  `function_call_output` items; reasoning returned as `reasoning` items that
  must be passed back on the next iteration (use `store:false` +
  `include:["reasoning.encrypted_content"]` so nothing lives on OpenAI's side);
  `reasoning: {effort}`; `max_output_tokens`; typed stream events
  (`response.output_text.delta`, `response.function_call_arguments.delta`,
  `response.completed` with `usage`). Prompt caching is automatic on the
  stable prefix; add `prompt_cache_key: "ha-mcp-gateway"`.
- Secrets: `OPENAI_API_KEY` via `wrangler secret put`. The guard at `:3183`
  checks the key the resolved tier needs.
- History is stored provider-neutral (role/content/tool_calls only, per L6),
  converted at call time, so switching tiers mid-conversation works.

Cost reality check for Sol: a Deep turn today runs 20–90 k prompt tokens and
2–3 k completion tokens across iterations. At $4 / $20 per M that is roughly
$0.10–$0.40 per deep question (less with cache hits at $0.40 per M cached
input). Fine for a handful a day; not for the default tier — which is exactly
why Auto routes only forensic/trend questions there. OpenAI "Fast mode" (2×
price, ~2.5× speed) is available on Sol if Deep answers feel slow.

---

## 4. Accuracy — fewer mistakes (each item is a real failure from the log or BUGS.md)

**A1 — History save fails above 128 KiB (3× on Sep 2).**
`HISTORY_BYTE_CAP = 110000` (`ha-websocket.js:5231`) measures
`JSON.stringify(...).length` (UTF-16 code units, not bytes), only shifts while
`length > 2`, and the per-message cap only applies to `tool` messages
(`TOOL_CONTENT_CAP`, `:5198`) — an assistant message with a 100 KB
`reasoning_content` is never trimmed. Fix: measure with `TextEncoder`, cap
every message (assistant content 8 KB, reasoning stripped per L6), shift down
to `length > 0`, and wrap the `put` in try/catch that falls back to saving only
the last user/assistant pair. Also reconcile `MAX_TURNS` (fast path 6 at
`:5005`, LLM path 8 at `:5223`). Add a vitest for the trimmer.

**A2 — Status questions answered wrong, then corrected.** §2 L5 (templated
answers from `stateCache`). For status questions that *do* reach the LLM, the
snapshot is already injected when `HOUSE_STATUS_TRIGGER_RE` matches; add
"unlocked|locked|open|closed" to that regex (`ha-websocket.js:892`) so "what
doors are unlocked" always carries the snapshot.

**A3 — `call_service` takes any `entity_id` unverified.**
`executeNativeTool` → `executeAIAction` (`ha-websocket.js:3899`, `:3492`) passes
the model's `entity_id` straight to HA. Add a pre-flight: if the id is not in
`stateCache`, return `{error: "Unknown entity X. Closest: light.bedside_lamp
(Bedside Lamp), …"}` using friendly-name fuzzy match (trigram or
Levenshtein over `friendly_name` + object_id). The model self-corrects in one
iteration instead of confabulating or erroring at HA. Same check in
`get_state`.

**A4 — Service field names go unvalidated** (`todo.add_item` was called with
`summary` instead of `item` → HA rejected). The services catalog is already
cached (`ha:services`, 71 domains). Validate `data` keys against the service's
`fields` and return the field list on mismatch. The flat-arg coalescer
(`coalesceServiceData`, `:47`) is the natural home.

**A5 — Entity-registry MCP tools 404** (BUGS `#a41b2fcd`). `disable_entity` /
`update_entity_registry` / `enable_entity` / bulk variants (`src/worker.js:1153-1180`)
POST to `/api/config/entity_registry/<id>`, which is not an HA REST endpoint;
the registry is WebSocket-only (`config/entity_registry/update`). Route them
through the DO's WS like the other registry routes. Not a chat-path bug, but
it's the tool the agent reached for when asked to fix the Tesla tracker.

**A6 — Voice mis-hearings.** §5 V1 (keyterms) + A3 (fuzzy entity match) +
alias table (§5 V4) together cover "beside lamp".

**A7 — Prompt says "Be concise" but reasoning isn't.** The static prompt is
~9.4 k tokens with tool schemas (`chat-prompt.js` 14 KB + `getAgentContext`
4.3 KB + 19 schemas 19 KB). Two trims that don't touch behavioral rules: the
2 000-char TESLA MODEL Y block (`chat-prompt.js:105`) can move behind
`get_house_topology`-style on-demand retrieval; the stale "last 2h" timeline
comment (`chat-prompt.js:155`) vs 1 h cutoff (`ha-websocket.js:4891`) should be
made true. Prefix cache means this mostly saves cost, not time — do it last.

**A8 — Presence flap (BUGS `#6f87e35d`)** is an HA-side tracker config problem
(`device_tracker.tesla_model_y_route` reporting home at gps_accuracy 0); the
gateway fix is A5 so the agent can actually apply the registry change.

---

## 5. Voice commands

### What exists

Tap-to-toggle mic (`src/chat-ui.html.js:1203-1279`), whole-clip POST to
`/transcribe` (Scribe v2, `language_code: eng`, `no_verbatim`, **no keyterms**,
`worker.js:2430-2437`), transcript auto-sent with no review, no VAD, no TTS, no
wake word, and the voice path calls `send()` without `suppressRefocus`, which is
the Tesla keyboard pop John asked about on Sep 1.

### V1 — Keyterm biasing (cheapest accuracy win)

Scribe v2 batch accepts up to 1 000 `keyterms` (≤ 50 chars each). Build the
list server-side from `stateCache`: friendly names of every controllable
entity (light, switch, lock, cover, climate, scene, script, fan,
media_player), area names, household names (John, Sabrina, Ranger), Tesla
terms (precondition, sentry, charge limit), and the fast-path vocabulary.
Cache in KV with the registry refresh (15-min cycle). Send on every
`/transcribe`. Expect "beside lamp" → "bedside lamp".

### V2 — Silence auto-stop

Client-side VAD via `AudioContext` + `AnalyserNode` RMS: stop recording after
~1.2 s of silence following speech, minimum clip 0.6 s, hard cap 15 s. Keeps
tap-to-start; removes the second tap (which is what a driver or someone holding
a baby needs). Keep the manual tap-to-stop as fallback.

### V3 — Voice mode (Tesla / hands-busy)

A persistent toggle (localStorage) that:
- never focuses the textarea (fixes the keyboard pop: set `suppressRefocus` in
  the mic `onstop` path, `chat-ui.html.js:1256`),
- tags the request `source: "voice"` so the DO prepends `[voice]` to the user
  turn and the prompt rule says: ≤ 2 sentences, no markdown, no lists, spell
  out times,
- speaks the reply with `speechSynthesis` (free, offline, works in Tesla's
  Chromium) — optional ElevenLabs TTS later if the voice matters,
- shows the transcript in the user bubble with a tap-to-edit affordance and a
  3-second "sending…" window to cancel a mis-hearing before it fires,
- uses a bigger mic target and larger type.

### V4 — Voice command grammar (deterministic, no LLM)

Promote `_tryDeterministicFastPath` into `src/intent-grammar.js`: a small
table-driven grammar with the same bail guards, unit-tested like the cover
path. Commands worth fast-pathing in this house, grouped by risk:

*Safe, fire immediately (Quick tier fallback if the grammar misses):*
- "open / close the (main) garage", "basement bay", "left basement" — today.
- "lock the front door / back porch / basement / garage entry / lock up /
  lock everything" → `lock.lock` (lock is safe; unlock is not).
- "turn on/off the <friendly name or alias>", "<name> on/off", "dim <name> to
  50", "<area> lights off" → resolve via alias table then fuzzy friendly name
  (A3), else fall through.
- "set the AC / main level / basement to 71", "AC up/down 2" → `climate.set_temperature`
  on the mapped thermostat (QUICK FACTS already maps them).
- "goodnight", "I'm leaving", "we're home", "movie time" → HA scripts/scenes
  (create them in HA; grammar maps phrase → `script.turn_on`).
- "turn off the drop lights in an hour", "AC down 2 for an hour" →
  `call_service` + `schedule_action` (the compound pattern the prompt already
  teaches; the grammar can do it without a model).
- "cancel that", "never mind" → cancel the most recent scheduled action.

*Status (read fast path, §2 L5):* "is the house locked / secure", "what's
open", "who's home", "is the Tesla charging / plugged in / how much charge",
"what's the temperature inside / outside", "is the garage open".

*Requires confirmation (spoken "yes" or tap):* "unlock <door>", "open the
garage" between 10 PM and 5 AM, "disarm". The grammar returns
`{needs_confirmation, action}`; the UI shows a confirm chip and re-sends with
`confirm_token`.

*Never fast-path, always LLM:* anything with forensic markers, "why", multi-
clause requests, unknown names.

**Alias table:** "call the bedside lamp 'my lamp'" → `save_memory` already
exists; add a structured `entity_aliases` DO storage map that the grammar and
A3 consult first. Aliases learned once are used at 0 ms forever.

### V5 — Things not worth doing yet

- Wake word in a browser: unreliable, battery-hostile, and Tesla's browser
  won't keep the mic open. Tap-to-talk + VAD is the honest ceiling.
- Scribe v2 Realtime WebSocket: only if L7 measurements show batch STT > 1.5 s.

---

## 6. GUI

- **Tier control**: a 4-segment toggle in the composer (Auto · ⚡ · ● · ◆),
  sticky in localStorage, sent as `tier` on every request. The reply footer
  shows what actually ran: "2.1 s · Quick · DeepSeek V4 Flash" (or "↑ escalated
  to Standard"). This makes the latency work visible and lets John A/B by feel.
- **Streaming bubble** (L1) with a live reasoning panel; the final `reply`
  event replaces the text.
- **Persistent tool trace**: today `showStatus` (`chat-ui.html.js:964`) reuses
  one element so tool calls overwrite each other and vanish at reply time.
  Render a collapsed "3 tool calls · get_state ×2, query_state_history" line
  under the bubble instead. Cheap and it's the audit trail for "why did it say
  that".
- **Voice mode** (V3): toggle, transcript-edit, confirm chips, TTS.
- **Status bar**: generalize `/covers` (`worker.js:2477`, two hardcoded
  entities) into `/status-bar` returning locks, covers, climate setpoints and
  presence from `stateCache`; render as pills above the transcript. Tapping a
  pill sends the matching command through the grammar (lock pill → "lock the
  front door").
- **Quick-action chips** generated from context: unlocked doors → "Lock the
  back porch"; open garage after dark → "Close the garage"; pending scheduled
  actions → "Cancel".
- **Latency badge + STT timer** (L7) so regressions are seen, not guessed.
- **Housekeeping**: the typing indicator is the MiniMax brand bar
  (`chat-ui.html.js:680-697`) — replace with a neutral one; `Clear` only clears
  the DOM, add a "clear server history" that hits a DO route; add a
  `manifest.json` so the phone install has an icon and standalone mode.
- Fold the duplicated SSE reader (`chat-ui.html.js:993-1028` and the retry copy
  at `:1035-1097`) into one function before adding `delta` handling, or every
  event change has to be made twice.

---

## 7. Telemetry & evaluation

- Add to `chat_timing_ms`: `tier`, `tier_source`, `provider`, `model`,
  `escalated`, `stt_ms` (from the client via a `client_timing` field on the
  next request or a `navigator.sendBeacon` to `/chat/timing`), `first_delta_ms`.
- `/admin/latency?days=N`: p50/p90 total and first-delta **per tier and per
  intent_tag**, plus escalation rate and fast-path hit rate. Same shape as
  `/admin/token-usage` (`worker.js:2704`).
- **Golden utterance set**: `test/fixtures/utterances.json` — ~40 real
  messages from `ai_log` (the ones above plus the BUGS.md ones) each with the
  expected route (fast_path / status / quick / standard / deep) and, for
  commands, the expected `domain.service` + entity. Two vitest suites: the
  router/grammar (pure, runs on every `npm test`) and an opt-in live suite
  (`LIVE_EVAL=1`) that replays them against the real DO and diffs tool calls.
  This is what makes "fewer mistakes" measurable before and after a model swap.

---

## 8. Sequencing

Everything DO-side needs the V30 class rename + migration (CLAUDE.md gotcha #1);
Worker/UI-side changes go live on push. Group so each phase is one deploy.

| Phase | Scope | Rename? |
|---|---|---|
| **0 — quick wins, Worker + UI only** | Tesla refocus fix; keyterms in `/transcribe` + STT timing; tier toggle in the UI (sent but ignored until Phase 1); neutral typing indicator; SSE reader de-dup; latency badge from `started`→`reply`. | no |
| **1 — V30: correctness + tiers + streaming** | A1 history fix + L6 reasoning strip + MAX_TURNS reconcile; L3 parallel context; tier config + router + escalation + per-request `tier`; effort enum; L1 streaming deltas; L4 short-circuit extension; A3 entity pre-flight + alias table; A4 service-field validation; L5/A2 status fast path; A5 registry via WS; telemetry fields. Ship Quick = DeepSeek V4 Flash, Standard = GLM 5.3 low, Deep = GLM 5.3 high. | **yes** |
| **2 — V31: OpenAI** | `src/llm-providers.js` with the Responses adapter; `OPENAI_API_KEY`; Deep = GPT-5.6 Sol; `/admin/latency`; golden-utterance live eval to compare Deep on Sol vs GLM high. | **yes** |
| **3 — voice** | Intent grammar module + tests; VAD auto-stop; voice mode + TTS + transcript edit + confirm chips; status bar + chips. Grammar is DO-side (rename); UI parts are not. | grammar yes / UI no |

Phase 1 is the one that changes what the house does; test the grammar and
trimmer in vitest first, then verify against `/admin/version` that the V30
isolate is live before judging any latency numbers.

---

## 9. Open questions for John

1. **Who talks to it, and from where?** Tesla browser, phone, both? Does
   Sabrina use voice? (Drives how aggressive Voice mode and TTS should be.)
2. **OpenAI: yes or no?** Adding a key and paying ~$0.10–0.40 per deep
   question for Sol — worth it, or keep Deep on GLM 5.3 high and spend the
   effort on the Quick tier? Phase 2 is skippable.
3. **Quick-tier model preference**: DeepSeek V4 Flash on Fireworks (known-good
   with the tool chain, one API key) vs GPT-5.6 Luna (second provider,
   slower output, cheaper input)?
4. **Voice safety policy**: which commands may never fire from voice without
   a confirm — unlock, open garage at night, anything else? Any that should
   be voice-only allowed for John and not Sabrina?
5. **Should the tier toggle be sticky** across sessions, or reset to Auto?
6. **TTS**: browser voice is free and instant; ElevenLabs TTS sounds better
   and costs a call per reply. Which?
7. **Latency targets you'd accept**: ~3 s for commands and ~8 s for questions
   is what the plan aims at. Is 3 s already too slow for garage/lock commands
   in the car (in which case the grammar in V4 matters more than the tiers)?
8. **Scenes/scripts for macros** ("goodnight", "I'm leaving"): do these exist
   in HA already, or should the plan include creating them?
