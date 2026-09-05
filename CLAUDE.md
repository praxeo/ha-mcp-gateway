# CLAUDE.md

Guidance for Claude Code working in this repository. This file is comprehensive
and self-contained; `README.md` is the longer narrative reference (it opens with
the design history). When the two overlap, the code is authoritative — verify
before relying on either.

---

## What this project is

**HA-MCP-Gateway** is a Cloudflare Worker + Durable Object that bridges a Home
Assistant smart home to LLMs. It:

- holds a persistent WebSocket to Home Assistant and mirrors live entity state
  in memory,
- streams every meaningful HA event into a queryable D1 **forensic log**,
- exposes the whole surface as an **MCP server** (`POST /mcp`) for clients like
  Claude Desktop and Claude Code,
- runs a built-in **chat agent** — "Ranger," Meta Muse Spark 1.3 (contributor)
  on the Responses API (runtime-configurable; see LLM configuration) with
  reasoning enabled and a native tool-calling loop — reachable at a web
  `/chat` UI and via the `ai_chat` MCP tool,
- short-circuits deterministic cover (garage/bay door) commands via a sub-500ms
  fast path that skips the LLM entirely.

It is a single-household production deployment — the author's home. There is no
staging environment, and a push to `main` deploys to the live house (see
Build, test, deploy below). Treat changes with appropriate care.

The autonomous "heartbeat" agent that once ran every 60 seconds has been
removed — see the Story section in `README.md`. There is exactly one execution
path now: user-driven chat.

---

## Build, test, deploy

Working directory: `C:\Users\obert\ha-mcp-gateway`. Shell is **PowerShell on
Windows**.

```powershell
npm install          # dependencies (only devDependency is vitest)
npm test             # vitest run — 9 suites (forensic filter, light sanitizer,
                     #   scheduler, fast path, coalesce, llm-config,
                     #   llm-providers, speech-shaping, chat-history)
```

- **Deploy is git-driven.** A push to `main` triggers a **Cloudflare Workers
  Builds** pipeline (set up in the Cloudflare dashboard, so it leaves no
  artifact in the repo) that runs the build and deploys. A merged commit goes
  live — treat `git push` to `main` as a production deploy.
- `wrangler deploy` from the repo root is the manual / local alternative; it
  runs the same build.
- **Build** (either path) runs the `wrangler.toml` `[build]` directive —
  `npx esbuild src/worker.js --bundle --outdir=dist --format=esm --outbase=src`
  — producing `dist/worker.js`.
- **`dist/worker.js` is a build artifact. Never edit it by hand** — it is
  overwritten on every build. All source lives in `src/`.
- A deploy reconciles bindings, cron triggers, and Durable Object migrations
  with Cloudflare.
- Tests run with `vitest` — 9 suites under `test/` (207 cases): the forensic
  noise filter (`should-log-state-change`), the light-service sanitizer, the
  scheduler, the cover fast path, the flat-arg coalescer, the runtime
  LLM-config helpers (`llm-config`), the provider adapters (`llm-providers` —
  imports the real module, no stub), and the TTS/keyterm helpers
  (`speech-shaping`), and the persisted-history trimmer (`chat-history` —
  also imports the real module). Add tests alongside these when changing pure, testable
  logic; the stubbed helpers keep a synced copy in their test — when you change
  one of those functions, update its stub in the same commit or the suite is
  testing code that no longer exists.

---

## Critical gotchas — read before changing code

1. **Durable Object isolate staleness.** The persistent HA WebSocket keeps the
   DO's V8 isolate resident across deploys — Cloudflare never hibernates it, so
   it never reloads new code on an ordinary deploy. **Worker-side changes
   (`src/worker.js`) take effect immediately. DO-side changes
   (`src/ha-websocket.js`) do not.** To force a fresh DO isolate you must rename
   the DO class via a `renamed_classes` migration in `wrangler.toml` and update
   `class_name` in the `durable_objects.bindings`. The class is currently
   `HAWebSocketV36` — it has been renamed 35 times for exactly this reason.
   Procedure for any DO-side change you need live:
   - bump the class name (`HAWebSocketV31` → `HAWebSocketV32`) in the `export
     class` line in `src/ha-websocket.js`, every `HAWebSocketV31.` static
     reference, the `export {}` at the file end, and the `worker.js` import;
   - add a `[[migrations]]` block with `tag = "v32"` and
     `renamed_classes = [{ from = "HAWebSocketV31", to = "HAWebSocketV32" }]`;
   - update `class_name` in `[[durable_objects.bindings]]`.
   **Exception — the LLM config is now runtime-configurable** (V29, extended
   in V30 to the provider and wire format): the chat/
   agent model, endpoint, provider, and reasoning mode can be swapped live via the
   `/admin/llm-config` route (DO storage override) with no rename or redeploy.
   See the LLM configuration section. A model swap no longer needs this dance.
   DO storage (snapshot, chat history, memory, cursors) is preserved across
   renames. Diagnose staleness with `wrangler tail --format json` (compare
   per-event `scriptVersion.id` to the latest deploy) or by comparing
   `/admin/version` (Worker) against the DO `/version` route.

