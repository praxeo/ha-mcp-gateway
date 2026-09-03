// Tests for src/chat-history.js — the persisted-history trimmer.
//
// Imports the real module (it is pure), so there is no stub to keep in sync.
//
// The load-bearing cases are the two that were actually broken in production:
// an oversized value that DO storage rejected (three times on 2026-09-02, at
// 139–148 KB), and trimming that could orphan a tool result.

import { describe, it, expect } from "vitest";
import {
  trimChatHistory,
  capMessage,
  truncateToBytes,
  byteLength,
  DO_VALUE_LIMIT_BYTES,
  HISTORY_BYTE_BUDGET,
  MAX_TURNS
} from "../src/chat-history.js";

const turn = (n) => [
  { role: "user", content: `[web]: question ${n}` },
  { role: "assistant", content: `answer ${n}` }
];

describe("byteLength", () => {
  it("counts bytes, not UTF-16 code units — the original bug", () => {
    // The old cap used String.length, so multi-byte content undercounted
    // against a limit that is specified in bytes.
    const emoji = "🔒".repeat(100);
    expect(emoji.length).toBe(200);        // UTF-16 units
    expect(byteLength(emoji)).toBe(400);   // actual bytes
  });

  it("serializes non-strings before measuring", () => {
    expect(byteLength([{ role: "user", content: "hi" }])).toBeGreaterThan(10);
  });
});

