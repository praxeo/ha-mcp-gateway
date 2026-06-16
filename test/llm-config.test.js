/**
 * Unit tests for the runtime LLM config helpers (V29):
 * resolveLLMConfig, applyReasoningToBody, sanitizeLLMConfigPatch, and the
 * env-layer extractor llmConfigFromEnv.
 *
 * The chat/agent model, endpoint, and reasoning mode are runtime-configurable
 * so a model swap (Qwen ↔ MiniMax) does NOT require the DO-rename migration
 * dance. Resolution precedence is: DO storage override → env vars → baked-in
 * defaults. Fireworks rejects sending `thinking` and `reasoning_effort`
 * together, so applyReasoningToBody must emit at most one.
 *
 * These functions are pure. Keep these stubs in sync with the module-level
 * helpers in src/ha-websocket.js.
 */
import { describe, it, expect } from "vitest";

// ---- stubs mirrored from src/ha-websocket.js ----

const LLM_REASONING_MODES = new Set(["thinking", "effort", "none"]);
const LLM_REASONING_EFFORTS = new Set(["low", "medium", "high", "none"]);

// Baked-in defaults — mirror HAWebSocketV29._defaultLLMConfig().
const DEFAULTS = {
  endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
  model: "accounts/fireworks/models/qwen3p7-plus",
  reasoning_mode: "thinking",
  reasoning_effort: "high"
};

function llmConfigFromEnv(env) {
  const e = env || {};
  const out = {};
  if (typeof e.LLM_ENDPOINT === "string" && e.LLM_ENDPOINT.trim()) out.endpoint = e.LLM_ENDPOINT.trim();
  if (typeof e.LLM_MODEL === "string" && e.LLM_MODEL.trim()) out.model = e.LLM_MODEL.trim();
  if (typeof e.LLM_REASONING_MODE === "string" && LLM_REASONING_MODES.has(e.LLM_REASONING_MODE.trim())) {
    out.reasoning_mode = e.LLM_REASONING_MODE.trim();
  }
  if (typeof e.LLM_REASONING_EFFORT === "string" && LLM_REASONING_EFFORTS.has(e.LLM_REASONING_EFFORT.trim())) {
    out.reasoning_effort = e.LLM_REASONING_EFFORT.trim();
  }
  return out;
}

function resolveLLMConfig(stored, env, defaults) {
  const base = defaults || {};
  const envLayer = llmConfigFromEnv(env);
  const override = (stored && typeof stored === "object") ? stored : {};
  const pick = (key) => {
    if (key in override && override[key] != null) return { value: override[key], source: "override" };
    if (key in envLayer) return { value: envLayer[key], source: "env" };
    return { value: base[key], source: "default" };
  };
  const endpoint = pick("endpoint");
  const model = pick("model");
  const mode = pick("reasoning_mode");
  const effort = pick("reasoning_effort");
  const safeMode = LLM_REASONING_MODES.has(mode.value) ? mode.value : base.reasoning_mode;
  const safeEffort = LLM_REASONING_EFFORTS.has(effort.value) ? effort.value : base.reasoning_effort;
  return {
    endpoint: endpoint.value,
    model: model.value,
    reasoning_mode: safeMode,
    reasoning_effort: safeEffort,
    source: {
      endpoint: endpoint.source,
      model: model.source,
      reasoning_mode: mode.source,
      reasoning_effort: effort.source
    }
  };
}

function applyReasoningToBody(body, cfg) {
  if (!body || typeof body !== "object") return body;
  delete body.thinking;
  delete body.reasoning_effort;
  const mode = cfg && cfg.reasoning_mode;
  if (mode === "thinking") {
    body.thinking = { type: "enabled" };
  } else if (mode === "effort") {
    body.reasoning_effort = (cfg && cfg.reasoning_effort) || "high";
  }
  return body;
}

function sanitizeLLMConfigPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { error: "body must be a JSON object" };
  }
  const allowed = new Set(["endpoint", "model", "reasoning_mode", "reasoning_effort"]);
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "reset") continue;
    if (!allowed.has(k)) return { error: `unknown config key: ${k}` };
    if (k === "endpoint") {
      if (typeof v !== "string" || !/^https?:\/\//.test(v)) return { error: "endpoint must be an http(s) URL" };
      out.endpoint = v.trim();
    } else if (k === "model") {
      if (typeof v !== "string" || !v.trim()) return { error: "model must be a non-empty string" };
      out.model = v.trim();
    } else if (k === "reasoning_mode") {
      if (!LLM_REASONING_MODES.has(v)) return { error: `reasoning_mode must be one of ${[...LLM_REASONING_MODES].join(", ")}` };
      out.reasoning_mode = v;
    } else if (k === "reasoning_effort") {
      if (!LLM_REASONING_EFFORTS.has(v)) return { error: `reasoning_effort must be one of ${[...LLM_REASONING_EFFORTS].join(", ")}` };
      out.reasoning_effort = v;
    }
  }
  if (Object.keys(out).length === 0) return { error: "no recognized config fields to set" };
  return { value: out };
}

// ---- tests ----

describe("resolveLLMConfig — layering", () => {
  it("returns baked-in defaults (Qwen 3.7 Plus) with no override or env", () => {
    const cfg = resolveLLMConfig(null, {}, DEFAULTS);
    expect(cfg.model).toBe("accounts/fireworks/models/qwen3p7-plus");
    expect(cfg.endpoint).toBe(DEFAULTS.endpoint);
    expect(cfg.reasoning_mode).toBe("thinking");
    expect(cfg.reasoning_effort).toBe("high");
    expect(cfg.source).toEqual({
      endpoint: "default", model: "default", reasoning_mode: "default", reasoning_effort: "default"
    });
  });

  it("env vars override defaults", () => {
    const env = {
      LLM_MODEL: "accounts/fireworks/models/minimax-m3",
      LLM_REASONING_MODE: "effort",
      LLM_REASONING_EFFORT: "medium"
    };
    const cfg = resolveLLMConfig(null, env, DEFAULTS);
    expect(cfg.model).toBe("accounts/fireworks/models/minimax-m3");
    expect(cfg.reasoning_mode).toBe("effort");
    expect(cfg.reasoning_effort).toBe("medium");
    expect(cfg.endpoint).toBe(DEFAULTS.endpoint); // untouched → default
    expect(cfg.source.model).toBe("env");
    expect(cfg.source.endpoint).toBe("default");
  });

  it("stored override beats both env and defaults", () => {
    const env = { LLM_MODEL: "accounts/fireworks/models/minimax-m3" };
    const stored = { model: "accounts/fireworks/models/deepseek-v4-pro", reasoning_mode: "none" };
    const cfg = resolveLLMConfig(stored, env, DEFAULTS);
    expect(cfg.model).toBe("accounts/fireworks/models/deepseek-v4-pro");
    expect(cfg.reasoning_mode).toBe("none");
    expect(cfg.source.model).toBe("override");
    expect(cfg.source.reasoning_mode).toBe("override");
  });

  it("partial override leaves untouched fields on lower layers", () => {
    const env = { LLM_ENDPOINT: "https://example.test/v1/chat/completions" };
    const stored = { model: "accounts/fireworks/models/qwen3p6-plus" };
    const cfg = resolveLLMConfig(stored, env, DEFAULTS);
    expect(cfg.model).toBe("accounts/fireworks/models/qwen3p6-plus"); // override
    expect(cfg.endpoint).toBe("https://example.test/v1/chat/completions"); // env
    expect(cfg.reasoning_mode).toBe("thinking"); // default
    expect(cfg.source).toEqual({
      endpoint: "env", model: "override", reasoning_mode: "default", reasoning_effort: "default"
    });
  });

  it("a bad enum that slipped into storage falls back to the default for that field", () => {
    const stored = { reasoning_mode: "bogus", reasoning_effort: "ludicrous" };
    const cfg = resolveLLMConfig(stored, {}, DEFAULTS);
    expect(cfg.reasoning_mode).toBe("thinking");
    expect(cfg.reasoning_effort).toBe("high");
  });

  it("ignores bad env enum values (treated as absent)", () => {
    const env = { LLM_REASONING_MODE: "turbo" };
    const cfg = resolveLLMConfig(null, env, DEFAULTS);
    expect(cfg.reasoning_mode).toBe("thinking");
    expect(cfg.source.reasoning_mode).toBe("default");
  });
});

