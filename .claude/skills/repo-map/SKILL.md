---
name: repo-map
description: Navigate the ha-mcp-gateway codebase — what to read vs. never read, end-to-end request traces, verified search recipes, and a symbol index for a repo whose behavior lives in one 5,700-line Durable Object beside a 3,000-line Worker. Use when locating a symbol, tracing a request, answering "where is X handled", orienting before editing src/worker.js or src/ha-websocket.js, or checking a claim about this code against the code.
---

# Browsing ha-mcp-gateway

`CLAUDE.md` is auto-loaded. It covers **what the system is**, **the rules for
changing it**, and — in its "Where to change things" section — **which knob to
turn for a given task** (the voice, the prompt, the model, VAD tuning).

This skill is the layer under that: **how to move around the source** when the
answer is not already in a table. Reach for it when you need to find something by
concept, trace a request end to end, or confirm a number instead of repeating one.

Two standing rules:

1. **The code is authoritative.** `CLAUDE.md` and `README.md` are hand-maintained
   and have drifted before — stale model names, stale counts, missing files. Run
   the matching recipe in §5 before repeating a number from either.
2. **Never edit `dist/worker.js`.** It is esbuild output, regenerated on every
   build. All source is in `src/`.

---

## 1. Context budget: what to read, what to never read

Small in file count, large in file size. Reading the wrong file whole costs more
context than the rest of the task.

| File | Lines | How to read it |
|---|---|---|
| `src/ha-websocket.js` | 5,723 | **Never whole.** Grep the symbol, read a window (§4). Class `HAWebSocketV31`. |
| `src/worker.js` | 3,057 | **Never whole.** The `TOOLS` array alone is lines ~58–722. |
| `src/chat-ui.html.js` | 1,612 | One template literal (`CHAT_HTML`) — the entire `/chat` UI. Grep inside it. |
| `src/agent-tools.js` | 603 | Safe whole — the 19 chat-agent tool schemas. |
| `src/vectorize-schema.js` | 420 | Safe whole. |
| `src/llm-providers.js` | 381 | Safe whole. Read its header comment first — it explains the two wire formats. |
| `src/chat-prompt.js` | 209 | Safe whole. Read before touching prompt text. |
| `src/chat-history.js` | 167 | Safe whole. |
| `src/stt.js` | 157 | Safe whole. All speech-to-text. |
| `src/tts.js` | 89 | Safe whole. All text-to-speech. |
| `migrations/*.sql` | 8–61 | Safe whole. |
| `test/*.test.js` | 127–525 | Safe. Often the fastest spec for a pure helper. |

**Never read these:**

- `dist/worker.js` — 418 KB build artifact, nothing not already in `src/`.
- `node_modules/` — vendored.
- `.prompt-dump.json`, `.prompt-extracted.txt` — 50 KB diagnostic dumps that
  **contain household PII**. Gitignored. Do not read, quote, or copy them.
- `.claude/settings.local.json` — **contains live Cloudflare API tokens.**
  Gitignored. Never read it into context or echo it.
- `.claude/worktrees/**` — stale full copies of the repo from past sessions.
  Scoping a grep to `src/` avoids them; a bare recursive grep from the root does
  not (§4).
- `README.md` (65 KB) — grep for sections, never read whole.

---

## 2. Where things live

Follow the question, not the filename.

| Your question | Go to |
|---|---|
| "What MCP tools exist / what does tool X do?" | `src/worker.js` → `TOOLS`, then `handleTool` for behavior |
| "What can the *chat agent* do?" | `src/agent-tools.js` (19 schemas); dispatch in `executeNativeTool` |
| "How is a chat message handled?" | `ha-websocket.js` → `chatWithAgent` → `chatWithAgentNative` → `runNativeToolLoop` |
| "Why did the agent say that?" | Prompt: `src/chat-prompt.js`. Context: `buildDynamicContext`, `_buildNativeContextEntities`, `_buildHouseStateSnapshot` |
| "Which model / provider / reasoning?" | `ha-websocket.js` static `LLM_*` + `resolveLLMConfig`; provider facts in `src/llm-providers.js` |
| "How does a request reach a non-Fireworks provider?" | `src/llm-providers.js` — Chat Completions ↔ Responses API translation |
| "Why did the conversation forget?" | `src/chat-history.js` — byte budget vs. the DO's 131072-byte value cap |
| "Voice in / voice out" | `src/stt.js` / `src/tts.js` — each is self-contained |
| "Why is the garage door instant?" | `_tryDeterministicFastPath` (`ha-websocket.js`) |
| "How does an HA event become a D1 row?" | `onEvent` → `_shouldLogStateChange` → `_write*ToD1` |
| "How does semantic search work?" | `retrieveKnowledge` (DO) + `src/vectorize-schema.js` + `backfillKnowledge` (worker) |
| "What runs on a schedule?" | Worker `scheduled()` + `prewarmCache` + `daily*`; DO `alarm()` + `_fireDueScheduledActions` |
| "What HTTP routes exist?" | Worker: grep `url.pathname ===`. DO: grep `case "/` |

