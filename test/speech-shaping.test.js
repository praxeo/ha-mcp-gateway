// Tests for the voice-pipeline pure helpers:
//  - cleanForSpeech / resolveVoiceSpeed (src/tts.js) — shapes an agent
//    reply for text-to-speech and resolves the ElevenLabs speed setting
//  - normalizeKeyterm (src/stt.js) — filters entity names into Scribe
//    keyterm bias
//
// These import the real modules (same convention as llm-providers and
// chat-history tests), so the suite cannot drift from the shipped code.

import { describe, it, expect } from "vitest";
import { cleanForSpeech, resolveVoiceSpeed, TTS_CONFIG } from "../src/tts.js";
import { normalizeKeyterm } from "../src/stt.js";

describe("cleanForSpeech", () => {
  it("returns empty string for empty input", () => {
    expect(cleanForSpeech(null)).toBe("");
    expect(cleanForSpeech(undefined)).toBe("");
    expect(cleanForSpeech("")).toBe("");
  });

  it("strips bold markers but keeps the words", () => {
    expect(cleanForSpeech("The **back porch** is unlocked.")).toBe("The back porch is unlocked.");
  });

  it("speaks an entity id as its object name", () => {
    expect(cleanForSpeech("Turning off light.bedside_lamp now."))
      .toBe("Turning off bedside lamp now.");
  });

  it("handles the cover fast-path entity ids the agent quotes", () => {
    expect(cleanForSpeech("cover.ratgdo32_2b8ecc_door is closing."))
      .toBe("ratgdo32 2b8ecc door is closing.");
  });

  it("leaves ordinary prose containing periods alone", () => {
    expect(cleanForSpeech("Back by 7 p.m. tonight.")).toBe("Back by 7 p.m. tonight.");
    expect(cleanForSpeech("Warm rooms, e.g. the den.")).toBe("Warm rooms, e.g. the den.");
    expect(cleanForSpeech("It is 71.5 degrees.")).toBe("It is 71.5 degrees.");
  });

  it("flattens a bulleted list into sentences", () => {
    const out = cleanForSpeech("Two doors are unlocked:\n- Basement Door\n- Back Porch");
    expect(out).toBe("Two doors are unlocked:. Basement Door. Back Porch");
    expect(out).not.toContain("-");
    expect(out).not.toContain("\n");
  });

  it("removes heading markers", () => {
    expect(cleanForSpeech("## Status\nAll locked.")).toBe("Status. All locked.");
  });

  it("removes code fences and inline code", () => {
    expect(cleanForSpeech("Try `npm test` now.")).toBe("Try npm test now.");
    expect(cleanForSpeech("Before\n```\nsome code\n```\nAfter")).toContain("Before");
    expect(cleanForSpeech("Before\n```\nsome code\n```\nAfter")).not.toContain("`");
  });

  it("expands spoken units and symbols into words", () => {
    expect(cleanForSpeech("It is 72°F outside.")).toBe("It is 72 degrees Fahrenheit outside.");
    expect(cleanForSpeech("Battery at 84% now.")).toBe("Battery at 84 percent now.");
    expect(cleanForSpeech("Locks & cameras.")).toBe("Locks and cameras.");
  });

  it("drops URLs entirely rather than reading them", () => {
    expect(cleanForSpeech("See https://example.com/x for details.")).toBe("See for details.");
  });

  it("strips emoji so they are not read as garbage", () => {
    expect(cleanForSpeech("All secure ✅🔒 tonight.")).toBe("All secure tonight.");
    expect(cleanForSpeech("Heating ♨️ to 70°F.")).toBe("Heating to 70 degrees Fahrenheit.");
  });

  it("collapses runs of whitespace", () => {
    expect(cleanForSpeech("Locked.    All   five.")).toBe("Locked. All five.");
  });

  it("truncates at a sentence boundary when over the cap", () => {
    const sentence = "The house is secure and everything is locked up tight. ";
    const long = sentence.repeat(30);
    const out = cleanForSpeech(long);
    expect(out.length).toBeLessThanOrEqual(TTS_CONFIG.maxChars);
    expect(out.endsWith(".")).toBe(true);
  });

  it("leaves short plain replies untouched", () => {
    expect(cleanForSpeech("Done.")).toBe("Done.");
    expect(cleanForSpeech("main garage bay door is opening.")).toBe("main garage bay door is opening.");
  });
});

describe("resolveVoiceSpeed", () => {
  it("defaults to the config speed when nothing is set", () => {
    expect(resolveVoiceSpeed({}, {})).toBe(TTS_CONFIG.speed);
  });

  it("prefers per-request speed over the secret, and the secret over the default", () => {
    expect(resolveVoiceSpeed({ speed: 1.1 }, { ELEVENLABS_VOICE_SPEED: "0.9" })).toBe(1.1);
    expect(resolveVoiceSpeed({}, { ELEVENLABS_VOICE_SPEED: "0.9" })).toBe(0.9);
  });

  it("clamps to the ElevenLabs working range and rounds to 2 decimals", () => {
    expect(resolveVoiceSpeed({ speed: 5 }, {})).toBe(1.2);
    expect(resolveVoiceSpeed({ speed: 0.1 }, {})).toBe(0.7);
    expect(resolveVoiceSpeed({ speed: "1.057" }, {})).toBe(1.06);
  });

  it("falls back to the default on unparseable values", () => {
    expect(resolveVoiceSpeed({ speed: "fast" }, {})).toBe(TTS_CONFIG.speed);
    expect(resolveVoiceSpeed({}, { ELEVENLABS_VOICE_SPEED: null })).toBe(TTS_CONFIG.speed);
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
