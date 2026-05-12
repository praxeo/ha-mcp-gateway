# HA-MCP-Gateway

A Cloudflare Worker + Durable Object that bridges Home Assistant to LLMs. It
holds a persistent WebSocket to HA, mirrors live state in memory, streams
every meaningful event into a queryable D1 forensic log, and exposes the
whole surface as an MCP server. A built-in chat agent (MiniMax, native
tool-calling loop) answers questions on demand and acts on user commands.
Deterministic cover commands short-circuit the LLM via a sub-500ms fast path.
A Cloudflare Vectorize index over nine entity-kinds backs semantic retrieval.

This document is the load-bearing reference for picking up the codebase
cold. It opens with the story of how the architecture got here, then covers
the current code in operational detail.

---

## Story: the monitor that didn't earn its keep

The original ambition was bigger than what's here today. An autonomous LLM
heartbeat — MiniMax with the full tool surface — ran every 60 seconds,
consumed a queue of state-change events filtered down to "interesting"
ones, retrieved relevant context from the vector index, and decided whether
to act, notify, save an observation, or do nothing. The pitch in the MCP
intro message was things like *"I locked the back porch deadbolt at 4:49 AM
because it was unsecured and the house was occupied."* In principle, a
24/7 reasoning loop with full state visibility should surface insights
humans miss.

In practice, it didn't. Over roughly 30 days of running, the autonomous
monitor produced zero useful proactive interventions. When asked directly
what it had done, the agent itself admitted:

- It saw the auxiliary heat draw spike above 5000W and didn't flag it
  ("the spike was brief").
- It logged observations like `[basement-porch-camera-flapping]`
  (motion 8× at 1:38 AM across 4 weeks) but never surfaced them in chat.
- It correctly identified that it was supposed to bring these to attention
  and was unable to close the loop on its own initiative.

Worse, the actions it *did* take were variously annoying or dangerous.
Every autonomous service call was one of:
- right and useful (zero instances anyone could recall),
- right but unnecessary (annoying),
- wrong (potentially dangerous).

There was no silent-good-outcome bucket. The expected value of running it
was negative.

### Diagnosing it

The instinct was to reach for a smarter model. The diagnosis was harder.
The model could reason fine — it just had the wrong job. Three observations
made this clear:

1. **Pattern recognition is a batch problem, not a streaming problem.**
   You don't notice that the basement porch camera fires at 1:38 AM by
   looking at one event. You notice by looking at 30 days of events and
   seeing the cluster. The heartbeat saw events one at a time.

2. **The LLM is excellent at narrative synthesis on demand and mediocre
   at real-time interrupt judgment.** A "tell me the 24-hour story" chat
   call produced a clean, well-organized narrative with the right anomalies
   flagged. The same model on a 60s tick, asked "should I interrupt John?"
   answered "no" 86,400 times a day.

3. **The autonomous monitor's value was supposed to be the data it
   surfaced — but the data was always there.** The cache held live state.
   HA held history. The vector index held semantics. What was missing was
   a clean way to *ask*. The monitor was filling that gap by deciding
   what to volunteer; the right fix was making it cheap and natural to
   query.

There was also a separate, more important consideration: the household is
about to grow. With a child arriving in October, "the AI sometimes does
dangerous things autonomously" stops being a tolerable risk.

### What we built instead

The autonomous heartbeat is gone. In its place:

- **A forensic event log in D1.** Every state change (`state_changes`),
  every automation fire (`automation_runs`), and every service call
  (`service_calls`) lands in dedicated tables with HA's context-chain
  links preserved. 90-day rolling retention. Reconnect-backfill from
  HA's history API for state changes missed during WS dropouts.
- **Three new query tools on the chat agent.** `query_state_history`,
  `query_automation_runs`, and `query_causal_chain` (walks parent/child
  context links across all three tables). Same helpers back both the
  native chat dispatcher and the MCP surface — Claude Code can hit
  everything the chat agent can.
- **A new `FORENSIC MEMORY` block in the chat system prompt** telling
  the model the log is its always-on memory and to query it freely
  rather than guessing.
- **Net deletion: ~720 lines** out of `ha-websocket.js`, plus seven
  vestigial MCP tools (`ai_enable` / `ai_disable` / `ai_status` /
  `ai_trigger` / `ai_clear_log` / `ai_clear_memory` / `ai_clear_chat`).
  `dist/worker.js` shrank from ~390KB to ~352KB. `alarm()` collapsed to
  WS ping/pong + reschedule — three redundant DO keepalives remain
  (the WS itself, the alarm, and the minute-cadence prewarm cron).

The chat agent now feels omniscient about the house's history without
being intrusive. "What happened at 3 AM?" "Why didn't the porch light
fire when the door opened?" "How many times did the basement bay open
this week?" — all become one or two SQL queries, narrated.

### What's gone for good

The autonomous prompt (`getNativeAgentSystemPrompt` with its
`AUTONOMOUS ACTION SAFETY` block of hard-NEVERs), `runAIAgent` and
`runAIAgentNative`, the `recentEvents` queue, the `shouldQueueEvent`
and `checkBurst` filters, the 15-min synthetic heartbeat, the
`aiEnabled` flag and all the toggle endpoints — deleted. Git history
keeps them retrievable if the experiment ever needs to be revisited
with a different hypothesis.

### What survives

