/**
 * Unit tests for _shouldLogStateChange behavioral contract.
 *
 * The function lives in HAWebSocketV3 but its logic is pure aside from
 * `this._numericDeadbandMap`. We test it here via a minimal stub that
 * avoids the full CF worker import chain.
 */
import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Inline stub — mirrors the real _shouldLogStateChange + _numericDeadbandMap.
// Keep in sync with src/ha-websocket.js _shouldLogStateChange.
// ---------------------------------------------------------------------------
class ShouldLogStub {
  constructor() {
    this._numericDeadbandMap = new Map();
  }

  _shouldLogStateChange(entityId, newState) {
    const attr = newState.attributes || {};
    const deviceClass = attr.device_class || "";
    const unit = String(attr.unit_of_measurement || "").toLowerCase();
    const lcId = String(entityId).toLowerCase().replace(/_\d+$/, "");

    const DENY_SUFFIX = [
      "_lqi", "_signal_strength", "_rssi", "_bssid", "_ssid",
      "_last_update_trigger", "_audio_output", "_link_quality"
    ];
    if (DENY_SUFFIX.some((s) => lcId.endsWith(s))) return false;

    if (deviceClass === "signal_strength") return false;
    if (unit === "dbm" || unit === "db" || unit === "lqi") return false;

    const HARD_DENY_SUFFIX = ["_summation_delivered", "_summation_received"];
    if (HARD_DENY_SUFFIX.some((s) => lcId.endsWith(s))) return false;

    const rawVal = parseFloat(newState.state);
    if (isFinite(rawVal)) {
      let threshold = null;
      if (deviceClass === "power" || unit === "w") {
        threshold = 50;
      } else if (deviceClass === "energy" || unit === "kwh") {
        threshold = 0.01;
      } else if (deviceClass === "humidity" || unit === "%") {
        threshold = 2;
      } else if (deviceClass === "temperature") {
        threshold = 0.5;
      } else if (deviceClass === "illuminance") {
        const last = this._numericDeadbandMap.get(entityId);
        if (last != null) {
          if (Math.abs(rawVal - last) / Math.max(Math.abs(last), 1) < 0.10) return false;
        }
        this._numericDeadbandMap.set(entityId, rawVal);
        return true;
      }
      if (threshold != null) {
        const last = this._numericDeadbandMap.get(entityId);
        if (last != null && Math.abs(rawVal - last) < threshold) return false;
        this._numericDeadbandMap.set(entityId, rawVal);
      }
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mkState(state, { device_class = "", unit_of_measurement = "" } = {}) {
  return { state, attributes: { device_class, unit_of_measurement } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("_shouldLogStateChange", () => {
  let stub;
  beforeEach(() => { stub = new ShouldLogStub(); });

  // --- Existing denylist ---
  it("drops _lqi suffix", () => {
    expect(stub._shouldLogStateChange("sensor.door_lqi", mkState("100"))).toBe(false);
  });

  it("drops _rssi suffix", () => {
    expect(stub._shouldLogStateChange("sensor.plug_rssi", mkState("-70"))).toBe(false);
  });

  it("drops signal_strength device_class", () => {
    expect(stub._shouldLogStateChange("sensor.foo", mkState("-70", { device_class: "signal_strength" }))).toBe(false);
  });

  it("drops dBm unit", () => {
    expect(stub._shouldLogStateChange("sensor.foo", mkState("-70", { unit_of_measurement: "dBm" }))).toBe(false);
  });

  // --- Hard denylist (summation counters) ---
  it("drops _summation_delivered suffix", () => {
    expect(stub._shouldLogStateChange(
      "sensor.frient_a_s_emizb_141_summation_delivered",
      mkState("123.45", { device_class: "energy", unit_of_measurement: "kWh" })
    )).toBe(false);
  });

  it("drops _summation_received suffix", () => {
    expect(stub._shouldLogStateChange("sensor.meter_summation_received", mkState("50"))).toBe(false);
  });

  // --- Deadband: power ---
  it("passes power first observation (no prior)", () => {
    expect(stub._shouldLogStateChange("sensor.power", mkState("100", { device_class: "power", unit_of_measurement: "W" }))).toBe(true);
  });

  it("drops power delta below 50W threshold", () => {
    stub._shouldLogStateChange("sensor.power", mkState("100", { device_class: "power", unit_of_measurement: "W" }));
    expect(stub._shouldLogStateChange("sensor.power", mkState("130", { device_class: "power", unit_of_measurement: "W" }))).toBe(false);
  });

  it("passes power delta above 50W threshold", () => {
    stub._shouldLogStateChange("sensor.power", mkState("100", { device_class: "power", unit_of_measurement: "W" }));
    expect(stub._shouldLogStateChange("sensor.power", mkState("160", { device_class: "power", unit_of_measurement: "W" }))).toBe(true);
  });

  // --- Deadband: humidity ---
  it("drops humidity delta below 2% threshold", () => {
    stub._shouldLogStateChange("sensor.humidity", mkState("50", { device_class: "humidity", unit_of_measurement: "%" }));
    expect(stub._shouldLogStateChange("sensor.humidity", mkState("51", { device_class: "humidity", unit_of_measurement: "%" }))).toBe(false);
  });

  it("passes humidity delta at or above 2% threshold", () => {
    stub._shouldLogStateChange("sensor.humidity", mkState("50", { device_class: "humidity", unit_of_measurement: "%" }));
    expect(stub._shouldLogStateChange("sensor.humidity", mkState("52", { device_class: "humidity", unit_of_measurement: "%" }))).toBe(true);
  });

  // --- Deadband: temperature ---
  it("drops temperature delta below 0.5° threshold", () => {
    stub._shouldLogStateChange("sensor.temp", mkState("70", { device_class: "temperature" }));
    expect(stub._shouldLogStateChange("sensor.temp", mkState("70.3", { device_class: "temperature" }))).toBe(false);
  });

  it("passes temperature delta at or above 0.5° threshold", () => {
    stub._shouldLogStateChange("sensor.temp", mkState("70", { device_class: "temperature" }));
    expect(stub._shouldLogStateChange("sensor.temp", mkState("70.6", { device_class: "temperature" }))).toBe(true);
  });

  // --- Deadband: illuminance (relative 10%) ---
  it("passes illuminance first observation", () => {
    expect(stub._shouldLogStateChange("sensor.lux", mkState("100", { device_class: "illuminance" }))).toBe(true);
  });

  it("drops illuminance delta below 10% relative", () => {
    stub._shouldLogStateChange("sensor.lux", mkState("100", { device_class: "illuminance" }));
    expect(stub._shouldLogStateChange("sensor.lux", mkState("105", { device_class: "illuminance" }))).toBe(false);
  });

  it("passes illuminance delta at or above 10% relative", () => {
    stub._shouldLogStateChange("sensor.lux", mkState("100", { device_class: "illuminance" }));
    expect(stub._shouldLogStateChange("sensor.lux", mkState("115", { device_class: "illuminance" }))).toBe(true);
  });

  // --- Non-numeric states always pass ---
  it("always passes 'on'/'off' states regardless of device_class", () => {
    expect(stub._shouldLogStateChange("binary_sensor.motion", mkState("on"))).toBe(true);
    expect(stub._shouldLogStateChange("binary_sensor.motion", mkState("off"))).toBe(true);
  });

  it("always passes 'home'/'not_home' states", () => {
    expect(stub._shouldLogStateChange("person.john", mkState("home"))).toBe(true);
    expect(stub._shouldLogStateChange("person.john", mkState("not_home"))).toBe(true);
  });

  it("always passes 'locked'/'unlocked' states", () => {
    expect(stub._shouldLogStateChange("lock.front_door", mkState("locked"))).toBe(true);
    expect(stub._shouldLogStateChange("lock.front_door", mkState("unlocked"))).toBe(true);
  });

  // --- Deadband map is per-entity ---
  it("tracks deadband independently per entity_id", () => {
    stub._shouldLogStateChange("sensor.powerA", mkState("100", { device_class: "power" }));
    stub._shouldLogStateChange("sensor.powerB", mkState("100", { device_class: "power" }));
    // A moves 20W (below threshold) — should drop
    expect(stub._shouldLogStateChange("sensor.powerA", mkState("120", { device_class: "power" }))).toBe(false);
    // B moves 60W (above threshold) — should pass
    expect(stub._shouldLogStateChange("sensor.powerB", mkState("160", { device_class: "power" }))).toBe(true);
  });
});
