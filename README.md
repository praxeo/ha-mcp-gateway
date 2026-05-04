# ha-mcp-gateway

A Cloudflare Worker + Durable Object that bridges Home Assistant to LLMs. It
holds a persistent WebSocket to HA, exposes ~70 typed tools as an MCP server
for Claude Desktop, and runs an autonomous home agent ("MiniMax") that owns
chat and a 30-second autonomous heartbeat. State for nine entity-kinds is
embedded into a Cloudflare Vectorize index for semantic retrieval.

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
Cloudflare Worker (worker.js)         ◀── /mcp, /chat, /twilio, /admin/*, /health, /refresh
   │  routing, MCP handler, multi-kind backfill, daily cron
   ▼
Durable Object: HAWebSocket (ha-websocket.js)
   │  singleton "ha-websocket-singleton" — owns the persistent WS
   │  in-memory stateCache, recent-events queue, native tool loop,
   │  autonomous heartbeat, write-through embeds
   ├──► Home Assistant WebSocket (port 8123, JWT auth)
   ├──► Cloudflare Vectorize "ha-knowledge"  (env.KNOWLEDGE)
   ├──► Cloudflare Workers AI @cf/baai/bge-large-en-v1.5  (env.AI)
   └──► MiniMax M2.7-highspeed at api.minimax.io  (OpenAI-compatible)
```

Layer-by-layer:

1. **Physical devices** — Zigbee / Z-Wave / Wi-Fi plugs / ESPHome / Roku / Ecobee.
2. **Home Assistant** — open-source server owning every integration, automation, scene, script, recorder. WebSocket API on port 8123.
3. **HA Green** — a Nabu Casa appliance running HA OS on the local LAN. Cloud-relayed via Nabu Casa for remote access.
4. **ha-mcp-gateway (this repo)** — Worker + DO. Translates natural language into HA service calls. Auth: Cloudflare Access JWT for browser users; long-lived HA token in worker secret.
5. **Vectorize knowledge index (`ha-knowledge`)** — see [Knowledge index](#knowledge-index-ha-knowledge) below.
6. **MiniMax M2.7-highspeed** — chat completions + native tool calls. The DO runs the tool loop, not MiniMax.
7. **Frontends** — Claude Desktop (MCP), `/chat` HTML UI served by the Worker (SSE-streaming), Twilio (WhatsApp).

---

## Repo layout

| File | Role |
|---|---|
| `src/worker.js` | Cloudflare Worker entry. Owns the MCP handler (`TOOLS` list + `handleTool` dispatch), HTTP routes (`/chat`, `/twilio`, `/admin/rebuild-knowledge`, `/health`, `/refresh`, `/mcp`), KV cache helpers (states/registries), the multi-kind `backfillKnowledge`, and the `scheduled()` cron handler with daily resync. |
| `src/ha-websocket.js` | Durable Object class. Holds the persistent HA WebSocket, in-memory `stateCache`, recent-events queue. System prompts (`getAgentContext`, `getNativeAgentSystemPrompt`). Two execution paths: `chatWithAgentNative` (user-driven, SSE) and `runAIAgentNative` (heartbeat). The native tool loop (`runNativeToolLoop`), the action executor (`executeAIAction`), the read-tool dispatcher (`executeNativeTool`), the multi-kind retriever (`retrieveKnowledge`), and write-through embed/upsert helpers. |
| `src/agent-tools.js` | OpenAI-format tool schemas passed to MiniMax: 4 action tools (`call_service`, `ai_send_notification`, `save_memory`, `save_observation`) + 4 read tools (`get_state`, `get_logbook`, `render_template`, `vector_search`). |
| `src/vectorize-schema.js` | Canonical metadata schema, `vectorIdFor(kind, refId)`, FNV-1a hash, per-kind embed-text builders, `isNoisyEntity` / `isNoisyService` / `entityCategoryFor` helpers, `buildMetadata` (string-coerces `is_noisy`). Imported by both worker.js and ha-websocket.js. |
| `wrangler.toml` | Bindings (HA_WS, HA_CACHE, KNOWLEDGE, AI), build command (esbuild bundles `src/worker.js` → `dist/worker.js`), cron triggers (`* * * * *` cache prewarm, `30 8 * * *` daily knowledge resync). |
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
| `is_noisy`        | string | ✓           | `"true"` / `"false"` (string-typed metadata index) |
| `topic_tag`       | string | ✓           | Bracketed prefix for observations, "" otherwise |
| `hash`            | string |             | fnv1a of embed text — change detection |
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
  unless `force=1`.
- DO `POST /vector_search` — internal endpoint the Worker delegates to
  for the `vector_search` MCP/native tool. Body: `{query, kinds, domain,
  area, top_k, include_noisy}`. `top_k` clamped `[1, 50]`.

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

## Native tool loop

MiniMax is given OpenAI-format tool schemas (`NATIVE_AGENT_TOOLS` in
`agent-tools.js`). The DO drives the loop: send messages, read
`tool_calls`, dispatch via `executeNativeTool`, push tool results back,
repeat until MiniMax emits no `tool_calls`.

Caps:

- **Chat path** (`chatWithAgentNative`): `maxIterations: 12`. Synthesis
  fallback on overflow — pushes a "stop using tools, compose now" user
  message and re-calls MiniMax with `tools: []` so the model produces
  prose from work-so-far instead of a tool trace.
- **Autonomous path** (`runAIAgentNative`): `maxIterations: 8`.

Tool surface:

| Tool | Side effect | Notes |
|---|---|---|
| `call_service` | yes | Any HA service. Post-action verify `get_state` for `climate` / `lock` / `cover`. |
| `ai_send_notification` | yes | `notify.notify` call + writes a `notification` entry to `ai_log`. |
| `save_memory` | yes | Append to `ai_memory` (100 FIFO). Embed + upsert. Evicted entries get vector-deleted. |
| `save_observation` | yes | Append to `ai_observations` (500 FIFO). Embed + upsert. `replaces` prefix-deletes existing entries (and their vectors). |
| `get_state` | no | stateCache hit; force_refresh fetches via WS. |
| `get_logbook` | no | HA `/api/logbook`. Tool description requires explicit TZ offset (`-05:00` for CDT). |
| `render_template` | no | HA `/api/template`. Jinja2 evaluation. |
| `vector_search` | no | DO `/vector_search` → `retrieveKnowledge`. Multi-kind metadata-filtered semantic search. |

Action tools are dispatched through `executeAIAction` with
`source="native_loop"` so the unified `ai_log` records who did what
(`legacy_json` / `native_loop` / `tool_call`).

---

## Agent state buckets

| Bucket | Storage key | Cap | Semantics |
|---|---|---|---|
| `ai_memory` | DO storage | 100 FIFO | Confirmed long-term facts. Embedded into KNOWLEDGE on write. |
| `ai_observations` | DO storage | 500 FIFO | Hypotheses-in-progress, prefixed with `[topic-tag]`. Embedded into KNOWLEDGE on write. `replaces` prefix-supersede. |
| `ai_log` | DO storage `ai_log` (last 150 compacted) + in-memory ring (1000) | 1000 in-memory / 150 persisted | Unified timeline: `chat_user`, `chat_reply`, `action`, `action_verified`, `notification`, `decision`, `state_change`, `memory_saved`, `observation_saved`, `vector_*`, errors. Source-tagged. |
| `chat_history` | DO storage | 10 user turns / 110 KB byte cap | OpenAI-format messages including `tool_calls` and `tool` results — preserves full tool-calling trace across turns. |
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
       1. Load ai_memory, ai_observations, chat_history
       2. _buildNativeContextEntities(message)
            ├ retrieveKnowledge kinds=["entity"], k=15
            ├ retrieveKnowledge kinds=["memory"], k=5
            └ retrieveKnowledge kinds=["observation"], k=5
       3. _buildClimatePreambleIfNeeded(message)
       4. getNativeAgentSystemPrompt("chat", ctx)
       5. runNativeToolLoop(messages, { maxIterations: 12, onEvent })
            loop: callMiniMaxWithTools → dispatch tool_calls → push results
       6. Save preserved tool-calling trace to chat_history (capped)
       7. SSE events: thinking | tool_call | tool_result | reply | error
```

### Autonomous heartbeat (every alarm tick when events queued)

```
DO alarm() every 60s
  → if recentEvents.length > 0 || 15-min heartbeat
    → runAIAgentNative
       1. Load ai_memory, ai_observations
       2. _buildNativeContextEntities(eventQuery)
       3. getNativeAgentSystemPrompt("autonomous", ctx)
       4. runNativeToolLoop(messages, { maxIterations: 8 })
       5. logAI("decision", ...)
```

`onEvent` callback fires only on the chat path (it backs SSE).

### Registry events → incremental re-embed

```
HA event entity_registry_updated  → handleEntityRegistryUpdated  → reembedRefs({ kind: "entity", ... })
HA event device_registry_updated  → handleDeviceRegistryUpdated  → reembedRefs({ kind: "device", ... }) AND ({ kind: "entity", refIds: [device's entities] })
```

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

---

## Operational notes

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
  `iteration_ceiling_synthesize` — should be rare. Frequent occurrence
  means questions are routinely needing more than 12 tool calls and the
  ceiling should bump again, OR specific tools are returning verbose
  results that bloat per-iteration cost.
- **Time-format leak.** Timeline timestamps are pre-formatted Central in
  the prompt. If user-facing replies still show UTC/Z-suffix it means
  MiniMax is copying timestamps from a tool result mid-loop (most
  likely `get_logbook`, which returns ISO+UTC). Rule 10 in OPERATIONAL
  REMINDERS forbids this; if it slips through, consider reformatting
  `get_logbook` results before pushing them back as tool messages.

---

## Recent significant changes

- **9acf9bc** — multi-kind knowledge index (`ha-knowledge`) replacing
  entity-only `ha-entities`. `vector_search` MCP/native tool. Synthesis
  fallback on iteration ceiling. Time-format reformat-at-injection.
  Snapshot serializer fix + cap bump. `get_logbook` description
  hardened to require TZ offset. Legacy `VECTORIZE` binding,
  `/admin/backfill-vectors` alias, `retrieveRelevantEntities` shim
  removed. (1886 insertions / 263 deletions.)
- **32d45d9** — snapshot trim to agent-relevant domains.
- **f4a4db0** — climate preamble for HVAC-related prompts.
- **39dcf08** — ARCHITECTURE self-knowledge in MiniMax system prompt.
- **f758509** — state freshness + gateway health surfaced to agent.
- **a37b63e** — DO storage `state_cache_snapshot` for cold-start.
- **da4a14f** — ping/pong watchdog + `statesReady` flag.

`git log --oneline` walks back further. Anything older than these is
foundational and unlikely to need re-reading.

---

## Things to reach for next

If iterating from here, the highest-leverage open items:

1. **Chat/monitor split.** The current monolithic prompt+tools is what
   makes the model occasionally flaky on direct questions. A split would
   give the chat path a terse prompt, narrower tool list (no
   memory/observation writes), and per-channel history; the autonomous
   monitor keeps the heavier prompt for pattern inference. Plan this
   from a fresh file when ready.
2. **Tool-result reformatting.** `get_logbook` returns ISO+UTC strings
   that MiniMax sometimes copies into replies. Reformat the `tool`
   message content before pushing it back into the loop.
3. **Per-channel chat history.** `chat_history` is a single shared list
   across web / Twilio / Claude Desktop. Each `from` should arguably
   have its own slot — trivially partitioned.
4. **Service-Auth bypass for ops endpoints.** `/admin/rebuild-knowledge`
   is gated by Cloudflare Access browser auth today. A service token
   with Access policy bypass for `/admin/*` would let ops scripts run
   without `cloudflared`.
