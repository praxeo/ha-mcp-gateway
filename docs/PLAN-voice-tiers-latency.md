# Plan — faster, more accurate Ranger: two reasoning tiers, Tesla-first voice, GUI

Status: **plan only, nothing implemented.** Written 2026-09-03 against `main`
at `40444c9`, revised the same day after John's decisions (§0). Every
file/line reference was checked against that commit. Numbers in §1 come from
the live `ai_log` (`chat_timing_ms` rows, Aug 31 – Sep 3, 2026).

Sections: 0 Decisions · 1 Where the time goes · 2 Latency · 3 Reasoning tiers ·
4 Accuracy (fewer mistakes) · 5 Voice · 6 GUI · 7 Telemetry & eval ·
8 Sequencing · 9 Remaining assumptions.

---

## 0. Decisions (John, 2026-09-03)

| Question | Decision | What it changes |
|---|---|---|
| Who uses it, where | John only; phone sometimes, **Tesla browser primarily** | Voice mode is the primary UX, designed for the Tesla screen |
| OpenAI | **No.** Stay in the Fireworks ecosystem | No provider adapter, no Responses API work, one API key |
| Tiers | **Quick = GLM 5.3 effort low. High = GLM 5.3 effort high.** | Two tiers, same model: prefix cache is shared, router is trivial |
| Temperatures | "Take them down some" | Chat loop is already at 0; the legacy `callLLM` 0.3/0.4 comes down (§2 L2) |
| Voice safety policy | N/A for now | No confirm-first class; unlock and night-time garage stay on the LLM path as today |
| Toggle persistence | **Reset to Quick** each session | No localStorage for tier; High is per-session opt-in |
| Spoken replies | **ElevenLabs voice, behind a "Speak replies" toggle, default off** (John expects to use it rarely); **auto-send when recording stops** | `/tts` proxy, playback only when the toggle is on, silence auto-stop → send |
| Keyboard after a voice send | **Must never pop up. Top priority.** | First item in Phase 0; mechanics pinned in §5 V3 |
| Is 3 s too slow in the car | **Yes** | The deterministic command grammar moves to Phase 1, ahead of streaming |
| Goodnight / leaving macros | Probably exist; not important now | Deferred |

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
| Prefix-cache hit on the *first* iteration of a turn | 4 of 16 |
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

So the levers, in order of payoff for a driver: **(a)** answer commands and
status from the cache with no LLM at all (the grammar, §5 V4), **(b)** stop
generating 700 reasoning tokens for ordinary turns (Quick tier at effort low),
**(c)** stream so perceived latency = TTFT and speech can start early,
**(d)** fix the history overflow so the agent stops forgetting.

---

## 2. Latency

### L1 — Token streaming (biggest perceived win, no model change)

Today no call uses `stream: true` (`callLLMWithTools`, `src/ha-websocket.js:4354`,
does `await response.json()`); the browser gets `started` → `thinking` → silence
→ one atomic `reply`. Perceived latency equals total latency.

Plan:
- `callLLMWithTools` gets a `stream: true` mode that parses Fireworks' SSE,
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
- In voice mode, streaming lets TTS start on the first complete sentence
  (§5 V3, second step) instead of after the whole reply.

### L2 — Fewer reasoning tokens by default, and temperatures

`reasoning_effort: "high"` (`ha-websocket.js:214`) is the default for every
turn, including "when will it rain again?" (181 tokens, 4.5 s) and "what's the
status of the house?" (591 tokens, 10.9 s). The two-tier design in §3 makes
the default `low`. Expected: roughly half the generation time on the same
model for ordinary turns; High stays available for forensic questions.

Temperatures: the chat tool loop already runs `temperature: 0` (confirmed in
the `fireworks-sampling-options` header on every logged turn: `temperature
0.0, top_k 20, top_p 0.95`). The only nonzero values are in the legacy
`callLLM` (`ha-websocket.js:3093`: 0.3 for JSON mode, 0.4 otherwise), which the
chat path does not use but the iteration-ceiling synthesis and any future
non-tool call would. Bring both to 0.1 so nothing drifts. If "temperatures"
meant the reasoning level, the tier change already does that.

### L3 — Parallelize the pre-LLM phase (~0.75 s → ~0.3 s)

`storage.get(history)` (`ha-websocket.js:5048`), `_buildNativeContextEntities`
(`:5062`) and `_buildClimatePreambleIfNeeded` (`:5065`) are three serial awaits
that share no inputs. `Promise.all` them. Inside `_buildNativeContextEntities`
the embedding call (`:2830`) is serial before four parallel Vectorize queries —
unavoidable, but a grammar hit skips retrieval entirely.