2. **A DO migration makes the PR's branch check go red, and that is expected.**
   Workers Builds runs `npx wrangler versions upload` on non-production
   branches. A versioned upload **cannot apply Durable Object migrations**:

   ```
   ✘ [ERROR] Version upload failed. You attempted to upload a version of a
     Worker that includes a Durable Object migration, but migrations must be
     fully applied via a non-versioned deployment. [code: 10211]
   ```

   So any PR that renames the DO class (i.e. every PR that needs gotcha #1)
   will show a failing `Workers Builds` check on its branch, no matter how
   correct it is. The build itself succeeds — read the log and confirm the
   failure is `10211` at the upload step, not a real build error. The migration
   applies when the PR merges to `main`, because the production branch runs
   `wrangler deploy`. Don't "fix" the check by dropping the migration: that
   ships renamed-class code that the pinned isolate never loads.

   Verify locally before merging with `wrangler deploy --dry-run --outdir=...`,
   which validates config, bindings and migration syntax without contacting the
   API. A failed versioned upload changes nothing in production.

3. **Never edit `dist/`.** It is generated.

4. **Pooling discipline.** Every Workers AI embedding call must use
   `pooling: "cls"`. The `ha-knowledge` Vectorize index was built with cls
   pooling; mismatched pooling between backfill and query produces near-random
   rankings.

5. **Cloudflare Access fronts the Worker.** A direct `curl` /
   `Invoke-RestMethod` hits the Access login page, not the app. Use
   `cloudflared access curl` or a service token for any HTTP probe.

6. **PowerShell quoting.** To POST JSON, write the body to a UTF-8-**without-BOM**
   temp file and use `--data-binary "@file"`. Inline JSON on the PowerShell
   command line gets mangled. See the smoke-test snippets in `README.md`.

7. **Production is live.** There is no staging. A deploy — including a `git
   push` to `main` — changes the behavior of a real, occupied house. Don't
   push speculative changes to `main`.

8. **Commit hygiene.** Commit messages in this repo follow
   `type(scope): VNN — summary` (e.g. `feat(do): V29 — runtime LLM config + Qwen 3.7 Plus default`). The
   `VNN` matches the DO migration tag when the change is DO-side.

---

## Architecture

```
User (web /chat · Claude Desktop · Claude Code · WhatsApp[dormant])
        │
        ▼
Cloudflare Worker  (src/worker.js)
   │   HTTP routing, MCP JSON-RPC handler (82-tool surface), embedded
   │   CHAT_HTML UI, ElevenLabs STT proxy, multi-kind knowledge backfill,
   │   scheduled() cron handler
   ▼
Durable Object  HAWebSocketV36  (src/ha-websocket.js)
   │   singleton "ha-websocket-singleton" — persistent HA WebSocket,
   │   in-memory stateCache, hibernation snapshot, chat tool loop,
   │   cover fast path, forensic D1 writers, reconnect backfill
   ├─► Home Assistant WebSocket (JWT auth) — subscribes to state_changed,
   │     entity_registry_updated, device_registry_updated,
   │     automation_triggered, call_service
   ├─► D1 "ha_db"            — ai_log, observations, state_changes,
   │                           automation_runs, service_calls
   ├─► Vectorize "ha-knowledge" — nine-kind semantic index
   ├─► Workers AI            — @cf/baai/bge-large-en-v1.5 embeddings (cls)
   ├─► Meta Model API        — Muse Spark 1.3 over /v1/responses (default)
   ├─► Fireworks             — GLM 5.3 chat completions (rollback provider)
   ├─► ElevenLabs Scribe     — speech-to-text  (src/stt.js)
   └─► ElevenLabs TTS        — spoken replies  (src/tts.js)
```

The Worker is stateless request routing. All long-lived state and all LLM calls
live in the single Durable Object. The DO is a singleton — every request
addresses the same instance by the fixed name `ha-websocket-singleton`.

---

## Repo layout

| Path | Role |
|---|---|
| `src/worker.js` | Worker entry. MCP handler (`TOOLS` — 82 entries — + `handleTool` dispatch, `getAgentToolset`, `DANGEROUS_TOOLS`), HTTP routes, embedded `CHAT_HTML`, ElevenLabs STT proxy, KV cache helpers, per-kind `build*Docs`, `backfillKnowledge`, `scheduled()` cron handler. |
| `src/ha-websocket.js` | The Durable Object class `HAWebSocketV36`. Persistent HA WS, `stateCache`, chat path (`chatWithAgentNative`), native tool loop (`runNativeToolLoop`), tool dispatch (`executeNativeTool`), action executor (`executeAIAction`), prompt builders, fast path, forensic D1 writers, reconnect backfill, `alarm()` keepalive. `_sanitizeLightServiceData` strips unsupported color descriptors from `light.turn_on` / `light.toggle` calls before they reach HA. ~5,700 lines — the bulk of the system. |
| `src/chat-history.js` | Persisted-history trimming (V31). Real byte accounting against the DO's 131072-byte per-value limit, per-message caps, reasoning stripped from stored turns, and trimming at whole-turn boundaries so a tool result is never orphaned from its call. Both save paths go through `trimChatHistory`. Pure and unit-tested. |
| `src/llm-providers.js` | Provider adapters (V30). `LLM_PROVIDERS` (fireworks/meta), endpoint derivation, per-provider effort clamping, and the Chat-Completions ↔ Responses-API translation (`chatMessagesToResponsesInput`, `buildResponsesBody`, `responsesToChatCompletion`). Pure and unit-tested. |
| `src/chat-prompt.js` | The Ranger chat system prompt. `buildStaticChatSystemPrompt()` (the cache-stable half) and `renderDynamicContext()` (the per-request half). **Edit prompt text here, not in the DO.** |
| `src/chat-ui.html.js` | `CHAT_HTML` — the whole `/chat` web UI as one exported template literal (~1,600 lines): voice capture and VAD tuning, the reasoning-tier toggle, the spoken-replies toggle, the cover bar. |
| `src/stt.js` | All ElevenLabs Scribe speech-to-text: `STT_CONFIG`, the keyterm vocabulary (`STT_FIXED_KEYTERMS`, `STT_KEYTERM_DOMAINS`), KV keyterm caching, `handleTranscribe`. |
| `src/tts.js` | All ElevenLabs text-to-speech: `TTS_CONFIG` (voice id, model, delivery settings), `cleanForSpeech()` speech shaping, `handleTTS`. The file header says it plainly — edit here, not `worker.js`. |
| `src/agent-tools.js` | OpenAI-format tool schemas for the chat agent: `NATIVE_AGENT_TOOLS` (19 = 6 action + 13 read), `CHAT_ALLOWED_TOOL_NAMES`, `NATIVE_ACTION_TOOL_NAMES`. |
| `src/vectorize-schema.js` | Shared Vectorize schema + helpers: `vectorIdFor`, `topicTagFor`, `fnv1aHex`, per-kind embed-text builders, `isNoisyEntity` / `isNoisySwitch` / `isNoisyService`, `buildMetadata`. Imported by both `worker.js` and `ha-websocket.js`. |
| `migrations/000{1,2,3}_*.sql` | D1 schema. 0001 indexes legacy tables; 0002 creates the forensic log tables; 0003 de-dupes `state_changes` and adds the backfill-idempotency unique index. |
| `wrangler.toml` | Bindings, `[build]`, cron triggers, DO migrations v1→v36. |
| `dist/worker.js` | esbuild output — **build artifact, never edit**. |
| `BUGS.md` | The iteration backlog — bugs captured via `report_bug`, folded in at iteration time. |
| `.dev.vars` | Local-dev secrets — never committed. |

---

## Where to change things

A task-to-location map for the knobs that actually get turned. Line numbers are a
starting offset and drift with every edit — the symbol names are the durable part,
so `grep -n "<symbol>" src/<file>.js` if a number looks off.

### The voice Ranger speaks in (ElevenLabs TTS)

All of it is in `src/tts.js`, whose header says it outright: *edit here, not
`worker.js`*.

| To change | Edit |
|---|---|
| **The voice itself** | `TTS_CONFIG.defaultVoiceId` (`tts.js:4`) — currently `21m00Tcm4TlvDq8ikWAM` (Rachel). Resolution order is per-request `body.voice` → `env.ELEVENLABS_VOICE_ID` → this constant, so **setting the `ELEVENLABS_VOICE_ID` secret swaps the voice with no code change and no deploy**. Edit the constant only to move the baked-in default. |
| TTS model / audio format | `TTS_CONFIG.model_id` (`tts.js:5`, `eleven_flash_v2_5`), `output_format` (`tts.js:6`, `mp3_22050_32`) |
| **Speaking rate** | `ELEVENLABS_VOICE_SPEED` secret — **no code change, no deploy**. ElevenLabs semantics: `1.0` natural, **< 1.0 slower, > 1.0 faster**, working range `0.7`–`1.2` (clamped by `resolveVoiceSpeed`, `tts.js`). Resolution order is per-request `body.speed` → secret → `TTS_CONFIG.speed` (`tts.js:8`, `1.0`). |
| How it sounds — delivery | `stability` / `similarity_boost` / `style` / `use_speaker_boost` (`tts.js:19-22`) |
| How long a spoken reply can run | `TTS_CONFIG.maxChars` (`tts.js:7`, 300 ≈ 45 words). The cut backs up to the last sentence end. |
| **How text is rewritten before it is spoken** | `cleanForSpeech()` (`tts.js:29`) — strips markdown, URLs, and emoji, expands `°F` / `%` / `&` / `+` into words, flattens entity IDs to just the object name (`light.porch_light` → "porch light"), and joins consecutive list items into narrative "a, b, and c" prose so spoken replies never sound like a staccato rundown. This is the **only** speech shaper — the chat UI posts the raw reply to `/tts` and lets the server shape it. Covered by `test/speech-shaping.test.js`. |

### What Ranger hears (ElevenLabs Scribe STT)

All of it is in `src/stt.js`.

| To change | Edit |
|---|---|
| **Words it keeps mishearing** | `STT_FIXED_KEYTERMS` (`stt.js:12`) — the hand-written vocabulary the transcriber cannot learn from entity names: household names, "sentry mode", "basement bay", "deadbolt", "precondition". Add the misheard phrase here first; this is the highest-leverage fix for a voice command that keeps landing wrong. |
| Which entities contribute their friendly names as keyterms | `STT_KEYTERM_DOMAINS` (`stt.js:6`) |
| STT model / language / temperature | `STT_CONFIG` (`stt.js:24`) — `scribe_v2`, `eng`, `0` |
| Keyterm list caps | `STT_KEYTERM_MAX` (1000) / `STT_KEYTERM_MAXLEN` (50) (`stt.js:21-22`) |
| Keyterm cache | `STT_CACHE_KEY` / `STT_CACHE_TTL` (`stt.js:3-4`, 1h in KV) |

Keyterms are read **read-only** from KV on the transcribe path so a cold cache
costs nothing on the voice critical path; a miss refreshes in the background via
`ctx.waitUntil`. If ElevenLabs 4xx-rejects the keyterms, `handleTranscribe` retries
once without them rather than failing the turn (`stt.js:82`).

### Voice capture behavior in the browser

In `src/chat-ui.html.js` — the UI is one template literal, so grep inside it.

| To change | Edit |
|---|---|
| How long a pause ends a clip | `VAD_SILENCE_MS` (`chat-ui.html.js:1409`, 1200ms) |
| Ignore-too-short threshold | `VAD_MIN_CLIP_MS` (`chat-ui.html.js:1410`, 600ms) |
| Hard ceiling on a stuck mic | `VAD_MAX_CLIP_MS` (`chat-ui.html.js:1411`, 15s) |
| Mic sensitivity (what counts as speech) | `VAD_SPEECH_RMS` (`chat-ui.html.js:1412`, 0.045) |
| Spoken replies on/off + its default | `speakOn` / `toggleSpeak()` (`chat-ui.html.js:954`), persisted per-browser in `localStorage` under `ha_speak_replies`. Default **off**. |
| Reasoning-tier control | `setTier()` (`chat-ui.html.js:946`). Resets to Quick on every page load **by design** — an ordinary command should never pay for reasoning it does not need. |

### The chat prompt

`src/chat-prompt.js`. **Edit prompt text here, not in `ha-websocket.js`.**

| To change | Edit |
|---|---|
| Persona, behavioral rules, tool guidance | `buildStaticChatSystemPrompt()` (`chat-prompt.js:22`) |
| Anything that varies per request | `renderDynamicContext()` (`chat-prompt.js:134`) |
| Voice-reply style (short, narrative, no lists) | The `voiceTurn` block in `renderDynamicContext()` — injected **only when the UI's spoken-replies toggle is on** (`speak: true`, forwarded by the worker and DO `/ai_chat` routes), regardless of whether the input was typed or dictated. A dictated turn with the toggle off gets the normal text/table reply — voice *input* and spoken *output* are independent. |

The split exists for prefix caching: the static half must be **byte-identical** on
every request. Interpolating one per-request value into it silently destroys the
cache with no error — so per-request data goes in the dynamic half, always. The
behavioral rules (TRUTHFULNESS, ACTION CONFIRMATION, TOOL ERROR HANDLING,
COMMITMENT RULE) encode real past failures; don't trim them casually.

### Model, provider, and reasoning

| To change | Edit |
|---|---|
| **Model / provider, live** | `POST /admin/llm-config` — no deploy, no DO rename. This is the normal path; see the LLM configuration section. |
| The baked-in default | `static LLM_ENDPOINT` / `LLM_MODEL` / `LLM_PROVIDER` / `LLM_API` (`ha-websocket.js:259-262`) |
| Baseline reasoning effort (the Quick tier) | `static LLM_REASONING_EFFORT` (`ha-websocket.js:276`) |
| Reasoning summary verbosity | `static LLM_REASONING_SUMMARY` (`ha-websocket.js:285`). `"detailed"` is the only value that ever produced text against the live Meta API; `null` drops the request. |
| What each UI tier maps to | `LLM_TIERS` (`llm-providers.js:95`) — `quick` → `low`, `high` → `high` |
| Adding a provider, or its endpoints / key env var / allowed efforts | `LLM_PROVIDERS` (`llm-providers.js:35`) |

Test a candidate model **without** storing it: `POST /admin/llm-selftest` with a
config patch. It runs one real probe through `callLLMWithTools`.

### Conversation memory

`src/chat-history.js` — how much history survives into the next turn.
`HISTORY_BYTE_BUDGET` (`:36`, 96000), `MAX_TURNS` (`:41`, 8), and the per-role caps
`TOOL_CONTENT_CAP` / `ASSISTANT_CONTENT_CAP` / `USER_CONTENT_CAP` (`:44-46`). The
budget exists because a DO storage value is hard-capped at 131072 bytes
(`DO_VALUE_LIMIT_BYTES`), and exceeding it used to lose the whole conversation.

### Behavior of the house itself

| To change | Edit |
|---|---|
| Which phrases skip the LLM entirely | `_tryDeterministicFastPath` (`ha-websocket.js`) — garage/bay open+close. Always explicit open/close, never `toggle`. |
| What the agent can *do* in chat | `NATIVE_AGENT_TOOLS` in `src/agent-tools.js`, plus a `case` in `executeNativeTool`; mutating tools must also join `NATIVE_ACTION_TOOL_NAMES` |
| What external MCP clients can do | `TOOLS` in `src/worker.js`, dispatched by `handleTool`; role-gate via `DANGEROUS_TOOLS` |
| Which events reach the forensic log | `_shouldLogStateChange` (`ha-websocket.js`) — has unit coverage, update the test with it |
| What the agent is told about the house right now | `_buildHouseStateSnapshot` and its gate `HOUSE_STATUS_TRIGGER_RE` (`ha-websocket.js`) |

**Before editing anything in `src/ha-websocket.js`, re-read gotcha #1.** A DO-side
change does not go live without the class rename plus a migration. Everything in
`worker.js`, `stt.js`, `tts.js`, `chat-ui.html.js`, `chat-prompt.js`,
`llm-providers.js` and `chat-history.js` is Worker-side and takes effect on deploy
— which is why the voice and prompt knobs were pulled out into their own modules in
the first place.

---

## The two tool surfaces

These are distinct and should not be conflated:

- **MCP surface** — `TOOLS` in `src/worker.js`, **82 tools**, returned by the
  MCP `tools/list` method. Full HA control (entities, devices, areas, floors,
  labels, automations, scripts, scenes, dashboards, calendars, todos, input
  helpers, services) plus agent-state tools, the three forensic query tools,
  the three ephemeral scheduler tools (`schedule_action`,
  `list_scheduled_actions`, `cancel_scheduled_action`), `report_bug`, and
  `ai_chat`. `getAgentToolset` filters out `DANGEROUS_TOOLS` (12 tools —
  `restart_ha`, automation create/update/delete, bulk enable/disable, etc.)
  for non-external roles; external MCP clients get the full set. `handleTool`
  is the dispatcher.
- **Chat agent native surface** — `NATIVE_AGENT_TOOLS` in `src/agent-tools.js`,
  **19 tools**, the curated set the in-house chat agent gets. 6 action tools
  (`call_service`, `ai_send_notification`, `save_memory`, `save_observation`,
  `schedule_action`, `cancel_scheduled_action`) and 13 read tools (`get_state`,
  `get_logbook`, `render_template`, `vector_search`, `get_house_topology`,
  `get_automation_config`, `report_bug`, `query_state_history`,
  `query_automation_runs`, `query_causal_chain`, `get_nws_weather`,
  `get_nws_discussion`, `list_scheduled_actions`). Dispatched by
  `executeNativeTool`.

The forensic query tools and several others share single helper implementations
between the two surfaces — when changing a shared tool, check both call sites.

---

## Key subsystems

### Forensic event log

Every `state_changed` (filtered by `_shouldLogStateChange`), every
`automation_triggered`, and every `call_service` HA event is written
fire-and-forget to D1 tables `state_changes` / `automation_runs` /
`service_calls`, with HA's context-chain IDs preserved. 90-day rolling
retention. On WS reconnect, `_backfillStateChangesFromHA` pulls missed state
changes from HA's history API (idempotent via `INSERT OR IGNORE` on a unique
index). Surfaced to the agent through `query_state_history`,
`query_automation_runs`, and `query_causal_chain`. `_shouldLogStateChange` is
the noise filter (Zigbee LQI/RSSI suffixes, monotonic counters, numeric
deadbands) — it has unit-test coverage; update the test when you change it.

