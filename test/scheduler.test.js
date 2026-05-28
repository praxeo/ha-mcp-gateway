/**
 * Unit tests for the ephemeral one-shot scheduler.
 *
 * The four methods (_scheduleAction, _listScheduledActions,
 * _cancelScheduledAction, _fireDueScheduledActions) live on HAWebSocketV23 in
 * src/ha-websocket.js. We test them here via a minimal stub that avoids the
 * full CF worker import chain (same pattern as should-log-state-change.test.js).
 *
 * KEEP IN SYNC with the methods in src/ha-websocket.js. The stub mirrors them
 * line-for-line minus the logAI / sanitize-light hooks (no-op'd here).
 */
import { describe, it, expect, beforeEach } from "vitest";

class MemoryStorage {
  constructor() { this.m = new Map(); }
  async get(key) { const v = this.m.get(key); return v ? JSON.parse(JSON.stringify(v)) : undefined; }
  async put(key, value) { this.m.set(key, JSON.parse(JSON.stringify(value))); }
  async delete(key) { return this.m.delete(key); }
  async list({ prefix } = {}) {
    const out = new Map();
    for (const [k, v] of this.m.entries()) {
      if (!prefix || k.startsWith(prefix)) out.set(k, JSON.parse(JSON.stringify(v)));
    }
    return out;
  }
}

class SchedulerStub {
  constructor({ connected = true, authenticated = true, sendCommandImpl = null } = {}) {
    this.state = { storage: new MemoryStorage() };
    this.connected = connected;
    this.authenticated = authenticated;
    this.commandCalls = [];
    this.sendCommand = sendCommandImpl || (async (cmd) => {
      this.commandCalls.push(cmd);
      return { result: {} };
    });
  }
  logAI() {}
  _sanitizeLightServiceData(_d, _s, data) { return data; }

  async _scheduleAction({ delaySeconds, domain, service, serviceData, description, source = "chat" }) {
    const d = Number(delaySeconds);
    if (!Number.isFinite(d) || d <= 0) return { error: "delay_seconds must be a positive number" };
    if (d > 60 * 60 * 24 * 30) return { error: "delay_seconds cannot exceed 30 days (2592000s)" };
    if (typeof domain !== "string" || !domain) return { error: "domain is required" };
    if (typeof service !== "string" || !service) return { error: "service is required" };
    const id = crypto.randomUUID();
    const now = Date.now();
    const fireAtMs = now + Math.floor(d * 1000);
    const record = {
      id, scheduled_at_ms: now, fire_at_ms: fireAtMs,
      service_call: { domain, service, service_data: serviceData && typeof serviceData === "object" ? serviceData : {} },
      description: typeof description === "string" ? description.slice(0, 200) : "",
      source: source || "chat"
    };
    await this.state.storage.put(`scheduled:${id}`, record);
    return { ok: true, id, fire_at_ms: fireAtMs, fires_in_seconds: Math.round((fireAtMs - now) / 1000), description: record.description };
  }

  async _listScheduledActions() {
    const map = await this.state.storage.list({ prefix: "scheduled:" });
    const now = Date.now();
    const tasks = [];
    for (const [, v] of map) {
      if (!v || typeof v !== "object" || typeof v.fire_at_ms !== "number") continue;
      tasks.push({
        id: v.id, description: v.description || "", service_call: v.service_call || {},
        fire_at_ms: v.fire_at_ms, fires_in_seconds: Math.max(0, Math.round((v.fire_at_ms - now) / 1000)),
        source: v.source || "chat"
      });
    }
    tasks.sort((a, b) => a.fire_at_ms - b.fire_at_ms);
    return { count: tasks.length, tasks };
  }

  async _cancelScheduledAction({ id }) {
    if (!id || typeof id !== "string") return { error: "task_id is required" };
    const key = `scheduled:${id}`;
    const existing = await this.state.storage.get(key);
    if (!existing) return { ok: false, cancelled: false, reason: "not_found", id };
    await this.state.storage.delete(key);
    return { ok: true, cancelled: true, id, description: existing.description || "" };
  }

