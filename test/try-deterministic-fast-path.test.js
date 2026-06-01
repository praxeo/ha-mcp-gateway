/**
 * Unit tests for _tryDeterministicFastPath bail/fire behavior.
 *
 * The method lives on HAWebSocketV25 in src/ha-websocket.js. Its only DO
 * dependencies are `this.stateCache` (Map of entity_id -> state object),
 * `this.sendCommand` (HA service-call dispatcher), and `this.logAI`
 * (fire-and-forget log writer). We test via an inline stub class to avoid the
 * full CF worker import chain (same pattern as the other suites here).
 *
 * KEEP IN SYNC with src/ha-websocket.js _tryDeterministicFastPath. The stub
 * mirrors it line-for-line minus the logAI hook (recorded here instead).
 *
 * Regression anchor: a forensic/timeline question ("show me a timeline for
 * when the garage door opened ... figure out if the Tesla can open the
 * garage") once matched the bare verb "open" and physically opened the main
 * garage bay door. These tests lock in that such questions bail to the LLM.
 */
import { describe, it, expect, beforeEach } from "vitest";

const GARAGE = "cover.ratgdo32_2b8ecc_door";
const BASEMENT = "cover.ratgdo32_b1e618_door";
const LEFT_BASEMENT = "cover.ratgdo_left_basement_door";

class FastPathStub {
  constructor() {
    this.stateCache = new Map();
    this.commands = [];
    this.logged = [];
  }
  logAI(type, message, data) {
    this.logged.push({ type, message, data });
  }
  async sendCommand(cmd) {
    this.commands.push(cmd);
    return { success: true };
  }

  async _tryDeterministicFastPath(message) {
    if (!message || typeof message !== "string") return null;
    const text = message.toLowerCase().trim();

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    if (text.endsWith("?") || /^(did|do|does|is|are|was|were|have|has|had)\b/.test(text)) {
      return null;
    }

    if (/\b(when|whenever|timeline|history|historical|logbook|recently|earlier|yesterday|how long|how often|how many|what time|last time|figure out|trying to|find out|tell me|show me|list|summary|summarize|report|explain)\b/.test(text)) {
      return null;
    }

    if (wordCount > 12 || (text.match(/,/g) || []).length >= 2) {
      return null;
    }

    const mentionsOpen = /\b(open|opens|opened|opening|raise|raises|raised|raising|lift|lifts|lifted|lifting)\b/.test(text);
    const mentionsClose = /\b(close|closes|closed|closing|shut|shuts|shutting|lower|lowers|lowered|lowering|drop|drops|dropped|dropping)\b/.test(text);
    if (!mentionsOpen && !mentionsClose) return null;
    if (mentionsOpen && mentionsClose) return null;

    const isOpen = /\b(open|raise|lift)\b/.test(text);
    const isClose = /\b(close|shut|lower|drop)\b/.test(text);
    if (!isOpen && !isClose) return null;
    if (isOpen && isClose) return null;

    const NON_COVER_QUALIFIER = /\b(exterior|interior|front|back|rear|side|patio|sliding|french|storm|screen|porch|walkout|cellar|deadbolt|latch|lock|window|vent|hatch|gate|light|fan|switch)\b/;
    const hasDisqualifier = NON_COVER_QUALIFIER.test(text);

    let entityId = null;
    let label = null;

    if (/\bleft\b.*\bbasement\b/.test(text) || /\bleft\b.*\bbay\b/.test(text)) {
      entityId = "cover.ratgdo_left_basement_door";
      label = "left basement bay door";
    }
    else if (
      /\bbasement bay\b/.test(text) ||
      /\bbasement garage\b/.test(text) ||
      /\bright basement\b/.test(text) ||
      /\bbasement door\b/.test(text) ||
      (/\bbasement\b/.test(text) && !hasDisqualifier)
    ) {
      entityId = "cover.ratgdo32_b1e618_door";
      label = "basement bay door";
    }
    else if (
      /\bmain garage\b/.test(text) ||
      /\bgarage door\b/.test(text) ||
      /\bgarage bay\b/.test(text) ||
      (/\bgarage\b/.test(text) && !hasDisqualifier)
    ) {
      entityId = "cover.ratgdo32_2b8ecc_door";
      label = "main garage bay door";
    }

    if (!entityId) return null;

    const cached = this.stateCache.get(entityId);
    const currentState = cached?.state;

    if (isOpen && (currentState === "open" || currentState === "opening")) {
      return { reply: `${label} is already ${currentState}.`, actions_taken: [], fast_path: true };
    }
    if (isClose && (currentState === "closed" || currentState === "closing")) {
      return { reply: `${label} is already ${currentState}.`, actions_taken: [], fast_path: true };
    }

    const service = isOpen ? "open_cover" : "close_cover";
    const verb = isOpen ? "opening" : "closing";
    try {
      await this.sendCommand({
        type: "call_service",
        domain: "cover",
        service,
        service_data: { entity_id: entityId },
        target: {}
      });
      this.logAI("action", `Called cover.${service} (fast path)`, { entity_id: entityId, source: "fast_path" });
      return { reply: `${label} is ${verb}.`, actions_taken: ["call_service"], fast_path: true };
    } catch (err) {
      this.logAI("error", `Fast path failed for ${entityId}: ${err.message}`, { entity_id: entityId, service, error: err.message });
      return null;
    }
  }
}