### Knowledge index (`ha-knowledge`)

Cloudflare Vectorize, 1024-dim, cosine, `@cf/baai/bge-large-en-v1.5` with cls
pooling. Nine kinds: entity, automation, script, scene, area, device, service,
memory, observation. Entity/device refresh on HA registry events; memory/
observation are write-through; automation/script/area/device/service resync
nightly. `vector_search` (both surfaces) does metadata-filtered semantic search.
Schema and helpers are in `src/vectorize-schema.js` — the single source of truth
for vector IDs and metadata shape.

### HOUSE_STATE_SNAPSHOT

`_buildHouseStateSnapshot()` emits a small, authoritative text block read from
the live `stateCache` — locks, garage/bay covers, thermostats, presence, power,
contact sensors, and the Tesla Model Y. It is **gated**: `buildDynamicContext`
injects it only when the user message matches `HOUSE_STATUS_TRIGGER_RE`, or
vector retrieval found no high-confidence entity, or no message was passed. The
TRUTHFULNESS prompt rule depends on it.

### Native tool loop & chat prompt

`chatWithAgentNative` is the one chat path. It tries the cover fast path first,
then builds context and runs `runNativeToolLoop`: call the model, dispatch
`tool_calls` via `executeNativeTool`, push results, repeat. The chat path uses
`maxIterations: 6`, `maxTokens: 4096`, `hallucinationGuard: true`.
`callLLMWithTools` posts to Fireworks with `temperature: 0`,
`thinking: { type: "enabled" }`, and a 45s `AbortController` timeout.

