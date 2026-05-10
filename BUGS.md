# BUGS.md — captured during use, fixed in iteration sessions

Populated by the chat agent's `report_bug` tool. The user flags an issue
in chat ("that's a bug" / "save to debug log" / "log this as broken" / …)
and MiniMax writes a structured entry to the DO `bugs` bucket along with
recent context (last chat turns, last 10 `ai_log` entries, current state
of cited entities).

## Iteration ritual

At the start of each iteration session:

```powershell
# 1. Pull as Markdown, ready to prepend
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/bugs?format=markdown" `
  > "$env:TEMP\new-bugs.md"

# 2. Prepend $env:TEMP\new-bugs.md to BUGS.md (above the marker below)

# 3. Commit:  chore: import N bugs from runtime

# 4. Clear the bucket so we don't re-import
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/bugs/clear" -X POST
```

Triage one bug at a time. After fixing, strike through the heading
(`## ~~#abc12345 — …~~`) and add a `Fixed: <commit-sha>` line under the
body. Do not delete entries — the history is the audit trail.

---

## #vec-orphan-diff-noop — 2026-05-10 — orphan_deleted count is 0 across every force=1 rebuild

**Severity:** low (fails safe) • **Source:** spotted during A1/E2 deploy verification (Round 1.5)

`backfillKnowledge`'s orphan-diff logic (introduced in Round 1) reads `last_indexed_ids_v1` from DO storage, diffs against the current rebuild's id set, and deletes vectors that no longer appear. Then it writes the new id set for next time.

In `/admin/index-stats` history (5 force=1 runs spanning two days), every run reports `orphans_deleted: 0`, including partial rebuilds where the current set was a small subset of the prior full-rebuild set. Expected: the first partial rebuild after the full 2728-vector rebuild should have flagged ~2471 ids as orphans. Observed: 0.

Empirically the bug is failing safe — a partial force=1 rebuild of just `memory,observation` did NOT delete entities (vector_search for "basement" still returns 5 entities). So either:
- The DO `/last_indexed_ids_read` endpoint is returning an empty list across calls.
- The DO `/last_indexed_ids_write` POSTs from the worker are silently failing (e.g., `doFetch` serialization issue with the ~183 KB id payload).
- The shard reassembly in `/last_indexed_ids_read` is dropping all entries.

**Investigation hooks:** add `console.log` of `lastIds.length` and `currentSet.size` inside the orphan-diff branch in `backfillKnowledge`, redeploy, run a `force=1` rebuild, inspect via `wrangler tail --format json`. Then check `/last_indexed_ids_read` DO endpoint directly. Most likely culprit: the body-size of the `last_indexed_ids_write` POST exceeds something CF / `doFetch` doesn't handle gracefully — a 183 KB JSON body is below the 1 MB request limit but might still be triggering an unseen error.

**Impact:** vectors orphaned by entity renames or HA registry deletions will accumulate. The `/admin/cleanup-stale-vectors` endpoint handles the known-bad patterns (automation/script/scene entity-id form), so the practical damage is limited.

**Workaround until fixed:** none needed; periodically rerun `/admin/cleanup-stale-vectors` after large HA registry changes.

---

## ~~#vec-topic-tag-filter — 2026-05-09 — vector_search topic_tag filter silently ignored at Vectorize layer; client-side fallback shipped but blocked on DO refresh~~

**Resolved 2026-05-09.** Root cause was misdiagnosed throughout. Actual bug: `executeNativeTool`'s `case "vector_search"` (the chat agent's internal tool dispatcher at [src/ha-websocket.js:3091](src/ha-websocket.js:3091)) did not thread `topic_tag` or `min_score` through to `retrieveKnowledge` — even though the parent worker's `case "vector_search"` did, and the DO's HTTP `/vector_search` endpoint did. Three vector_search call paths exist; only two were updated in Round 1.

The DO had been on new code the whole time. The class rename, compat-date bump, observation reindex, and Vectorize metadata-index recreate were all unnecessary for this issue (though some were independently useful — index dedup is permanently cleaner). The "stale isolate" diagnosis was wrong. `wrangler tail --format json` made the actual root cause visible: the raw tool_call from MiniMax contained `topic_tag` and `min_score`, but the args reaching `retrieveKnowledge` had them stripped.

Also fixed: Vectorize-side `topic_tag` filter is exact-match including the surrounding brackets that `extractTopicTag` captures. Added input normalization in `retrieveKnowledge` so callers can pass either bare-form (`"basement-bay-afternoon-pattern"`) or bracketed (`"[basement-bay-afternoon-pattern]"`) — both match.