describe("_tryDeterministicFastPath — bail guards", () => {
  let stub;
  beforeEach(() => {
    stub = new FastPathStub();
    // Covers start closed so an erroneous open would actually fire.
    stub.stateCache.set(GARAGE, { state: "closed" });
    stub.stateCache.set(BASEMENT, { state: "closed" });
    stub.stateCache.set(LEFT_BASEMENT, { state: "closed" });
  });

  it("REGRESSION: forensic timeline question does NOT open the garage", async () => {
    const msg =
      "Show me a timeline for when the Tesla switched to home, when the " +
      "garage door opened and closed, and when my phone went from " +
      "disconnected to connected on Wi-Fi — trying to figure out if the " +
      "Tesla's location can open the garage door";
    const result = await stub._tryDeterministicFastPath(msg);
    expect(result).toBeNull();
    expect(stub.commands).toHaveLength(0);
  });

  it("bails on a trailing-question-mark state query", async () => {
    expect(await stub._tryDeterministicFastPath("is the garage door open?")).toBeNull();
    expect(stub.commands).toHaveLength(0);
  });

  it("bails on sentence-initial auxiliary", async () => {
    expect(await stub._tryDeterministicFastPath("did the garage door open today")).toBeNull();
    expect(stub.commands).toHaveLength(0);
  });

  it("bails on forensic markers without a '?'", async () => {
    for (const m of [
      "tell me when the garage door last opened",
      "show me the garage door history",
      "what time did the garage open",
      "list the garage door open events"
    ]) {
      const r = await stub._tryDeterministicFastPath(m);
      expect(r, `should bail: ${m}`).toBeNull();
    }
    expect(stub.commands).toHaveLength(0);
  });

  it("bails when both open and close are mentioned (any inflection)", async () => {
    expect(await stub._tryDeterministicFastPath("the garage opened then closed")).toBeNull();
    expect(stub.commands).toHaveLength(0);
  });

  it("bails on inflected-only (descriptive) mentions", async () => {
    // "opened" is past tense / descriptive, not an imperative.
    expect(await stub._tryDeterministicFastPath("the garage door opening")).toBeNull();
    expect(stub.commands).toHaveLength(0);
  });

  it("bails on long / comma-heavy multi-clause input", async () => {
    expect(
      await stub._tryDeterministicFastPath("open the garage, the basement, and the side door")
    ).toBeNull();
    expect(stub.commands).toHaveLength(0);
  });
});

describe("_tryDeterministicFastPath — genuine commands still fire", () => {
  let stub;
  beforeEach(() => {
    stub = new FastPathStub();
    stub.stateCache.set(GARAGE, { state: "closed" });
    stub.stateCache.set(BASEMENT, { state: "open" });
  });

  it("opens the main garage on a bare imperative", async () => {
    const r = await stub._tryDeterministicFastPath("open the garage door");
    expect(r?.fast_path).toBe(true);
    expect(stub.commands).toHaveLength(1);
    expect(stub.commands[0]).toMatchObject({
      service: "open_cover",
      service_data: { entity_id: GARAGE }
    });
  });

  it("fast-paths a polite imperative", async () => {
    const r = await stub._tryDeterministicFastPath("could you open the garage door please");
    expect(r?.fast_path).toBe(true);
    expect(stub.commands[0].service).toBe("open_cover");
  });

  it("closes the basement bay", async () => {
    const r = await stub._tryDeterministicFastPath("close the basement bay door");
    expect(r?.fast_path).toBe(true);
    expect(stub.commands[0]).toMatchObject({
      service: "close_cover",
      service_data: { entity_id: BASEMENT }
    });
  });

  it("no-ops when already in the target state (no command sent)", async () => {
    const r = await stub._tryDeterministicFastPath("open the basement bay door");
    expect(r?.actions_taken).toEqual([]);
    expect(stub.commands).toHaveLength(0);
  });
});
