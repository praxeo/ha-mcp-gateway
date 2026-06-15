/**
 * Unit tests for coalesceServiceData — the flat-argument healer for
 * call_service / schedule_action tool calls (V28).
 *
 * MiniMax M3 emits service parameters (entity_id, temperature, ...) at the
 * TOP LEVEL of the tool arguments instead of nesting them inside `data` /
 * `service_data`. The dispatchers and the scheduler only read the nested
 * object, so flat params were dropped and HA rejected the call. This is the
 * exact failure behind "Minimax couldn't precondition the Tesla".
 *
 * The function is pure. Keep this stub in sync with the module-level
 * coalesceServiceData in src/ha-websocket.js.
 */
import { describe, it, expect } from "vitest";

const SERVICE_CALL_RESERVED_KEYS = new Set([
  "domain", "service", "data", "service_data", "target",
  "return_response", "delay_seconds", "description"
]);

function coalesceServiceData(args, nestedKey) {
  const src = args && typeof args === "object" ? args : {};
  const nestedRaw = src[nestedKey];
  const data = (nestedRaw && typeof nestedRaw === "object" && !Array.isArray(nestedRaw))
    ? { ...nestedRaw } : {};
  for (const [k, v] of Object.entries(src)) {
    if (SERVICE_CALL_RESERVED_KEYS.has(k)) continue;
    if (!(k in data)) data[k] = v;
  }
  if (!data.entity_id && src.target && typeof src.target === "object" && src.target.entity_id) {
    data.entity_id = src.target.entity_id;
  }
  return data;
}

describe("coalesceServiceData", () => {
  it("preserves a correctly-nested data object", () => {
    const args = {
      domain: "climate",
      service: "set_temperature",
      data: { entity_id: "climate.tesla_model_y_climate", temperature: 70 }
    };
    expect(coalesceServiceData(args, "data")).toEqual({
      entity_id: "climate.tesla_model_y_climate",
      temperature: 70
    });
  });

  it("heals flat entity_id (climate.turn_on Tesla precondition case)", () => {
    const args = {
      domain: "climate",
      service: "turn_on",
      entity_id: "climate.tesla_model_y_climate"
    };
    expect(coalesceServiceData(args, "data")).toEqual({
      entity_id: "climate.tesla_model_y_climate"
    });
  });

  it("heals flat temperature alongside a nested entity_id (set_temperature case)", () => {
    const args = {
      domain: "climate",
      service: "set_temperature",
      data: { entity_id: "climate.main" },
      temperature: 73
    };
    expect(coalesceServiceData(args, "data")).toEqual({
      entity_id: "climate.main",
      temperature: 73
    });
  });

  it("lifts entity_id out of a target object so the scheduler (target:{}) sees it", () => {
    const args = {
      domain: "climate",
      service: "set_temperature",
      target: { entity_id: "climate.main" },
      temperature: 73
    };
    expect(coalesceServiceData(args, "service_data")).toEqual({
      entity_id: "climate.main",
      temperature: 73
    });
  });

  it("does not fold reserved keys into data", () => {
    const args = {
      domain: "light",
      service: "turn_on",
      return_response: false,
      delay_seconds: 3600,
      description: "later",
      entity_id: "light.kitchen",
      brightness_pct: 60
    };
    expect(coalesceServiceData(args, "service_data")).toEqual({
      entity_id: "light.kitchen",
      brightness_pct: 60
    });
  });

  it("lets explicit nested values win over flat duplicates", () => {
    const args = {
      domain: "climate",
      service: "set_temperature",
      data: { temperature: 70 },
      temperature: 99
    };
    expect(coalesceServiceData(args, "data")).toEqual({ temperature: 70 });
  });

  it("returns an empty object when nothing is provided", () => {
    expect(coalesceServiceData({ domain: "x", service: "y" }, "data")).toEqual({});
    expect(coalesceServiceData({}, "data")).toEqual({});
    expect(coalesceServiceData(null, "data")).toEqual({});
  });

  it("ignores a non-object nested value and still heals flat params", () => {
    const args = {
      domain: "switch",
      service: "turn_on",
      data: "switch.fan",
      entity_id: "switch.fan"
    };
    expect(coalesceServiceData(args, "data")).toEqual({ entity_id: "switch.fan" });
  });
});