Verification: `topic_tag="basement-bay-afternoon-pattern"` → 2 matches; `topic_tag="[basement-bay-afternoon-pattern]"` → 2 matches; `topic_tag="NONEXISTENT_TAG_ZZZ"` → 0 matches; `min_score=0.99` on basement entities → 0 matches; `min_score=0.50` (default) → 9 matches. All filter behaviors now match expected semantics.

Lesson for future stale-isolate diagnoses: before reaching for class rename / compat bump / nuke, instrument with `console.log` at the suspect function entry, deploy, and check `wrangler tail --format json` to see whether NEW code is reached at all and what args arrive. The version ID in the JSON tail per-event distinguishes stale-isolate vs args-routing bugs in one read.

---

## ~~#vec-topic-tag-filter (original entry, kept as audit trail) — 2026-05-09 — vector_search topic_tag filter silently ignored at Vectorize layer; client-side fallback shipped but blocked on DO refresh~~

**Severity:** medium  •  **Source:** verification probe after vector-search optimization round 1  •  **Entities:** Vectorize binding `KNOWLEDGE`, observation kind

`vector_search` with `topic_tag="[basement-bay-afternoon-pattern]"` (and every variant — without brackets, with a NONEXISTENT tag, with a brand-new tag value) returns the same top-K semantically similar observations as if no tag filter were applied. The filter is silently ignored at the Vectorize platform level.

**What we know:**
- `wrangler vectorize list-metadata-index ha-knowledge` confirms `topic_tag` is registered as a String metadata index.
- The retrieveKnowledge code path correctly threads `topic_tag` from agent → worker → DO → Vectorize filter object.
- The same filter mechanism works correctly for `area`, `is_noisy`, `kind`, and `domain` (verified case-insensitive area normalization in this round).
- After force=1 rebuild, observations have their `topic_tag` metadata field populated (the bracketed prefix from `extractTopicTag`).

**Likely cause:** Cloudflare Vectorize metadata-index backfill behavior. Per CF docs, metadata indexes only apply to vectors *inserted* after the index is created. `upsert` of an existing vector_id may treat as UPDATE, which doesn't (re)trigger metadata-index population. The other working filters likely had their indexes created before any vectors existed; `topic_tag` may have been added later, missing its backfill.

**Workaround shipped:** Client-side `topic_tag` filter in [retrieveKnowledge](src/ha-websocket.js) at the start of the result-mapping loop. Normalizes brackets and case so `'foo'` and `'[foo]'` match. Over-fetches to top_k=50 when topic_tag is set so we don't miss matches outside the top-2k semantic neighborhood. **However:** this code is currently NOT live on the running DO — see deployment caveat below. It will activate on the next DO cycle.

**Deployment caveat — DO stale-code issue.** The HAWebSocket Durable Object holds a persistent WebSocket to Home Assistant, which prevents Cloudflare's normal "10-second idle → reload latest code" hibernation. As a result, DO-side code changes (anything inside `retrieveKnowledge`, including this filter) only take effect when the DO eventually cycles for unrelated reasons (HA WS drop, deploy-induced graceful migration, periodic restart). Worker-side code (admin endpoints, vector_search forwarding handler, MCP routing) refreshes immediately on deploy, but the DO does not.

**Update — what's been tried (all unsuccessful):**

1. **Recreated the Vectorize metadata index** via `wrangler vectorize delete-metadata-index ha-knowledge --property-name=topic_tag` then `create-metadata-index --type=string`. Let it propagate, retested. Filter still ignored.

