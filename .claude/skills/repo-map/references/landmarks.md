# Landmark index

Verified symbol index, grouped by subsystem so you can find code by *concept* when
you don't know the name.

**Line numbers drift with every edit.** They are a starting offset, not an address.
Confirm with `grep -n "<symbol>" src/<file>.js` before reading a window. The
grouping and the names are the durable part.

Regenerate the raw indexes at any time:

```bash
grep -nE '^  (async )?[_a-zA-Z][a-zA-Z0-9_]*\(' src/ha-websocket.js   # DO methods (88)
grep -nE '^(async )?function ' src/worker.js                          # Worker functions (41)
```

---

## src/ha-websocket.js — class `HAWebSocketV31` (5,723 lines)

### Module-level pure helpers (before the class)

Unit-tested. Each keeps a **synced stub copy** in its test file — change the
helper and the stub together, or the suite silently tests dead code.

| Line | Symbol | Role |
|---|---|---|
| 36 | `sanitizeChannelKey` | Normalizes a chat channel/sender key |
| 60 | `coalesceServiceData` | Heals flat `call_service` / `schedule_action` args → `coalesce-service-data.test.js` |
| 98 | `llmConfigFromEnv` | Layer 2 of LLM config resolution |
| 118 | `resolveLLMConfig` | 3-layer precedence: DO storage → env → defaults → `llm-config.test.js` |
| 174 | `applyReasoningToBody` | Emits `thinking` XOR `reasoning_effort` |
| 191 | `sanitizeLLMConfigPatch` | Validates `/admin/llm-config` POST bodies |

### Class configuration constants