The system prompt is split for prefix caching (V13):
`getStaticChatSystemPrompt()` is 100% static (byte-identical every request —
caches as a stable prefix) and `buildDynamicContext()` holds all per-request
data, prepended to the trailing user message. **When editing the prompt, keep
anything per-request out of the static half** — interpolating a dynamic value
into `getStaticChatSystemPrompt()` silently destroys the prefix cache.

### Cover fast path

`_tryDeterministicFastPath` pattern-matches imperative garage/basement-bay
open/close commands and fires `cover.open_cover` / `cover.close_cover` directly,
skipping the LLM. It always uses explicit open/close (never `toggle`), no-ops if
already in the target state, and falls through to the LLM on any error or
ambiguity.

### Ephemeral scheduler

`_scheduleAction` / `_listScheduledActions` / `_cancelScheduledAction` /
`_fireDueScheduledActions` on the DO power the three new tools
(`schedule_action`, `list_scheduled_actions`, `cancel_scheduled_action`).
Pending tasks live in DO storage under the `scheduled:<uuid>` namespace; the
60s `alarm()` tick calls `_fireDueScheduledActions` which fires any past-due
tasks. Two delivery rules: **delete-before-fire** (better to lose a task than
fire it twice for non-idempotent services like `toggle`) and a **WS-up guard**
(skip the tick when the HA WS is down so a transient outage doesn't destroy
the task). The compound "on for an hour" / "AC down 2 then back up" patterns
are agent-orchestrated — chat agent calls `call_service` immediately and
`schedule_action` for the reversal in the same turn, snapshotting any
"from current temp" arithmetic at schedule time.

