/**
 * Unit tests for _sanitizeLightServiceData behavioral contract.
 *
 * The method lives on HAWebSocketV22 but its only DO dependencies are
 * `this.stateCache` (a Map of entity_id -> state object) and `this.logAI`
 * (fire-and-forget log writer). We test via an inline stub class to avoid
 * the full CF worker import chain.
 *
 * Keep in sync with src/ha-websocket.js _sanitizeLightServiceData.
 */
import { describe, it, expect, beforeEach } from "vitest";

class SanitizeStub {
  constructor() {
    this.stateCache = new Map();
    this.logged = [];
  }
  logAI(type, message, data) {
    this.logged.push({ type, message, data });
  }

  _sanitizeLightServiceData(domain, service, data) {
    if (domain !== "light") return data;
    if (service !== "turn_on" && service !== "toggle") return data;
    if (!data || typeof data !== "object") return data;

    const eid = data.entity_id;
    if (!eid || typeof eid !== "string") return data;

    const cached = this.stateCache.get(eid);
    const supported = cached?.attributes?.supported_color_modes;
    if (!Array.isArray(supported) || supported.length === 0) return data;

    const DESCRIPTOR_TO_MODES = {
      rgb_color:         ["rgb", "rgbw", "rgbww"],
      rgbw_color:        ["rgbw"],
      rgbww_color:       ["rgbww"],
      hs_color:          ["hs"],
      color_name:        ["hs"],
      xy_color:          ["xy"],
      color_temp:        ["color_temp"],
      color_temp_kelvin: ["color_temp"],
      kelvin:            ["color_temp"],
      white:             ["white"]
    };
    const PRIORITY = [
      "color_temp_kelvin", "color_temp", "kelvin",
      "rgb_color", "hs_color", "white", "color_name",
      "rgbw_color", "rgbww_color", "xy_color"
    ];

    let sanitized = null;
    const stripped = [];

    for (const [descriptor, requiredModes] of Object.entries(DESCRIPTOR_TO_MODES)) {
      if (!(descriptor in data)) continue;
      const ok = requiredModes.some((m) => supported.includes(m));
      if (!ok) {
        if (!sanitized) sanitized = { ...data };
        stripped.push(descriptor);
        delete sanitized[descriptor];
      }
    }

    const ref = sanitized || data;
    const remaining = Object.keys(DESCRIPTOR_TO_MODES).filter((k) => k in ref);
    if (remaining.length > 1) {
      if (!sanitized) sanitized = { ...data };
      const keep = PRIORITY.find((p) => remaining.includes(p)) || remaining[0];
      for (const r of remaining) {
        if (r !== keep) {
          stripped.push(r);
          delete sanitized[r];
        }
      }
    }

    if (stripped.length > 0) {
      this.logAI(
        "light_sanitize",
        `Stripped ${stripped.length} color descriptor(s) from ${eid}`,
        { entity_id: eid, stripped, supported_color_modes: supported }
      );
    }

    return sanitized || data;
  }
}