| Line | Symbol | Role |
|---|---|---|
| 224 | `export class HAWebSocketV31` | **The class name. Bump it for any DO-side change** (gotcha #1) |
| 259–262 | `LLM_ENDPOINT`, `LLM_MODEL`, `LLM_PROVIDER`, `LLM_API` | Baked-in default: Muse Spark 1.3 over Meta `/v1/responses` |
| 272, 276 | `LLM_REASONING_MODE`, `LLM_REASONING_EFFORT` | `"effort"` / `"low"` — low is the Quick tier baseline |
| 285 | `LLM_REASONING_SUMMARY` | `"detailed"` — the only value that produced text on the live Meta API |
| 305 | `SESSION_AFFINITY_KEY` | Fireworks replica pinning |
| 307–316 | `MAX_CONTEXT_ENTITIES`, `MAX_SENSOR_CONTEXT`, `LOG_*` caps | Context and log sizing |
| 318–328 | `SNAPSHOT_ATTR_ALLOWLIST`, `SNAPSHOT_DOMAIN_ALLOWLIST` | What survives into the hibernation snapshot |
| 956 | `CLIMATE_TRIGGER_RE` | Gates the climate preamble |
| 965 | `HOUSE_STATUS_TRIGGER_RE` | Gates `HOUSE_STATE_SNAPSHOT` injection |

### Router and lifecycle

| Line | Symbol | Role |
|---|---|---|
| 759 | `constructor` | |
| 1123 | `fetch(request)` | **The DO's internal HTTP router** — one big `switch`; every `/status`, `/llm_config`, `/ai_chat*`, registry, scheduler and forensic route |
| 1677 | `connect()` | Opens the HA WebSocket, authenticates |
| 1708 | `disconnect()` / 1720 `scheduleReconnect` | |
| 1724 | `onMessage(event)` | Raw WS frame handler |
| 1766 | `onEvent(event)` | **HA event fan-out — entry point for all forensic logging** |
| 1866 | `onClose` / 1879 `onError` | |
| 1884 | `sendCommand` / 1894 `resolveCommand` | WS request/response correlation |
| 5691 | `alarm()` | 60s keepalive: ping/pong, reconnect, fires due scheduled actions |

### State cache and snapshot

| Line | Symbol | Role |
|---|---|---|
| 1902 | `fetchAllStates()` | Full state pull from HA |
| 1915 | `_serializeStateCacheForSnapshot()` | |
| 1952 | `_persistStateSnapshot()` / 1971 `_restoreStateSnapshot()` | Survives isolate eviction |
| 1996 | `subscribeToStateChanges()` | |
| 2010 | `subscribeToRegistryEvents()` | |
| 2028 | `subscribeToForensicEvents()` | `automation_triggered`, `call_service` |

### Forensic log (D1)

| Line | Symbol | Role |
|---|---|---|
| 2044 | `_shouldLogStateChange` | **The noise filter** — Zigbee LQI/RSSI, monotonic counters, deadbands → `should-log-state-change.test.js` |
| 2118 | `_shouldStoreAttributes` | |
| 2139 | `_extractTriggerEntity` / 2147 `_touchLastEventSeen` | |
| 2156 | `_recordD1WriteFailure` | Increments `_d1WriteFailures` |
| 2165 | `_writeStateChangeToD1` | Fire-and-forget — **never `await` these in `onEvent`** |
| 2184 | `_writeAutomationRunToD1` / 2204 `_writeServiceCallToD1` | |
| 2228 | `_backfillStateChangesFromHA` | Reconnect gap-fill, idempotent via `INSERT OR IGNORE` |
| 2300 | `_parseTimeRefToMs` | |
| 2314 | `_executeQueryStateHistory` | Backs `query_state_history` |
| 2352 | `_executeQueryAutomationRuns` | |
| 2392 | `_executeQueryCausalChain` | Walks HA context-chain IDs |

### Knowledge index (Vectorize)

| Line | Symbol | Role |
|---|---|---|
| 2498 | `handleEntityRegistryUpdated` / 2523 `handleDeviceRegistryUpdated` | Re-embed on registry change |
| 2572 | `_buildEntityDocsForRefs` / 2631 `_buildDeviceDocsForRefs` | |
| 2689 | `_embedAndUpsertDocs` | **All embedding calls must use `pooling: "cls"`** (gotcha #4) |
| 2768 | `reembedRefs` / 2782 `reembedEntities` | |
| 2788 | `_memoryDocFor` / 2918 `_observationDocFor` | Write-through kinds |
| 2940 | `_embedAndUpsertSingle` / 2954 `_deleteVectorIds` | |
| 2972 | `retrieveKnowledge` | **The semantic search entry point** — backs `vector_search` on both surfaces |

### Chat path

| Line | Symbol | Role |
|---|---|---|
| 3371 | `chatWithAgent` | Entry point; branches on `USE_NATIVE_TOOL_LOOP` at 3376. Legacy JSON path below the gate |
| 5243 | `chatWithAgentNative` | **The path that actually runs** |
| 535 | `_tryDeterministicFastPath` | Cover open/close short-circuit → `try-deterministic-fast-path.test.js` |
| 5196 | `getStaticChatSystemPrompt()` | Delegates to `chat-prompt.js`; must stay byte-identical |
| 5208 | `buildDynamicContext(ctx)` | **All per-request data goes here** |
| 5010 | `_buildNativeContextEntities` | Vector-retrieval context build |
| 5099 | `_buildFlatContextEntities` | Fallback when `USE_VECTOR_ENTITY_RETRIEVAL` is off |
| 5165 | `_buildNativeTimeline` | |
| 441 | `_buildHouseStateSnapshot` | Authoritative live-state block; gated injection |
| 4677 | `runNativeToolLoop` | The tool-calling loop |
| 4084 | `executeNativeTool` | **Chat-surface tool dispatcher** (19 tools) |
| 3682 | `executeAIAction` | Legacy action executor |
| 691 | `_sanitizeLightServiceData` | Strips unsupported color descriptors → `sanitize-light-service-data.test.js` |
| 399 | `_reformatToolResultTimestamps` | Forces US Central in agent-facing text |
| 4042 | `_formatLogbookForLLM` | |
| 4550 | `_persistChatHistory` | Trims via `chat-history.js` before writing to DO storage |

### LLM transport

| Line | Symbol | Role |
|---|---|---|
| 805 | `_getLLMConfig()` | Resolves config; both call sites use it so they cannot drift |
| 4587 | `_apiKeyFor(cfg)` | Picks `FIREWORKS_API_KEY` vs `MODEL_API_KEY` per provider |
| 3260 | `callLLM` | Non-tool completion |
| 4596 | `callLLMWithTools` | Tool-calling completion; takes an `effortOverride` for the UI tier |

### Weather (NWS) and climate

| Line | Symbol | Role |
|---|---|---|
| 4340 | `_nwsFetch` / 4360 `_getHomeLatLon` / 4393 `_nwsGetPoint` | |
| 4412 | `_executeGetNwsWeather` / 4484 `_executeGetNwsDiscussion` | |
| 1029 | `_fetchClimateData` / 1070 `_buildClimatePreambleIfNeeded` | |
| 1005 | `_explainHvacAction` | |

### Ephemeral scheduler

| Line | Symbol | Role |
|---|---|---|
| 5587 | `_listScheduledActions` | |
| 5611 | `_cancelScheduledAction` | |
| 5626 | `_fireDueScheduledActions` | **delete-before-fire** + **WS-up guard** → `scheduler.test.js` |

`_scheduleAction` sits just above `_listScheduledActions`; grep for it.

### Agent state and logging

| Line | Symbol | Role |
|---|---|---|
| 816 | `getAgentContext` | |
| 882 | `_getHouseTopologyText` | Backs `get_house_topology` |
| 926 | `_saveMemoryCriteriaBlock` | |
| 3353 | `logAI` / 3324 `loadLogFromStorage` / 3331 `persistLog` | |
| 2841 | `_writeAiLogEntryToD1` / 2870 `_loadAiLogFromD1` / 2900 `_loadObservationsFromD1` | |
| 2807, 2821 | `_migrateRetire*` | One-shot storage-key migrations |

---

## src/worker.js — Worker entry (3,057 lines)

| Line | Symbol | Role |
|---|---|---|
| 58–722 | `var TOOLS = [...]` | **The 82-tool MCP surface.** Two entry styles: one-line (18) and multi-line (64) |
| 724 | `DANGEROUS_TOOLS` | The 12 role-gated tools |
| 739 | `getAgentToolset(role)` | `mcp_external` gets all 82; everyone else gets 70 |
| 744 | `mcpToOpenAITool` | Schema shape conversion |
| 1088 | `handleTool(env, name, args)` | **The MCP dispatcher** — the biggest function here |
| 2230 | `handleMCP(request, env)` | JSON-RPC envelope: `initialize`, `tools/list`, `tools/call` |
| 2963 | `scheduled(event, env, ctx)` | Cron entry |

### Transport helpers

| Line | Symbol | Role |
|---|---|---|
| 757 | `haRequest` | Home Assistant REST |
| 785 | `getDO` / 790 `doFetch` | **Every DO call goes through these** — singleton `ha-websocket-singleton` |
| 866 | `callServiceWS` | Service call via the DO's WebSocket |
| 876–891 | `cacheGet` / `cacheSet` / `cacheDel` | KV helpers |
| 1053 | `sttDeps(env)` | Dependency bundle handed to `stt.js` (keeps STT free of worker internals) |

### Cached registry readers

`getStates` (896), `getEntityState` (910), `getServices` (930),
`getEntityRegistry` (939), `getAreaRegistry` (953), `getDeviceRegistry` (967),
`getFloorRegistry` (997), `getLabelRegistry` (1011), `getCalendars` (1025),
`getDashboardList` (1038). Invalidation: `invalidateStates` (1062),
`invalidateRegistry` (1065).

### Knowledge backfill

Per-kind doc builders — `buildEntityDocs` (1573), `buildAutomationDocs` (1656),
`buildScriptDocs` (1723), `buildSceneDocs` (1777), `buildAreaDocs` (1829),
`buildDeviceDocs` (1874), `buildServiceDocs` (1932), `buildMemoryDocs` (1978),
`buildObservationDocs` (2012) — dispatched by `buildKindDocs` (2047) and driven by
`backfillKnowledge` (2062).

Safe config fetchers: `fetchAutomationConfigSafe` (1549), `fetchScriptConfigSafe`
(1557), `fetchSceneConfigSafe` (1565).

### Cron work

`prewarmCache` (2972), `dailyAiLogRetention` (3006), `dailyForensicLogRetention`
(3019), `dailyKnowledgeResync` (3035).

### Misc

`formatBugsAsMarkdown` (807), `sanitizeForTemplate` (1068),
`normalizeAutomationConfig` (1072).

---

## Smaller modules — read whole

### `src/llm-providers.js` (381) — provider adapters

The translator between the DO's canonical Chat-Completions shape and whatever the
provider wants. Pure and side-effect free.

| Line | Symbol | Role |
|---|---|---|
| 24 | `LLM_APIS` | `"chat"` \| `"responses"` wire formats |
| 28 | `LLM_REASONING_EFFORTS` | Union across providers |
| 35 | `LLM_PROVIDERS` | **Per-provider facts** — key env var, default api, endpoints, allowed efforts |
| 58 | `isKnownProvider` / 64 `endpointFor` | |
| 73 | `clampEffortForProvider` | Narrows to the nearest supported level, never silently "off" |
| 95 | `LLM_TIERS` | **UI tier → effort**: `quick` → `low`, `high` → `high` |
| 100 | `effortForTier` | |
| 115 | `chatToolsToResponsesTools` | Note: `strict` must be forced false or every request 400s |
| 141 | `chatMessagesToResponsesInput` | |
| 213 | `normalizeReasoningItem` / 225 `dropOrphanReasoning` | Reasoning replay across tool rounds |
| 250 | `buildResponsesBody` | |
| 296 | `responsesToChatCompletion` | Converts back to the canonical shape |
| 377 | `stripProviderInternals` | |

### `src/chat-history.js` (167) — history trimming

`DO_VALUE_LIMIT_BYTES` (31, 131072 — the hard DO cap), `HISTORY_BYTE_BUDGET` (36,
96000), `MAX_TURNS` (41, 8), `TOOL_CONTENT_CAP` (44, 4000),
`ASSISTANT_CONTENT_CAP` / `USER_CONTENT_CAP` (45–46, 8000). Helpers: `byteLength`
(52), `truncateToBytes` (58), `capMessage` (79), `trimChatHistory` (127).

### `src/stt.js` (157) — speech to text

`STT_CACHE_KEY` / `STT_CACHE_TTL` (3–4), `STT_KEYTERM_DOMAINS` (6),
**`STT_FIXED_KEYTERMS` (12 — the hand-written vocabulary; first place to go when a
voice command keeps landing wrong)**, `STT_KEYTERM_MAX` / `STT_KEYTERM_MAXLEN`
(21–22), `STT_CONFIG` (24). Functions: `normalizeKeyterm` (30),
`buildSTTKeytermsFromData` (40), `buildSTTKeyterms` (69), `refreshSTTKeyterms`
(76), `handleTranscribe` (82).

### `src/tts.js` (89) — text to speech

`TTS_CONFIG` (3) — `defaultVoiceId` (4), `model_id` (5), `output_format` (6),
`maxChars` (7), and the delivery settings (8–11). `cleanForSpeech` (14) is the
speech shaper → `speech-shaping.test.js`. `handleTTS` (46); voice resolution order
is `body.voice` → `env.ELEVENLABS_VOICE_ID` → `TTS_CONFIG.defaultVoiceId` (53).

### `src/agent-tools.js` (603) — chat-agent tool schemas

`ACTION_TOOLS` (16, 6 tools), `READ_TOOLS` (219, 13 tools), `NATIVE_AGENT_TOOLS`
(564), `NATIVE_TOOL_NAMES` (567), `NATIVE_ACTION_TOOL_NAMES` (573),
`CHAT_ALLOWED_TOOL_NAMES` (583).

### `src/chat-prompt.js` (209) — the prompt

`buildStaticChatSystemPrompt` (22, the cache-stable half),
`renderDynamicContext` (134, the per-request half). **Edit prompt text here.**

### `src/vectorize-schema.js` (420)

`vectorIdFor`, `topicTagFor`, `fnv1aHex`, per-kind embed-text builders,
`isNoisyEntity` / `isNoisySwitch` / `isNoisyService`, `buildMetadata`. Imported by
**both** `worker.js` and `ha-websocket.js`.

### `src/chat-ui.html.js` (1,612)

`CHAT_HTML` (7) — the whole `/chat` UI in one template literal. Notable interior
landmarks: tier control `setTier` (946), spoken-replies toggle `speakOn` (954),
VAD constants (1409–1412).

---

## Tests → what they pin

9 tracked files, 207 cases.

| Test file | Cases | Pins |
|---|---|---|
| `llm-providers.test.js` | 54 | Wire-format translation both directions, effort clamping, reasoning replay |
| `llm-config.test.js` | 34 | `resolveLLMConfig`, `applyReasoningToBody`, `sanitizeLLMConfigPatch` |
| `should-log-state-change.test.js` | 28 | The forensic noise filter |
| `chat-history.test.js` | 24 | Byte budgeting against the DO value cap |
| `scheduler.test.js` | 19 | delete-before-fire and the WS-up guard |
| `speech-shaping.test.js` | 18 | `cleanForSpeech` — markdown stripping, unit expansion, entity-id flattening |
| `sanitize-light-service-data.test.js` | 11 | Color-descriptor stripping |
| `try-deterministic-fast-path.test.js` | 11 | Cover fast path; explicit open/close, never toggle |
| `coalesce-service-data.test.js` | 8 | Flat-arg healing |

Several suites keep a **synced stub copy** of the pure helper under test. Change
the helper in `src/` and the stub together, or the suite tests dead code.

`npm test` reports 12 files / 271 tests because it also collects stale copies from
`.claude/worktrees/` — see SKILL.md §5.