### Crons

Two triggers in `wrangler.toml`:
- `* * * * *` → `prewarmCache` (warms KV; heavy registry refresh every 15 min;
  reconnects the DO if the WS is dead).
- `30 8 * * *` → `dailyKnowledgeResync` + `dailyAiLogRetention` (30-day `ai_log`
  prune) + `dailyForensicLogRetention` (90-day forensic prune).

The DO's `alarm()` keeps the WS alive (ping/pong, reconnect on no-pong) and
also calls `_fireDueScheduledActions` to fire any due scheduled tasks. The
60s reschedule is **mandatory**. Do not remove the reschedule.

---

## LLM configuration

**Runtime-configurable since V29; provider + wire format added in V30.** The
effective config is resolved at call time by `resolveLLMConfig` (module-level,
pure) with three layers, highest precedence first:

1. **DO storage override** — `state.storage` key `llm_config`, set live via the
   `/admin/llm-config` route (worker) → `/llm_config` (DO). No deploy, no rename.
2. **env vars** — `LLM_ENDPOINT` / `LLM_MODEL` / `LLM_PROVIDER` / `LLM_API` /
   `LLM_REASONING_MODE` / `LLM_REASONING_EFFORT` (a fresh isolate picks these up).
3. **baked-in defaults** — the static class constants in `src/ha-websocket.js`,
   exposed via `HAWebSocketV36._defaultLLMConfig()`:

```js
static LLM_ENDPOINT = "https://api.meta.ai/v1/responses";
static LLM_MODEL = "muse-spark-1.3-contributor";
static LLM_PROVIDER = "meta";             // "meta" | "fireworks"
static LLM_API = "responses";             // "responses" | "chat"
static LLM_REASONING_MODE = "effort";     // "thinking" | "effort" | "none"
static LLM_REASONING_EFFORT = "low";      // baseline = the Quick tier
static LLM_REASONING_SUMMARY = "auto";    // Responses-only; null = blank panel
```

**`MODEL_API_KEY` is required** now that `meta` is the default. Without it every
chat turn fails with `MODEL_API_KEY not configured`. Set the secret BEFORE the
DO refreshes onto V30.

**Reasoning tiers.** The chat UI sends `tier` on every request and
`effortForTier` maps it: `quick` → `low` (the default, reset on every page
load), `high` → `high`. It overrides the config's baseline effort for that turn
only. Muse Spark additionally accepts `minimal` and `xhigh`, and rejects
`none` — the adapter omits the reasoning block instead of sending it.

Both call sites (`callLLM`, `callLLMWithTools`) go through `await
this._getLLMConfig()` and use the resolved `cfg.endpoint` / `cfg.model`, so they
can't drift. Reasoning is applied by `applyReasoningToBody(body, cfg)`: mode
`"thinking"` → `thinking: { type: "enabled" }`; `"effort"` →
`reasoning_effort: <effort>`; `"none"` → neither. Fireworks **rejects sending
`thinking` and `reasoning_effort` together**, so the helper always emits at most
one and clears any pre-existing field first. Reasoning still returns in
`reasoning_content`, so the extraction / SSE stream / prior-turn re-feed are
unchanged. The pure helpers have unit coverage in `test/llm-config.test.js`
(keep the stubs there in sync).