### L4 — Extend the post-tool short-circuit

`ha-websocket.js:4592-4645` already skips the wrap-up LLM call for a single
`light.*` / `switch.*` / `lock.*` / `scene.turn_on` call and synthesizes
"Done — X." Extend the allow-list to `cover.*`, `climate.set_temperature`
(synthesize "Set main level to 71."), `script.turn_on`, `fan.*`,
`media_player.*` volume/pause, and `schedule_action` ("Scheduled: X at 8:05 PM").
Each extension saves one full iteration (~5 s at effort low).

### L5 — Deterministic answers for status questions (no LLM)

The `HOUSE_STATE_SNAPSHOT` (`_buildHouseStateSnapshot`, `ha-websocket.js:368`)
already renders locks, covers, climate, presence, power, Tesla from
`stateCache`. Add a read fast path next to `_tryDeterministicFastPath`:
short questions that match a narrow grammar ("what doors are unlocked", "is
the house locked", "is the garage open", "who's home", "what's the temperature
inside", "is the Tesla charging/plugged in") get a templated answer in <100 ms,
phrased for speech ("Two doors are unlocked: basement and back porch."). Anything
with forensic markers or that doesn't match cleanly falls through to the LLM
exactly as today. Same bail-guard discipline as the cover fast path
(`ha-websocket.js:480-513`). Fixes the "unlocked doors" mistake at the root:
the answer is the truth table, not a paraphrase.

### L6 — Persisted history bloat

Prompt tokens grew 10.7 k → 30 k across one evening because every assistant
message in history carries its `reasoning_content` (preserved by
`sanitizeMessagesForLLM`, `ha-websocket.js:3026`, and stored via
`loopAdditions`, `:5199`). Fireworks needs `reasoning_content` **within** a
tool-loop turn; it does not need it from prior turns. Strip it (or cap it at
~300 chars) when building `nextHistory` (`:5218`). Cuts prefill and cuts the
110 KB cap pressure (§4 A1).

### L7 — STT and TTS latency must be measured

`/transcribe` (`src/worker.js:2407`) has no timing, no timeout, and the UI has no
timer. Add `stt_ms`, `tts_first_audio_ms` (client) and `Server-Timing`
headers (worker). Scribe v2 batch on a 3-second clip is typically ~1 s; if
measurements show >1.5 s, Scribe v2 Realtime (WebSocket, ~150 ms) is the
upgrade — measure first.

---

## 3. Reasoning tiers (two, same model)

| Tier | Job | Model | Reasoning | Target |
|---|---|---|---|---|
| **Quick** (default, every session) | everything that isn't forensic: commands the grammar missed, status, weather, scheduling, memory | GLM 5.3 (`glm-5p3`) | `effort: low` | < 6 s spoken, < 2 s to first streamed token |
| **High** (per-session opt-in) | forensic / "trends over the last few days" / debugging HA / anything with `query_*` tools | GLM 5.3 | `effort: high` | quality over speed |

Same model in both tiers means one API key, one prompt cache, one set of tool
schemas, and no message-format differences. The tier is just the
`reasoning_effort` value on that request.

If Quick at ~67 tok/s still feels slow after the grammar and streaming land,
the one-line fallback is DeepSeek V4 Flash on Fireworks
(`deepseek-v4-flash-0731`, ~256 tok/s, ran V17–V26 and handled the tool chain)
as the Quick model. Not planned; noted so the decision is recorded.

### Router

Ordered, first match wins; pure functions in a new `src/tier-router.js` with
vitest coverage like the fast-path tests:

1. Cover fast path / status fast path / intent grammar (§5 V4) → **no LLM**.
2. UI toggle set to High for this session → **High**.
3. Forensic markers (the existing regex at `ha-websocket.js:486`: when /
   history / how often / last time / summarize / explain …) or trend words
   (trend, habit, pattern, why, debug, root cause, "last N days") → **High**.
4. Everything else → **Quick**.

**Escalation** keeps Quick safe: if a Quick turn (a) returns a tool error the
model can't recover from in one more iteration, or (b) hits the 6-iteration
ceiling, re-run the same turn at High and emit an SSE `escalated` event so
the UI shows "↑ high". Misrouting costs seconds, not correctness.

### Config shape (extends the V29 runtime config; no rename needed to change it)

```json
{
  "model": "accounts/fireworks/models/glm-5p3",
  "reasoning_mode": "effort",
  "tiers": { "quick": { "reasoning_effort": "low" }, "high": { "reasoning_effort": "high" } },
  "default_tier": "quick"
}
```

- `resolveLLMConfig` (`ha-websocket.js:100`) gains `tier` resolution; tier
  entries may override `model` / `reasoning_mode` too, so a Quick-model swap
  later is a config POST, not a deploy.
- `sanitizeLLMConfigPatch` (`:151`) allow-list grows: `default_tier`, `tiers.*`.
- `LLM_REASONING_EFFORTS` (`:78`) is `low|medium|high|none` — sufficient.
- Per-request `tier` flows UI → `/chat` body → Worker whitelist
  (`src/worker.js:2531`) → DO `/ai_chat_stream` → `chatWithAgent` →
  `runNativeToolLoop`. The MCP `ai_chat` tool gets an optional `tier` arg too
  (Claude Code asking a forensic question can pick High).
- Per-turn telemetry gains `tier`, `tier_source` (`ui|router|escalated`),
  `model`, `reasoning_effort` — today the model is not logged at all.

**Not doing: OpenAI.** Recorded for the future: GPT-5.6 via
`/v1/chat/completions` rejects function tools combined with any
`reasoning_effort` other than `none`; reasoning + tools needs the Responses
API and therefore a provider adapter for auth, message shape, reasoning
items, and stream events. That is the cost if this is ever revisited.

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
`get_state`. The same matcher backs the grammar's name resolution (§5 V4).

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

**A7 — Static prompt size.** ~9.4 k tokens with tool schemas
(`chat-prompt.js` 14 KB + `getAgentContext` 4.3 KB + 19 schemas 19 KB). Two
trims that don't touch behavioral rules: the 2 000-char TESLA MODEL Y block
(`chat-prompt.js:105`) can move behind on-demand retrieval; the stale "last 2h"
timeline comment (`chat-prompt.js:155`) vs 1 h cutoff (`ha-websocket.js:4891`)
should be made true. Prefix cache means this mostly saves cost, not time. Last.

**A8 — Presence flap (BUGS `#6f87e35d`)** is an HA-side tracker config problem
(`device_tracker.tesla_model_y_route` reporting home at gps_accuracy 0); the
gateway fix is A5 so the agent can actually apply the registry change.

---

## 5. Voice (Tesla-first)

### What exists

Tap-to-toggle mic (`src/chat-ui.html.js:1203-1279`), whole-clip POST to
`/transcribe` (Scribe v2, `language_code: eng`, `no_verbatim`, **no keyterms**,
`worker.js:2430-2437`), transcript auto-sent with no review, no VAD, no TTS, no
wake word, and the voice path calls `send()` without `suppressRefocus`, which is
the Tesla keyboard pop from Sep 1.

### V1 — Keyterm biasing (cheapest accuracy win)

Scribe v2 batch accepts up to 1 000 `keyterms` (≤ 50 chars each). Build the
list server-side from `stateCache`: friendly names of every controllable
entity (light, switch, lock, cover, climate, scene, script, fan,
media_player), area names, household names (John, Sabrina, Ranger), Tesla
terms (precondition, sentry, charge limit), and the grammar vocabulary. Cache
in KV with the registry refresh (15-min cycle). Send on every `/transcribe`.

### V2 — Silence auto-stop, then auto-send (decided)

Client-side VAD via `AudioContext` + `AnalyserNode` RMS: stop recording after
~1.2 s of silence following speech, minimum clip 0.6 s, hard cap 15 s, then
transcribe and send with no review step. Tap-to-stop stays as a manual
override; a tap during the "sending…" moment cancels.

### V3 — Voice mode with ElevenLabs spoken replies (decided)

Voice mode is on by default when the UA is the Tesla browser and toggleable
elsewhere (persisted; tier is not). In voice mode:

- **No keyboard after a voice send — the top-priority item.** Root cause:
  `send()` ends every path with `refocusInput()` (`chat-ui.html.js:989` early
  error return, `:1085` iOS retry success, `:1100` normal), which calls
  `input.focus()` (`:826`) and pops the on-screen keyboard over the Tesla
  screen. The cover buttons already dodge this with a one-shot
  `suppressRefocus = true` before `send()` (`:815-822`); the mic `onstop` path
  (`:1256`) does not set it. Fix in two layers so it can't regress: (1) set
  `suppressRefocus = true` in the mic path before `send()`, exactly like
  `sendQuick`; (2) make `refocusInput()` also return early whenever voice mode
  is on, so no code path in voice mode ever focuses the textarea. Each `send()`
  flow calls `refocusInput()` exactly once, so the one-shot flag is consumed
  correctly and can't leak. Nothing else on the page focuses the input
  (no `autofocus`; the only `.focus()` call is `:826`). Verify on the Tesla
  after Phase 0 ships, since it's the only browser that matters.
- **`source: "voice"`** on the request → the DO prepends `[voice]` to the user
  turn and a static prompt rule says: ≤ 2 sentences, no markdown, no lists,
  spell out times, say the entity's friendly name not its id. Grammar and
  status fast-path replies are already speech-shaped.
- **"Speak replies" toggle, default off**, persisted in localStorage,
  shown next to the mic. When off, nothing below in this list runs and no
  TTS call is made. When on:
- **`/tts` Worker route** proxying ElevenLabs
  `POST /v1/text-to-speech/{voice_id}/stream` with `eleven_flash_v2_5`
  (~75 ms model latency), `optimize_streaming_latency`, `output_format`
  `mp3_22050_32` (small, Tesla-safe), text capped at ~600 chars. Uses the
  existing `ELEVENLABS_API_KEY`; voice id via a new `ELEVENLABS_VOICE_ID`
  var. Strip markdown and entity ids before synthesis.
- **Autoplay unlock.** Chromium's user-activation window expires before a
  reply arrives, so create the `<audio>` element and play a silent buffer on
  the mic tap; later `src` swaps then play without a gesture. Verify on the
  Tesla first — it's the one browser that matters.
- **Playback**: first step, fetch the stream on the `reply` event and play.
  Second step (after L1): send sentence-sized chunks to `/tts` as `delta`
  events complete sentences and queue them, so speech starts ~1 s after the
  first token instead of after the whole reply.
- Cost is one TTS call per spoken reply; replies are short by rule, so this
  stays well inside ElevenLabs' plan character budget. Speak only when the
  toggle is on.
- Larger type, bigger mic target, transcript shown in the user bubble.

### V4 — Command grammar (deterministic, no LLM) — **Phase 1, ahead of streaming**

Promote `_tryDeterministicFastPath` into `src/intent-grammar.js`: table-driven,
same bail guards (question / forensic marker / length), unit-tested like the
cover path (`test/try-deterministic-fast-path.test.js`). Order of
implementation reflects car use:

1. **Covers** (today): open / close the (main) garage, basement bay, left basement.
2. **Locks, lock only**: "lock the front door / back porch / basement / garage
   entry", "lock up", "lock everything" → `lock.lock`. Unlock stays on the
   LLM path (no policy decided yet, so no new voice-only exposure).
3. **Status** (L5): "is the house locked / secure", "what's open", "who's
   home", "is the Tesla charging / plugged in / how much charge", "what's the
   temperature inside / outside", "is the garage open".
4. **Lights / switches**: "turn on/off the <name>", "<name> off", "dim <name>
   to 50", "<area> lights off" → alias table → fuzzy friendly-name match (A3)
   → `light.*` / `switch.*`. Ambiguous match (two names within a small score
   gap) → fall through to the LLM.
5. **Climate**: "set the AC / main level / basement to 71", "AC up/down 2" →
   `climate.set_temperature` on the mapped thermostat (QUICK FACTS already
   holds the mapping; move it into the grammar table).
6. **Timed**: "turn off the drop lights in an hour", "AC down 2 for an hour" →
   `call_service` + `schedule_action` without a model.
7. **Undo**: "cancel that", "never mind" → cancel the most recent scheduled action.
8. **Macros** ("goodnight", "I'm leaving", "we're home") → `script.turn_on` once
   the scripts are confirmed. Deferred.

Every grammar hit logs `intent_tag: "grammar:<class>"` so hit rate and false
positives are auditable in `ai_log`, and every grammar reply is one short
spoken sentence.

**Alias table:** "call the bedside lamp 'my lamp'" writes a structured
`entity_aliases` map in DO storage that the grammar and A3 consult first.
Learned once, used at 0 ms.

### V5 — Not worth doing yet

Wake word in a browser (unreliable, battery-hostile, Tesla won't keep the mic
open) and Scribe v2 Realtime (only if L7 shows batch STT > 1.5 s).

---

## 6. GUI

- **Tier control**: a two-position toggle in the composer (Quick · High),
  **resets to Quick on every page load**, sent as `tier` on every request.
  The reply footer shows what ran: "1.8 s · Quick" or "↑ escalated to High".
- **Voice mode** (V3): mic-first layout on the Tesla, no keyboard after a
  voice send, transcript in the user bubble, a small "sending…" cancel
  window after auto-stop, and a separate "Speak replies" toggle (default
  off).
- **Streaming bubble** (L1) with a live reasoning panel; the final `reply`
  event replaces the text.
- **Persistent tool trace**: today `showStatus` (`chat-ui.html.js:964`) reuses
  one element so tool calls overwrite each other and vanish at reply time.
  Render a collapsed "3 tool calls · get_state ×2, query_state_history" line
  under the bubble instead.
- **Status bar**: generalize `/covers` (`worker.js:2477`, two hardcoded
  entities) into `/status-bar` returning locks, covers, climate setpoints and
  presence from `stateCache`; render as pills above the transcript. Tapping a
  pill sends the matching grammar command (lock pill → "lock the front door").
- **Quick-action chips** from context: unlocked doors → "Lock the back porch";
  open garage after dark → "Close the garage"; pending scheduled actions →
  "Cancel".
- **Latency badge + STT/TTS timers** (L7) so regressions are seen, not guessed.
- **Housekeeping**: the typing indicator is the MiniMax brand bar
  (`chat-ui.html.js:680-697`) — replace with a neutral one; `Clear` only clears
  the DOM, add a "clear server history" DO route; add a `manifest.json` for the
  phone install.
- Fold the duplicated SSE reader (`chat-ui.html.js:993-1028` and the retry copy
  at `:1035-1097`) into one function before adding `delta` handling.

---

## 7. Telemetry & evaluation

- Add to `chat_timing_ms`: `tier`, `tier_source`, `model`, `reasoning_effort`,
  `escalated`, `source` (`voice|text`), `stt_ms`, `tts_first_audio_ms`,
  `first_delta_ms` (client timings arrive as a `client_timing` field on the
  next request or a `navigator.sendBeacon` to `/chat/timing`).
- `/admin/latency?days=N`: p50/p90 total and first-delta **per tier, per
  source, and per intent_tag**, plus escalation rate and grammar hit rate.
  Same shape as `/admin/token-usage` (`worker.js:2704`).
- **Golden utterance set**: `test/fixtures/utterances.json` — ~40 real
  messages from `ai_log` (the ones above plus the BUGS.md ones) each with the
  expected route (grammar class / status / quick / high) and, for commands,
  the expected `domain.service` + entity. Two vitest suites: the
  router/grammar (pure, runs on every `npm test`) and an opt-in live suite
  (`LIVE_EVAL=1`) that replays them against the real DO and diffs tool calls.

---

## 8. Sequencing

Everything DO-side needs the V30 class rename + migration (CLAUDE.md gotcha #1);
Worker/UI-side changes go live on push. Group so each phase is one deploy.

| Phase | Scope | Rename? |
|---|---|---|
| **0 — Worker + UI, no rename** | **Keyboard-pop fix first** (ship it alone if need be); VAD auto-stop → auto-send; keyterms + STT timing in `/transcribe`; voice-mode toggle (Tesla UA default); "Speak replies" toggle + `/tts` route + ElevenLabs playback + autoplay unlock; Quick/High toggle (sent, ignored until Phase 1); neutral typing indicator; SSE reader de-dup; latency badge; `callLLM` temperatures to 0.1. | no |
| **1 — V30: grammar, tiers, correctness** | Intent grammar classes 1–7 + tests; L5 status fast path; A3 entity pre-flight + alias table; A4 field validation; two tiers + router + escalation + per-request `tier` (web and MCP `ai_chat`); `[voice]` prompt rule; A1 history fix + L6 reasoning strip + MAX_TURNS reconcile; L3 parallel context; L4 short-circuit extension; A5 registry via WS; telemetry fields. | **yes** |
| **2 — V31: streaming and polish** | L1 streaming deltas; sentence-chunked TTS; status bar + chips; `/admin/latency`; golden-utterance live eval; A7 prompt trims; macros once scripts are confirmed. | **yes** |

Phase 1 is the one that changes what the house does: test the grammar and
trimmer in vitest first, then verify against `/admin/version` that the V30
isolate is live before judging any latency numbers. Expected after Phase 1:
garage / lock / light / status commands from the car in ~200 ms; ordinary
questions ~5–6 s spoken; forensic questions unchanged on High.

---

## 9. Remaining assumptions (say if either is wrong)

1. "Take the temperatures down" is read as sampling temperature. The chat
   loop is already at 0, so the only change is the legacy `callLLM` 0.3/0.4 →
   0.1. If it meant "less reasoning by default", the Quick tier is that.
2. Voice mode defaults on when the browser identifies as Tesla and is a
   toggle elsewhere. If you'd rather it be a plain toggle everywhere, that's
   a one-line change in Phase 0.
