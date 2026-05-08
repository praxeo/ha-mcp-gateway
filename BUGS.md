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

<!-- newest entries prepended above this comment -->