  async _fireDueScheduledActions() {
    if (!this.connected || !this.authenticated) return;
    const map = await this.state.storage.list({ prefix: "scheduled:" });
    if (!map || map.size === 0) return;
    const now = Date.now();
    const due = [];
    for (const [key, v] of map) {
      if (!v || typeof v !== "object" || typeof v.fire_at_ms !== "number") {
        await this.state.storage.delete(key);
        continue;
      }
      if (v.fire_at_ms <= now) due.push([key, v]);
    }
    for (const [key, task] of due) {
      try { await this.state.storage.delete(key); } catch { continue; }
      const sc = task.service_call || {};
      const { domain, service } = sc;
      const data = sc.service_data || {};
      if (!domain || !service) continue;
      try {
        const cleanData = this._sanitizeLightServiceData(domain, service, data);
        await this.sendCommand({ type: "call_service", domain, service, service_data: cleanData, target: {} });
      } catch {
        // swallow — task already deleted (delete-before-fire)
      }
    }
  }
}

describe("scheduler", () => {
  let s;
  beforeEach(() => { s = new SchedulerStub(); });

  describe("_scheduleAction validation", () => {
    it("rejects zero delay", async () => {
      expect((await s._scheduleAction({ delaySeconds: 0, domain: "light", service: "turn_off" })).error).toBeDefined();
    });
    it("rejects negative delay", async () => {
      expect((await s._scheduleAction({ delaySeconds: -5, domain: "light", service: "turn_off" })).error).toBeDefined();
    });
    it("rejects delay over 30 days", async () => {
      const r = await s._scheduleAction({ delaySeconds: 60 * 60 * 24 * 31, domain: "light", service: "turn_off" });
      expect(r.error).toMatch(/30 days/);
    });
    it("rejects missing domain", async () => {
      const r = await s._scheduleAction({ delaySeconds: 10, service: "turn_off" });
      expect(r.error).toMatch(/domain/);
    });
    it("rejects missing service", async () => {
      const r = await s._scheduleAction({ delaySeconds: 10, domain: "light" });
      expect(r.error).toMatch(/service/);
    });
    it("accepts valid input and returns id + fire_at_ms", async () => {
      const r = await s._scheduleAction({
        delaySeconds: 60, domain: "light", service: "turn_off",
        serviceData: { entity_id: "light.x" }, description: "test"
      });
      expect(r.ok).toBe(true);
      expect(typeof r.id).toBe("string");
      expect(r.fire_at_ms).toBeGreaterThan(Date.now());
      expect(r.fires_in_seconds).toBeGreaterThan(50);
      expect(r.fires_in_seconds).toBeLessThanOrEqual(60);
    });
  });

  describe("_listScheduledActions", () => {
    it("returns empty when no tasks", async () => {
      const r = await s._listScheduledActions();
      expect(r.count).toBe(0);
      expect(r.tasks).toEqual([]);
    });
    it("returns tasks sorted by fire_at_ms ascending", async () => {
      await s._scheduleAction({ delaySeconds: 600, domain: "light", service: "turn_off", serviceData: { entity_id: "light.a" }, description: "later" });
      await s._scheduleAction({ delaySeconds: 60, domain: "light", service: "turn_off", serviceData: { entity_id: "light.b" }, description: "sooner" });
      const r = await s._listScheduledActions();
      expect(r.count).toBe(2);
      expect(r.tasks[0].description).toBe("sooner");
      expect(r.tasks[1].description).toBe("later");
    });
  });

  describe("_cancelScheduledAction", () => {
    it("cancels an existing task", async () => {
      const sched = await s._scheduleAction({
        delaySeconds: 60, domain: "light", service: "turn_off",
        serviceData: { entity_id: "light.x" }, description: "cancel me"
      });
      const r = await s._cancelScheduledAction({ id: sched.id });
      expect(r.ok).toBe(true);
      expect(r.cancelled).toBe(true);
      expect((await s._listScheduledActions()).count).toBe(0);
    });
    it("returns not_found for unknown id", async () => {
      const r = await s._cancelScheduledAction({ id: "no-such-id" });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("not_found");
    });
    it("rejects missing task_id", async () => {
      expect((await s._cancelScheduledAction({})).error).toMatch(/task_id/);
    });
  });

  describe("_fireDueScheduledActions", () => {
    it("fires due tasks and removes them from storage", async () => {
      const id = "test-past";
      await s.state.storage.put(`scheduled:${id}`, {
        id, scheduled_at_ms: Date.now() - 5000, fire_at_ms: Date.now() - 1000,
        service_call: { domain: "light", service: "turn_off", service_data: { entity_id: "light.x" } },
        description: "past", source: "chat"
      });
      await s._fireDueScheduledActions();
      expect(s.commandCalls.length).toBe(1);
      expect(s.commandCalls[0].domain).toBe("light");
      expect(s.commandCalls[0].service).toBe("turn_off");
      expect(s.commandCalls[0].service_data.entity_id).toBe("light.x");
      expect((await s._listScheduledActions()).count).toBe(0);
    });

    it("leaves future tasks alone", async () => {
      await s._scheduleAction({
        delaySeconds: 3600, domain: "light", service: "turn_off",
        serviceData: { entity_id: "light.x" }, description: "future"
      });
      await s._fireDueScheduledActions();
      expect(s.commandCalls.length).toBe(0);
      expect((await s._listScheduledActions()).count).toBe(1);
    });

    it("deletes task BEFORE firing even when sendCommand throws", async () => {
      const failingS = new SchedulerStub({
        sendCommandImpl: async () => { throw new Error("HA WS rejected"); }
      });
      const id = "test-fail";
      await failingS.state.storage.put(`scheduled:${id}`, {
        id, scheduled_at_ms: Date.now() - 5000, fire_at_ms: Date.now() - 1000,
        service_call: { domain: "light", service: "turn_off", service_data: { entity_id: "light.x" } },
        description: "fail", source: "chat"
      });
      await failingS._fireDueScheduledActions();
      // Task is gone — delete-before-fire prevents infinite retry on a poisoned task.
      expect((await failingS._listScheduledActions()).count).toBe(0);
    });

    it("skips firing when WS is disconnected (preserves task)", async () => {
      const offlineS = new SchedulerStub({ connected: false });
      const id = "test-offline";
      await offlineS.state.storage.put(`scheduled:${id}`, {
        id, scheduled_at_ms: Date.now() - 5000, fire_at_ms: Date.now() - 1000,
        service_call: { domain: "light", service: "turn_off", service_data: { entity_id: "light.x" } },
        description: "offline", source: "chat"
      });
      await offlineS._fireDueScheduledActions();
      expect(offlineS.commandCalls.length).toBe(0);
      expect((await offlineS._listScheduledActions()).count).toBe(1);
    });

    it("skips firing when WS is unauthenticated (preserves task)", async () => {
      const offlineS = new SchedulerStub({ authenticated: false });
      const id = "test-unauth";
      await offlineS.state.storage.put(`scheduled:${id}`, {
        id, scheduled_at_ms: Date.now() - 5000, fire_at_ms: Date.now() - 1000,
        service_call: { domain: "light", service: "turn_off", service_data: { entity_id: "light.x" } },
        description: "unauth", source: "chat"
      });
      await offlineS._fireDueScheduledActions();
      expect((await offlineS._listScheduledActions()).count).toBe(1);
    });

    it("fires multiple due tasks in one tick", async () => {
      const now = Date.now();
      await s.state.storage.put(`scheduled:a`, {
        id: "a", scheduled_at_ms: now - 5000, fire_at_ms: now - 2000,
        service_call: { domain: "light", service: "turn_off", service_data: { entity_id: "light.a" } },
        description: "a", source: "chat"
      });
      await s.state.storage.put(`scheduled:b`, {
        id: "b", scheduled_at_ms: now - 5000, fire_at_ms: now - 1000,
        service_call: { domain: "light", service: "turn_off", service_data: { entity_id: "light.b" } },
        description: "b", source: "chat"
      });
      await s._fireDueScheduledActions();
      expect(s.commandCalls.length).toBe(2);
      expect((await s._listScheduledActions()).count).toBe(0);
    });

    it("skips and deletes malformed records (missing fire_at_ms)", async () => {
      await s.state.storage.put(`scheduled:bad`, { id: "bad", description: "no fire time" });
      await s._fireDueScheduledActions();
      expect(s.commandCalls.length).toBe(0);
      expect((await s._listScheduledActions()).count).toBe(0);
    });

    it("does not fire tasks missing domain/service", async () => {
      const id = "test-incomplete";
      await s.state.storage.put(`scheduled:${id}`, {
        id, scheduled_at_ms: Date.now() - 5000, fire_at_ms: Date.now() - 1000,
        service_call: {}, description: "no service", source: "chat"
      });
      await s._fireDueScheduledActions();
      expect(s.commandCalls.length).toBe(0);
      expect((await s._listScheduledActions()).count).toBe(0);
    });
  });
});