Operating the runtime config:

Two providers are wired: `fireworks` (wire format `chat`) and `meta` (the Meta
Model API — Muse Spark — wire format `responses`). **The endpoint and the
API-key secret are DERIVED from the provider/api pair** unless an endpoint is
set explicitly, so switching provider is one field, not three. An `api` never
set explicitly follows the provider's default; that is deliberate, since
inheriting `chat` from the baked defaults would leave a switch to `meta`
pointed at the wrong wire format. See `docs/MUSE-SPARK.md` for the procedure.

```text
GET  /admin/llm-config                          # effective + stored + env + defaults
POST /admin/llm-config  {"model":"accounts/fireworks/models/minimax-m3",
                         "reasoning_mode":"thinking"}   # set override (merged)
POST /admin/llm-config  {"reset":true}          # clear override → back to env/defaults
POST /admin/llm-config  {"provider":"meta",
                         "model":"muse-spark-1.3-contributor"}  # → Responses API
POST /admin/llm-selftest {"provider":"meta","model":"muse-spark-1.3-contributor"}
                                                # probe a candidate; does NOT store it
```

**Always run `/admin/llm-selftest` before making a new provider or model live.**
It sends one small tool-calling request through the real `callLLMWithTools` path
and reports whether tool calls round-trip in the expected shape and whether
reasoning replay items came back. This is a live house; a model that cannot call
tools correctly fails at the point where it is asked to open a door.

The override is validated by `sanitizeLLMConfigPatch` (only `endpoint`, `model`,
`provider`, `api`, `reasoning_mode`, `reasoning_effort`; enums enforced). A set updates the
in-process cache, so even the pinned live isolate honors it on the next call.

The API key follows the resolved provider: `MODEL_API_KEY` for `meta`,
`FIREWORKS_API_KEY` for `fireworks` (`_apiKeyFor`). Provider history (kept here because it
explains the migration tags): originally MiniMax → gpt-oss-120b on Groq (V13–15)
→ MiniMax again (V16) → DeepSeek V4 Flash on Fireworks (V17–V26) → MiniMax M3 on
Fireworks (V27–V28) → Qwen 3.7 Plus on Fireworks (V29, runtime-configurable) →
GLM 5.2 → GLM 5.2 Fast → Qwen `qwen3p8-2p4t-a95b` → GLM 5.3 (`glm-5p3`), all on
Fireworks (still V29 class — a model swap is exempt from the DO-rename/migration
dance per gotcha #1; the default change ships in code and goes live via the
`/admin/llm-config` override or a fresh isolate). `glm-5p3` carries a 1M-token
context window and native tool calling. It keeps reasoning on via
`reasoning_effort` (mode `"effort"`, effort `"high"`); per the Fireworks
reasoning guide, `reasoning_effort` and the Anthropic-style `thinking` toggle are
interchangeable (Fireworks maps between them, and maps NIM `enable_thinking` onto
`reasoning_effort`), so `"high"` works regardless of model family — no reasoning
change was needed for the swap. Verified against the live API before the swap:
`glm-5p3` accepts `reasoning_effort`, emits `reasoning_content`, returns
`tool_calls` in the same shape, accepts an echoed assistant `reasoning_content`
on later tool-loop rounds, and still serves the `fireworks-*` perf headers.
Don't reintroduce Groq or the old MiniMax endpoint/auth (`MINIMAX_API_KEY`,
`reasoning_split`). The current default is `glm-5p3`, served by Fireworks via
`FIREWORKS_API_KEY`; any OpenAI-compatible Fireworks model can be selected at
runtime via the override.

**V30 moved the default off Fireworks** to Meta Muse Spark 1.3 (contributor
tier) on the Responses API — the only surface that carries reasoning between
turns, which is what a multi-round tool loop needs. Fireworks/GLM 5.3 remains
one config POST away for rollback:
`{"provider":"fireworks","model":"accounts/fireworks/models/glm-5p3"}`.
The Responses API has several rules that fail hard if broken (`strict` defaults
true; reasoning items must be followed by a message or call; assistant text
before a tool call must be tagged `phase: "commentary"`; there is no
`reasoning_content` on output). All of them are handled in
`src/llm-providers.js` and explained in `docs/MUSE-SPARK.md` — read that before
touching the adapter.

