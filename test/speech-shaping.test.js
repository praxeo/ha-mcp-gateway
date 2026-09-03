// Tests for the two pure helpers added for Phase 0 voice work in
// src/worker.js: stripForSpeech (shapes an agent reply for text-to-speech)
// and normalizeKeyterm (filters entity names into Scribe keyterm bias).
//
// Per repo convention the helpers are stubbed here in sync with the worker —
// worker.js has no test-friendly export surface. Keep these copies identical
// to the originals when either changes.

import { describe, it, expect } from "vitest";

// ── synced stub: src/worker.js stripForSpeech ────────────────────────────
const TTS_MAX_CHARS = 600;

function stripForSpeech(raw) {
  if (typeof raw !== "string") return "";
  let t = raw;
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1");
  t = t.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, "$1$2");
  t = t.replace(/^\s*#{1,6}\s*/gm, "");
  t = t.replace(/^\s*[-*•]\s+/gm, "");
  t = t.replace(/\b[a-z_]{3,}\.[a-z0-9_]{3,}\b/g, (m) => m.split(".")[1].replace(/_/g, " "));
  t = t.replace(/\s*\n+\s*/g, ". ");
  t = t.replace(/\.\s*\./g, ".");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > TTS_MAX_CHARS) {
    const cut = t.slice(0, TTS_MAX_CHARS);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = lastStop > 120 ? cut.slice(0, lastStop + 1) : cut;
  }
  return t;
}

// ── synced stub: src/worker.js normalizeKeyterm ──────────────────────────
const STT_KEYTERM_MAXLEN = 50;

function normalizeKeyterm(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 3 || t.length > STT_KEYTERM_MAXLEN) return null;
  if (!/[a-z]/i.test(t)) return null;
  if (/^[0-9a-f]{6,}$/i.test(t)) return null;
  if (t.includes("_") || t.includes(".")) return null;
  return t;
}

describe("stripForSpeech", () => {
  it("returns empty string for non-string input", () => {
    expect(stripForSpeech(null)).toBe("");
    expect(stripForSpeech(undefined)).toBe("");
    expect(stripForSpeech(42)).toBe("");
  });

  it("strips bold markers but keeps the words", () => {
    expect(stripForSpeech("The **back porch** is unlocked.")).toBe("The back porch is unlocked.");
  });

  it("speaks an entity id as its object name", () => {
    expect(stripForSpeech("Turning off light.bedside_lamp now."))
      .toBe("Turning off bedside lamp now.");
  });

  it("handles the cover fast-path entity ids the agent quotes", () => {
    expect(stripForSpeech("cover.ratgdo32_2b8ecc_door is closing."))
      .toBe("ratgdo32 2b8ecc door is closing.");
  });

  it("leaves ordinary prose containing periods alone", () => {
    expect(stripForSpeech("Back by 7 p.m. tonight.")).toBe("Back by 7 p.m. tonight.");
    expect(stripForSpeech("Warm rooms, e.g. the den.")).toBe("Warm rooms, e.g. the den.");
    expect(stripForSpeech("It is 71.5 degrees.")).toBe("It is 71.5 degrees.");
  });

  it("flattens a bulleted list into sentences", () => {
    const out = stripForSpeech("Two doors are unlocked:\n- Basement Door\n- Back Porch");
    expect(out).toBe("Two doors are unlocked:. Basement Door. Back Porch");
    expect(out).not.toContain("-");
    expect(out).not.toContain("\n");
  });

  it("removes heading markers", () => {
    expect(stripForSpeech("## Status\nAll locked.")).toBe("Status. All locked.");
  });

  it("removes code fences and inline code", () => {
    expect(stripForSpeech("Try `npm test` now.")).toBe("Try npm test now.");
    expect(stripForSpeech("Before\n```\nsome code\n```\nAfter")).toContain("Before");
    expect(stripForSpeech("Before\n```\nsome code\n```\nAfter")).not.toContain("`");
  });

  it("collapses runs of whitespace", () => {
    expect(stripForSpeech("Locked.    All   five.")).toBe("Locked. All five.");
  });

  it("truncates at a sentence boundary when over the cap", () => {
    const sentence = "The house is secure and everything is locked up tight. ";
    const long = sentence.repeat(30);
    const out = stripForSpeech(long);
    expect(out.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    expect(out.endsWith(".")).toBe(true);
  });

  it("leaves short plain replies untouched", () => {
    expect(stripForSpeech("Done.")).toBe("Done.");
    expect(stripForSpeech("main garage bay door is opening.")).toBe("main garage bay door is opening.");
  });
});

describe("normalizeKeyterm", () => {
  it("accepts ordinary friendly names", () => {
    expect(normalizeKeyterm("Bedside Lamp")).toBe("Bedside Lamp");
    expect(normalizeKeyterm("Back Porch")).toBe("Back Porch");
  });

  it("collapses internal whitespace and trims", () => {
    expect(normalizeKeyterm("  Front   Door  ")).toBe("Front Door");
  });

  it("rejects entity ids and snake_case object names", () => {
    expect(normalizeKeyterm("light.bedside_lamp")).toBeNull();
    expect(normalizeKeyterm("bedside_lamp")).toBeNull();
  });

  it("rejects terms that are too short or too long", () => {
    expect(normalizeKeyterm("AC")).toBeNull();
    expect(normalizeKeyterm("x".repeat(51))).toBeNull();
    expect(normalizeKeyterm("x".repeat(50))).toBe("x".repeat(50));
  });

  it("rejects strings with no letters", () => {
    expect(normalizeKeyterm("12345")).toBeNull();
    expect(normalizeKeyterm("---")).toBeNull();
  });

  it("rejects hex blobs that leak in as device names", () => {
    expect(normalizeKeyterm("2b8ecc")).toBeNull();
    expect(normalizeKeyterm("a1b2c3d4e5")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(normalizeKeyterm(null)).toBeNull();
    expect(normalizeKeyterm(undefined)).toBeNull();
    expect(normalizeKeyterm(7)).toBeNull();
  });
});