describe("truncateToBytes", () => {
  it("leaves short strings alone", () => {
    expect(truncateToBytes("short", 100)).toBe("short");
  });

  it("brings an oversized string under the budget", () => {
    const out = truncateToBytes("x".repeat(5000), 1000);
    expect(byteLength(out)).toBeLessThanOrEqual(1000);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("respects the byte budget with multi-byte content", () => {
    const out = truncateToBytes("é".repeat(5000), 1000);
    expect(byteLength(out)).toBeLessThanOrEqual(1000);
  });

  it("never splits a surrogate pair", () => {
    const out = truncateToBytes("🔒".repeat(1000), 500);
    expect(byteLength(out)).toBeLessThanOrEqual(500);
    // A lone surrogate would not survive an encode/decode round trip intact.
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("capMessage", () => {
  it("drops reasoning from an assistant message", () => {
    // This is what actually blew the limit: reasoning was never capped.
    const out = capMessage({
      role: "assistant",
      content: "Done.",
      reasoning_content: "x".repeat(100000),
      _reasoning_items: [{ type: "reasoning", encrypted_content: "y".repeat(50000) }]
    });
    expect(out.reasoning_content).toBeUndefined();
    expect(out._reasoning_items).toBeUndefined();
    expect(out.content).toBe("Done.");
    expect(byteLength(out)).toBeLessThan(200);
  });

  it("keeps tool_calls, which the next turn needs to stay coherent", () => {
    const out = capMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }]
    });
    expect(out.tool_calls).toHaveLength(1);
  });

  it("caps an oversized assistant message", () => {
    const out = capMessage({ role: "assistant", content: "x".repeat(50000) });
    expect(byteLength(out.content)).toBeLessThanOrEqual(8000);
  });

  it("caps a tool result and keeps its call id", () => {
    const out = capMessage({ role: "tool", tool_call_id: "c1", content: "x".repeat(50000) });
    expect(out.tool_call_id).toBe("c1");
    expect(byteLength(out.content)).toBeLessThanOrEqual(4000);
  });

  it("caps a huge pasted user message", () => {
    const out = capMessage({ role: "user", content: "x".repeat(50000) });
    expect(byteLength(out.content)).toBeLessThanOrEqual(8000);
  });

  it("passes through junk without throwing", () => {
    expect(capMessage(null)).toBeNull();
    expect(capMessage("nope")).toBe("nope");
  });
});

describe("trimChatHistory — the production failure", () => {
  it("keeps a value DO storage would have rejected under the limit", () => {
    // Reproduces 2026-09-02: two messages totalling ~148 KB. The old trimmer
    // stopped shifting at length > 2 and never capped assistant content, so
    // the put failed and the next turn lost the thread.
    const history = [
      { role: "user", content: "[web]: summarize the last few days" },
      {
        role: "assistant",
        content: "Here is the summary. ".repeat(2000),
        reasoning_content: "z".repeat(140000)
      }
    ];
    expect(byteLength(history)).toBeGreaterThan(DO_VALUE_LIMIT_BYTES);

    const out = trimChatHistory(history);
    expect(byteLength(out)).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
    expect(byteLength(out)).toBeLessThan(DO_VALUE_LIMIT_BYTES);
    // and the exchange itself survives
    expect(out.some((m) => m.role === "user")).toBe(true);
    expect(out.some((m) => m.role === "assistant")).toBe(true);
  });

  it("fits even when a single message is enormous on its own", () => {
    const out = trimChatHistory([
      { role: "user", content: "q" },
      { role: "assistant", content: "y".repeat(400000) }
    ]);
    expect(byteLength(out)).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
  });

  it("fits when every turn is large — many turns, not just one", () => {
    const history = [];
    for (let i = 0; i < 40; i++) {
      history.push({ role: "user", content: `[web]: q${i} ` + "x".repeat(3000) });
      history.push({ role: "assistant", content: "y".repeat(9000) });
    }
    const out = trimChatHistory(history);
    expect(byteLength(out)).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("trimChatHistory — turn boundaries", () => {
  it("keeps at most MAX_TURNS user messages", () => {
    const history = [];
    for (let i = 0; i < 20; i++) history.push(...turn(i));
    const out = trimChatHistory(history);
    expect(out.filter((m) => m.role === "user")).toHaveLength(MAX_TURNS);
  });

  it("keeps the most recent turns, not the oldest", () => {
    const history = [];
    for (let i = 0; i < 20; i++) history.push(...turn(i));
    const out = trimChatHistory(history);
    expect(out[0].content).toContain("question 12");
    expect(out[out.length - 1].content).toContain("answer 19");
  });

  it("never leaves a tool result without its call — the latent bug", () => {
    // shift()-based trimming could drop the assistant message carrying
    // tool_calls while keeping the tool results that answered them. The
    // Responses API rejects that: every function_call_output.call_id must
    // match a function_call.call_id in the same request.
    // Sized so the BYTE loop must run after the turn cap — that is the
    // condition under which the old shift() orphaned things. Verified: the old
    // trimmer returned a history starting with a `tool` message and orphaning
    // call_2.
    const history = [];
    for (let i = 0; i < 8; i++) {
      history.push({ role: "user", content: `[web]: q${i}` });
      history.push({
        role: "assistant",
        content: "n".repeat(18000),
        tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "get_state", arguments: "{}" } }]
      });
      history.push({ role: "tool", tool_call_id: `call_${i}`, content: "r".repeat(3000) });
      history.push({ role: "assistant", content: `answer ${i}` });
    }
    expect(byteLength(history)).toBeGreaterThan(HISTORY_BYTE_BUDGET); // byte loop runs

    const out = trimChatHistory(history);
    expect(out[0].role).toBe("user"); // starts on a turn boundary

    const callIds = new Set();
    for (const m of out) {
      if (m.role === "assistant") for (const tc of m.tool_calls || []) callIds.add(tc.id);
      if (m.role === "tool") {
        expect(callIds.has(m.tool_call_id)).toBe(true); // no orphan
      }
    }
  });

  it("never starts with a tool result", () => {
    const out = trimChatHistory([
      { role: "tool", tool_call_id: "orphan", content: "result" },
      { role: "user", content: "[web]: hi" },
      { role: "assistant", content: "hello" }
    ]);
    expect(out[0].role).not.toBe("tool");
  });
});

describe("trimChatHistory — robustness", () => {
  it("returns an empty array for junk input", () => {
    expect(trimChatHistory(null)).toEqual([]);
    expect(trimChatHistory(undefined)).toEqual([]);
    expect(trimChatHistory("nope")).toEqual([]);
  });

  it("drops null entries rather than throwing", () => {
    const out = trimChatHistory([null, { role: "user", content: "hi" }, undefined]);
    expect(out).toHaveLength(1);
  });

  it("leaves a short history untouched apart from the reasoning strip", () => {
    const out = trimChatHistory([
      { role: "user", content: "[web]: close the garage" },
      { role: "assistant", content: "main garage bay door is closing." }
    ]);
    expect(out).toEqual([
      { role: "user", content: "[web]: close the garage" },
      { role: "assistant", content: "main garage bay door is closing." }
    ]);
  });

  it("honours explicit options", () => {
    const history = [];
    for (let i = 0; i < 10; i++) history.push(...turn(i));
    expect(trimChatHistory(history, { maxTurns: 2 }).filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("stays under a tiny budget without throwing", () => {
    const history = [];
    for (let i = 0; i < 10; i++) history.push(...turn(i));
    const out = trimChatHistory(history, { byteBudget: 200 });
    expect(byteLength(out)).toBeLessThanOrEqual(200);
  });
});