describe("applyReasoningToBody — never sends thinking + reasoning_effort together", () => {
  it("'thinking' mode sets only thinking", () => {
    const body = applyReasoningToBody({ model: "m" }, { reasoning_mode: "thinking" });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("'effort' mode sets only reasoning_effort", () => {
    const body = applyReasoningToBody({ model: "m" }, { reasoning_mode: "effort", reasoning_effort: "high" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toBeUndefined();
  });

  it("'none' mode sets neither", () => {
    const body = applyReasoningToBody({ model: "m" }, { reasoning_mode: "none" });
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("clears any pre-existing reasoning fields before applying", () => {
    const body = { thinking: { type: "enabled" }, reasoning_effort: "low" };
    applyReasoningToBody(body, { reasoning_mode: "effort", reasoning_effort: "medium" });
    expect(body.reasoning_effort).toBe("medium");
    expect(body.thinking).toBeUndefined();
  });

  it("'effort' mode without an effort value defaults to high", () => {
    const body = applyReasoningToBody({}, { reasoning_mode: "effort" });
    expect(body.reasoning_effort).toBe("high");
  });
});

describe("sanitizeLLMConfigPatch — validation", () => {
  it("accepts a valid full patch", () => {
    const r = sanitizeLLMConfigPatch({
      endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
      model: "accounts/fireworks/models/minimax-m3",
      reasoning_mode: "effort",
      reasoning_effort: "high"
    });
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({
      endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
      model: "accounts/fireworks/models/minimax-m3",
      reasoning_mode: "effort",
      reasoning_effort: "high"
    });
  });

  it("accepts a single-field patch", () => {
    const r = sanitizeLLMConfigPatch({ model: "accounts/fireworks/models/qwen3p7-plus" });
    expect(r.value).toEqual({ model: "accounts/fireworks/models/qwen3p7-plus" });
  });

  it("ignores the reset key but still requires another recognized field", () => {
    expect(sanitizeLLMConfigPatch({ reset: true }).error).toMatch(/no recognized config fields/);
    const r = sanitizeLLMConfigPatch({ reset: true, model: "x/y" });
    expect(r.value).toEqual({ model: "x/y" });
  });

  it("rejects unknown keys", () => {
    expect(sanitizeLLMConfigPatch({ temperature: 0.5 }).error).toMatch(/unknown config key/);
  });

  it("rejects a non-URL endpoint", () => {
    expect(sanitizeLLMConfigPatch({ endpoint: "ftp://nope" }).error).toMatch(/http\(s\) URL/);
  });

  it("rejects an empty model", () => {
    expect(sanitizeLLMConfigPatch({ model: "   " }).error).toMatch(/non-empty string/);
  });

  it("rejects a bad reasoning_mode / reasoning_effort", () => {
    expect(sanitizeLLMConfigPatch({ reasoning_mode: "turbo" }).error).toMatch(/reasoning_mode must be one of/);
    expect(sanitizeLLMConfigPatch({ reasoning_effort: "extreme" }).error).toMatch(/reasoning_effort must be one of/);
  });

  it("rejects non-object bodies", () => {
    expect(sanitizeLLMConfigPatch(null).error).toMatch(/JSON object/);
    expect(sanitizeLLMConfigPatch([]).error).toMatch(/JSON object/);
    expect(sanitizeLLMConfigPatch("nope").error).toMatch(/JSON object/);
  });
});

describe("llmConfigFromEnv — only present, valid keys contribute", () => {
  it("trims values and skips blanks/invalid enums", () => {
    const out = llmConfigFromEnv({
      LLM_MODEL: "  accounts/fireworks/models/minimax-m3  ",
      LLM_ENDPOINT: "   ",
      LLM_REASONING_MODE: "none",
      LLM_REASONING_EFFORT: "nope"
    });
    expect(out).toEqual({
      model: "accounts/fireworks/models/minimax-m3",
      reasoning_mode: "none"
    });
  });

  it("returns an empty object for empty env", () => {
    expect(llmConfigFromEnv({})).toEqual({});
    expect(llmConfigFromEnv(null)).toEqual({});
  });
});
