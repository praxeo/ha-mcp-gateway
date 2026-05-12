# ha-mcp-gateway

A Cloudflare Worker + Durable Object that bridges Home Assistant to LLMs. It
holds a persistent WebSocket to HA, exposes ~70 typed tools as an MCP server
for Claude Desktop, and runs an autonomous home agent ("MiniMax") that owns
chat and a 30-second autonomous heartbeat. State for nine entity-kinds is
embedded into a Cloudflare Vectorize index for semantic retrieval. Chat and
the autonomous monitor run on split system prompts with profile-scoped tool
sets; deterministic cover commands short-circuit the LLM via a sub-500ms
fast path.

This document is the load-bearing reference for picking up the codebase
cold — whether that's a future iteration session or another agent. It
covers architecture, repo layout, the knowledge index, the native tool
loop, agent state, bindings, and operational gotchas.

---

## Architecture

```
User (web / WhatsApp / Claude Desktop)
        │
        ▼
Cloudflare Worker (worker.js)         ◀── /mcp, /chat, /twilio, /transcribe,
   │                                       /admin/bugs, /admin/bugs/clear,
   │                                       /admin/rebuild-knowledge,
   │                                       /admin/index-stats,
   │                                       /admin/cleanup-stale-vectors,
   │                                       /admin/reindex-observations,
   │                                       /health, /refresh
   │  routing, MCP handler, CHAT_HTML, ElevenLabs STT proxy,
   │  multi-kind backfill, daily cron, bug-log markdown export
   ▼
Durable Object: HAWebSocketV2 (ha-websocket.js)
   │  singleton "ha-websocket-singleton" — owns the persistent WS
   │  in-memory stateCache, recent-events queue, cover fast path,
   │  HOUSE_STATE_SNAPSHOT builder, native tool loop, autonomous
   │  heartbeat, write-through embeds, per-channel chat_history
   ├──► Home Assistant WebSocket (port 8123, JWT auth)
   ├──► Cloudflare Vectorize "ha-knowledge"  (env.KNOWLEDGE)
   ├──► Cloudflare Workers AI @cf/baai/bge-large-en-v1.5  (env.AI)
   ├──► MiniMax M2.7-highspeed at api.minimax.io  (OpenAI-compatible)
   └──► ElevenLabs Scribe at api.elevenlabs.io       (speech-to-text)
```

Layer-by-layer:

1. **Physical devices** — Zigbee / Z-Wave / Wi-Fi plugs / ESPHome / Roku / Ecobee.
2. **Home Assistant** — open-source server owning every integration, automation, scene, script, recorder. WebSocket API on port 8123.
3. **HA Green** — a Nabu Casa appliance running HA OS on the local LAN. Cloud-relayed via Nabu Casa for remote access.
4. **ha-mcp-gateway (this repo)** — Worker + DO. Translates natural language into HA service calls. Auth: Cloudflare Access JWT for browser users; long-lived HA token in worker secret.
5. **Vectorize knowledge index (`ha-knowledge`)** — see [Knowledge index](#knowledge-index-ha-knowledge) below.
6. **MiniMax M2.7-highspeed** — chat completions + native tool calls. The DO runs the tool loop, not MiniMax. 45s timeout per call with `AbortError` handling.
7. **ElevenLabs Scribe** — `scribe_v1` speech-to-text. Worker proxies the chat UI's audio blobs through `/transcribe` and returns `{ text, language_code }`.
8. **Frontends** — Claude Desktop (MCP), `/chat` HTML UI served by the Worker (SSE-streaming, hero mic button, collapsible reasoning panel, retry/copy/clear), Twilio (WhatsApp).

---

## Repo layout

| File | Role |
|---|---|
| `src/worker.js` | Cloudflare Worker entry. Owns the MCP handler (`TOOLS` list + `handleTool` dispatch), HTTP routes (`/chat`, `/twilio`, `/transcribe`, `/admin/rebuild-knowledge`, `/admin/index-stats`, `/admin/cleanup-stale-vectors`, `/admin/reindex-observations`, `/admin/bugs`, `/admin/bugs/clear`, `/health`, `/refresh`, `/mcp`), the embedded `CHAT_HTML` UI (mic, reasoning panel, retry/copy/clear, iOS Safari "Load failed" auto-retry), the ElevenLabs STT proxy, the `formatBugsAsMarkdown` helper, KV cache helpers (states/registries), the multi-kind `backfillKnowledge` (with friendly-name collision guard, vector-id dedup, and orphan-diff cleanup on force rebuilds), and the `scheduled()` cron handler with daily resync. |
| `src/ha-websocket.js` | Durable Object class `HAWebSocketV2` (renamed from `HAWebSocket` via v2 migration to force isolate refresh). Holds the persistent HA WebSocket, in-memory `stateCache`, recent-events queue. **Two system prompts**: `getChatSystemPrompt` (chat profile, with CHAT ACTION CONFIRMATION) and `getNativeAgentSystemPrompt(role, ctx)` (autonomous + shared, with AUTONOMOUS ACTION SAFETY). Both inject a live `_buildHouseStateSnapshot()` block plus six semantic top-K blocks (entity, memory, observation, automation, device, service). Two execution paths: `chatWithAgentNative` (user-driven, SSE) and `runAIAgentNative` (heartbeat). Cover-command fast path (`_tryDeterministicFastPath`) short-circuits the LLM. The native tool loop (`runNativeToolLoop`), action executor (`executeAIAction` with PINNED-prefix memory FIFO exemption), tool dispatcher (`executeNativeTool`), multi-kind retriever (`retrieveKnowledge` — applies area lowercase normalization, topic_tag bracket-normalization + client-side filter, default min_score floor of 0.50, friendly_name dedup, observation time-decay, entity state-aware boost), write-through embed/upsert helpers (auto-stamp `created_at`), per-channel `chat_history:${channelKey}`, sharded `last_indexed_ids_v1` for orphan diff. |
| `src/agent-tools.js` | OpenAI-format tool schemas passed to MiniMax. 4 action tools (`call_service`, `ai_send_notification`, `save_memory`, `save_observation`) + 5 read tools (`get_state`, `get_logbook`, `render_template`, `vector_search`, `get_automation_config`) + 1 chat-only meta tool (`report_bug` — captures user-flagged issues to DO `bugs` storage). `vector_search` accepts `query`, `kinds` (REQUIRED in practice), `domain`, `area` (case-insensitive), `topic_tag` (with or without brackets), `min_score` (default 0.50), `top_k` (max 50), `include_noisy`. Exports `NATIVE_AGENT_TOOLS`, `NATIVE_TOOL_NAMES`, `NATIVE_ACTION_TOOL_NAMES`, and `CHAT_ALLOWED_TOOL_NAMES` (chat profile excludes `save_memory` + `save_observation`; autonomous excludes `report_bug`). |
| `src/vectorize-schema.js` | Canonical metadata schema (incl. `created_at` for memory/observation), `vectorIdFor(kind, refId)`, FNV-1a hash, per-kind embed-text builders (entity embed includes `manufacturer` + `model` from device lookup; conditional fields drop empty placeholders), `isNoisyEntity` (with `device_class: "battery"` exemption from the diagnostic-flag) / `isNoisyService` / `entityCategoryFor` helpers, `buildMetadata` (lowercase-coerces `area`, string-coerces `is_noisy`, propagates `created_at`). Imported by both worker.js and ha-websocket.js. |
| `wrangler.toml` | Bindings (HA_WS, HA_CACHE, KNOWLEDGE, AI), build command (esbuild bundles `src/worker.js` → `dist/worker.js`), cron triggers (`* * * * *` cache prewarm, `30 8 * * *` daily knowledge resync), DO migrations v1 (`new_classes` for `HAWebSocket`) + v2 (`renamed_classes` to `HAWebSocketV2`). `compatibility_date = "2026-05-09"`. |
| `dist/worker.js` | esbuild output. **Build artifact — never edit.** |
| `.dev.vars` | Local-dev secrets. Never committed. |

---

## Knowledge index (`ha-knowledge`)

Cloudflare Vectorize, 1024-dim, cosine, model `@cf/baai/bge-large-en-v1.5`,
**pooling `cls`** (must match at backfill and query time — mismatched pooling
gives near-random rankings).

### Metadata schema

| Field             | Type   | Filterable? | Notes                                    |
|-------------------|--------|-------------|------------------------------------------|
| `kind`            | string | ✓           | `entity` `automation` `script` `scene` `area` `device` `service` `memory` `observation` |
| `ref_id`          | string |             | entity_id, automation HA-internal id, `<domain>.<service>`, `fnv1aHex(text)`, … |
| `friendly_name`   | string |             | Display label (first 80 chars for memory/observation) |
| `domain`          | string | ✓           | Entity domain for entity kind, kind name otherwise |
| `area`            | string | ✓           | Resolved area name, "" if none |
| `entity_category` | string | ✓           | `primary` `diagnostic` `config` (entity-only; "primary" otherwise) |
| `is_noisy`        | string | ✓           | `"true"` / `"false"` (string-typed metadata index). `device_class: battery` is exempted from the diagnostic-flag so battery sensors are visible without `include_noisy`. |
| `topic_tag`       | string | ✓           | Bracketed prefix for observations (`"[topic-name]"`), "" otherwise. `retrieveKnowledge` normalizes input — callers can pass `"foo"` or `"[foo]"`. |
| `hash`            | string |             | fnv1a of embed text — change detection |
| `created_at`      | string |             | ISO timestamp on memory/observation — drives time-decay scoring at retrieve. Auto-stamped on write-through. Not filterable. |
| `device_class`    | string |             | Entity-only extra; not filterable |

`is_noisy` is stored as the literal strings `"true"` / `"false"` because
the metadata index is declared `--type=string`. **Only `buildMetadata` in
`src/vectorize-schema.js` writes those literals** — every callsite passes
a JS boolean and lets `buildMetadata` coerce.

Default vector_search filters out `is_noisy: "true"` records. Pass
`include_noisy: true` to include them.

### Vector ID format

`{kind}:{ref_id}` truncated to 64 bytes with an `_<fnv1aHex>` suffix when
the prefixed form would exceed the cap. `vectorIdFor(kind, refId)` is the
single source of truth.

### Refresh strategy

| Kind         | Refresh trigger                                                 |
|--------------|-----------------------------------------------------------------|
| entity       | event-driven (`entity_registry_updated`) + nightly cron resweep |
| device       | event-driven (`device_registry_updated`) + nightly cron resweep |
| memory       | write-through (`executeAIAction.save_memory`)                   |
| observation  | write-through (`executeAIAction.save_observation`)              |
| automation   | nightly cron                                                    |
| script       | nightly cron                                                    |
| scene        | nightly cron                                                    |
| area         | nightly cron                                                    |
| service      | nightly cron                                                    |

`executeAIAction` for memory/observation also handles vector cleanup on
FIFO eviction and on `replaces`-prefix observation supersede.

### Endpoints

- `POST /admin/rebuild-knowledge?force=1&kinds=a,b,c` — multi-kind
  backfill. Both query params optional. Skips unchanged docs by hash
  unless `force=1`. On `force=1` runs an orphan diff against
  `last_indexed_ids_v1` (sharded across DO storage keys at 1500 ids each)
  and deletes vectors no longer in the build set. Returns
  `{ total_docs, deduped_docs, embedded, skipped, errors,
  collisions_by_kind, orphans_deleted, kinds, duration_ms }`.
- `GET /admin/index-stats` — last-N (20) backfill summaries from DO
  storage `index_stats_v1`. Useful for watching collision counts and
  orphan deletes over time.
- `POST /admin/cleanup-stale-vectors` — one-shot legacy cleanup.
  Computes deterministic vector ids for `automation.* / script.* /
  scene.*` entity-kind dupes (left over from when `buildEntityDocs` also
  indexed those domains) plus slug-form `kind:automation`/`script`/`scene`
  ref_ids, and deletes them via `KNOWLEDGE.deleteByIds` (batches of 100,
  the Vectorize cap). Idempotent — re-running is a no-op.
- `POST /admin/reindex-observations` — delete all observation vector ids
  then force-rebuild the observation kind. Use when the Vectorize
  metadata index for a property was created after vectors existed and
  needs fresh INSERT semantics to populate (per Cloudflare's rule that
  metadata indexes only apply to vectors inserted after the index is
  created).
- DO `POST /vector_search` — internal endpoint the Worker delegates to
  for the `vector_search` MCP/native tool. Body: `{query, kinds, domain,
  area, topic_tag, min_score, top_k, include_noisy}`. `top_k` clamped
  `[1, 50]`. Internally over-fetches to 50 when `topic_tag` is set so
  client-side bracket-normalized filtering doesn't miss matches outside
  the top semantic neighborhood.
- DO `POST /index_stats_update` / `GET /index_stats_read` — backfill
  summary persistence; used by the worker after each rebuild.
- DO `POST /last_indexed_ids_write` / `GET /last_indexed_ids_read` —
  sharded id-set persistence used by the orphan diff.

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

`_buildHouseStateSnapshot()` ([ha-websocket.js:204](src/ha-websocket.js))
emits a small text block injected into both system prompts every turn,
read directly from the in-memory `stateCache`. It groups a curated set of
entity IDs (locks, garage/basement bay covers, the two thermostats with
inline `current/target/hvac_action`, presence trackers, whole-home power,
key contact sensors, and a few mode booleans) and prints
`<entity_id> (<friendly_name>): <state>` with cover position rendered
inline when present.

Why it exists:

- **Authoritative for the listed entities.** The prompt tells MiniMax
  the snapshot is regenerated every turn from live cache and to trust it.
  This is what makes the TRUTHFULNESS rule enforceable — the agent has a
  ground-truth read on the security/climate/presence surface without
  needing a tool call.
- **Aggregation guard.** Aggregate claims like "everything secure" or
  "all garage doors closed" are explicitly forbidden unless every
  asserted entity is in the snapshot or the agent called `get_state` on
  it this turn.
- **Fast-path enables.** The cover fast path uses the same `stateCache`
  for its no-op guard — if the target is already in the requested state,
  it replies "already closed" without firing a service call.

Anything not in the snapshot is fair game for `get_state` /
`vector_search`; the prompt explicitly says so.

---

## Native tool loop

MiniMax is given OpenAI-format tool schemas (`NATIVE_AGENT_TOOLS` in
`agent-tools.js`). The DO drives the loop: send messages, read
`tool_calls`, dispatch via `executeNativeTool`, push tool results back,
repeat until MiniMax emits no `tool_calls`. Each MiniMax call has a 45s
timeout with `AbortError` handling.

Caps:

- **Chat path** (`chatWithAgentNative`): `maxIterations: 6`,
  `maxTokens: 4096`, `hallucinationGuard: true`. The chat profile filters
  `NATIVE_AGENT_TOOLS` through `CHAT_ALLOWED_TOOL_NAMES` (8 tools —
  `save_memory` and `save_observation` are excluded; the autonomous
  monitor picks those up from the timeline). Synthesis fallback on
  overflow — pushes a "stop using tools, compose now" user message and
  re-calls MiniMax with `tools: []` so the model produces prose from
  work-so-far instead of a tool trace.
- **Autonomous path** (`runAIAgentNative`): `maxIterations: 8`,
  `maxTokens: 8192`, `hallucinationGuard: false`, tool set is
  `NATIVE_AGENT_TOOLS` minus `report_bug` (no user to flag bugs in the
  unattended path) — 9 tools.

Tool surface (10 total):

| Tool | Side effect | Chat? | Auto? | Notes |
|---|---|---|---|---|
| `call_service` | yes | ✓ | ✓ | Any HA service. Post-action verify `get_state` for `climate` / `lock` / `cover`. |
| `ai_send_notification` | yes | ✓ | ✓ | `notify.notify` call + writes a `notification` entry to `ai_log`. |
| `save_memory` | yes | ✗ | ✓ | Append to `ai_memory` (100 FIFO). Embed + upsert. Evicted entries get vector-deleted. |
| `save_observation` | yes | ✗ | ✓ | Append to `ai_observations` (500 FIFO). Embed + upsert. `replaces` prefix-deletes existing entries (and their vectors). |
| `get_state` | no | ✓ | ✓ | stateCache hit; force_refresh fetches via WS. |
| `get_logbook` | no | ✓ | ✓ | HA `/api/logbook`. Tool description requires explicit TZ offset (`-05:00` for CDT). |
| `render_template` | no | ✓ | ✓ | HA `/api/template`. Jinja2 evaluation. |
| `vector_search` | no | ✓ | ✓ | DO `/vector_search` → `retrieveKnowledge`. Multi-kind metadata-filtered semantic search. Args: `query`, `kinds` (REQUIRED in practice — never call without), `domain` (entity-only), `area` (case-insensitive — must match HA area name), `topic_tag` (bare or bracketed), `min_score` (default 0.50), `top_k` (max 50), `include_noisy`. Applies friendly_name dedup, observation time-decay (~14% over 30 days), entity state-aware boost (+0.05 for active/recently-changed). |
| `get_automation_config` | no | ✓ | ✓ | HA `/api/config/automation/config/{id}`. Returns trigger/condition/action body for automation debugging. `render_template` cannot substitute. |
| `report_bug` | log-only | ✓ | ✗ | User-flagged issue capture. Writes a structured entry (description + last 4 chat turns + last 10 `ai_log` entries + current state of cited entities) to DO `bugs` storage (FIFO 200). Surfaced via `/admin/bugs`. See [BUGS.md](BUGS.md) and the BUG REPORTS prompt section. |

Action tools are dispatched through `executeAIAction` with
`source="native_loop"` so the unified `ai_log` records who did what
(`legacy_json` / `native_loop` / `tool_call` / `fast_path`).

Tool messages persisted into `chat_history` are truncated at 4 KB
(`TOOL_CONTENT_CAP`) so that long `vector_search` / `render_template`
results don't bloat the byte budget across turns.

### System prompt structure

The chat and autonomous monitor have diverged. Both prompts inject
`getAgentContext()` (architecture self-knowledge), the
HOUSE_STATE_SNAPSHOT, gateway health, the unified timeline, semantic top-K
memories/observations, and the relevant-entity slice. Differences:

| Section                       | Chat       | Autonomous |
|-------------------------------|------------|------------|
| ARCHITECTURE / GATEWAY HEALTH | ✓          | ✓          |
| HOUSE_STATE_SNAPSHOT          | ✓          | ✓          |
| Tool list (in prompt)         | 8 tools    | 9 tools    |
| MODE block                    | implicit   | role=`autonomous` or `chat` |
| YOUR MEMORY / OBSERVATIONS    | ✗ (chat doesn't write) | ✓ |
| OPERATIONAL REMINDERS         | QUICK FACTS only | full 11-item list |
| RETRIEVAL DISCIPLINE          | ✓          | ✓          |
| TRUTHFULNESS — STATE CLAIMS   | ✓          | ✓          |
| BUG REPORTS                   | ✓          | ✗          |
| CHAT ACTION CONFIRMATION      | ✓          | ✗          |
| AUTONOMOUS ACTION SAFETY      | ✗          | ✓ (role=autonomous only) |

`CHAT ACTION CONFIRMATION` enforces a Case-A / Case-B asymmetry: a
direct user instruction acts immediately; an agent-proposed action
requires explicit affirmative confirmation (no charitable interpretation
of "ok"/"sure"/emoji/silence) before it actuates a cover, lock, alarm,
or high-power appliance.

`AUTONOMOUS ACTION SAFETY` lists hard-NEVER actions for the unattended
heartbeat path: covers (open OR close), locks (unlock), alarm modify,
oven/stove/water-heater operation, and out-of-range climate setpoints.
For these, the agent must `ai_send_notification` and stop.

`BUG REPORTS` (chat-only) tells the model when to call `report_bug`:
explicit recording-verb + issue-noun phrases ("that's a bug", "save to
debug log", "log this as broken", etc.). Negative cases — venting,
corrections, questions, preferences — explicitly do not fire. If
intent is ambiguous, the model asks "Want me to log that as a bug?"
and only fires on explicit confirmation. After a successful call the
reply is brief: "Logged bug #&lt;id&gt; — &lt;summary&gt;." No fix attempts;
fixes happen in code on the next iteration.

`TRUTHFULNESS — STATE CLAIMS` (both prompts) forbids state assertions or
aggregations the agent hasn't verified this turn from the snapshot,
`get_state`, or pre-injected context. Anchors the no-fabrication rule.

### Cover-command fast path

`_tryDeterministicFastPath(message)` runs at the top of
`chatWithAgentNative`. It short-circuits to a direct `cover.open_cover`
or `cover.close_cover` service call when:

1. The text contains an open-verb (`open|raise|lift`) XOR a close-verb
   (`close|shut|lower|drop`) — never both.
2. The text is not a question — bails on trailing `?` or sentence-initial
   `did|do|does|is|are|was|were|have|has|had`.
3. A target entity matches: explicit phrases (`left basement`, `basement
   bay`, `right basement`, `basement door`, `main garage`, `garage door`,
   `garage bay`) always match; the bare-noun fallbacks (`basement`,
   `garage`) match only when the disqualifier regex
   (`exterior|interior|front|back|rear|side|patio|sliding|french|storm|
   screen|porch|walkout|cellar|deadbolt|latch|lock|window|vent|hatch|
   gate|light|fan|switch`) does NOT fire.
4. The cover is not already in the target state (`open` no-ops if
   `open|opening`, `close` no-ops if `closed|closing`).

On a match: explicit `open_cover` / `close_cover` (NEVER `toggle`),
`ai_log` entry tagged `source: "fast_path"`, reply persisted to
`chat_history`, SSE `reply` event emitted. Returns
`{ reply, actions_taken, fast_path: true }`. On any error, falls through
to the LLM path.

Sub-500ms typical. Search `ai_log` for `fast_path=true` to count
hit-rate.

---

## Agent state buckets

| Bucket | Storage key | Cap | Semantics |
|---|---|---|---|
| `ai_memory` | DO storage | 100 FIFO | Confirmed long-term facts. Embedded into KNOWLEDGE on write. Memories prefixed with `PINNED:` are exempt from FIFO eviction (architectural facts, presence rules, naming conventions shouldn't be lost to rapid arrival/departure churn). If all 100 slots are pinned, the list grows rather than dropping pinned content. |
| `ai_observations` | DO storage | 500 FIFO | Hypotheses-in-progress, prefixed with `[topic-tag]`. Embedded into KNOWLEDGE on write. `replaces` prefix-supersede. |
| `ai_log` | DO storage `ai_log` (last 150 compacted) + in-memory ring (1000) | 1000 in-memory / 150 persisted | Unified timeline: `chat_user`, `chat_reply`, `action`, `action_verified`, `notification`, `decision`, `state_change`, `memory_saved`, `observation_saved`, `vector_*`, errors. Source-tagged. |
| `chat_history:${channelKey}` | DO storage | 10 user turns / 110 KB byte cap per channel | OpenAI-format messages including `tool_calls` and `tool` results — preserves full tool-calling trace across turns. Per-channel: web / Twilio / each Twilio number gets its own slot via `sanitizeChannelKey(from)`. Tool-message `content` is truncated at 4 KB (`TOOL_CONTENT_CAP`) before persisting. |
| `state_cache_snapshot` | DO storage | 127 KB cap | Hibernation snapshot for cold-start. Filtered to a domain allowlist (`SNAPSHOT_DOMAIN_ALLOWLIST`) + sensor whitelist + battery threshold. Logs `snapshot_oversize` and attempts the put even at over-cap (silent skip is worse than a put-exception we already catch). |

Timeline timestamps are reformatted to **Central time** at prompt-injection
(`HAWebSocket._formatTimelineTimestamp`). Underlying `ai_log` entries stay
ISO 8601 for parseability.

---

## Bindings & secrets

### Worker bindings (`wrangler.toml`)

| Binding | Resource | Purpose |
|---|---|---|
| `HA_WS` | Durable Object class `HAWebSocket` | Singleton `ha-websocket-singleton` |
| `HA_CACHE` | KV namespace | TTL'd cache for HA registries / states between cold starts |
| `KNOWLEDGE` | Vectorize index `ha-knowledge` | Multi-kind semantic index |
| `AI` | Workers AI | `@cf/baai/bge-large-en-v1.5` embeddings (cls pooling) |
| `DB` | D1 database `ha_db` | Relational store for `ai_log`, `observations`, `bugs`. Currently dual-written alongside DO storage on `save_observation`; reads still come from DO storage. Staged migration — read flip lands in a later dispatch. |

### Worker secrets (`wrangler secret`)

| Secret | Purpose |
|---|---|
| `HA_URL` | HA base URL (Nabu Casa cloud-relayed) |
| `HA_TOKEN` | Long-lived HA access token |
| `MINIMAX_API_KEY` | api.minimax.io bearer |
| `TWILIO_ACCOUNT_SID` | WhatsApp/SMS inbound auth |
| `TWILIO_AUTH_TOKEN` | (same) |
| `USE_NATIVE_TOOL_LOOP` | `"true"` flips chat + autonomous to the native tool path. Legacy JSON-action path retained but dormant. |
| `USE_VECTOR_ENTITY_RETRIEVAL` | `"true"` flips context build to vector retrieval. Falls back to flat-list `_buildFlatContextEntities` on failure. |
| `MCP_AUTH_TOKEN` | (optional) Bearer for `/mcp` route. Cloudflare Access sits in front anyway. |
| `CLIMATE_PREAMBLE_ENABLED` | (optional) Set to `"false"` to disable the climate-preamble injection on HVAC-related prompts. |
| `ELEVENLABS_API_KEY` | (optional) `xi-api-key` for the `/transcribe` ElevenLabs Scribe STT proxy. Without it the chat UI's mic button returns an error; chat still works typed. |

Cron triggers:

- `* * * * *` — `prewarmCache(env)`. Warms KV every minute; heavy
  refresh of all registries every 15 minutes; reconnects the DO if the
  WebSocket is dead.
- `30 8 * * *` — `dailyKnowledgeResync(env)`. 03:30 CDT (08:30 UTC).
  Resyncs `automation`, `script`, `scene`, `area`, `device`, `service`
  kinds. Skips unchanged docs by hash.

The `scheduled()` handler dispatches on `event.cron`.

---

## How a request flows

### Chat (web `/chat` SSE, Twilio webhook, MCP `ai_chat` tool)

```
POST /chat (text/event-stream)
  → DO /ai_chat_stream
    → chatWithAgentNative
       0. SSE `started` event (iOS Safari heartbeat before model latency)
       1. _tryDeterministicFastPath(message)  ── hit? log, persist
          history, emit `reply`, return. No LLM call.
       2. Load chat_history:${channelKey}
       3. _buildNativeContextEntities(message, { entityTopK: 10 })
            ├ retrieveKnowledge kinds=["entity"], k=10
            ├ retrieveKnowledge kinds=["memory"], k=5
            ├ retrieveKnowledge kinds=["observation"], k=5
            ├ retrieveKnowledge kinds=["automation"], k=3
            ├ retrieveKnowledge kinds=["device"], k=2
            └ retrieveKnowledge kinds=["service"], k=2
          (six parallel calls — cross-kind context so action queries
           like "turn on the dock light" have the relevant automation +
           device pre-injected without an extra round-trip)
       4. _buildClimatePreambleIfNeeded(message)
       5. getChatSystemPrompt(ctx)         ── chat profile prompt
       6. runNativeToolLoop(messages, {
            maxIterations: 6,
            allowedTools: NATIVE_AGENT_TOOLS.filter(CHAT_ALLOWED_TOOL_NAMES),
            hallucinationGuard: true,
            maxTokens: 4096,
            onEvent
          })
            loop: callMiniMaxWithTools (45s timeout) → emit `reasoning`
            from `reasoning_content` → dispatch tool_calls → push results
       7. Save preserved tool-calling trace to chat_history:${channelKey}
          (10 turns / 110 KB / 4 KB tool-content cap)
       8. SSE events: started | thinking | reasoning | tool_call |
          tool_result | reply | error
```

### Speech-to-text (`/transcribe`)

```
Browser (chat UI mic button) ──multipart audio──► /transcribe
  → Worker forwards to api.elevenlabs.io/v1/speech-to-text
    with model=scribe_v1, xi-api-key=env.ELEVENLABS_API_KEY
  → returns { text, language_code }
  → UI populates the input box and auto-sends
```

### Autonomous heartbeat (every alarm tick when events queued)

```
DO alarm() every 60s
  → if recentEvents.length > 0 || 15-min heartbeat
    → runAIAgentNative
       1. Load ai_memory, ai_observations
       2. _buildNativeContextEntities(eventQuery)
       3. getNativeAgentSystemPrompt("autonomous", ctx)
       4. runNativeToolLoop(messages, {
            maxIterations: 8,
            allowedTools: NATIVE_AGENT_TOOLS,        // full 9-tool set
            hallucinationGuard: false,
            maxTokens: 8192
          })
       5. logAI("decision", ...)
```

`onEvent` callback fires only on the chat path (it backs SSE).

### Registry events → incremental re-embed

```
HA event entity_registry_updated  → handleEntityRegistryUpdated  → reembedRefs({ kind: "entity", ... })
HA event device_registry_updated  → handleDeviceRegistryUpdated  → reembedRefs({ kind: "device", ... }) AND ({ kind: "entity", refIds: [device's entities] })
```

---

## Chat UI surface

`CHAT_HTML` is a single embedded HTML/CSS/JS template in
[src/worker.js:666–1665](src/worker.js) served at `/chat`. Key
client-side features:

- **Hero mic button + auto-send.** 3-state machine
  (idle / recording / processing). Records audio, POSTs to
  `/transcribe`, populates the input box, and auto-submits the
  transcribed text.
- **Collapsible reasoning panel.** A `<details>` element above each
  assistant bubble surfaces the `reasoning` SSE stream
  (MiniMax `reasoning_content`). Collapsed by default.
- **Per-message buttons.** Copy (toggles to "copied" briefly), retry
  (visible only on error bubbles, re-sends the last user message),
  clear (wipes the chat, restores welcome screen).
- **iOS Safari "Load failed" auto-retry.** The chat fetcher catches
  the iOS-specific `Load failed` error and silently retries the request
  once before bubbling the error up.
- **SSE event handling.** Listens for `started` (heartbeat),
  `reasoning` (panel update), `thinking` / `tool_call` / `tool_result`
  (live trace), `reply` (final), `error`.

---

## Deploy

```powershell
# From C:\Users\obert\ha-mcp-gateway
wrangler deploy
```

esbuild bundles `src/worker.js` → `dist/worker.js` automatically per the
`[build]` directive. Bindings + crons get reconciled with Cloudflare on
each deploy.

### Smoke tests (Cloudflare Access in front — use cloudflared)

```powershell
# One-time browser login (token cached ~24h)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access login `
  https://ha-mcp-gateway.obert-john.workers.dev

# Full backfill
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/rebuild-knowledge?force=1" `
  -X POST --max-time 300

# Vector search via chat (writes to a temp file to dodge PowerShell's
# JSON quoting rules; UTF-8 without BOM is required)
$tmp = "$env:TEMP\probe.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($tmp,
  '{"message":"Use vector_search to find dock lighting entities. Top 5."}',
  $utf8NoBom)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/chat" --silent -X POST `
  -H "Content-Type: application/json" --data-binary "@$tmp"
```

Acceptance benchmarks (post-rebuild): expected ~2,500–3,500 vectors
total, scored matches ≥ 0.65 for in-domain queries, zero `*_commands_tx`
counters in default queries.

Round-1 quick checks (post-rebuild + cleanup):

```powershell
$gw = "https://ha-mcp-gateway.obert-john.workers.dev"

# Backfill summary — collisions_total should be small and steady
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "$gw/admin/index-stats"

# One-shot legacy cleanup (idempotent — safe to re-run)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "$gw/admin/cleanup-stale-vectors" -X POST

# topic_tag filter probe — both forms should return the same N
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "$gw/chat" -X POST -H "Content-Type: application/json" --data-binary `
  '{"message":"vector_search kinds=[\"observation\"] topic_tag=\"some-tag\" query=\"x\" top_k=5"}'
```

---

## Operational notes

- **DO with persistent WS holds onto its V8 isolate across deploys.**
  Cloudflare normally hibernates idle DO isolates after ~10s and reloads
  the latest deployed code on the next request. The HA WebSocket is
  always active, so the DO never idles, so worker code can update for
  arbitrarily long stretches without the DO picking it up. Symptoms:
  worker-side endpoints work immediately on deploy, DO-side method-body
  changes don't. **The diagnostic playbook is `wrangler tail
  --format json` and inspect the per-event `scriptVersion.id` against
  the latest `wrangler deploy` version id.** Each event in the JSON
  output also has an `entrypoint` field (e.g., `HAWebSocketV2`) and a
  `logs[]` array; instrument the suspect function with a `console.log`,
  redeploy, and confirm whether new-code logs appear before reaching
  for refresh tricks (class rename via `renamed_classes` migration,
  `compatibility_date` bump, or the heavy
  `wrangler delete` + `wrangler deploy` reset). The class was renamed
  `HAWebSocket` → `HAWebSocketV2` once already as part of this round's
  workaround attempts; storage was preserved, the rename is permanent.
  See the resolved `#vec-topic-tag-filter` entry in [BUGS.md](BUGS.md)
  for the full narrative — the actual bug ended up being a missing
  arg-pass-through in the dispatcher, not a stale isolate; the tail-
  with-version-ids check would have caught it on the first probe.
- **Pooling discipline.** Every Workers AI call uses `pooling: "cls"`.
  Mixing pooling between backfill and query produces near-random rankings.
- **Native loop is the live path.** `USE_NATIVE_TOOL_LOOP="true"` is set.
  Legacy JSON-action path (`chatWithAgent` / `runAIAgent`) is retained for
  rollback. Both call into `executeAIAction` so memory/observation/
  notification semantics are identical across paths.
- **`update_automation` returns 405 on this HA instance.** The MCP tool
  description warns; the agent system prompt warns. Edits go through the
  HA UI manually.
- **`ai_chat` is not a native tool — no recursion.** The agent can't
  invoke itself as a tool. (`talk_to_agent` is an MCP-only alias.)
- **Cloudflare Access fronts the worker.** Direct curl/Invoke-RestMethod
  hits the Access login page. Use `cloudflared access curl` or a service
  token. Service Auth is the right long-term setup for ops scripts.
- **Snapshot-oversize is best-effort.** If `state_cache_snapshot` exceeds
  127 KB, we log `snapshot_oversize` and attempt the put anyway. DO
  storage hard limit is 128 KiB. If you grow past 1500+ entities the
  snapshot will need a tighter allowlist or chunking.
- **Iteration ceiling synthesis.** Watch `ai_log` for
  `iteration_ceiling_synthesize` — should be rare. Caps are now
  chat=6, autonomous=8. Frequent chat-path occurrence means questions
  are routinely needing more than 6 tool calls (consider bumping or
  splitting), OR specific tools are returning verbose results that
  bloat per-iteration cost.
- **Fast-path observability.** Cover-command fast path tags
  `ai_log` entries with `source: "fast_path"` and includes
  `fast_path: true` on the chat-summary entry. To audit hit-rate, grep
  for `fast_path=true` in chat completions vs total chats. To audit
  for false positives (fast-path firing on a question or non-cover
  intent), look for fast-path action entries that the user followed
  with "no, I meant…" or "stop." If observed, tighten the disqualifier
  regex in `_tryDeterministicFastPath`.
- **Time-format leak.** Timeline timestamps are pre-formatted Central in
  the prompt. If user-facing replies still show UTC/Z-suffix it means
  MiniMax is copying timestamps from a tool result mid-loop (most
  likely `get_logbook`, which returns ISO+UTC). Rule 10 in OPERATIONAL
  REMINDERS forbids this; if it slips through, consider reformatting
  `get_logbook` results before pushing them back as tool messages.
- **MiniMax timeout.** Each call has a 45s `AbortController` timeout.
  Errors land in `ai_log` as `minimax_timeout`. Persistent timeouts
  usually mean api.minimax.io is degraded — the legacy JSON-action
  path is retained for rollback if needed (see
  `USE_NATIVE_TOOL_LOOP="true"`).
- **ElevenLabs cost.** Scribe is billed per audio minute. The mic
  button records on hold/click only; runaway recordings can rack up
  cost. There's no rate limit in the proxy today — relevant if usage
  scales beyond the household.

---

## Recent significant changes

Newest first. `git log --oneline` walks back further; anything older than
9acf9bc is foundational and unlikely to need re-reading.

- **(unreleased — D1 dual-write, step 1–2 of 6)** — wired the existing
  `ha_db` D1 instance into the worker as `env.DB` and dual-write
  `save_observation` through to `D1.observations` (PK `topic_tag`,
  `INSERT OR REPLACE`) alongside the existing DO storage + Vectorize
  path. DO storage remains the read source during this transition; D1
  is being populated in parallel so a later dispatch can flip reads
  safely. Migration `0001_d1_indexes_and_columns.sql` adds indexes on
  `ai_log(timestamp,type)`, `observations(timestamp)`,
  `bugs(severity,timestamp_iso)`, plus a nullable `observations.data`
  column for future structured payloads. D1 write failure is non-fatal
  (logs `d1_save_observation_failed`); rollback is a one-line comment.
- **(unreleased — vector-search optimization round 1)** — comprehensive
  pass on the `ha-knowledge` index after a probing session uncovered
  duplication, missing battery sensors, and case-sensitive area
  filtering as top issues. Backfill side: skip `automation.* / script.*
  / scene.*` entity-ids in `buildEntityDocs` (covered by their dedicated
  kinds), exempt `device_class: battery` from the `is_noisy` diagnostic
  flag, conditional-field embed text + manufacturer/model from device
  lookup (so hardware-code queries like `tz3210` rank the right
  device), lowercase-coerce `area` in metadata, friendly-name collision
  guard during upsert (kinds `automation/script/scene/area` only),
  vector-id dedup, orphan diff against
  `last_indexed_ids_v1` on `force=1` rebuilds. Retrieve side: extra
  filter params `topic_tag` (with bracket-normalization — accepts
  `"foo"` or `"[foo]"`) and `min_score` (default 0.50, the empirical
  noise floor for bge-large-en-v1.5 on this corpus), friendly-name
  dedup pass on the result set, observation time-decay (~14% over 30
  days), entity state-aware boost (+0.05 for active/recently-changed),
  cross-kind chat retrieval (entity + memory + observation +
  automation + device + service — six parallel calls). Memory FIFO
  exempts `PINNED:` prefix from eviction. New admin endpoints
  `/admin/index-stats`, `/admin/cleanup-stale-vectors`,
  `/admin/reindex-observations`. DO class renamed
  `HAWebSocket` → `HAWebSocketV2` (v2 migration, state preserved).
  `compatibility_date` bumped to `2026-05-09`.
- **(unreleased)** — `report_bug` native tool (chat-only) +
  `/admin/bugs` GET / `/admin/bugs/clear` POST + `BUGS.md` workflow.
  Natural-language bug capture: when the user explicitly tags an issue
  ("that's a bug", "save to debug log"), MiniMax writes a structured
  entry to DO `bugs` storage with auto-attached context (last 4 chat
  turns, last 10 ai_log entries, cited entity states). Iteration ritual
  pulls as Markdown, prepends to BUGS.md, clears the bucket.
- **9842540** — fast-path bails on questions ("did you close the
  basement?"). Trailing `?` and sentence-initial state verbs return null.
- **9707c0f** — fast-path bare-noun (`basement` / `garage`) fallbacks
  gated by a non-cover disqualifier (locks, vents, windows, side doors).
- **73fbb91** — deterministic fast path for cover commands. Sub-500ms.
  Always explicit `open_cover`/`close_cover`, never `toggle`. No-op guard
  via `stateCache`. Falls through to LLM on any error.
- **953aab6** — HOUSE_STATE_SNAPSHOT injection in both prompts +
  TRUTHFULNESS / AUTONOMOUS ACTION SAFETY / CHAT ACTION CONFIRMATION
  prompt sections. The snapshot is the ground-truth read on
  security/climate/presence; TRUTHFULNESS forbids unverified state
  claims; AUTONOMOUS ACTION SAFETY hard-bans covers/locks/alarms in the
  unattended path.
- **6a14a90** — `get_automation_config` native tool, UTC-timestamp
  paraphrasing rule, vector_search retrieval discipline.
- **f352e7f** — mic-label overflow CSS fix.
- **1c272d4** — collapsible `<details>` reasoning panel + hero mic
  button with auto-send.
- **3a18a20** — fix: read reasoning from `reasoning_content` field, not
  content tags.
- **58861da** — render reasoning traces in chat UI.
- **b75932c** — surface MiniMax `reasoning_content` as SSE
  `reasoning` events.
- **b2771f0** — fix: dispatch native tools through `executeNativeTool`
  (Patch 2.4 regression).
- **f07c88d** — `started` SSE event + iOS Safari "Load failed"
  auto-retry.
- **37e0a01** — chat/monitor system-prompt split + 45s MiniMax timeout
  + SSE transport hardening.
- **b4b2f08** — `CHAT_ALLOWED_TOOL_NAMES` export (chat profile excludes
  `save_memory`, `save_observation`).
- **d9e7c13** — clear / retry / copy buttons in chat UI.
- **f095d78** — ElevenLabs Scribe STT integration + `/transcribe`
  worker route + `ELEVENLABS_API_KEY` secret.
- **9acf9bc** — multi-kind knowledge index (`ha-knowledge`) replacing
  entity-only `ha-entities`. `vector_search` MCP/native tool. Synthesis
  fallback on iteration ceiling. Time-format reformat-at-injection.
  `get_logbook` description hardened to require TZ offset. Legacy
  `VECTORIZE` binding and `retrieveRelevantEntities` shim removed.
- **32d45d9** — snapshot trim to agent-relevant domains.
- **f4a4db0** — climate preamble for HVAC-related prompts.
- **39dcf08** — ARCHITECTURE self-knowledge in MiniMax system prompt.

---

## Iterating

Bugs caught during use are captured in chat by saying things like
"that's a bug" / "save to debug log" / "log this as broken." The chat
agent calls the `report_bug` native tool, which writes a structured
entry to DO `bugs` storage (FIFO 200) — description + last 4 chat
turns + last 10 `ai_log` entries + current state of any cited entities.
The bucket is server-side only; runtime never modifies code.

At iteration time, fold the captured bugs into [BUGS.md](BUGS.md) and
clear the bucket:

```powershell
# Pull as Markdown ready to prepend
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/bugs?format=markdown" `
  > "$env:TEMP\new-bugs.md"

# Manually prepend $env:TEMP\new-bugs.md to BUGS.md (above the marker
# comment), commit as `chore: import N bugs from runtime`.

# Then clear the bucket so the next pull doesn't re-import.
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/bugs/clear" -X POST
```

Triage one bug at a time. Most fixes are code changes (system-prompt
edits, fast-path regex tweaks, automation YAML in HA, `QUICK FACTS`
additions). After fixing, strike through the bug heading in BUGS.md
(`## ~~#abc12345 — …~~`) and add `Fixed: <commit-sha>` under the body
— don't delete entries, the history is the audit trail.

The endpoints:

- `GET /admin/bugs` — JSON dump of the bucket. `?format=markdown`
  emits ready-to-prepend Markdown (newest first).
- `POST /admin/bugs/clear` — empties the bucket. Idempotent. Run
  AFTER you've imported entries to BUGS.md.

DO-internal routes (called by the worker, not directly):
`/bugs` (read), `/bugs_clear` (empty).

`report_bug` itself:

- **Trigger**: explicit recording verb (save, log, report, record,
  note, capture, remember-as) + issue noun (bug, debug, problem,
  broken, issue). Ambiguous cases prompt "Want me to log that as a
  bug?"
- **Auto-attached context**: `id` (FNV1a hex of description+timestamp,
  8 chars), `timestamp_iso` + `timestamp_central`, `channel` (per-Twilio
  number / web), `severity`, `description`, `entities`, `entity_states`
  (cached), `last_chat_turns` (4), `last_log_entries` (10).
- **Storage**: DO `bugs` key, FIFO 200.
- **Logging**: `ai_log` entry `bug_reported` with id + truncated
  description + severity + entities. Source `native_loop`.
- **Profile**: chat-only — filtered out of autonomous's `allowedTools`.

---

## Things to reach for next

If iterating from here, the highest-leverage open items:

1. **Tool-result reformatting.** `get_logbook` returns ISO+UTC strings
   that MiniMax sometimes copies into replies despite Rule 10.
   Reformat the `tool` message `content` to Central before pushing it
   back into the loop — closes the leak at the source rather than
   relying on the prompt rule.
2. **Service-Auth bypass for ops endpoints.** `/admin/rebuild-knowledge`
   is gated by Cloudflare Access browser auth today. A service token
   with Access policy bypass for `/admin/*` would let ops scripts run
   without `cloudflared`.
3. **Fast-path generalization.** The deterministic short-circuit is
   currently cover-only. Lights and locks have similar shapes ("turn
   off the kitchen lights", "lock the front door") and would benefit
   from the same sub-500ms path — but each new domain needs its own
   no-op guard, disqualifier list, and question-bail tests, so do them
   one domain at a time with telemetry.
4. **HOUSE_STATE_SNAPSHOT bytecount.** Today the snapshot is small
   enough to inline, but every entity added to a `GROUPS` list pays
   prompt-token rent every turn on both paths. If it grows beyond
   ~60 lines, consider per-room trim driven by query intent.
5. **Reasoning-trace persistence.** `reasoning_content` is currently
   surface-only — emitted to SSE, displayed in the panel, then dropped.
   Persisting it to `chat_history` would let the agent see its own
   prior reasoning across turns; cost is byte-budget pressure.
6. **ElevenLabs cost guardrails.** No rate limit on `/transcribe`
   today. If usage scales beyond the household, add a per-channel
   monthly budget cap or move to a self-hosted Whisper.