---

## Bindings, secrets, and flags

**Bindings** (`wrangler.toml`): `HA_WS` (DO `HAWebSocketV36`), `HA_CACHE` (KV),
`KNOWLEDGE` (Vectorize `ha-knowledge`), `AI` (Workers AI), `DB` (D1 `ha_db`),
`CF_VERSION_METADATA`.

**Secrets** (`wrangler secret put`): `HA_URL`, `HA_TOKEN`, `FIREWORKS_API_KEY`,
`MODEL_API_KEY` (**required** — Meta Model API / Muse Spark, the default
provider since V30), `ELEVENLABS_API_KEY` (optional, for `/transcribe`
and `/tts`), `ELEVENLABS_VOICE_ID` (optional, picks the spoken-reply voice),
`ELEVENLABS_VOICE_SPEED` (optional, spoken-reply pace: `0.7` slowest – `1.2`
fastest, `1.0` natural; < 1 slows, > 1 speeds up),
`MCP_AUTH_TOKEN` (optional).

**Flags**: `USE_NATIVE_TOOL_LOOP` (`"true"` — the chat path),
`USE_VECTOR_ENTITY_RETRIEVAL` (`"true"` — vector context build, flat-list
fallback), `CLIMATE_PREAMBLE_ENABLED` (optional), `DUMP_SYSTEM_PROMPT`
(`"1"` — one-shot preflight dump of the request body to `ai_log`; unset after).

---

## HTTP routes (Worker)

`/health`, `/transcribe` (ElevenLabs STT proxy — `src/stt.js`), `/tts` (ElevenLabs
spoken replies — `src/tts.js`), `/manifest.json`, `/refresh`, `/chat` (GET = UI,
POST = SSE chat), `/covers` (GET — live garage/basement-bay cover states for
the chat UI's persistent cover bar), `/twilio` (dormant), `/mcp` (and `/` —
MCP JSON-RPC), plus admin endpoints: `/admin/bugs`, `/admin/bugs/clear`, `/admin/recent_activity`,
`/admin/token-usage` (GET — per-day chat token totals from `ai_log`; `?days=N`
1–30, `?format=json|markdown`), `/admin/version`,
`/admin/llm-config` (GET/POST — runtime LLM config),
`/admin/llm-selftest` (GET/POST — one probe request through the real
`callLLMWithTools` path; POST a config patch to test a candidate provider/model
WITHOUT storing it),
`/admin/index-stats`, `/admin/reindex-observations`,
`/admin/cleanup-stale-vectors`, `/admin/rebuild-knowledge`.

The DO has its own internal HTTP router (`/status`, `/llm_config`, `/reconnect`,
`/version`, `/vector_search`, `/call_service`, the registry routes, the forensic
query routes, etc.) — reached only via `doFetch` from the Worker.

---

## Conventions when editing

- Match the existing code style — plain ES modules, no framework, no TypeScript,
  no build step beyond esbuild bundling.
- LLM endpoint/model/effort live in static class constants; the two call sites
  (`callLLM`, `callLLMWithTools`) must not drift. Change the constant.
- Provider-specific wire details belong in `src/llm-providers.js`, not in the
  call sites. `callLLMWithTools` always RETURNS a Chat-Completions-shaped
  object, whichever provider served it, so `runNativeToolLoop` and the stored
  `chat_history` stay provider-neutral and switching mid-conversation works.
- Forensic D1 writes are deliberately fire-and-forget — never make the WS event
  handler `await` a D1 write. Failures increment `_d1WriteFailures`.
- `executeNativeTool` and `handleTool` are the two dispatchers. A new chat tool
  needs: a schema in `agent-tools.js`, a `case` in `executeNativeTool`, and
  (if it mutates state) membership in `NATIVE_ACTION_TOOL_NAMES`.
- The chat system prompt is large and load-bearing. Behavioral rules
  (TRUTHFULNESS, ACTION CONFIRMATION, TOOL ERROR HANDLING, COMMITMENT RULE) are
  there for real past failures — don't trim them casually.
- Timestamps in agent-facing text must be US Central. Tool results pass through
  `_reformatToolResultTimestamps`; the prompt forbids the model emitting ISO/UTC.
- After a DO-side change, you must bump the class name + add a migration (see
  gotcha #1) or the change will not go live.

---

## Bug capture & iteration workflow

Bugs found during use are captured conversationally — the user says "that's a
bug" / "log this as broken" and the chat agent calls `report_bug`, which stores
a structured entry (description + recent chat turns + recent `ai_log` + cited
entity state) in DO storage under per-id keys.

At iteration time: pull `/admin/bugs?format=markdown`, prepend to `BUGS.md`,
commit, then `POST /admin/bugs/clear`. Fix one at a time; after fixing, strike
through the `BUGS.md` heading and add `Fixed: <commit-sha>` — don't delete
entries, the history is the audit trail.