The Worker is stateless routing. **All long-lived state and every LLM call live in
the one Durable Object.** Behavior is almost always in `src/ha-websocket.js`;
plumbing is in `src/worker.js`.

---

## 3. End-to-end traces

Verified against the current tree. Line numbers drift; symbol names do not.

**Web chat (`POST /chat`)**

```
worker.js  url.pathname === "/chat"          (~2362)
  └─ stub.fetch("http://do/ai_chat_stream")  (~2393, SSE)
       └─ DO fetch() case "/ai_chat_stream"  (~1595)
            └─ chatWithAgent()               gate: env.USE_NATIVE_TOOL_LOOP === "true" (~3376)
                 └─ chatWithAgentNative()                        (~5243)
                      ├─ _tryDeterministicFastPath()             ← may return before any LLM call
                      ├─ getStaticChatSystemPrompt()             ← byte-identical every request
                      ├─ buildDynamicContext()                   ← all per-request data
                      └─ runNativeToolLoop()                     (~4677)
                           ├─ callLLMWithTools()                 (~4596)
                           │    └─ llm-providers.js: buildResponsesBody()
                           │         → provider → responsesToChatCompletion()
                           └─ executeNativeTool()                (~4084)
```

The provider layer is a **wire-format translator only**. History and the tool loop
always speak Chat Completions; `llm-providers.js` converts at the boundary, which
is what lets the model be swapped mid-conversation.

**MCP (`POST /mcp`)**

```
worker.js  handleMCP()  (~2230)
  ├─ tools/list  → getAgentToolset(role)        → TOOLS minus DANGEROUS_TOOLS (12)
  └─ tools/call  → handleTool(env, name, args)  (~1088)
       ├─ haRequest()  → Home Assistant REST
       └─ doFetch()    → the Durable Object
```

**Voice**

```
POST /transcribe → stt.js handleTranscribe()  keyterms read-only from KV;
                                              4xx on keyterms → retry without
POST /tts        → tts.js handleTTS()         cleanForSpeech() → ElevenLabs
```

**Cron**

```
worker.js scheduled()  (~2963)
  ├─ "* * * * *"  → prewarmCache()   (~2972)  KV warm; registry every 15m; DO reconnect
  └─ "30 8 * * *" → dailyKnowledgeResync() (~3035) + dailyAiLogRetention() (~3006)
                    + dailyForensicLogRetention() (~3019)

ha-websocket.js alarm()  (~5691)  WS ping/pong + reconnect + _fireDueScheduledActions()
                                  (the 60s reschedule is mandatory — never remove it)
```

---

## 4. Search recipes

Run from the repo root. **Always scope to `src/`, `test/`, or a named file** — a
bare recursive grep also hits `.claude/worktrees/` and `dist/`.

```bash
# Symbol → line number (start every lookup here)
grep -n "methodName" src/ha-websocket.js

# Read a window around the hit instead of the whole file
sed -n '4677,4740p' src/ha-websocket.js

# Full method index of the Durable Object (88 methods)
grep -nE '^  (async )?[_a-zA-Z][a-zA-Z0-9_]*\(' src/ha-websocket.js

# Full function index of the Worker (41 functions)
grep -nE '^(async )?function ' src/worker.js

# Every Worker HTTP route
grep -oE 'url\.pathname === "[^"]+"' src/worker.js | sort -u

# Every DO internal route
grep -oE 'case "/[a-z_]+"' src/ha-websocket.js | sort -u

# Where is this tool implemented, across both surfaces?
grep -n '"toolname"' src/worker.js src/agent-tools.js src/ha-websocket.js
```

Prefer `grep -n` plus `sed -n 'A,Bp'` over reading a file. Two cheap commands beat
one 5,700-line read.

