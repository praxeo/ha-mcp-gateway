# Knowledge index — what changed and how to operate it

The `ha-mcp-gateway` Worker now backs a **unified multi-kind Vectorize index**
(`ha-knowledge`) instead of the entity-only `ha-entities` index, and it
exposes a `vector_search` tool to MCP clients and to MiniMax's native
tool-calling loop. This document covers the new endpoints, the new tool, and
the procedures for rebuilding the index.

## Index layout

`ha-knowledge` (1024-dim, cosine, model `@cf/baai/bge-large-en-v1.5`,
pooling `cls`) holds one row per object with the canonical metadata schema:

| Field             | Type   | Filterable? | Notes                                    |
|-------------------|--------|-------------|------------------------------------------|
| `kind`            | string | ✓           | `entity` `automation` `script` `scene` `area` `device` `service` `memory` `observation` |
| `ref_id`          | string |             | entity_id, automation HA-internal id, `<domain>.<service>`, fnv1a(text), … |
| `friendly_name`   | string |             | Display label (first 80 chars for memory/observation) |
| `domain`          | string | ✓           | Entity domain for entity kind, the kind name otherwise |
| `area`            | string | ✓           | Resolved area name, "" if none |
| `entity_category` | string | ✓           | `primary` `diagnostic` `config` (entity-only; "primary" otherwise) |
| `is_noisy`        | string | ✓           | `"true"` / `"false"` (string-typed metadata index) |
| `topic_tag`       | string | ✓           | Bracketed prefix for observations, "" otherwise |
| `hash`            | string |             | fnv1a of embed text — change detection |
| `device_class`    | string |             | (entity-only extra; not filterable) |

Default vector_search filters out `is_noisy: "true"` records. Pass
`include_noisy: true` to include them.

## Refresh strategy

| Kind          | Refresh trigger                                                 |
|---------------|-----------------------------------------------------------------|
| entity        | event-driven (`entity_registry_updated`) + nightly cron resweep |
| device        | event-driven (`device_registry_updated`) + nightly cron resweep |
| memory        | write-through (`executeAIAction.save_memory`)                   |
| observation   | write-through (`executeAIAction.save_observation`)              |
| automation    | nightly cron                                                    |
| script        | nightly cron                                                    |
| scene         | nightly cron                                                    |
| area          | nightly cron                                                    |
| service       | nightly cron                                                    |

## Endpoints

### `POST /admin/rebuild-knowledge?force=1&kinds=entity,automation`

Multi-kind backfill into `ha-knowledge`. Both query params are optional:

* `force=1` — re-embed everything regardless of hash. Default: skip docs
  whose embed-text hash is unchanged.
* `kinds=a,b,c` — comma-separated subset of `entity`, `automation`,
  `script`, `scene`, `area`, `device`, `service`, `memory`, `observation`.
  Omit for all kinds.

Returns:

```json
{
  "total_docs": 2843,
  "embedded": 184,
  "skipped": 2658,
  "errors": 1,
  "kinds": {
    "entity":     { "found": 1842, "build_ms":  91 },
    "automation": { "found":   58, "build_ms": 312 },
    "script":     { "found":   31, "build_ms": 184 },
    ...
  },
  "duration_ms": 14781
}
```

### `POST /admin/backfill-vectors?force=1`

Deprecated alias retained for transition compatibility — delegates to
`backfillKnowledge({ kinds: ["entity"] })`. Will be removed once the new
index is verified.

### DO `POST /vector_search`

Internal endpoint the worker delegates to. Body shape:

```json
{
  "query": "string",
  "kinds": ["entity"],
  "domain": "light",
  "area": "Master Bedroom",
  "top_k": 15,
  "include_noisy": false
}
```

Only `query` is required. `top_k` is clamped to `[1, 50]`.

## New tool — `vector_search`

Exposed to MCP clients (in `tools/list`) and to MiniMax via the native
tool-calling loop. Same input shape as the DO endpoint above. The agent
should reach for it whenever the pre-injected entity context block doesn't
have what it needs — particularly for HA service discovery
(`kinds=["service"]`), automation/script lookup, or recalling specific
prior memories/observations.

## Rebuild procedure

Index creation is a one-time setup the user runs from PowerShell:

```powershell
wrangler vectorize create ha-knowledge --dimensions=1024 --metric=cosine

wrangler vectorize create-metadata-index ha-knowledge --property-name=kind --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=domain --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=area --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=entity_category --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=is_noisy --type=string
wrangler vectorize create-metadata-index ha-knowledge --property-name=topic_tag --type=string
```

(Metadata indexes are immutable — declare them all at creation time.)

Then deploy and trigger a full backfill:

```powershell
# From C:\Users\obert\ha-mcp-gateway
wrangler deploy

Invoke-RestMethod -Uri "https://ha-mcp-gateway.obert-john.workers.dev/admin/rebuild-knowledge?force=1" `
                  -Method POST
```

## Cron triggers

`wrangler.toml` declares two cron entries:

* `* * * * *` — every minute, runs `prewarmCache`
* `30 8 * * *` — 03:30 CDT (08:30 UTC), runs the daily heavy resync of
  automation, script, scene, area, device, and service kinds

The cron handler dispatches on `event.cron` so the two paths are isolated.

## Bindings

`wrangler.toml` declares both Vectorize bindings during the transition:

```toml
[[vectorize]]
binding = "KNOWLEDGE"
index_name = "ha-knowledge"

[[vectorize]]
binding = "VECTORIZE"
index_name = "ha-entities"
```

The DO and the worker's backfill code both use `KNOWLEDGE`. The legacy
`VECTORIZE` binding is still declared so a rollback path exists, but
nothing in the codebase reads from it. After verification, remove the
`VECTORIZE` binding from `wrangler.toml` and delete the old index:

```powershell
wrangler vectorize delete ha-entities
```

## Acceptance smoke tests

```powershell
# 1. Health check should report knowledge: bound
Invoke-RestMethod -Uri "https://ha-mcp-gateway.obert-john.workers.dev/health"

# 2. Full rebuild
Invoke-RestMethod -Uri "https://ha-mcp-gateway.obert-john.workers.dev/admin/rebuild-knowledge?force=1" `
                  -Method POST

# 3. Entity match — dock_tree_zigbee_plug should appear in top 5, score >= 0.65
Invoke-RestMethod -Uri "https://ha-mcp-gateway.obert-john.workers.dev/chat" `
                  -Method POST -ContentType "application/json" `
                  -Body '{"message":"Use vector_search to find entities related to dock lights. Return the top 5 with scores."}'

# 4. Cross-kind search — automations matching "bedtime"
Invoke-RestMethod -Uri "https://ha-mcp-gateway.obert-john.workers.dev/chat" `
                  -Method POST -ContentType "application/json" `
                  -Body '{"message":"Use vector_search with kinds=[\"automation\"] to find any automations related to bedtime."}'

# 5. Service discovery — light.turn_on should surface for "dim a light with a transition"
Invoke-RestMethod -Uri "https://ha-mcp-gateway.obert-john.workers.dev/chat" `
                  -Method POST -ContentType "application/json" `
                  -Body '{"message":"Use vector_search with kinds=[\"service\"] to find the HA service that dims a light with a transition. Return top 3."}'

# 6. include_noisy reproducibility — diagnostic counters should appear when requested
Invoke-RestMethod -Uri "https://ha-mcp-gateway.obert-john.workers.dev/chat" `
                  -Method POST -ContentType "application/json" `
                  -Body '{"message":"Use vector_search with include_noisy=true to find _successful_commands_tx counters. Show top 3."}'
```