2. **Deleted then re-INSERTED all 155 observation vectors** via a one-shot `/admin/reindex-observations` endpoint (deletes ids first so the next upsert is a fresh INSERT, which should trigger metadata indexing per CF's "indexes only apply to vectors inserted after the index is created" rule). Verified 155 deleted + 155 re-embedded. Filter still ignored.

3. **Class-rename migration** — renamed `HAWebSocket` → `HAWebSocketV2` in source + added `[[migrations]] tag = "v2" renamed_classes` entry in wrangler.toml. Deployed. Verified the bundled code shows the new class name and the new `wantTopicTag` filter. Verified `/health` reports the DO is connected with state preserved (1088 cached entities, 66 ai_log entries — same instance, migrated). Still — the DO process is running OLD code that doesn't apply the topic_tag client-side filter or honor explicit `min_score` arg passed by the agent.

   Evidence: `min_score: 0.95` query returned 9 results (top score 0.541, all should have been pruned); equivalent unfiltered query also returned 9. Default `min_score: 0.50` IS being applied (50 raw → 9 with score ≥ 0.50). So *the floor logic runs*, but only with the hardcoded default — the explicit user value never reaches the comparison. Same shape for `topic_tag`: passes through to retrieveKnowledge, code says it filters, runtime returns unfiltered.

**Likely root cause (deeper than originally diagnosed):** Cloudflare V8 isolate / module-level caching keeps the previously-loaded retrieveKnowledge bound on the persistent DO process even after class migration. Renamed_classes updates the binding but doesn't necessarily evict the JS module from V8's compiled cache. The persistent HA WebSocket prevents normal idle-eviction.

**What still works (also confirmed in this round):**
- Worker-side: collision guard during backfill (caught 4 legitimate alias dupes), force rebuild, /admin/cleanup-stale-vectors (deleted 120 stale legacy ids), /admin/index-stats endpoint, /admin/reindex-observations endpoint.
- DO-side: cross-kind chat retrieval (RELEVANT AUTOMATIONS / DEVICES / SERVICES blocks in prompt), area filter case-insensitive normalization, dedup pass on result set (20 distinct from 20), default `min_score: 0.50` floor (50 raw → 9 with score ≥ 0.50). These all work because they were in the DO's loaded code before this round started failing.

**Remaining resolution options:**
1. **`wrangler delete && wrangler deploy`** — destroys all DO storage state (chat_history, ai_memory, ai_observations, bugs, ai_log, state_cache_snapshot, index_stats_v1, last_indexed_ids_v1). Heavy. Don't do this lightly.
2. **Wait for natural cycle** — eventual HA WS drop or CF infrastructure rotation will refresh the DO. May take hours/days. The deployed code will activate at that point with no action needed.
3. **Add a self-abort endpoint that calls `state.abort()`** — but the OLD code doesn't have it, so we can't reach it. (Would work for *future* stale-code scenarios after the DO refreshes once.)
4. **Manually disconnect HA + sustain inactivity for 70+ seconds** — disable the minute cron in wrangler.toml, deploy, then disconnect HA WS, wait, redeploy with cron back. Untested; HA WS auto-reconnect logic might prevent the idle window.

**Agent-side workaround** (works regardless of DO state):
Post-filter `vector_search` results client-side in the chat agent: drop matches whose `topic_tag` doesn't match the desired tag, drop matches with score below desired floor. The metadata is returned with each match — the agent can do this in its synthesis step. Already documented in the new system prompt guidance.

**Recommended:** Option 2 — wait. The agent has the workaround. The DO will refresh on its own. When it does, the deployed code becomes live with no further action.

---

## #897fc129 — 5/8/2026, 10:22:58 PM — person.john showing not_home despite John being physically at home and active…

**Severity:** low  •  **Source:** chat (web)  •  **Entities:** person.john, sensor.johns_iphone_11_2_geocoded_location, zone.home

> person.john showing not_home despite John being physically at home and actively chatting via web. John's iPhone last geocoded at Highland Village Dr (3:08 PM, ~1 mile from house) — person entity may not be updating to home even though he's on the local network. Sabrina's person correctly shows home. John confirmed he's home at 10:22 PM.

**Captured state at report:**
- `person.john`: not_home
- `sensor.johns_iphone_11_2_geocoded_location`: 960 Rocket Way
Gardendale AL 35071
United States
- `zone.home`: 1

**Recent timeline (last 10 ai_log entries):**
- 2026-05-09 03:22:15 [chat_user] web: No, we did not.
- 2026-05-09 03:22:15 [vector_query] returned 5 matches for "No, we did not."
- 2026-05-09 03:22:15 [vector_query] returned 10 matches for "No, we did not."
- 2026-05-09 03:22:15 [vector_query] returned 5 matches for "No, we did not."
- 2026-05-09 03:22:26 [chat_reply] Got it — so you haven't been back yet tonight. Sabrina's been home since 5:31 PM, so you've been on separate schedules. She's there solo right now.
- 2026-05-09 03:22:26 [chat] done | exec=0 iter=1
- 2026-05-09 03:22:38 [chat_user] web: Home. Yes, report that as a bug.
- 2026-05-09 03:22:38 [vector_query] returned 5 matches for "Home. Yes, report that as a bug."
- 2026-05-09 03:22:38 [vector_query] returned 10 matches for "Home. Yes, report that as a bug."
- 2026-05-09 03:22:38 [vector_query] returned 5 matches for "Home. Yes, report that as a bug."

---

<!-- newest entries prepended above this comment -->