---

## 5. Verify-before-you-claim

Each recipe was run against the current tree; the comment is what it returned.

```bash
# MCP tool count  → 82
awk '/^var TOOLS = \[/,/^\];/' src/worker.js | grep -c "inputSchema"

# All 82 MCP tool names (handles both one-line and multi-line entry styles)
awk '/^var TOOLS = \[/,/^\];/' src/worker.js \
  | grep -oE '^.{4}name: "[a-z_]+"' | sed 's/.*name: "//; s/"$//' | sort

# Chat-agent tool count  → 19  (6 action + 13 read)
grep -cE '^      name: "' src/agent-tools.js

# Dangerous (role-gated) tools  → 12
awk '/^const DANGEROUS_TOOLS/,/\]\);/' src/worker.js | grep -c '^  "'

# Current DO class (drives the rename/migration dance — CLAUDE.md gotcha #1)
grep -n "^export class HAWebSocket" src/ha-websocket.js       # → HAWebSocketV31

# Current model / provider / reasoning defaults
grep -n "static LLM_" src/ha-websocket.js

# Highest DO migration tag — must match the class version
grep -E '^tag = ' wrangler.toml | tail -1                     # → v31

# Tracked test files and cases  → 9 files / 207 cases
git ls-tree -r HEAD --name-only -- test/ | wc -l
for f in $(git ls-tree -r HEAD --name-only -- test/); do \
  echo "$(basename $f): $(grep -cE '^\s*it\(' $f)"; done
```

**`npm test` over-reports — do not quote its totals.** There is no vitest
`exclude`, so a run also collects stale duplicate suites out of
`.claude/worktrees/` (full repo snapshots from past sessions) and currently
reports **12 files / 271 tests**. Those duplicates run against the *old* source
bundled in each worktree, so they can pass while the real suite fails. The truth
is **9 tracked files / 207 cases**; read the file paths in vitest output, not the
totals.

---

## 6. Live traps

- **DO changes do not go live on an ordinary deploy.** The persistent HA WebSocket
  pins the V8 isolate. Any change to `src/ha-websocket.js` needs the class rename
  plus a migration (CLAUDE.md gotcha #1) — it is at `HAWebSocketV31` after 30
  renames. Everything else in `src/` is Worker-side and ships on deploy, which is
  the reason the voice, prompt, provider and history code was extracted into
  modules: those knobs can be turned without the rename dance.
- **A model swap needs no rename.** `POST /admin/llm-config` overrides provider,
  model, endpoint and reasoning live. `POST /admin/llm-selftest` probes a
  candidate config without storing it.
- **`sed -i` strips CRLF here.** The working tree is CRLF (`core.autocrlf=true`)
  for `CLAUDE.md`, `.gitignore` and most tracked text. Use `perl -i -pe`, which
  preserves line endings, or the Edit tool — and when matching multi-line blocks
  in perl, read with `:raw` and match raw UTF-8 bytes (no `use utf8`, no `\x{...}`
  escapes for the box-drawing and em-dash characters in CLAUDE.md).
- **Two chat paths still exist.** `chatWithAgent` holds the legacy JSON path;
  `chatWithAgentNative` is what runs, gated on `env.USE_NATIVE_TOOL_LOOP ===
  "true"`. That flag is **not** in `wrangler.toml` — it is set in the Cloudflare
  dashboard. Do not write off the legacy branch without checking the flag.
- **The prefix cache is load-bearing.** Interpolating any per-request value into
  `getStaticChatSystemPrompt()` silently destroys it. Per-request data belongs in
  `buildDynamicContext()`.
- **`src/oauth.js` may exist locally but is not in the repo.** It is untracked
  work-in-progress (an OAuth 2.1 server for `/mcp`), nothing imports it, and its
  migration is unapplied. `/mcp` is not OAuth-protected. Confirm with
  `grep -rn "oauth" src/worker.js` (no output) before describing it as wired.
- **Production is the author's occupied house.** There is no staging; a push to
  `main` deploys. Read freely; do not push speculative changes.

---

## 7. Deeper reference

`references/landmarks.md` — the full verified symbol index for
`src/ha-websocket.js` and `src/worker.js` with line numbers, grouped by subsystem,
plus the smaller modules and what each test suite pins. Load it when you need to
find something by *concept* rather than by name, or when a grep for the obvious
name comes back empty.