describe("_sanitizeLightServiceData", () => {
  let stub;
  beforeEach(() => {
    stub = new SanitizeStub();
  });

  it("brightness-only light: strips all color descriptors, keeps brightness_pct", () => {
    stub.stateCache.set("light.kitchen_drop_lights", {
      attributes: { supported_color_modes: ["brightness"] }
    });
    const out = stub._sanitizeLightServiceData("light", "turn_on", {
      entity_id: "light.kitchen_drop_lights",
      brightness_pct: 100,
      color_temp_kelvin: 4000,
      rgb_color: [255, 0, 0],
      white: 255
    });
    expect(out).toEqual({ entity_id: "light.kitchen_drop_lights", brightness_pct: 100 });
    expect(stub.logged).toHaveLength(1);
    expect(stub.logged[0].type).toBe("light_sanitize");
    expect(stub.logged[0].data.stripped).toEqual(
      expect.arrayContaining(["color_temp_kelvin", "rgb_color", "white"])
    );
  });

  it("color_temp+brightness light: keeps color_temp_kelvin, drops rgb_color", () => {
    stub.stateCache.set("light.living_room_lamp", {
      attributes: { supported_color_modes: ["brightness", "color_temp"] }
    });
    const out = stub._sanitizeLightServiceData("light", "turn_on", {
      entity_id: "light.living_room_lamp",
      brightness_pct: 50,
      color_temp_kelvin: 4000,
      rgb_color: [255, 0, 0]
    });
    expect(out).toEqual({
      entity_id: "light.living_room_lamp",
      brightness_pct: 50,
      color_temp_kelvin: 4000
    });
    expect(stub.logged).toHaveLength(1);
    expect(stub.logged[0].data.stripped).toEqual(["rgb_color"]);
  });

  it("full-color light: keeps color_temp by priority, drops rgb_color even though both are valid", () => {
    stub.stateCache.set("light.fancy_bulb", {
      attributes: { supported_color_modes: ["rgb", "color_temp", "hs"] }
    });
    const out = stub._sanitizeLightServiceData("light", "turn_on", {
      entity_id: "light.fancy_bulb",
      rgb_color: [255, 0, 0],
      color_temp: 300
    });
    expect(out).toEqual({ entity_id: "light.fancy_bulb", color_temp: 300 });
    expect(stub.logged).toHaveLength(1);
    expect(stub.logged[0].data.stripped).toEqual(["rgb_color"]);
  });

  it("unknown entity (not in cache): passes through unchanged", () => {
    const input = {
      entity_id: "light.unknown",
      brightness_pct: 100,
      rgb_color: [255, 0, 0],
      color_temp: 300
    };
    const out = stub._sanitizeLightServiceData("light", "turn_on", input);
    expect(out).toBe(input);
    expect(stub.logged).toHaveLength(0);
  });

  it("non-light domain: passes through unchanged", () => {
    stub.stateCache.set("switch.something", { attributes: {} });
    const input = { entity_id: "switch.something", foo: "bar" };
    const out = stub._sanitizeLightServiceData("switch", "turn_on", input);
    expect(out).toBe(input);
    expect(stub.logged).toHaveLength(0);
  });

  it("light.turn_off: passes through unchanged (off doesn't take color)", () => {
    stub.stateCache.set("light.kitchen_drop_lights", {
      attributes: { supported_color_modes: ["brightness"] }
    });
    const input = { entity_id: "light.kitchen_drop_lights", transition: 1 };
    const out = stub._sanitizeLightServiceData("light", "turn_off", input);
    expect(out).toBe(input);
    expect(stub.logged).toHaveLength(0);
  });

  it("light.toggle: same sanitization as turn_on", () => {
    stub.stateCache.set("light.kitchen_drop_lights", {
      attributes: { supported_color_modes: ["brightness"] }
    });
    const out = stub._sanitizeLightServiceData("light", "toggle", {
      entity_id: "light.kitchen_drop_lights",
      brightness_pct: 100,
      rgb_color: [255, 0, 0]
    });
    expect(out).toEqual({ entity_id: "light.kitchen_drop_lights", brightness_pct: 100 });
    expect(stub.logged).toHaveLength(1);
  });

  it("multi-entity (entity_id is array): passes through unchanged", () => {
    stub.stateCache.set("light.a", { attributes: { supported_color_modes: ["brightness"] } });
    stub.stateCache.set("light.b", { attributes: { supported_color_modes: ["rgb"] } });
    const input = {
      entity_id: ["light.a", "light.b"],
      brightness_pct: 100,
      rgb_color: [255, 0, 0]
    };
    const out = stub._sanitizeLightServiceData("light", "turn_on", input);
    expect(out).toBe(input);
    expect(stub.logged).toHaveLength(0);
  });

  it("rgb_color is accepted on a rgbww light (rgb_color matches any of rgb/rgbw/rgbww)", () => {
    stub.stateCache.set("light.rgbww_bulb", {
      attributes: { supported_color_modes: ["rgbww"] }
    });
    const out = stub._sanitizeLightServiceData("light", "turn_on", {
      entity_id: "light.rgbww_bulb",
      rgb_color: [255, 128, 0]
    });
    expect(out).toEqual({ entity_id: "light.rgbww_bulb", rgb_color: [255, 128, 0] });
    expect(stub.logged).toHaveLength(0);
  });

  it("kelvin/color_temp_kelvin both present: keeps color_temp_kelvin by priority", () => {
    stub.stateCache.set("light.ct_bulb", {
      attributes: { supported_color_modes: ["color_temp"] }
    });
    const out = stub._sanitizeLightServiceData("light", "turn_on", {
      entity_id: "light.ct_bulb",
      kelvin: 3500,
      color_temp_kelvin: 4000
    });
    expect(out).toEqual({ entity_id: "light.ct_bulb", color_temp_kelvin: 4000 });
    expect(stub.logged[0].data.stripped).toEqual(["kelvin"]);
  });

  it("empty supported_color_modes: pass through (fail-open)", () => {
    stub.stateCache.set("light.weird", { attributes: { supported_color_modes: [] } });
    const input = { entity_id: "light.weird", rgb_color: [1, 2, 3] };
    const out = stub._sanitizeLightServiceData("light", "turn_on", input);
    expect(out).toBe(input);
    expect(stub.logged).toHaveLength(0);
  });
});