Everything that earned its keep: the persistent HA WS and live
`stateCache`, the hibernation snapshot, the chat path with its native
tool loop, the vector knowledge index, the fast-path cover commands,
`save_memory` / `save_observation` (now chat-only, gated by explicit
user-request prompts), the `ai_log` table for chat history, the
`observations` table, all three crons, and the entire MCP tool surface
minus the seven autonomous-control entries.

---

## Architecture

```
User (web / Claude Desktop / Claude Code / WhatsApp[dormant])
        │
        ▼
Cloudflare Worker (worker.js)         ◀── /mcp, /chat, /transcribe,
   │                                       /admin/bugs, /admin/bugs/clear,
   │                                       /admin/recent_activity,
   │                                       /admin/rebuild-knowledge,
   │                                       /admin/index-stats,
   │                                       /admin/cleanup-stale-vectors,
   │                                       /admin/reindex-observations,
   │                                       /admin/version, /health, /refresh
   │  routing, MCP handler, CHAT_HTML, ElevenLabs STT proxy,
   │  multi-kind backfill, three crons (cache prewarm, knowledge resync,
   │  ai_log + forensic-log retention)
   ▼
Durable Object: HAWebSocketV5 (ha-websocket.js)
   │  singleton "ha-websocket-singleton" — owns the persistent WS
   │  in-memory stateCache, hibernation snapshot, cover fast path,
   │  HOUSE_STATE_SNAPSHOT builder, chat tool loop, forensic D1 writers,
   │  reconnect backfill, per-channel chat_history
   ├──► Home Assistant WebSocket (port 8123, JWT auth)
   │       subscribes to: state_changed, entity_registry_updated,
   │                      device_registry_updated, automation_triggered,
   │                      call_service
   ├──► Cloudflare D1 "ha_db"                (env.DB)
   │       tables: ai_log, observations, bugs,
   │               state_changes, automation_runs, service_calls
   ├──► Cloudflare Vectorize "ha-knowledge"  (env.KNOWLEDGE)
   ├──► Cloudflare Workers AI                (env.AI, bge-large-en-v1.5)
   ├──► MiniMax M2.7-highspeed at api.minimax.io  (OpenAI-compatible)
   └──► ElevenLabs Scribe at api.elevenlabs.io       (speech-to-text)
```

Layer-by-layer:

1. **Physical devices** — Zigbee / Z-Wave / Wi-Fi plugs / ESPHome / Roku / Ecobee.
2. **Home Assistant** — open-source server owning every integration, automation, scene, script, recorder. WebSocket API on port 8123.
3. **HA Green** — a Nabu Casa appliance running HA OS on the local LAN. Cloud-relayed via Nabu Casa for remote access.
4. **ha-mcp-gateway (this repo)** — Worker + DO. Translates natural language into HA service calls and answers historical questions from the forensic log. Auth: Cloudflare Access JWT for browser users; long-lived HA token in worker secret.
5. **Vectorize knowledge index (`ha-knowledge`)** — see [Knowledge index](#knowledge-index-ha-knowledge).
6. **Cloudflare D1 (`ha_db`)** — relational store. `ai_log` keeps chat/action history; `observations` keeps tagged hypotheses; `bugs` is the iteration capture bucket; `state_changes` / `automation_runs` / `service_calls` are the [forensic log](#forensic-event-log).
7. **MiniMax M2.7-highspeed** — chat completions + native tool calls. The DO drives the loop, not MiniMax. 45s timeout per call with `AbortError` handling.
8. **ElevenLabs Scribe** — `scribe_v1` speech-to-text. Worker proxies the chat UI's audio blobs through `/transcribe`.
9. **Frontends** — Claude Desktop and Claude Code (MCP), `/chat` HTML UI served by the Worker (SSE-streaming, hero mic button, collapsible reasoning panel). Twilio (WhatsApp) is currently dormant.

---

## Repo layout

| File | Role |
|---|---|
| `src/worker.js` | Cloudflare Worker entry. Owns the MCP handler (`TOOLS` list + `handleTool` dispatch), HTTP routes including `/admin/recent_activity`, the embedded `CHAT_HTML` UI, the ElevenLabs STT proxy, the `formatBugsAsMarkdown` helper, KV cache helpers, the multi-kind `backfillKnowledge`, and the `scheduled()` cron handler with daily knowledge resync, 30-day `ai_log` retention, and 90-day forensic-log retention (`dailyForensicLogRetention`). |
| `src/ha-websocket.js` | Durable Object class `HAWebSocketV5` (renamed forward through the persistent-WS refresh dance — see [Operational notes](#operational-notes)). Holds the persistent HA WebSocket and in-memory `stateCache`. Subscribes to five HA event types: `state_changed`, `entity_registry_updated`, `device_registry_updated`, `automation_triggered`, `call_service`. Writes every meaningful event fire-and-forget to D1 via `_writeStateChangeToD1` / `_writeAutomationRunToD1` / `_writeServiceCallToD1`, gated by `_shouldLogStateChange` for the state path (Zigbee/network-noise denylist). Reconnect backfill from HA history via `_backfillStateChangesFromHA`. One system prompt: `getChatSystemPrompt`, including a `FORENSIC MEMORY` section pointing the agent at the three query tools. One execution path: `chatWithAgentNative` (user-driven, SSE), preceded by `_tryDeterministicFastPath` for cover commands. Native tool loop in `runNativeToolLoop`, action executor in `executeAIAction`, tool dispatcher in `executeNativeTool` (now includes `query_state_history` / `query_automation_runs` / `query_causal_chain` cases). `alarm()` is WS keepalive only — ping/pong, reconnect on no-pong, mandatory reschedule. |
| `src/agent-tools.js` | OpenAI-format tool schemas passed to MiniMax. 4 action tools (`call_service`, `ai_send_notification`, `save_memory`, `save_observation`) + 9 read tools (`get_state`, `get_logbook`, `render_template`, `vector_search`, `get_automation_config`, `report_bug`, `query_state_history`, `query_automation_runs`, `query_causal_chain`) = 13 total. `CHAT_ALLOWED_TOOL_NAMES` includes all 13 — the chat agent has the full surface. |
| `src/vectorize-schema.js` | Canonical metadata schema, `vectorIdFor(kind, refId)`, FNV-1a hash, `topicTagFor(text)`, per-kind embed-text builders, `isNoisyEntity` / `isNoisyService` / `entityCategoryFor` helpers, `buildMetadata` (lowercase-coerces `area`, string-coerces `is_noisy`, propagates `created_at`). |
| `migrations/0001_d1_indexes_and_columns.sql` | Indexes on the legacy `ai_log` / `observations` / `bugs` tables. Also adds the nullable `data` JSON column to `observations`. |
| `migrations/0002_forensic_log.sql` | Creates `state_changes`, `automation_runs`, `service_calls` and their context-chain indexes. |
| `wrangler.toml` | Bindings (HA_WS, HA_CACHE, KNOWLEDGE, AI, DB), build command (esbuild bundles `src/worker.js` → `dist/worker.js`), cron triggers (`* * * * *` cache prewarm, `30 8 * * *` daily resync + retention), DO migrations v1→v2→v3 (`renamed_classes` chain). `compatibility_date = "2026-05-09"`. |
| `dist/worker.js` | esbuild output. **Build artifact — never edit.** |
| `.dev.vars` | Local-dev secrets. Never committed. |

---

## Forensic event log

The forensic event log is what makes the chat agent feel like it knows
everything that's happened in the house. Every meaningful event lands in
D1 within seconds, with the HA context chain preserved so cause-and-effect
queries are tractable.

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

All three tables have time, context, and table-specific indexes. Schema
lives in `migrations/0002_forensic_log.sql`.

### What gets written, when

| HA event             | Forensic table     | Filter             |
|----------------------|--------------------|--------------------|
| `state_changed`      | `state_changes`    | `_shouldLogStateChange`: domain skip (`image.*` — timestamp churn); suffix denylist (`*_lqi*`, `*_rssi*`, `*_signal_strength*`, `*_bssid*`, `*_ssid*`, `*_last_update_trigger*`, `dBm`/`dB`/`lqi` units); hard denylist (`*_summation_delivered`, `*_summation_received`, roborock `*_cleaning_area`/`*_cleaning_time`/`*_cleaning_progress`/`*_filter_time_left`/`*_main_brush_time_left`/`*_side_brush_time_left`/`*_dock_strainer_time_left`/`*_sensor_dirty_time_left`); numeric deadband (power 50W, energy 0.01kWh, voltage 2V, humidity 2%, temperature 0.5°, illuminance 10% relative) |
| `automation_triggered` | `automation_runs` | none — every fire logged |
| `call_service`       | `service_calls`    | none — every call logged |

The filter is deliberately more permissive than the old monitor's filter
(which was tuned to "don't wake the LLM"). For forensic use, the cost of
a row is trivial; the cost of a missing row is "can't answer the
question."

Writes are fire-and-forget; the WS handler never blocks on D1. Failures
increment `_d1WriteFailures` (exposed via `/status` and `cache_status`)
so silent loss is visible.

### Reconnect backfill

On every successful HA WS auth-ok, the DO reads `last_event_seen_ms`
from its storage. If it's set and the gap is under 1 hour, it pulls
`/api/history/period/{iso}` from HA and inserts the missed state
changes into `state_changes` with `source='backfill'` and
`context_id=null` (HA history doesn't preserve context). Writes use
`INSERT OR IGNORE` against a unique index on `(entity_id, fired_at_ms,
new_state)`, so reconnect backfill is idempotent. Service calls and
automation fires are not backfilled — HA's REST API doesn't expose
them reliably; brief gaps in those tables on reconnect are acceptable.

### Retention

90-day rolling window for all three forensic tables. `dailyForensicLogRetention`
runs at 03:30 CDT (08:30 UTC) alongside `dailyAiLogRetention` and
`dailyKnowledgeResync`.

### Query tools

Three tools surface the log to the chat agent and to MCP clients:

- **`query_state_history`** — filtered SELECT over `state_changes`.
  Filters: `entity_id`, `entity_id_like`, `domain`, `new_state`,
  `since` / `until` (ISO 8601 with offset or `NOW-Nh` / `NOW-Nm` /
  `NOW-Nd` relative). Default window is the last 24 hours. `limit`
  capped at 500.
- **`query_automation_runs`** — same shape over `automation_runs`.
  Filters: `automation_id`, `automation_id_like`, `trigger_entity_id`,
  `since` / `until`.
- **`query_causal_chain`** — given a `context_id`, walks parent/child
  links across all three tables. `direction: forward | backward | both`,
  `depth: 1-10`. Iterative walker (not a single recursive CTE) — each
  pass is one D1 query, depth-bounded, results de-duped by
  `(kind, context_id, fired_at_ms)` and sorted chronologically.

Single helpers (`_executeQueryStateHistory`, `_executeQueryAutomationRuns`,
`_executeQueryCausalChain`) back both the native chat dispatcher (via
`executeNativeTool`) and the MCP endpoints (via DO HTTP routes
`/query_state_history` etc.). No duplication.

### Eyeball endpoint

`GET /admin/recent_activity?hours=N` (default 1, max 720) returns a
plain-text dump of the last N hours UNION'd across all three tables:

```
[May 12, 2026, 2:32 PM] state_change   input_boolean.basement_work_mode      off -> on
[May 12, 2026, 2:32 PM] service_call   input_boolean.turn_on                 input_boolean.basement_work_mode
```

`?format=json` returns structured rows. Useful for verifying data flow
without invoking the chat agent.

---

## Knowledge index (`ha-knowledge`)

Cloudflare Vectorize, 1024-dim, cosine, model `@cf/baai/bge-large-en-v1.5`,
**pooling `cls`** (must match at backfill and query time — mismatched
pooling gives near-random rankings).

### Metadata schema

| Field             | Type   | Filterable? | Notes                                    |
|-------------------|--------|-------------|------------------------------------------|
| `kind`            | string | ✓           | `entity` `automation` `script` `scene` `area` `device` `service` `memory` `observation` |
| `ref_id`          | string |             | entity_id, automation HA-internal id, `<domain>.<service>`, `fnv1aHex(text)` for memories, `topicTagFor(text)` for observations |
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

`{kind}:{ref_id}` truncated to 64 bytes with an `_<fnv1aHex>` suffix when
the prefixed form would exceed the cap. `vectorIdFor(kind, refId)` is the
single source of truth. For observations, `ref_id` is `topicTagFor(text)`,
locking Vectorize identity to the D1 primary key.

### Refresh strategy

| Kind         | Refresh trigger                                                 |
|--------------|-----------------------------------------------------------------|
| entity       | event-driven (`entity_registry_updated`) + nightly cron resweep |
| device       | event-driven (`device_registry_updated`) + nightly cron resweep |
| memory       | write-through (`executeAIAction.save_memory`)                   |
| observation  | write-through (`executeAIAction.save_observation` to D1)        |
| automation   | nightly cron                                                    |
| script       | nightly cron                                                    |
| scene        | nightly cron                                                    |
| area         | nightly cron                                                    |
| service      | nightly cron                                                    |

### Endpoints

- `POST /admin/rebuild-knowledge?force=1&kinds=a,b,c` — multi-kind backfill.
- `GET /admin/index-stats` — last 20 backfill summaries.
- `POST /admin/cleanup-stale-vectors` — one-shot legacy cleanup (idempotent).
- `POST /admin/reindex-observations` — enumerates observation vectors via multi-probe similarity query (topK=100 per probe, 4 probes ≈ 400 IDs), deletes anything not in the canonical `topicTagFor`-derived keep-set, then force-rebuilds the observation kind. Idempotent; re-run if the index ever holds >400 observation vectors and a single pass misses some.
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

Metadata indexes are immutable — declare all six at creation time.

---

## HOUSE_STATE_SNAPSHOT

`_buildHouseStateSnapshot()` emits a small text block injected into the
chat system prompt every turn, read directly from the in-memory
`stateCache`. It groups a curated set of entity IDs (locks, garage/basement
bay covers, the two thermostats with inline `current/target/hvac_action`,
presence trackers, whole-home power, key contact sensors, mode booleans)
and prints `<entity_id> (<friendly_name>): <state>` with cover position
inline when present.

Why it exists:

- **Authoritative for the listed entities.** The prompt tells MiniMax to
  trust the snapshot — it's regenerated every turn from live cache. This
  is what makes the TRUTHFULNESS rule enforceable.
- **Aggregation guard.** Claims like "everything secure" are forbidden
  unless every asserted entity is in the snapshot or the agent called
  `get_state` on it this turn.
- **Fast-path no-op guard.** The cover fast path checks the snapshot —
  if the target is already in the requested state, it replies "already
  closed" without firing a service call.

Anything not in the snapshot is fair game for `get_state` /
`vector_search` / the forensic query tools.

---

## Native tool loop

MiniMax is given OpenAI-format tool schemas (`NATIVE_AGENT_TOOLS` in
`agent-tools.js`). The DO drives the loop: send messages, read
`tool_calls`, dispatch via `executeNativeTool`, push tool results back,
repeat until MiniMax emits no `tool_calls`. Each MiniMax call has a 45s
timeout with `AbortError` handling.

Caps:

- **Chat path** (`chatWithAgentNative`): `maxIterations: 6`,
  `maxTokens: 4096`, `hallucinationGuard: true`. Tool set is the full
  13-tool surface filtered through `CHAT_ALLOWED_TOOL_NAMES` (defensive
  no-op now that all 13 are allowed; kept for future flexibility).
  Synthesis fallback on overflow — pushes a "stop using tools, compose
  now" message and re-calls MiniMax with `tools:[]`.

Tool surface (13 total):

| Tool | Side effect | Notes |
|---|---|---|
| `call_service` | yes | Any HA service. Post-action verify `get_state` for `climate` / `lock` / `cover`. |
| `ai_send_notification` | yes | `notify.notify` + writes `notification` entry to `ai_log`. |
| `save_memory` | yes | Append to DO storage (100 FIFO, `PINNED:` prefix exempt). Embed + upsert. Chat-prompt rule: only on explicit user request. |
| `save_observation` | yes | INSERT OR REPLACE into D1 `observations` keyed on `topicTagFor(text)`. Embed + upsert. Chat-prompt rule: only on explicit user request. |
| `get_state` | no | stateCache hit; `force_refresh: true` fetches via REST `GET /api/states/{id}` (single entity, updates cache); `force_refresh: "bulk"` repopulates entire cache via WS `get_states`. |
| `get_logbook` | no | HA `/api/logbook`. Description requires explicit TZ offset (`-05:00` for CDT). |
| `render_template` | no | HA `/api/template`. Jinja2 evaluation. |
| `vector_search` | no | DO `/vector_search` → `retrieveKnowledge`. Multi-kind metadata-filtered semantic search. Args: `query`, `kinds` (REQUIRED), `domain`, `area`, `topic_tag`, `min_score` (default 0.50), `top_k` (max 50), `include_noisy`. |
| `get_automation_config` | no | HA `/api/config/automation/config/{id}`. Returns trigger/condition/action body. |
| `report_bug` | log-only | User-flagged issue capture to DO `bugs` storage (FIFO 200). |
| `query_state_history` | no | Filtered SELECT over `state_changes`. See [Forensic event log](#forensic-event-log). |
| `query_automation_runs` | no | Filtered SELECT over `automation_runs`. |
| `query_causal_chain` | no | Iterative parent/child walker across all three forensic tables. |

Action tools are dispatched through `executeAIAction` with
`source="native_loop"` so `ai_log` records who did what
(`legacy_json` / `native_loop` / `tool_call` / `fast_path`).

Tool messages persisted into `chat_history` are truncated at 4 KB
(`TOOL_CONTENT_CAP`) so long results don't bloat the byte budget across
turns.

### System prompt structure

The chat prompt (`getChatSystemPrompt`) injects, in order:

- `getAgentContext()` — architecture self-knowledge.
- GATEWAY HEALTH (WS connected, cache size, last pong age).
- TOOLS list (13 tools, with usage hints).
- COMMITMENT RULE (don't claim to have done something you didn't tool-call).
- BUG REPORTS (when to call `report_bug`).
- SAVING MEMORIES / OBSERVATIONS (chat-path rule: explicit user request only).
- CHAT ACTION CONFIRMATION (Case-A user-initiated vs Case-B agent-initiated
  asymmetry — a direct instruction acts immediately; an agent-proposed
  action requires explicit affirmative confirmation).
- QUICK FACTS (thermostat zone disambiguation, smoke/CO note, automation
  update 405 note, timestamp format Rule 10).
- Climate preamble (when HVAC keywords detected).
- RETRIEVAL DISCIPLINE (vector_search-first when the entity isn't visible).
- **FORENSIC MEMORY** (the agent's always-on log of the house — points
  at the three query tools and tells the agent to query freely).
- HOUSE_STATE_SNAPSHOT.
- UNIFIED TIMELINE (recent `ai_log` events, Central time pre-formatted).
- Semantic top-K blocks (memories, observations, automations, devices,
  services) when retrieval ran.
- RELEVANT ENTITIES (top-K from live state cache).
- TRUTHFULNESS — STATE CLAIMS (no state assertion without verification
  this turn).

`CHAT ACTION CONFIRMATION` is what protects against the agent acting on
ambiguous intent — emoji, "sure", silence, topic changes all explicitly
do not count as confirmation for an agent-proposed action on a cover,
lock, alarm, or high-power appliance.

### Cover-command fast path

`_tryDeterministicFastPath(message)` runs at the top of
`chatWithAgentNative`. It short-circuits to a direct `cover.open_cover`
or `cover.close_cover` service call when:

1. Open-verb XOR close-verb (`open|raise|lift` vs `close|shut|lower|drop`).
2. Not a question (trailing `?` or sentence-initial state verb bails).
3. Target entity matches an explicit phrase or a bare-noun fallback
   that survives the disqualifier regex.
4. Cover is not already in the target state (`stateCache` no-op guard).

On match: explicit `open_cover` / `close_cover` (NEVER `toggle`),
`ai_log` entry tagged `source: "fast_path"`, reply persisted, SSE `reply`
event emitted. Returns `{ reply, actions_taken, fast_path: true }`.
Sub-500ms typical.

---

## Agent state buckets

| Bucket | Storage | Cap | Semantics |
|---|---|---|---|
| `ai_memory` | DO storage | 100 FIFO | Confirmed long-term facts. Embedded into KNOWLEDGE on write. `PINNED:` prefix exempt from FIFO. |
| `observations` | D1 `observations` table | Unbounded | Tagged hypotheses-in-progress. `INSERT OR REPLACE` keyed on `topicTagFor(text)`. Embedded into KNOWLEDGE. |
| `ai_log` | D1 `ai_log` table + in-memory ring | 30 days D1 / 1000 in-memory | Unified timeline: `chat_user`, `chat_reply`, `action`, `action_verified`, `notification`, `memory_saved`, `observation_saved`, `vector_*`, errors. Pruned >30 days via daily cron. |
| `state_changes` / `automation_runs` / `service_calls` | D1 | 90 days each | Forensic log. See [Forensic event log](#forensic-event-log). |
| `chat_history:${channelKey}` | DO storage | 10 user turns / 110 KB | OpenAI-format messages including `tool_calls` and `tool` results. Per-channel via `sanitizeChannelKey(from)`. |
| `state_cache_snapshot` | DO storage | 127 KB | Hibernation snapshot for cold-start. |
| `bugs` | DO storage | 200 FIFO | User-flagged `report_bug` entries. Cleared during iteration ritual. |
| `last_event_seen_ms` | DO storage | scalar | Cursor for reconnect backfill (`_backfillStateChangesFromHA`). |

Timeline timestamps are reformatted to **Central time** at prompt-injection
(`HAWebSocketV5._formatTimelineTimestamp`). Underlying `ai_log` entries
stay ISO 8601 for parseability.

---

## Bindings & secrets

### Worker bindings (`wrangler.toml`)

| Binding | Resource | Purpose |
|---|---|---|
| `HA_WS` | Durable Object class `HAWebSocketV5` | Singleton `ha-websocket-singleton` |
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
| `MINIMAX_API_KEY` | api.minimax.io bearer |
| `USE_NATIVE_TOOL_LOOP` | `"true"` — the chat path; legacy JSON-action fallback dormant |
| `USE_VECTOR_ENTITY_RETRIEVAL` | `"true"` flips context build to vector retrieval. Falls back to flat-list on failure. |
| `MCP_AUTH_TOKEN` | (optional) Bearer for `/mcp`. Cloudflare Access sits in front anyway. |
| `CLIMATE_PREAMBLE_ENABLED` | (optional) `"false"` disables climate preamble. |
| `ELEVENLABS_API_KEY` | (optional) `xi-api-key` for `/transcribe`. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | (optional, dormant) For when Twilio path is re-implemented. |

### Cron triggers

- `* * * * *` — `prewarmCache(env)`. Warms KV every minute; heavy refresh
  of all registries every 15 minutes; reconnects the DO if the WS is dead.
- `30 8 * * *` — daily resync + retention. 03:30 CDT (08:30 UTC):
  - `dailyKnowledgeResync(env)` — resyncs the slow-changing kinds.
  - `dailyAiLogRetention(env)` — prunes `ai_log` rows >30 days.
  - `dailyForensicLogRetention(env)` — prunes `state_changes`,
    `automation_runs`, `service_calls` rows >90 days.

---

## How a request flows

### Chat (web `/chat` SSE, MCP `ai_chat` tool)

```
POST /chat (text/event-stream)
  → DO /ai_chat_stream
    → chatWithAgentNative
       0. SSE `started` event (iOS Safari heartbeat) + 3s keepalive interval
       1. _tryDeterministicFastPath(message)  ── cover hit? log, persist
          history, emit `reply`, return. No LLM call. Sub-500ms.
       2. Load chat_history:${channelKey}
       3. _buildNativeContextEntities(message, { entityTopK: 10 })
            ├ retrieveKnowledge kinds=["entity"], k=10
            ├ retrieveKnowledge kinds=["memory"], k=5
            ├ retrieveKnowledge kinds=["observation"], k=5
            ├ retrieveKnowledge kinds=["automation"], k=3
            ├ retrieveKnowledge kinds=["device"], k=2
            └ retrieveKnowledge kinds=["service"], k=2
       4. _buildClimatePreambleIfNeeded(message)
       5. getChatSystemPrompt(ctx)
       6. runNativeToolLoop(messages, {
            maxIterations: 6,
            allowedTools: 13-tool surface,
            hallucinationGuard: true,
            maxTokens: 4096,
            onEvent
          })
            loop: callMiniMaxWithTools (45s timeout)
                  → emit `reasoning` from `reasoning_content`
                  → dispatch tool_calls (including query_state_history etc.)
                  → push results
       7. Save preserved tool-calling trace to chat_history:${channelKey}
       8. SSE events: started | thinking | reasoning | tool_call |
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

`CHAT_HTML` is a single embedded HTML/CSS/JS template in `src/worker.js`
served at `/chat`. Features:

- **Hero mic button + auto-send.** 3-state machine
  (idle / recording / processing). Records audio, POSTs to `/transcribe`,
  populates the input box, auto-submits.
- **Collapsible reasoning panel.** A `<details>` element above each
  assistant bubble surfaces the `reasoning` SSE stream
  (MiniMax `reasoning_content`). Collapsed by default.
- **Per-message buttons.** Copy, retry (on error bubbles), clear.
- **iOS Safari "Load failed" auto-retry.** Catches the iOS-specific
  error and silently retries once.
- **SSE event handling.** `started` | `reasoning` | `thinking` |
  `tool_call` | `tool_result` | `reply` | `error`.

---

## Deploy

```powershell
# From C:\Users\obert\ha-mcp-gateway
wrangler deploy
```

esbuild bundles `src/worker.js` → `dist/worker.js` automatically per the
`[build]` directive. Bindings + crons + DO migrations reconcile with
Cloudflare on each deploy.

### Smoke tests

```powershell
# One-time browser login (token cached ~24h)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access login `
  https://ha-mcp-gateway.obert-john.workers.dev

# Forensic log eyeball
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/recent_activity?hours=1"

# Forensic-log query via chat (writes to a temp file to dodge PowerShell's
# JSON quoting rules; UTF-8 without BOM is required)
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

- **DO with persistent WS holds onto its V8 isolate across deploys.**
  Cloudflare normally hibernates idle DO isolates after ~10s and reloads
  the latest code on the next request. The HA WebSocket is always active,
  so the DO never idles, so worker-side code can update for arbitrarily
  long stretches without the DO picking it up. Symptoms: worker-side
  endpoints work immediately on deploy, DO-side method-body changes
  don't. **Diagnostic playbook**: `wrangler tail --format json` and
  inspect per-event `scriptVersion.id` against the latest `wrangler
  deploy` version id. **Fix**: rename the DO class via
  `renamed_classes` migration. The class has been renamed four times
  already for this reason (`HAWebSocket` → `HAWebSocketV2` → `HAWebSocketV3`
  → `HAWebSocketV4` → `HAWebSocketV5`). Storage is preserved across renames.
- **Three redundant DO keepalives.** The persistent HA WebSocket is the
  primary; the 60s alarm (which still reschedules itself even though it
  no longer dispatches an LLM call) is the secondary; the minute-cadence
  `prewarmCache` cron is the tertiary. Removing the alarm reschedule
  would leave a 60s window in which the DO could hibernate if both the
  WS and a request happen to be quiet. Don't.
- **Pooling discipline.** Every Workers AI call uses `pooling: "cls"`.
  Mixing pooling between backfill and query produces near-random rankings.
- **`update_automation` returns 405 on this HA instance.** The MCP tool
  description and the chat system prompt both warn. Edits go through the
  HA UI manually.
- **Cloudflare Access fronts the worker.** Direct curl/Invoke-RestMethod
  hits the Access login page. Use `cloudflared access curl` or a service
  token.
- **Snapshot-oversize is best-effort.** If `state_cache_snapshot`
  exceeds 127 KB, we log `snapshot_oversize` and attempt the put anyway.
  DO storage hard limit is 128 KiB. If entity count grows past ~1500, the
  snapshot will need a tighter allowlist or chunking.
- **Iteration ceiling synthesis.** Watch `ai_log` for
  `iteration_ceiling_synthesize` — should be rare. Chat cap is 6
  iterations.
- **Fast-path observability.** Cover-command fast path tags `ai_log`
  entries with `source: "fast_path"`. To audit hit-rate or false
  positives, query `ai_log` by source.
- **Time-format leak.** Timeline timestamps are pre-formatted Central
  in the prompt. If user-facing replies show UTC/Z-suffix, MiniMax is
  copying timestamps from a tool result mid-loop (most likely
  `get_logbook`, which still returns ISO+UTC). Rule 10 in the chat
  prompt forbids this; the long-term fix is reformatting `get_logbook`
  output before pushing it back as a tool message.
- **MiniMax timeout.** Each call has a 45s `AbortController` timeout.
  Errors land in `ai_log` as `minimax_timeout`. Persistent timeouts
  usually mean api.minimax.io is degraded.
- **D1 write observability.** `_d1WriteFailures` counter on the DO
  surfaces forensic-log write failures via `/status` and the
  `cache_status` MCP tool. Spot-check periodically — silent loss of
  forensic data would be the most painful failure mode.

---

## Recent significant changes

Newest first.

- **report_bug storage architecture fix + agent error-confabulation guardrail.**
  The old `report_bug` handler wrote the entire bugs list as a single
  `bugs` array key on DO storage. Each entry carried `last_chat_turns`,
  `last_log_entries`, and full `entity_states` (raw attribute trees), so
  a handful of entries blew the 128 KiB DO value cap. Writes failed
  silently; worse, the chat agent confabulated `"Logged bug #..."` replies
  after error returns because the BUG REPORTS rule documented the
  success-shape reply without telling the model to check the result
  first. v5 migration splits storage into per-id keys (`bug:<id>` plus
  a small `bug_ids` index — FIFO 200 with delete-on-drop) and trims every
  field: attribute allowlist for `entity_states`, 1 KB cap per chat turn,
  500-char cap per log entry's `data`, and an oversize fallback that
  sheds chat turns / log entries / entity_states in that order before
  reaching 100 KiB. A new `TOOL ERROR HANDLING — NO CONFABULATION`
  block at the top of the chat system prompt forbids the agent from
  inventing success after an `error`-shaped tool result, and the
  BUG REPORTS section now explicitly says: check the result, branch on
  `ok: true` vs `error`, surface the error text verbatim. Existing
  9-entry legacy `bugs` array migrates lossless on first new write.
  Post-deploy single-entry size went from ~10 KB (array-of-bloat) to
  ~4.7 KB (trimmed per-key).
- **Forensic noise-filter expansion + observation-vector orphan cleanup.**
  Live D1 audit found `_summation_delivered` leaking 1,400+ rows/hr
  despite a source-level hard-deny rule (the rule was committed after the
  v3 isolate-refresh rename, so the running DO never picked it up). Added
  a v4 class rename (`HAWebSocketV3` → `HAWebSocketV4`) to force refresh
  and extended `_shouldLogStateChange`: domain skip for `image.*`
  (timestamp churn), suffix denylist for roborock cleaning telemetry
  (`*_cleaning_area`, `*_cleaning_time`, `*_cleaning_progress`,
  `*_filter_time_left`, `*_main_brush_time_left`, etc.), and a 2V
  voltage deadband (mains jitter ±1V is meaningless; 120V→0V power
  cycles still pass). Eight new unit-test cases. Same deploy
  rewrote `/admin/reindex-observations` to enumerate observation
  vectors via multi-probe Vectorize query (kind filter, topK=100,
  4 probes ≈ 400 IDs) and delete any not in the canonical
  topicTagFor-derived keep-set. First post-deploy run deleted 256
  orphans accumulated across earlier ref_id schema changes
  (fnv1aHex → topicTagFor in commit 59c9b69).
- **Autonomous monitor excision (3-deploy refactor).** The 60-second
  heartbeat-driven autonomous LLM monitor was removed entirely after
  ~30 days of demonstrating no useful proactive intervention. In its
  place, every HA event now lands in D1 (`state_changes`,
  `automation_runs`, `service_calls`) and the chat agent gained three
  new query tools (`query_state_history`, `query_automation_runs`,
  `query_causal_chain`) plus a `FORENSIC MEMORY` section in its prompt.
  `report_bug` lifted to MCP for parity. DO class renamed
  `HAWebSocketV2` → `HAWebSocketV3` (v3 migration) to force isolate
  refresh after the deletion landed. ~720 lines removed from
  `ha-websocket.js`; `dist/worker.js` shrank from ~390KB to ~352KB.
  See the [Story](#story-the-monitor-that-didnt-earn-its-keep) section.
- **(retired) D1 ai_log + observation cutover.** `save_observation` and
  `ai_log` writes moved exclusively to D1 with one-time migrations
  retiring the DO storage keys. `dailyAiLogRetention` cron prunes
  >30-day rows.
- **(retired) Vector-search optimization round 1.** Comprehensive
  knowledge-index pass: skip `automation.* / script.* / scene.*`
  entity-id duplicates, exempt `device_class: battery` from `is_noisy`,
  conditional-field embed text + manufacturer/model from device lookup,
  lowercase-coerce `area`, friendly-name collision guard, vector-id
  dedup, orphan diff on `force=1` rebuilds. Retrieve side: `topic_tag`
  + `min_score` filters, friendly-name dedup, observation time-decay,
  entity state-aware boost, cross-kind chat retrieval.
- **`report_bug` native tool + `/admin/bugs` + `BUGS.md` workflow.**
  Natural-language bug capture with auto-attached context (last 4 chat
  turns + last 10 `ai_log` entries + current state of cited entities).
- **HOUSE_STATE_SNAPSHOT + TRUTHFULNESS rules.** The snapshot is the
  ground-truth read on security/climate/presence; TRUTHFULNESS forbids
  unverified state claims.
- **Cover-command fast path.** Deterministic sub-500ms cover open/close
  that bypasses the LLM. Explicit `open_cover`/`close_cover`, no-op
  guard via `stateCache`, falls through to LLM on any error.
- **Multi-kind knowledge index (`ha-knowledge`).** Replaced the
  entity-only `ha-entities` index. `vector_search` native tool. Synthesis
  fallback on iteration ceiling.

`git log --oneline` walks back further; anything older than the multi-kind
index migration is foundational and unlikely to need re-reading.

---

## Iterating

Bugs caught during use are captured in chat by saying things like "that's
a bug" / "save to debug log" / "log this as broken." The chat agent calls
`report_bug`, which writes a structured entry to DO `bugs` storage
(description + last 4 chat turns + last 10 `ai_log` entries + cited entity
state).

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
(`## ~~#abc12345 — …~~`) and add `Fixed: <commit-sha>` under the body —
don't delete entries, the history is the audit trail.

---

## Things to reach for next

If iterating from here, the highest-leverage open items:

1. **Model swap.** The chat-only architecture freed up the token budget
   for a meaningfully smarter model. DeepSeek V3 (drop-in, OpenAI-compatible,
   ~$15-30/month for this household's chat volume with prompt caching),
   Claude Sonnet 4.5 (better tool-following, ~$30-90/month, requires a
   format shim from OpenAI tool_calls to Anthropic tool_use blocks), or a
   local Qwen3.6-27B / Gemma 4 31B on hardware you own. The forensic-query
   workload specifically rewards SQL fluency — DeepSeek and Claude both
   shine there.
2. **Scheduled actions.** A `schedule_action` tool that accepts natural
   language ("close the basement bay at 11 PM tonight") and stores
   intentions in D1 or DO storage, fired by a per-minute cron tick. Easy
   to layer on the post-excision architecture.
3. **Daily / weekly digest cron.** A scheduled chat call once a day that
   queries the forensic log over the last 24 hours and writes a digest
   to push notification or `ai_log`. One model call, narrative output.
4. **Backfill of `automation_runs` and `service_calls` on reconnect.**
   HA REST history doesn't expose these reliably, so today only state
   changes are backfilled. If a long outage matters, dig into HA's
   alternative endpoints.
5. **Fast-path generalization.** Cover-only today. Lights and locks
   have similar shapes; each new domain needs its own no-op guard,
   disqualifier list, question-bail tests.
6. **HOUSE_STATE_SNAPSHOT bytecount.** If the snapshot grows past
   ~60 lines, consider per-room trim driven by query intent.
7. **Service-Auth bypass for ops endpoints.** A service token with Access
   policy bypass for `/admin/*` would let ops scripts run without
   `cloudflared`.
