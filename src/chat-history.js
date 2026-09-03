// ============================================================================
// chat-history.js — trimming for the persisted `chat_history:<channel>` value.
//
// Durable Object storage rejects any value over 131072 bytes. When that write
// fails the turn's reply has already been delivered, so the failure is silent
// to the user and the NEXT turn starts without the thread — the agent appears
// to forget the conversation it just had. That happened three times in one
// evening (2026-09-02) with values of 139–148 KB.
//
// The old trimmer missed it three ways:
//
//   1. It measured `JSON.stringify(...).length` — UTF-16 code units, not bytes.
//      Any non-ASCII content undercounts, and the limit is in bytes.
//   2. It only capped `tool` messages, so a single assistant message carrying a
//      large `reasoning_content` was never trimmed at all. That is what actually
//      blew the limit.
//   3. It stopped shifting at `length > 2`, so two oversized messages could sit
//      above the cap with no way down.
//
// A fourth problem was latent rather than observed: dropping messages off the
// front with `shift()` can remove an assistant message while keeping the `tool`
// results that answered its calls. An orphaned tool result is invalid on both
// wire formats, and the Responses API rejects it outright — every
// `function_call_output.call_id` must match a `function_call.call_id` in the
// same request. So trimming happens at whole-turn boundaries.
//
// Pure and side-effect free; tested directly in test/chat-history.test.js.
// ============================================================================

// Durable Object hard limit for a single stored value.
export const DO_VALUE_LIMIT_BYTES = 131072;

// What we actually aim for. The headroom absorbs the JSON envelope and any
// growth between measuring and writing; there is no benefit to running close
// to a limit whose failure mode is silent memory loss.
export const HISTORY_BYTE_BUDGET = 96000;

// Conversation depth, counted in user messages. Both the fast path and the LLM
// path write the SAME key, so they must agree — they previously used 6 and 8,
// which made retention depend on whichever path wrote last.
export const MAX_TURNS = 8;

// Per-message content caps, in bytes.
export const TOOL_CONTENT_CAP = 4000;
export const ASSISTANT_CONTENT_CAP = 8000;
export const USER_CONTENT_CAP = 8000;

const TRUNCATION_MARK = "…[truncated]";

const encoder = new TextEncoder();

export function byteLength(value) {
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

// Truncate to a byte budget without splitting a surrogate pair (which would
// produce a lone surrogate and a JSON serialization hazard).
export function truncateToBytes(str, maxBytes) {
  if (typeof str !== "string") return str;
  if (byteLength(str) <= maxBytes) return str;
  const room = Math.max(0, maxBytes - byteLength(TRUNCATION_MARK));
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(str.slice(0, mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  const last = str.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut--; // don't end mid-pair
  return str.slice(0, cut) + TRUNCATION_MARK;
}

// Reduce one message to what a later turn actually needs. Reasoning is dropped
// entirely: providers need it WITHIN the tool loop that produced it, never from
// a previous turn, and it is the single largest contributor to history growth
// (prompt tokens were observed climbing 10.7k → 30k across one evening).
export function capMessage(m, caps = {}) {
  if (!m || typeof m !== "object") return m;
  const toolCap = caps.tool ?? TOOL_CONTENT_CAP;
  const assistantCap = caps.assistant ?? ASSISTANT_CONTENT_CAP;
  const userCap = caps.user ?? USER_CONTENT_CAP;

  if (m.role === "tool") {
    const out = { role: "tool", tool_call_id: m.tool_call_id };
    out.content = typeof m.content === "string"
      ? truncateToBytes(m.content, toolCap)
      : m.content;
    return out;
  }

  if (m.role === "assistant") {
    // reasoning_content and _reasoning_items are deliberately not carried over.
    const out = { role: "assistant" };
    out.content = typeof m.content === "string"
      ? truncateToBytes(m.content, assistantCap)
      : m.content;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
    return out;
  }

  const out = { ...m };
  if (typeof out.content === "string") out.content = truncateToBytes(out.content, userCap);
  delete out.reasoning_content;
  delete out._reasoning_items;
  return out;
}

// Index of the first user message at or after `from`. -1 when there is none.
function nextUserIndex(messages, from) {
  for (let i = from; i < messages.length; i++) {
    if (messages[i] && messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Trim a history array so it is safe to persist:
 *   - every message capped,
 *   - at most `maxTurns` user messages,
 *   - under `byteBudget` bytes,
 *   - never starting mid-turn (no orphaned tool results).
 *
 * Returns a new array; never throws.
 */
export function trimChatHistory(messages, opts = {}) {
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const budget = opts.byteBudget ?? HISTORY_BYTE_BUDGET;

  let out = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === "object")
    .map((m) => capMessage(m, opts.caps));

  // Depth cap, measured in user messages, sliced at a turn boundary.
  const userIdxs = [];
  for (let i = 0; i < out.length; i++) if (out[i].role === "user") userIdxs.push(i);
  if (userIdxs.length > maxTurns) out = out.slice(userIdxs[userIdxs.length - maxTurns]);

  // Byte cap: drop whole turns from the front. Slicing to the next user message
  // keeps assistant tool_calls together with the tool results that answer them.
  while (out.length > 0 && byteLength(out) > budget) {
    const boundary = nextUserIndex(out, 1);
    if (boundary === -1) break;
    out = out.slice(boundary);
  }

  // A single turn that still doesn't fit: squeeze its contents hard before
  // giving up any of it.
  if (out.length > 0 && byteLength(out) > budget) {
    out = out.map((m) => capMessage(m, { tool: 500, assistant: 1000, user: 1000 }));
  }

  // Last resort: keep the most recent user message and the reply to it. Losing
  // older context is survivable; failing the write loses the whole thread.
  if (out.length > 0 && byteLength(out) > budget) {
    const lastUser = out.map((m) => m.role).lastIndexOf("user");
    out = lastUser === -1 ? out.slice(-1) : out.slice(lastUser);
    out = out.filter((m) => m.role === "user" || (m.role === "assistant" && !m.tool_calls));
    out = out.map((m) => capMessage(m, { assistant: 2000, user: 2000 }));
  }

  // Never begin with a dangling tool result.
  while (out.length > 0 && out[0].role === "tool") out.shift();

  return out;
}
