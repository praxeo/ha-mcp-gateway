# HA-MCP-Gateway

A Cloudflare Worker plus Durable Object that connects a Home Assistant smart
home to LLMs. It keeps a persistent WebSocket open to Home Assistant, mirrors
live entity state in memory, writes every meaningful event to a queryable D1
log, and exposes the whole surface as an MCP server for clients like Claude
Desktop and Claude Code.

There is also a built-in chat agent — "Ranger" — reachable at a `/chat` web UI
and through the `ai_chat` MCP tool. It runs GLM 5.2 on Fireworks with reasoning
enabled and a native tool-calling loop. The model is configurable at runtime
(see [LLM configuration](#llm-configuration)). Imperative garage/bay-door
commands skip the LLM entirely through a sub-500ms fast path.

This is a single-household deployment: the author's house. There is no staging
environment, and a push to `main` deploys to the live house. The rest of this
file is the working reference for the code. It starts with how the architecture
ended up this shape, because that history explains most of the current design.

---

## Background: the autonomous monitor

The first version was more ambitious. An LLM ran every 60 seconds with the full
tool surface: it drained a queue of state changes filtered down to the
interesting ones, pulled context from the vector index, and decided whether to
act, notify, save an observation, or do nothing. The MCP intro message
advertised it with lines like *"I locked the back porch deadbolt at 4:49 AM
because it was unsecured and the house was occupied."* The premise was that a
model watching the house around the clock would catch things a person misses.

It didn't work out. Over about a month it produced no proactive intervention
worth keeping. Asked directly what it had done, it was candid about the gaps:

- It saw aux heat spike above 5000W and chose not to flag it, because the spike
  was brief.
- It logged patterns like the basement porch camera triggering eight times at
  1:38 AM across four weeks, but never raised them in chat.
- It knew it was supposed to surface those patterns and couldn't work out how to
  bring them up unprompted.

When it did act, the service calls were either unnecessary (annoying) or wrong
(occasionally unsafe). The useful-and-correct case essentially never happened,
so on balance the monitor cost more than it returned.

The obvious fix was a better model, but that wasn't the problem. The model
reasoned fine; it had the wrong job. A streaming agent sees events one at a
time, and you don't notice that the basement porch camera fires at 1:38 AM by
looking at a single event — you notice it across thirty days of them. The same
model, asked "what happened in the last 24 hours?" in chat, gives a clean
narrative and surfaces the right anomalies. Asked "should I interrupt John?" on
a 60-second tick, the answer is no almost every time.

The data the monitor was meant to surface already existed: live state in the
cache, history in Home Assistant, semantics in the vector index. What was
missing wasn't a daemon volunteering things — it was a cheap way to ask.

There was also a concrete reason to stop. My first kid is due in October, and
"the AI occasionally does something dangerous on its own" is not something I
wanted running with a baby in the house.

So the monitor came out. Now every HA state change, automation fire, and service
call lands in D1 — three tables, with HA's context-chain IDs preserved so
cause-and-effect queries work, on a 90-day rolling window. On WebSocket
reconnect the worker pulls any missed state changes from HA's history API,
idempotent against a unique index so a retry can't double-insert.

The chat agent got three tools to read that log: `query_state_history`,
`query_automation_runs`, and `query_causal_chain` (which walks parent/child
context links across all three tables). The same helpers back both the chat
dispatcher and the MCP surface, so Claude Code can reach everything the chat
agent can. A `FORENSIC MEMORY` block in the system prompt tells the model the
log is its always-on memory and to query it instead of guessing.

The cleanup removed about 720 lines from `ha-websocket.js` plus seven
now-pointless MCP tools (`ai_enable`, `ai_disable`, `ai_status`, `ai_trigger`,
`ai_clear_log`, `ai_clear_memory`, `ai_clear_chat`). The bundle dropped from
~390KB to ~352KB, and `alarm()` collapsed to a WebSocket ping/pong with a
mandatory reschedule. (It later picked up one more job — firing due scheduled
actions; see [Scheduler](#scheduler).)

Gone for good: the autonomous prompt, the `runAIAgent` paths, the event queue,
the burst filters, the synthetic heartbeat, and the `aiEnabled` flag with its
toggle endpoints. Git history keeps them if the experiment is ever worth
revisiting with a different hypothesis. What stayed is what paid for itself: the
persistent WebSocket and `stateCache`, the hibernation snapshot, the chat path
and its native tool loop, the vector index, the cover fast path, `save_memory`
and `save_observation` (now chat-only, gated on an explicit request), the
`ai_log` and `observations` tables, the crons, and the rest of the MCP surface.

---

## Models

The chat agent has been through a lot of models for a one-house deployment.
Early on it ran Gemma 4 MoE on Cloudflare Workers AI — local-ish, free, fast at
small scale, but its tool-call adherence was poor; it would call services with
the wrong arguments. Kimi K2.6 via Moonshot reasoned better but drifted on
multi-step chains. NVIDIA's Nemotron Super 120B looked strong on paper and was
awkward against the OpenAI tool-call format.

gpt-oss-120b on Groq held the job for a few versions (V13–V15). Inference was
fast, but it couldn't keep a multi-step tool chain together — fabricated entity
states, reasoning paralysis, falling back to synthesis too early. Those failures
only surface once the agent has to chain three or four calls without losing the
thread, which is most of the interesting work here.

V16 reverted to MiniMax-M2.7, which handled the long chain better. V17–V26 ran
DeepSeek V4 Flash on Fireworks with `reasoning_effort: "high"` — cheaper than
MiniMax and better at the chain. V27 moved to MiniMax M3, and the reasoning
control moved from `reasoning_effort` to the `thinking: { type: "enabled" }`
toggle (Fireworks rejects sending both). V29 switched to Qwen 3.7 Plus, still on
the `thinking` toggle.

The current default is **GLM 5.2 on Fireworks** with reasoning enabled. GLM 5.2
drives reasoning through `reasoning_effort` rather than the `thinking` toggle, so
the reasoning mode moved back to `"effort"` (`"high"` maps to its High tier).
It's strong on the multi-step tool chain.

Since V29 the model is no longer a code-level decision: endpoint, model, and
reasoning mode resolve at runtime (DO storage override → env vars → baked-in
defaults), so a swap no longer needs the persistent-WebSocket class rename
described in [Operational notes](#operational-notes). See
[LLM configuration](#llm-configuration). Every model still fumbles edge cases —
V22 added a deterministic guard against unsupported color descriptors on
`light.turn_on`, V28 added a coalescer for flat tool-call arguments — but those
get fixed with source-level guards rather than left to the model.

---

## LLM configuration

The chat LLM has been runtime-configurable since V29. `resolveLLMConfig` in
`ha-websocket.js` resolves the effective config at call time from three layers,
highest precedence first:

1. **DO storage override** — the `llm_config` key, set live via
   `/admin/llm-config`. No deploy, no class rename.
2. **Environment variables** — `LLM_ENDPOINT`, `LLM_MODEL`,
   `LLM_REASONING_MODE`, `LLM_REASONING_EFFORT` (picked up by a fresh isolate).
3. **Baked-in defaults** — static class constants
   (`HAWebSocketV29._defaultLLMConfig()`): endpoint
   `api.fireworks.ai/.../chat/completions`, model
   `accounts/fireworks/models/glm-5p2`, reasoning mode `effort` at `high`.

Both call sites (`callLLM`, `callLLMWithTools`) go through `_getLLMConfig()`, so
they can't drift apart. `applyReasoningToBody` applies the reasoning setting:
`thinking` mode sends `thinking: { type: "enabled" }`, `effort` sends
`reasoning_effort: <effort>`, `none` sends neither. Fireworks rejects `thinking`
and `reasoning_effort` together, so the helper emits at most one. Reasoning comes
back in `reasoning_content` either way, so extraction, the SSE stream, and the
prior-turn re-feed don't depend on which mode is active.

```text
GET  /admin/llm-config                       # effective + stored + env + defaults
POST /admin/llm-config  {"model":"accounts/fireworks/models/minimax-m3",
                         "reasoning_mode":"thinking"}   # set override (merged)
POST /admin/llm-config  {"reset":true}       # clear override → back to env/defaults
```

`sanitizeLLMConfigPatch` validates a write (only `endpoint`, `model`,
`reasoning_mode`, `reasoning_effort`; enums enforced) and updates the in-process
cache, so even the pinned live isolate honors the change on its next call. Any
OpenAI-compatible Fireworks model works; the API key is the `FIREWORKS_API_KEY`
secret. This is the fast rollback path for a bad model swap, with no redeploy.

---

## Architecture

```
User (web / Claude Desktop / Claude Code / WhatsApp[dormant])
        │
        ▼
Cloudflare Worker (worker.js)         ◀── /mcp, /chat, /transcribe, /refresh,
   │                                       /health, /twilio[dormant],
   │                                       /admin/bugs, /admin/bugs/clear,
   │                                       /admin/recent_activity,
   │                                       /admin/rebuild-knowledge,
   │                                       /admin/index-stats,
   │                                       /admin/cleanup-stale-vectors,
   │                                       /admin/reindex-observations,
   │                                       /admin/version, /admin/llm-config
   │  routing, MCP handler (82-tool surface), CHAT_HTML, ElevenLabs STT
   │  proxy, multi-kind backfill, two crons (cache prewarm; daily resync
   │  + ai_log + forensic-log retention)
   ▼
Durable Object: HAWebSocketV29 (ha-websocket.js)
   │  singleton "ha-websocket-singleton" — owns the persistent WS
   │  in-memory stateCache, hibernation snapshot, cover fast path,
   │  HOUSE_STATE_SNAPSHOT builder, chat tool loop, forensic D1 writers,
   │  reconnect backfill, ephemeral scheduler, per-channel chat_history
   ├──► Home Assistant WebSocket (port 8123, JWT auth)
   │       subscribes to: state_changed, entity_registry_updated,
   │                      device_registry_updated, automation_triggered,
   │                      call_service
   ├──► Cloudflare D1 "ha_db"                (env.DB)
   │       tables: ai_log, observations, state_changes, automation_runs,
   │               service_calls   (bugs live in DO storage — see below)
   ├──► Cloudflare Vectorize "ha-knowledge"  (env.KNOWLEDGE)
   ├──► Cloudflare Workers AI                (env.AI, bge-large-en-v1.5)
   ├──► GLM 5.2 on Fireworks at api.fireworks.ai (OpenAI-compatible,
   │       runtime-configurable model/endpoint/reasoning)
   └──► ElevenLabs Scribe at api.elevenlabs.io       (speech-to-text)
```

The layers, bottom to top:

1. **Physical devices** — Zigbee, Z-Wave, Wi-Fi plugs, ESPHome, Roku, Ecobee,
   Tesla.
2. **Home Assistant** — the open-source server that owns every integration,
   automation, scene, script, and recorder. WebSocket API on port 8123.
3. **HA Green** — a Nabu Casa appliance running HA OS on the local LAN,
   cloud-relayed via Nabu Casa for remote access.
4. **ha-mcp-gateway (this repo)** — the Worker and DO. It turns natural language
   into HA service calls and answers historical questions from the forensic log.
   Auth is Cloudflare Access JWT for browser users and a long-lived HA token in
   a worker secret.
5. **Vectorize knowledge index (`ha-knowledge`)** — see
   [Knowledge index](#knowledge-index-ha-knowledge).
6. **Cloudflare D1 (`ha_db`)** — the relational store. `ai_log` keeps
   chat/action history, `observations` keeps tagged hypotheses, and
   `state_changes` / `automation_runs` / `service_calls` are the
   [forensic log](#forensic-event-log).
7. **GLM 5.2 (Fireworks)** — chat completions plus native tool calls, run with
   reasoning enabled via `reasoning_effort: "high"` (GLM 5.2's High tier; it
   does not use the `thinking` toggle). Model, endpoint, and reasoning mode are
   runtime-configurable (see [LLM configuration](#llm-configuration)). The DO
   drives the loop, not the model. Each call has a 45s `AbortController` timeout.
8. **ElevenLabs Scribe** — `scribe_v1` speech-to-text. The Worker proxies the
   chat UI's audio blobs through `/transcribe`.
9. **Frontends** — Claude Desktop and Claude Code (MCP), and the `/chat` HTML UI
   served by the Worker (SSE streaming, hero mic button, collapsible reasoning
   panel). Twilio (WhatsApp) is currently dormant.

---

## Repo layout

| File | Role |
|---|---|
| `src/worker.js` | Cloudflare Worker entry. Owns the MCP handler (`TOOLS` list — 82 tools — plus `handleTool` dispatch, `getAgentToolset` role filter, `DANGEROUS_TOOLS` set), HTTP routes including `/admin/recent_activity`, the embedded `CHAT_HTML` UI, the ElevenLabs STT proxy, the `formatBugsAsMarkdown` helper, KV cache helpers, the per-kind `build*Docs` builders, the multi-kind `backfillKnowledge`, and the `scheduled()` cron handler (`prewarmCache`, `dailyKnowledgeResync`, `dailyAiLogRetention`, `dailyForensicLogRetention`). |
| `src/ha-websocket.js` | Durable Object class `HAWebSocketV29` (renamed forward through the persistent-WS refresh dance — see [Operational notes](#operational-notes)). Holds the persistent HA WebSocket and in-memory `stateCache`. Subscribes to five HA event types: `state_changed`, `entity_registry_updated`, `device_registry_updated`, `automation_triggered`, `call_service`. Writes every meaningful event fire-and-forget to D1 via `_writeStateChangeToD1` / `_writeAutomationRunToD1` / `_writeServiceCallToD1`, gated by `_shouldLogStateChange` for the state path (Zigbee/network-noise denylist). Reconnect backfill from HA history via `_backfillStateChangesFromHA`. Chat system prompt is split into `getStaticChatSystemPrompt` (cacheable) + `buildDynamicContext` (per-turn). One execution path: `chatWithAgentNative` (user-driven, SSE), preceded by `_tryDeterministicFastPath` for cover commands. Native tool loop in `runNativeToolLoop`, action executor in `executeAIAction`, tool dispatcher in `executeNativeTool`. `alarm()` runs WS keepalive (ping/pong, reconnect on no-pong, mandatory reschedule) and fires due scheduled actions via `_fireDueScheduledActions`. |
| `src/agent-tools.js` | OpenAI-format tool schemas passed to the chat model. `ACTION_TOOLS` (6: `call_service`, `ai_send_notification`, `save_memory`, `save_observation`, `schedule_action`, `cancel_scheduled_action`) + `READ_TOOLS` (13: `get_state`, `get_logbook`, `render_template`, `vector_search`, `get_house_topology`, `get_automation_config`, `report_bug`, `query_state_history`, `query_automation_runs`, `query_causal_chain`, `get_nws_weather`, `get_nws_discussion`, `list_scheduled_actions`) = `NATIVE_AGENT_TOOLS`, 19 total. `CHAT_ALLOWED_TOOL_NAMES` includes all 19 — the chat agent has the full native surface. `NATIVE_ACTION_TOOL_NAMES` marks the 6 side-effecting tools (logged as actions). |
| `src/vectorize-schema.js` | Canonical metadata schema, `vectorIdFor(kind, refId)`, FNV-1a hash, `topicTagFor(text)`, per-kind embed-text builders, `isNoisyEntity` / `isNoisySwitch` / `isNoisyService` / `entityCategoryFor` helpers, `buildMetadata` (lowercase-coerces `area`, string-coerces `is_noisy`, propagates `created_at`). |
| `migrations/0001_d1_indexes_and_columns.sql` | Indexes on the legacy `ai_log` / `observations` / `bugs` tables. Also adds the nullable `data` JSON column to `observations`. |
| `migrations/0002_forensic_log.sql` | Creates `state_changes`, `automation_runs`, `service_calls` and their context-chain indexes. |
| `migrations/0003_state_changes_dedup.sql` | De-dupes `state_changes` and adds a unique index on `(entity_id, fired_at_ms, new_state)` so reconnect backfill's `INSERT OR IGNORE` is idempotent. |
| `wrangler.toml` | Bindings (HA_WS, HA_CACHE, KNOWLEDGE, AI, DB, CF_VERSION_METADATA), build command (esbuild bundles `src/worker.js` → `dist/worker.js`), cron triggers (`* * * * *` cache prewarm, `30 8 * * *` daily resync + retention), DO migrations v1→v29 (`renamed_classes` chain). `compatibility_date = "2026-05-09"`. |
| `dist/worker.js` | esbuild output. **Build artifact — never edit.** |
| `.dev.vars` | Local-dev secrets. Never committed. |

---

## Forensic event log

The forensic log is what lets the chat agent answer questions about the house's
past. Every meaningful event lands in D1 within seconds, with the HA context
chain preserved so cause-and-effect queries are tractable.

### Tables

```sql
state_changes (id, entity_id, friendly_name, domain, old_state, new_state,
               attributes_json, fired_at_ms, fired_at_iso, fired_at_central,
               context_id, context_parent_id, context_user_id, source)

automation_runs (id, automation_id, automation_name, fired_at_ms,
                 fired_at_iso, fired_at_central, trigger_entity_id,
                 trigger_description, context_id, context_parent_id, result)

service_calls (id, domain, service, service_data_json, target_entity_ids,
               fired_at_ms, fired_at_iso, fired_at_central,
               context_id, context_parent_id, context_user_id)
```

All three tables have time, context, and table-specific indexes.
`state_changes` also carries a unique `(entity_id, fired_at_ms, new_state)`
index for backfill idempotency. Schema lives in
`migrations/0002_forensic_log.sql` and `migrations/0003_state_changes_dedup.sql`.

### What gets written, when

| HA event             | Forensic table     | Filter             |
|----------------------|--------------------|--------------------|
| `state_changed`      | `state_changes`    | `_shouldLogStateChange`: domain skip (`image.*` — timestamp churn); suffix denylist (`_lqi`, `_signal_strength`, `_rssi`, `_bssid`, `_ssid`, `_last_update_trigger`, `_audio_output`, `_link_quality` — trailing `_<digits>` stripped first); `signal_strength` device-class skip; unit skip (`dBm`/`dB`/`lqi`); hard denylist (`*_summation_delivered`, `*_summation_received`, roborock `*_cleaning_area`/`*_cleaning_time`/`*_cleaning_progress`/`*_filter_time_left`/`*_main_brush_time_left`/`*_side_brush_time_left`/`*_dock_strainer_time_left`/`*_sensor_dirty_time_left`); numeric deadband (power 50W, energy 0.01kWh, voltage 2V, humidity 2%, temperature 0.5°, illuminance 10% relative) |
| `automation_triggered` | `automation_runs` | none — every fire logged |
| `call_service`       | `service_calls`    | none — every call logged |

The filter is deliberately more permissive than the old monitor's, which was
tuned to avoid waking the LLM. For forensic use the cost of an extra row is
trivial; the cost of a missing row is a question you can't answer.

Writes are fire-and-forget — the WS handler never blocks on D1. Failures
increment `_d1WriteFailures` (exposed via the DO `/status` route and the
`cache_status` MCP tool) so silent loss is visible.

### Reconnect backfill

On every successful HA WS auth-ok, the DO reads `last_event_seen_ms` from its
storage. If it's set and the gap is under an hour, it pulls
`/api/history/period/{iso}` from HA and inserts the missed state changes into
`state_changes` with `source='backfill'` and `context_id=null` (HA history
doesn't preserve context). Writes use `INSERT OR IGNORE` against the unique
index on `(entity_id, fired_at_ms, new_state)`, so backfill is idempotent.
Service calls and automation fires are not backfilled — HA's REST API doesn't
expose them reliably, and brief gaps in those tables on reconnect are
acceptable.

### Retention

90-day rolling window for all three forensic tables. `dailyForensicLogRetention`
runs at 03:30 CDT (08:30 UTC) alongside `dailyAiLogRetention` and
`dailyKnowledgeResync`.

### Query tools

Three tools surface the log to the chat agent and to MCP clients:

- **`query_state_history`** — filtered SELECT over `state_changes`. Filters:
  `entity_id`, `entity_id_like`, `domain`, `new_state`, `since` / `until`
  (ISO 8601 with offset or `NOW-Nh` / `NOW-Nm` / `NOW-Nd` relative). Default
  window is the last 24 hours. `limit` defaults to 50, capped at 500.
- **`query_automation_runs`** — same shape over `automation_runs`. Filters:
  `automation_id`, `automation_id_like`, `trigger_entity_id`, `since` / `until`.
- **`query_causal_chain`** — given a `context_id`, walks parent/child links
  across all three tables. `direction: forward | backward | both`, `depth: 1-10`
  (default 5). It's an iterative walker, not a single recursive CTE — each pass
  is one D1 query, depth-bounded, results de-duped and sorted chronologically.

Single helpers (`_executeQueryStateHistory`, `_executeQueryAutomationRuns`,
`_executeQueryCausalChain`) back both the native chat dispatcher (via
`executeNativeTool`) and the MCP endpoints, so there's no duplication.

### Eyeball endpoint

`GET /admin/recent_activity?hours=N` (default 1, max 720) returns a plain-text
dump of the last N hours UNION'd across all three tables:

```
[May 12, 2026, 2:32 PM] state_change   input_boolean.basement_work_mode      off -> on
[May 12, 2026, 2:32 PM] service_call   input_boolean.turn_on                 input_boolean.basement_work_mode
```

`?format=json` returns structured rows. Useful for verifying data flow without
invoking the chat agent.

---

## Knowledge index (`ha-knowledge`)

Cloudflare Vectorize, 1024-dim, cosine, model `@cf/baai/bge-large-en-v1.5`,
**pooling `cls`** (it must match at backfill and query time — mismatched pooling
gives near-random rankings).

### Metadata schema

| Field             | Type   | Filterable? | Notes                                    |
|-------------------|--------|-------------|------------------------------------------|
| `kind`            | string | ✓           | `entity` `automation` `script` `scene` `area` `device` `service` `memory` `observation` |
| `ref_id`          | string |             | entity_id, automation HA-internal id, `<domain>.<service>`, `topicTagFor(text)` for observations, `fnv1aHex(text)` for memories |
| `friendly_name`   | string |             | Display label (first 80 chars for memory/observation) |
| `domain`          | string | ✓           | Entity domain for entity kind, kind name otherwise |
| `area`            | string | ✓           | Resolved area name, "" if none |
| `entity_category` | string | ✓           | `primary` `diagnostic` `config` (entity-only) |
| `is_noisy`        | string | ✓           | `"true"` / `"false"` literals (string-typed index). `device_class: battery` is exempted. |
| `topic_tag`       | string | ✓           | Bracketed prefix for observations (`"[topic-name]"`). `retrieveKnowledge` normalizes — callers can pass `"foo"` or `"[foo]"`. |
| `hash`            | string |             | fnv1a of embed text — change detection |
| `created_at`      | string |             | ISO timestamp on memory/observation — drives time-decay scoring |
| `device_class`    | string |             | Entity-only extra; not filterable |

Default `vector_search` filters out `is_noisy: "true"` records. Pass
`include_noisy: true` to include them.

### Vector ID format

`{kind}:{ref_id}` truncated to 64 bytes with an `_<fnv1aHex>` suffix when the
prefixed form would exceed the cap. `vectorIdFor(kind, refId)` is the single
source of truth. For observations, `ref_id` is `topicTagFor(text)`, locking
Vectorize identity to the D1 primary key.

### Refresh strategy

| Kind         | Refresh trigger                                                 |
|--------------|-----------------------------------------------------------------|
| entity       | event-driven (`entity_registry_updated`)                        |
| device       | event-driven (`device_registry_updated`) + nightly cron resync  |
| memory       | write-through (`executeAIAction.save_memory`)                   |
| observation  | write-through (`executeAIAction.save_observation` to D1)        |
| automation   | nightly cron                                                    |
| script       | nightly cron                                                    |
| area         | nightly cron                                                    |
| service      | nightly cron                                                    |
| scene        | manual rebuild only — single scene in this household, dropped from the nightly resync |

`dailyKnowledgeResync` resyncs `automation`, `script`, `area`, `device`,
`service` — the slow-changing kinds not already covered by event-driven or
write-through updates. Hash-based skip means most docs land in the "skipped"
column on a typical run.

### Endpoints

- `POST /admin/rebuild-knowledge?force=1&kinds=a,b,c` — multi-kind backfill.
- `GET /admin/index-stats` — last 20 backfill summaries.
- `POST /admin/cleanup-stale-vectors` — one-shot legacy cleanup (idempotent).
- `POST /admin/reindex-observations` — enumerates observation vectors via a
  multi-probe similarity query (topK=100 per probe, 4 probes ≈ 400 IDs), deletes
  anything not in the canonical `topicTagFor`-derived keep-set, then
  force-rebuilds the observation kind. Idempotent; re-run if the index ever holds
  more than 400 observation vectors and a single pass misses some.
- DO `POST /vector_search` — internal endpoint backing the `vector_search` tool.

### Index recreation (one-time, before deploy)

```powershell
wrangler vectorize create ha-knowledge --dimensions=1024 --metric=cosine

wrangler vectorize create-metadata-index ha-knowledge --property-name=kind --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=domain --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=area --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=entity_category --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=is_noisy --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=topic_tag --type=string
```

Metadata indexes are immutable, so declare all six at creation time.

---

## HOUSE_STATE_SNAPSHOT

`_buildHouseStateSnapshot()` emits a small text block read directly from the
in-memory `stateCache`. It groups a curated set of entity IDs into seven blocks
— **LOCKS** (4), **COVERS** (3 garage/basement bay doors), **CLIMATE** (2
thermostats with inline `current/target/hvac_action`), **PRESENCE** (2 person
trackers), **POWER** (whole-home demand), **EXTERIOR DOORS / CONTACT SENSORS**
(4), and **TESLA MODEL Y** (8 EV status entities) — and prints
`<entity_id> (<friendly_name>): <state>`, with cover position inline when
present.

It's gated, because most turns don't need it. `buildDynamicContext` injects the
snapshot only when:

- the user's message matches `HOUSE_STATUS_TRIGGER_RE` (aggregate-state terms
  like "house", "status", "secure", "everything"; security terms "alarm",
  "armed", "intrusion"; presence terms "home", "away", "gone", "left", "back",
  "outside"; vehicle terms "tesla", "car", "vehicle"; plus the household first
  names "John" and "Sabrina"), or
- vector retrieval surfaced no entity scoring ≥ 0.65 (an open-ended question
  with no specific target), or
- defensively, when the caller passed no message.

It earns its place three ways:

- **Authoritative for the listed entities.** The prompt tells the model to trust
  the snapshot — it's regenerated every turn from live cache. This is what makes
  the TRUTHFULNESS rule enforceable.
- **Aggregation guard.** Claims like "everything secure" are forbidden unless
  every asserted entity is in the snapshot or the agent called `get_state` on it
  this turn.
- **Fast-path no-op guard.** The cover fast path checks the snapshot — if the
  target is already in the requested state, it replies "already closed" without
  firing a service call.

Anything not in the snapshot is fair game for `get_state`, `vector_search`, or
the forensic query tools.

---

## Native tool loop

The chat model is given OpenAI-format tool schemas (`NATIVE_AGENT_TOOLS` in
`agent-tools.js`, 19 tools). The DO drives the loop: send messages, read
`tool_calls`, dispatch via `executeNativeTool`, push tool results back, repeat
until the model emits no `tool_calls`. `callLLMWithTools` posts to Fireworks
(`temperature: 0`) using the runtime-resolved model and reasoning mode — by
default `accounts/fireworks/models/glm-5p2` with `reasoning_effort: "high"` (see
[LLM configuration](#llm-configuration)) — with a 45s `AbortController` timeout.

Caps:

- **Chat path** (`chatWithAgentNative`): `runNativeToolLoop` is invoked with
  `maxIterations: 6`, `maxTokens: 4096`, `hallucinationGuard: true`. The tool
  set is the full 19-tool surface filtered through `CHAT_ALLOWED_TOOL_NAMES` (a
  defensive no-op now that all 19 are allowed; kept for future flexibility).
  `runNativeToolLoop`'s own defaults — `maxIterations: 8`, `maxTokens: 16384` —
  apply to any other caller.
- **Synthesis fallback on overflow** — at the iteration ceiling the loop pushes a
  "stop using tools, compose now" message and re-calls the model with
  `tools: []`.
- **Post-tool fast-return (V11)** — when the model fires a *single*
  `call_service` whose `domain.service` is in a conservative whitelist
  (`light.turn_on/off/toggle`, `switch.turn_on/off/toggle`, `lock.lock/unlock`,
  `scene.turn_on`), the call succeeded, and the model emitted no accompanying
  text, the loop synthesizes `"Done — <friendly> <verb>."` server-side and
  returns without a second model call. Cover, climate, media, scripts, `save_*`,
  and `report_bug` keep the LLM wrap-up — their replies benefit from context.
- **Hallucination guard** — if the model's text claims an action ("I'm closing
  the garage", "Done — locked") but it emitted no `tool_call`, the loop logs
  `action_hallucination` and forces a retry.

Tool surface (19 total — the chat agent's native set):

| Tool | Side effect | Notes |
|---|---|---|
| `call_service` | yes | Any HA service. `return_response: true` for data-returning services. |
| `ai_send_notification` | yes | `notify.notify` + writes a `notification` entry to `ai_log`. |
| `save_memory` | yes | Append to DO storage (100 FIFO, `PINNED:` prefix exempt). Embed + upsert. Chat-prompt rule: only on explicit user request. |
| `save_observation` | yes | INSERT OR REPLACE into D1 `observations` keyed on `topicTagFor(text)`. Embed + upsert. Chat-prompt rule: only on explicit user request. |
| `schedule_action` | yes | One-shot HA service call fired once after a delay, then auto-deleted. ~60s granularity. See [Scheduler](#scheduler). |
| `cancel_scheduled_action` | yes | Cancel a pending scheduled action by `task_id`. |
| `get_state` | no | stateCache hit; `force_refresh: true` fetches via REST `GET /api/states/{id}` (single entity, updates cache); `force_refresh: "bulk"` repopulates the entire cache via WS `get_states`. |
| `get_logbook` | no | HA `/api/logbook`. The schema requires an explicit TZ offset (`-05:00` for CDT). |
| `render_template` | no | HA `/api/template`. Jinja2 evaluation. |
| `vector_search` | no | DO `/vector_search` → `retrieveKnowledge`. Multi-kind metadata-filtered semantic search. Args: `query`, `kinds` (REQUIRED), `domain`, `area`, `topic_tag`, `min_score` (default 0.50), `top_k` (default 15, max 50), `include_noisy`. |
| `get_house_topology` | no | Zero-arg. Returns the full room-by-room layout (`_getHouseTopologyText()`), moved out of the default prompt in V10. |
| `get_automation_config` | no | HA `/api/config/automation/config/{id}`. Returns the trigger/condition/action body. |
| `report_bug` | log-only | User-flagged issue capture to DO `bugs` storage (per-id keys, FIFO 200). |
| `query_state_history` | no | Filtered SELECT over `state_changes`. See [Forensic event log](#forensic-event-log). |
| `query_automation_runs` | no | Filtered SELECT over `automation_runs`. |
| `query_causal_chain` | no | Iterative parent/child walker across all three forensic tables. |
| `get_nws_weather` | no | Official NWS forecast for the home location (alerts, hourly, 7-day). ~1h cache. |
| `get_nws_discussion` | no | Latest NWS Area Forecast Discussion (the meteorologist narrative). ~4h cache. |
| `list_scheduled_actions` | no | List pending scheduled actions, soonest-first. See [Scheduler](#scheduler). |

Action tools are dispatched through `executeAIAction` with
`source="native_loop"` so `ai_log` records who did what (`legacy_json` /
`native_loop` / `tool_call` / `fast_path`).

Tool messages persisted into `chat_history` are truncated at 4 KB
(`TOOL_CONTENT_CAP`) so long results don't bloat the byte budget across turns.
Tool results run through `_reformatToolResultTimestamps` before being pushed
back, converting ISO/UTC timestamps to Central.

### System prompt structure

V13 split the chat system prompt in two so the leading prefix caches cleanly
against Fireworks' passive prefix cache.

**`getStaticChatSystemPrompt()`** — 100% static, byte-identical on every request
and channel, sent as the `system` message. Sections, in order:

- `getAgentContext()` — IDENTITY (the agent is "Ranger"), PERSONALITY,
  HOUSEHOLD, LAYOUT NOTE, LOCK MAP, GARAGE/BASEMENT BAY DOORS, KEY DEVICES.
- "Be concise / take action" framing.
- TOOLS — notes beyond the attached schemas.
- COMMITMENT RULE (don't claim to have done something you didn't tool-call).
- TOOL ERROR HANDLING — NO CONFABULATION (an `error`-shaped tool result means
  the call failed; surface it verbatim, never fabricate success).
- BUG REPORTS (when to call `report_bug`; check the result before replying).
- SAVING MEMORIES / OBSERVATIONS (chat-path rule: explicit user request only).
- ACTION CONFIRMATION (user-initiated commands act immediately; agent-initiated
  proposals require an explicit affirmative — emoji, "sure", silence, and topic
  changes do not count).
- QUICK FACTS (thermostat zone disambiguation, smoke/CO note, the Central-time
  timestamp rule, the Tesla Model Y control cheat-sheet).
- RETRIEVAL DISCIPLINE (vector_search-first when the entity isn't visible).
- FORENSIC MEMORY (the agent's always-on log — points at the three query tools).
- TRUTHFULNESS — STATE CLAIMS (no state assertion without verification this turn).

**`buildDynamicContext(ctx)`** — every per-request value, built once per turn and
prepended to the trailing user message (so it doesn't bust the static prefix).
Order: "answering a chat from X", GATEWAY HEALTH (degraded-only), climate
preamble (when HVAC keywords are detected), HOUSE_STATE_SNAPSHOT (gated — see
above), UNIFIED TIMELINE (recent non-chat `ai_log` events — actions, state
changes, notifications, memory/observation writes — last hour / 15 events,
Central time), the semantic top-K blocks (RELEVANT MEMORIES / OBSERVATIONS /
AUTOMATIONS, score ≥ 0.65), and RELEVANT ENTITIES (top-K from the live state
cache).

The trailing user turn is `${dynamicContext}\n\nCurrent time: ${now}\n\n${message}`.

### Cover-command fast path

`_tryDeterministicFastPath(message)` runs at the top of `chatWithAgentNative`.
It short-circuits to a direct `cover.open_cover` or `cover.close_cover` service
call when:

1. Open-verb XOR close-verb (`open|raise|lift` vs `close|shut|lower|drop`).
2. Not a question (a trailing `?` or sentence-initial state verb bails).
3. The target entity matches an explicit phrase or a bare-noun fallback that
   survives the disqualifier regex.
4. The cover is not already in the target state (`stateCache` no-op guard).

On match: explicit `open_cover` / `close_cover` (never `toggle`), an `ai_log`
entry tagged `source: "fast_path"`, the SSE `reply` event emitted *before*
bookkeeping (V12 latency reorder), and history persisted. Returns
`{ reply, actions_taken, fast_path: true }`. Sub-500ms typical.

---

## Scheduler

`schedule_action`, `list_scheduled_actions`, and `cancel_scheduled_action` let
the chat agent set up one-shot, delayed service calls — "turn the drop lights
off in an hour", "set the thermostat back in 30 minutes". A pending task lives in
DO storage under the `scheduled:<uuid>` namespace (not in HA's automation list)
and is deleted once it fires. Granularity is the 60-second `alarm()` tick, which
calls `_fireDueScheduledActions` for anything past due.

Two rules keep it safe:

- **Delete before fire.** A task is removed from storage before its service call
  runs, so a crash mid-fire loses the task rather than firing it twice — the
  right trade for non-idempotent services like `toggle`.
- **WS-up guard.** The tick skips firing when the HA WebSocket is down, so a
  transient outage doesn't quietly drop tasks.

Compound requests ("turn X on for an hour", "AC down two degrees then back up")
are handled by the agent in a single turn: it calls `call_service` for the
immediate change and `schedule_action` for the reversal, snapshotting any "from
the current value" arithmetic into absolute values at schedule time.

The implementation is `_scheduleAction` / `_listScheduledActions` /
`_cancelScheduledAction` / `_fireDueScheduledActions` on the DO, dispatched
through `executeNativeTool` for the chat agent and through the DO's internal
HTTP router for the MCP surface.

---

## MCP server surface

The Worker exposes a JSON-RPC 2.0 MCP endpoint at `POST /mcp` (and `/`).
`handleMCP` supports `initialize`, `notifications/initialized`, `tools/list`,
`tools/call`, and `ping`; `serverInfo` reports version `5.1.0`.

This is a separate, much broader surface than the chat agent's 19-tool native
set. `tools/list` returns `getAgentToolset("mcp_external")` — the full **82-tool
`TOOLS` array** in `worker.js`: complete HA control (entities, devices, areas,
floors, labels, automations, scripts, scenes, dashboards, calendars, todo lists,
input helpers, services), plus the agent-state tools (`save_memory`,
`save_observation`, `ai_send_notification`, `ai_log`, `ai_memory`,
`ai_observations`, `vector_search`), the three forensic query tools, the three
scheduler tools, `report_bug`, and `ai_chat` (which routes a message into the
chat agent). `handleTool` is the dispatcher; many tools delegate to the DO over
HTTP, and the forensic query tools share single helper implementations with the
chat agent's `executeNativeTool`.

`getAgentToolset` filters out a `DANGEROUS_TOOLS` set (12 tools — `restart_ha`,
`create/update/delete_automation`, `bulk_disable/enable_entities`,
`disable/enable_entity`, `update_entity_registry`, `update_dashboard_config`,
`clear_cache`, `fire_event`) for non-external roles. External MCP clients get the
full set; Cloudflare Access sits in front of `/mcp` regardless, and
`MCP_AUTH_TOKEN` adds an optional bearer check.

Three native chat tools have no MCP equivalent (`get_house_topology`,
`get_nws_weather`, `get_nws_discussion`); everything else in the 19-tool native
set maps to an MCP tool.

---

## Agent state buckets

| Bucket | Storage | Cap | Semantics |
|---|---|---|---|
| `ai_memory` | DO storage | 100 FIFO | Confirmed long-term facts. Embedded into KNOWLEDGE on write. `PINNED:` prefix exempt from FIFO. |
| `observations` | D1 `observations` table | Unbounded | Tagged hypotheses-in-progress. `INSERT OR REPLACE` keyed on `topicTagFor(text)`. Embedded into KNOWLEDGE. |
| `ai_log` | D1 `ai_log` table + in-memory ring | 30 days D1 / 1000 in-memory | Unified timeline: `chat_user`, `chat_reply`, `action`, `action_verified`, `notification`, `memory_saved`, `observation_saved`, `chat_timing_ms`, `vector_*`, errors. Pruned >30 days via daily cron. |
| `state_changes` / `automation_runs` / `service_calls` | D1 | 90 days each | Forensic log. See [Forensic event log](#forensic-event-log). |
| `chat_history:${channelKey}` | DO storage | 8 user turns (6 on the fast path) / 110 KB | OpenAI-format messages including `tool_calls` and `tool` results. Per-channel via `sanitizeChannelKey(from)`. |
| `scheduled:<uuid>` | DO storage | per-task keys | Pending one-shot scheduled actions. Fired and deleted by `_fireDueScheduledActions`. See [Scheduler](#scheduler). |
| `state_cache_snapshot` | DO storage | 127 KB | Hibernation snapshot for cold-start. |
| `bug:<id>` + `bug_ids` index | DO storage | 200 FIFO | User-flagged `report_bug` entries (per-id keys after the v5 storage fix). Cleared during the iteration ritual. |
| `last_event_seen_ms` | DO storage | scalar | Cursor for reconnect backfill (`_backfillStateChangesFromHA`). |

Timeline timestamps are reformatted to **Central time** at prompt-injection
(`HAWebSocketV29._formatTimelineTimestamp`). The underlying `ai_log` entries
stay ISO 8601 for parseability.

---

## Bindings & secrets

### Worker bindings (`wrangler.toml`)

| Binding | Resource | Purpose |
|---|---|---|
| `HA_WS` | Durable Object class `HAWebSocketV29` | Singleton `ha-websocket-singleton` |
| `HA_CACHE` | KV namespace | TTL'd cache for HA registries / states between cold starts |
| `KNOWLEDGE` | Vectorize index `ha-knowledge` | Multi-kind semantic index |
| `AI` | Workers AI | `@cf/baai/bge-large-en-v1.5` embeddings (cls pooling) |
| `DB` | D1 database `ha_db` | All forensic + agent persistence |
| `CF_VERSION_METADATA` | version metadata | Powers `/admin/version` for stale-DO detection |

### Worker secrets (`wrangler secret`)

| Secret | Purpose |
|---|---|
| `HA_URL` | HA base URL (Nabu Casa cloud-relayed) |
| `HA_TOKEN` | Long-lived HA access token |
| `FIREWORKS_API_KEY` | api.fireworks.ai bearer — the chat model |
| `ELEVENLABS_API_KEY` | (optional) `xi-api-key` for `/transcribe` |
| `MCP_AUTH_TOKEN` | (optional) Bearer for `/mcp`. Cloudflare Access sits in front anyway. |

### Config flags (vars or secrets)

| Flag | Purpose |
|---|---|
| `USE_NATIVE_TOOL_LOOP` | `"true"` — the chat path; the legacy JSON-action fallback is dormant |
| `USE_VECTOR_ENTITY_RETRIEVAL` | `"true"` flips context build to vector retrieval. Falls back to flat-list on failure. |
| `CLIMATE_PREAMBLE_ENABLED` | (optional) `"false"` disables the climate preamble |
| `DUMP_SYSTEM_PROMPT` | (optional) `"1"` emits a one-shot preflight breakdown of the model request body to `ai_log`. Unset after use. |
| `LLM_ENDPOINT` / `LLM_MODEL` / `LLM_REASONING_MODE` / `LLM_REASONING_EFFORT` | (optional) env-var layer for the runtime LLM config; overridden by the `llm_config` DO-storage override, overrides the baked-in defaults. See [LLM configuration](#llm-configuration). |

### Cron triggers

- `* * * * *` — `prewarmCache(env)`. Warms KV every minute, does a heavy refresh
  of all registries every 15 minutes, and reconnects the DO if the WS is dead.
- `30 8 * * *` — daily resync + retention at 03:30 CDT (08:30 UTC):
  - `dailyKnowledgeResync(env)` — resyncs the slow-changing kinds.
  - `dailyAiLogRetention(env)` — prunes `ai_log` rows >30 days.
  - `dailyForensicLogRetention(env)` — prunes `state_changes`, `automation_runs`,
    `service_calls` rows >90 days.

---

## How a request flows

### Chat (web `/chat` SSE, MCP `ai_chat` tool)

```
POST /chat (text/event-stream)
  → DO chatWithAgentNative
       0. SSE `started` event (iOS Safari heartbeat) + keepalive interval
       1. _tryDeterministicFastPath(message)  ── cover hit? emit `reply`,
          log, persist history, return. No LLM call. Sub-500ms.
       2. Load chat_history:${channelKey}
       3. _buildNativeContextEntities(message, { entityTopK: 6 })
            ├ retrieveKnowledge kinds=["entity"], k=6
            ├ retrieveKnowledge kinds=["memory"], k=3
            ├ retrieveKnowledge kinds=["observation"], k=3
            └ retrieveKnowledge kinds=["automation"], k=2
       4. _buildClimatePreambleIfNeeded(message)
       5. getStaticChatSystemPrompt()  → the `system` message
       6. buildDynamicContext(...)     → prepended to the user message
       7. runNativeToolLoop(messages, {
            maxIterations: 6,
            allowedTools: 19-tool surface,
            hallucinationGuard: true,
            maxTokens: 4096,
            onEvent
          })
            loop: callLLMWithTools (45s timeout)
                  → emit `reasoning` from the model's reasoning output
                  → dispatch tool_calls (including query_state_history etc.)
                  → push results
       8. Save preserved tool-calling trace to chat_history:${channelKey}
       9. SSE events: started | thinking | reasoning | tool_call |
          tool_result | reply | error
```

### Forensic write (every HA event)

```
HA WS event_type=state_changed → onEvent
  ├ stateCache.set/.delete  (unconditional)
  ├ _persistStateSnapshot   (60s cadence, unconditional)
  └ if old_state != new_state && _shouldLogStateChange:
        _writeStateChangeToD1({…, source: "ws"})  fire-and-forget
        _touchLastEventSeen(now)                   updates backfill cursor

HA WS event_type=automation_triggered → onEvent
  └ _writeAutomationRunToD1({…, result: "ran"})    fire-and-forget

HA WS event_type=call_service → onEvent
  └ _writeServiceCallToD1({…})                     fire-and-forget
```

### Reconnect backfill

```
HA WS auth_ok
  ├ subscribeToStateChanges()
  ├ subscribeToRegistryEvents()
  └ subscribeToForensicEvents() (automation_triggered, call_service)

  → state.storage.get("last_event_seen_ms")
    if 0 < age < 1h:
      _backfillStateChangesFromHA(sinceMs)
        GET /api/history/period/{iso}?minimal_response&significant_changes_only=false
        for each transition: _writeStateChangeToD1({…, source: "backfill",
                                                       context_id: null})
        logAI("backfill_complete", …)
```

### Registry events → incremental re-embed

```
HA event entity_registry_updated  → handleEntityRegistryUpdated → reembedRefs({kind:"entity", …})
HA event device_registry_updated  → handleDeviceRegistryUpdated → reembedRefs({kind:"device", …})
                                                                  + ({kind:"entity", refIds:[device's entities]})
```

### Speech-to-text (`/transcribe`)

```
Browser mic ──multipart audio──► /transcribe
  → Worker forwards to api.elevenlabs.io/v1/speech-to-text
    with model=scribe_v1, xi-api-key=env.ELEVENLABS_API_KEY
  → returns { text, language_code }
  → UI populates input box and auto-sends
```

---

## Chat UI surface

`CHAT_HTML` is a single embedded HTML/CSS/JS template in `src/worker.js`, served
at `/chat`. Features:

- **Hero mic button + auto-send.** A 3-state machine (idle / recording /
  processing). It records audio, POSTs to `/transcribe`, populates the input
  box, and auto-submits.
- **Collapsible reasoning panel.** A `<details>` element above each assistant
  bubble surfaces the `reasoning` SSE stream (the model's reasoning output).
  Collapsed by default.
- **Per-message buttons.** Copy, retry (on error bubbles), clear.
- **iOS Safari "Load failed" auto-retry.** Catches the iOS-specific error and
  silently retries once.
- **SSE event handling.** `started` | `reasoning` | `thinking` | `tool_call` |
  `tool_result` | `reply` | `error`.

---

## Deploy

Deploys are git-driven: a push to `main` triggers a **Cloudflare Workers Builds**
pipeline (configured in the Cloudflare dashboard) that runs the `[build]` step
and deploys. A merged commit goes live — treat a push to `main` as a production
deploy.

```powershell
# Manual / local deploy from C:\Users\obert\ha-mcp-gateway
wrangler deploy
```

Either path runs the `[build]` directive — esbuild bundles `src/worker.js` →
`dist/worker.js` — and reconciles bindings, crons, and DO migrations with
Cloudflare.

```powershell
# Unit tests (vitest)
npm test
```

### Smoke tests

```powershell
# One-time browser login (token cached ~24h)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access login `
  https://ha-mcp-gateway.obert-john.workers.dev

# Forensic log eyeball
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/recent_activity?hours=1"

# Forensic-log query via chat (write the body to a temp file to dodge
# PowerShell's JSON quoting rules; UTF-8 without BOM is required)
$gw = "https://ha-mcp-gateway.obert-john.workers.dev"
$tmp = "$env:TEMP\probe.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($tmp,
  '{"message":"Use query_state_history to show what changed in the last 30 minutes."}',
  $utf8NoBom)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "$gw/chat" --silent -X POST `
  -H "Content-Type: application/json" --data-binary "@$tmp"

# Direct D1 row counts
wrangler d1 execute ha_db --remote --command="SELECT 'state_changes' AS t, COUNT(*) FROM state_changes UNION ALL SELECT 'automation_runs', COUNT(*) FROM automation_runs UNION ALL SELECT 'service_calls', COUNT(*) FROM service_calls"

# Full knowledge backfill
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "$gw/admin/rebuild-knowledge?force=1" -X POST --max-time 300
```

---

## Operational notes

- **A DO with a persistent WS holds onto its V8 isolate across deploys.**
  Cloudflare normally hibernates an idle DO isolate after ~10s and reloads the
  latest code on the next request. The HA WebSocket is always active, so the DO
  never idles, so worker-side code can update for arbitrarily long stretches
  without the DO picking it up. Symptom: worker-side endpoints work immediately
  on deploy, DO-side method-body changes don't. To diagnose, run
  `wrangler tail --format json` and compare per-event `scriptVersion.id` against
  the latest deployed version id, or compare `/admin/version` (worker) against
  the DO `/version` route. To fix, rename the DO class via a `renamed_classes`
  migration. The class has been renamed twenty-eight times for exactly this
  reason (`HAWebSocket` → `HAWebSocketV2` → … → `HAWebSocketV29`); storage is
  preserved across renames. Since V29 the LLM config (model/endpoint/reasoning)
  is the exception — it's runtime-swappable via `/admin/llm-config` with no
  rename. See [LLM configuration](#llm-configuration).
- **Three redundant DO keepalives.** The persistent HA WebSocket is primary; the
  60s alarm (ping/pong + mandatory reschedule) is secondary; the minute-cadence
  `prewarmCache` cron is tertiary. The same alarm tick also fires due scheduled
  actions (see [Scheduler](#scheduler)). Removing the alarm reschedule would
  leave a 60s window in which the DO could hibernate if both the WS and a request
  happen to be quiet, so don't.
- **Pooling discipline.** Every Workers AI embedding call uses `pooling: "cls"`.
  Mixing pooling between backfill and query produces near-random rankings.
- **Cloudflare Access fronts the worker.** A direct curl / Invoke-RestMethod hits
  the Access login page. Use `cloudflared access curl` or a service token.
- **Snapshot-oversize is best-effort.** If `state_cache_snapshot` exceeds 127 KB,
  we log `snapshot_oversize` and attempt the put anyway (the DO storage hard
  limit is 128 KiB). If entity count grows past ~1500, the snapshot will need a
  tighter allowlist or chunking.
- **Iteration ceiling synthesis.** Watch `ai_log` for
  `iteration_ceiling_synthesize` — it should be rare. The chat cap is 6
  iterations.
- **Fast-path observability.** The cover-command fast path tags `ai_log` entries
  with `source: "fast_path"`. Query `ai_log` by source to audit hit-rate or false
  positives.
- **Latency instrumentation.** Every chat turn writes a `chat_timing_ms` row to
  `ai_log` with per-phase timing, token counts (`prompt`, `completion`,
  `cached`), `tool_iterations`, and an `intent_tag` (`fast_path` / `chat_only` /
  `forensic` / `deterministic_candidate` / `multi_tool`). `cached_tokens` should
  climb on iterations 2+ once the static system+tools prefix is warm; if it stays
  at 0, the prefix cache isn't hitting.
- **Time-format leak.** Timeline timestamps are pre-formatted Central in the
  prompt, and tool results pass through `_reformatToolResultTimestamps` before
  being pushed back. If a user-facing reply still shows a UTC/Z suffix, the model
  copied a timestamp it shouldn't have — QUICK FACTS forbids emitting ISO 8601 /
  `Z` / `UTC` in any reply.
- **Model timeout.** Each call has a 45s `AbortController` timeout (`Fireworks
  API timeout after 45000ms`). Persistent timeouts usually mean api.fireworks.ai
  is degraded.
- **D1 write observability.** `_d1WriteFailures` on the DO surfaces forensic-log
  write failures via the `/status` route and the `cache_status` MCP tool.
  Spot-check it periodically — silent loss of forensic data is the failure mode
  worth catching early.

---

## Recent significant changes

Newest first.

- **Ephemeral scheduler.** Three tools — `schedule_action`,
  `list_scheduled_actions`, `cancel_scheduled_action` — for one-shot delayed
  service calls. Tasks live in DO storage under `scheduled:<uuid>` and are fired
  by the 60s `alarm()` tick (`_fireDueScheduledActions`), with a delete-before-
  fire rule and a WS-up guard. See [Scheduler](#scheduler). This was item #1 on
  the old roadmap.
- **V29 — runtime-configurable LLM config; default GLM 5.2.** The endpoint,
  model, and reasoning mode now resolve at call time from a DO storage override →
  env vars → baked-in defaults, swappable live via `/admin/llm-config` with no
  class rename. The default moved from Qwen 3.7 Plus to GLM 5.2, with the
  reasoning mode back on `reasoning_effort` (`"high"`). See
  [LLM configuration](#llm-configuration).
- **V28 — flat tool-call argument coalescer.** A guard that repairs tool calls
  where the model emitted arguments flat (e.g. `entity_id` at the top level)
  instead of nested under `data`, folding them into the expected shape before
  dispatch. Unit-tested.
- **V27 — MiniMax M3.** Reasoning control moved from `reasoning_effort` to the
  `thinking: { type: "enabled" }` toggle (Fireworks rejects sending both).
- **V22 — sanitize light color descriptors before the HA call.** DeepSeek V4
  Flash repeatedly fumbled `light.turn_on` on brightness-only lights by including
  mutually-exclusive color descriptors (`rgb_color`, `color_temp_kelvin`,
  `white`, …) alongside `brightness_pct`. HA groups all color descriptors into
  one mutually-exclusive set ("Color descriptors" 400), and each descriptor
  requires the matching mode in `attributes.supported_color_modes`.
  `_sanitizeLightServiceData` reads the target's `supported_color_modes` from
  `stateCache` and strips any descriptor the light doesn't support before the
  call reaches HA; if multiple compatible descriptors remain, it keeps one by
  fixed priority. It's wired into both `executeAIAction` (chat path) and the DO
  `/call_service` route (MCP path) so one helper covers both surfaces. Light
  entity context now also includes `brightness`, `supported_color_modes`, and
  `color_mode` so the model sees the capability up front, and a one-line `LIGHT
  CALLS` rule was added to QUICK FACTS. Strips are logged to `ai_log` as
  `light_sanitize`. Covered by `test/sanitize-light-service-data.test.js`. This
  wasn't a prompt regression — the MiniMax-era prompt had no color-descriptor
  guidance either; DeepSeek just inferred the constraint less well from the
  schema. The deterministic guard is the floor regardless of model.
- **V21 — chat-prompt trim + Tesla Model Y knowledge.** History, timeline, and
  top-K retrieval windows tightened; tool schemas condensed; the snapshot
  trimmed. A `TESLA MODEL Y` group was added to HOUSE_STATE_SNAPSHOT (8 EV status
  entities) and a Tesla control cheat-sheet to QUICK FACTS — charge start/stop,
  charge limit, cabin precondition, lock, frunk/trunk/charge-port, plus a note
  that a sleeping car needs `button.tesla_model_y_wake` before commands land.
- **V17–V20 — LLM provider switch to DeepSeek V4 Flash on Fireworks.** After a
  detour through gpt-oss-120b on Groq (V13–V15) and a revert to MiniMax (V16 —
  gpt-oss handled multi-step agentic tool calling poorly: fabricated entity
  states, reasoning paralysis, premature synthesis fallback), the chat agent
  moved to DeepSeek V4 Flash on Fireworks
  (`accounts/fireworks/models/deepseek-v4-flash`). V18–V20 enabled Think High
  reasoning (`reasoning_effort: "high"`), dropped the conflicting `thinking`
  field (Fireworks rejects it alongside `reasoning_effort`), and stopped
  stripping `reasoning_content` from echoed assistant messages — Fireworks
  requires prior-turn reasoning re-fed for interleaved thinking across tool-call
  rounds. Auth moved to `FIREWORKS_API_KEY`.
- **V13 — system-prompt static/dynamic split for prefix caching.**
  `getChatSystemPrompt` was split into `getStaticChatSystemPrompt()` (100%
  static, byte-identical every request) and `buildDynamicContext()` (all
  per-request data, relocated to lead the trailing user turn). The static system
  + tool-list prefix now matches the provider's passive prefix cache across every
  tool-loop iteration. `cached_tokens` instrumentation added to
  `runNativeToolLoop`.
- **V9–V12 — system-prompt slim, behavioral gating, latency cuts.** Per-iteration
  prompt cut ~64% (≈30k → ≈11k tokens): the timeline excludes chat turns
  (duplicated by `conversation_history`), architecture prose deleted, JSON entity
  dumps replaced with one-line text. HOUSE_STATE_SNAPSHOT gated behind
  `HOUSE_STATUS_TRIGGER_RE`. House topology moved behind the zero-arg
  `get_house_topology` tool. `MAX_TURNS` reduced 10→8. Post-tool fast-return: a
  single simple action (light/switch/lock/scene) synthesizes "Done — X"
  server-side and skips the wrap-up LLM call. Fast-path reordered to emit the SSE
  reply before bookkeeping (~150ms → ~80-100ms perceived).
- **V7–V8 — phase-timing instrumentation.** Per-phase timing, token counts, and
  `intent_tag` added to `chat_timing_ms` rows; a `DUMP_SYSTEM_PROMPT`-gated
  preflight breakdown of the model request body to ground the prompt trim against
  literal token counts.
- **report_bug storage architecture fix + agent error-confabulation guardrail.**
  The old `report_bug` handler wrote the entire bugs list as a single `bugs`
  array key on DO storage. Each entry carried `last_chat_turns`,
  `last_log_entries`, and full `entity_states` (raw attribute trees), so a
  handful of entries blew the 128 KiB DO value cap. Writes failed silently, and
  worse, the chat agent confabulated `"Logged bug #..."` replies after the error
  returns. The v5 migration splits storage into per-id keys (`bug:<id>` plus a
  small `bug_ids` index — FIFO 200) and trims every field. A `TOOL ERROR HANDLING
  — NO CONFABULATION` block was added to the chat system prompt.
- **Forensic noise-filter expansion + observation-vector orphan cleanup.** A live
  D1 audit found `_summation_delivered` leaking 1,400+ rows/hr despite a
  source-level hard-deny rule (the rule had been committed after a class rename,
  so the running DO never picked it up). The v4 rename forced a fresh isolate;
  `_shouldLogStateChange` gained an `image.*` domain skip, roborock
  cleaning-telemetry suffixes, and a 2V voltage deadband. The same deploy
  rewrote `/admin/reindex-observations` to delete observation vectors orphaned by
  earlier ref_id schema changes.
- **Autonomous monitor excision (3-deploy refactor).** The 60-second
  heartbeat-driven autonomous LLM monitor was removed entirely after ~30 days of
  no useful proactive intervention. In its place, every HA event now lands in D1
  and the chat agent gained three forensic query tools plus a `FORENSIC MEMORY`
  prompt section. See [Background](#background-the-autonomous-monitor).
- **(retired) D1 ai_log + observation cutover.** `save_observation` and `ai_log`
  writes moved exclusively to D1 with one-time migrations retiring the DO storage
  keys. The `dailyAiLogRetention` cron prunes >30-day rows.
- **(retired) Multi-kind knowledge index (`ha-knowledge`).** Replaced the
  entity-only `ha-entities` index with the unified nine-kind index; added the
  `vector_search` native tool, `topic_tag` + `min_score` filters, friendly-name
  dedup, observation time-decay, and orphan diff on `force=1` rebuilds.
- **(retired) HOUSE_STATE_SNAPSHOT + TRUTHFULNESS rules.** The snapshot is the
  ground-truth read on security/climate/presence; TRUTHFULNESS forbids unverified
  state claims.
- **(retired) Cover-command fast path.** Deterministic sub-500ms cover open/close
  that bypasses the LLM.

`git log --oneline` walks back further; anything older than the multi-kind index
migration is foundational and unlikely to need re-reading.

---

## Iterating

Bugs caught during use are captured in chat — saying things like "that's a bug",
"save to debug log", or "log this as broken". The chat agent calls `report_bug`,
which writes a structured entry to DO `bugs` storage (description + last 4 chat
turns + last 10 `ai_log` entries + cited entity state).

At iteration time, fold captured bugs into BUGS.md and clear the bucket:

```powershell
# Pull as Markdown
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/bugs?format=markdown" `
  > "$env:TEMP\new-bugs.md"

# Prepend $env:TEMP\new-bugs.md to BUGS.md, commit, then clear:
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/bugs/clear" -X POST
```

Triage one at a time. After fixing, strike through the heading in BUGS.md
(`## ~~#abc12345 — …~~`) and add `Fixed: <commit-sha>` under the body — don't
delete entries, the history is the audit trail.

---

## Things to reach for next

Open items, roughly in order of leverage:

1. **Daily / weekly digest cron.** A scheduled chat call once a day that queries
   the forensic log over the last 24 hours and writes a digest to a push
   notification or `ai_log`. One model call, narrative output.
2. **Backfill of `automation_runs` and `service_calls` on reconnect.** HA REST
   history doesn't expose these reliably, so today only state changes are
   backfilled. If a long outage ever matters, dig into HA's alternative
   endpoints.
3. **Fast-path generalization.** Cover-only today. Lights and locks have similar
   shapes; each new domain needs its own no-op guard, disqualifier list, and
   question-bail tests.
4. **HOUSE_STATE_SNAPSHOT bytecount.** If the snapshot grows past ~60 lines,
   consider a per-room trim driven by query intent.
5. **Service-auth bypass for ops endpoints.** A service token with an Access
   policy bypass for `/admin/*` would let ops scripts run without `cloudflared`.
