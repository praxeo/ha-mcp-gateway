// src/vectorize-schema.js
//
// Shared schema, helpers, and per-kind embed text builders for the unified
// `ha-knowledge` Vectorize index. Imported by both worker.js (multi-kind
// backfill) and ha-websocket.js (incremental re-embed + retrieval).
//
// Canonical metadata shape (every vector):
//   kind             "entity" | "automation" | "script" | "scene" |
//                    "area" | "device" | "service" | "memory" | "observation"
//   ref_id           string — entity_id, automation HA-internal id, script/scene
//                    entity_id, area_id, device_id, "<domain>.<service>", or
//                    fnv1aHex(text) for memory/observation
//   friendly_name    human-readable label (or first 80 chars of text for
//                    memory/observation)
//   domain           entity domain for entity kind, the kind name otherwise
//   area             resolved area name, "" if none
//   entity_category  "primary" | "diagnostic" | "config" (entity-only;
//                    "primary" for everything else)
//   is_noisy         "true" | "false" (stored as string because the metadata
//                    index is created with --type=string for portability)
//   topic_tag        bracketed prefix for observations, "" otherwise
//   hash             fnv1a of embed text — change detection for skipping
//                    unchanged docs in backfill
//
// Filterable metadata indexes declared at index creation:
//   kind, domain, area, entity_category, is_noisy, topic_tag
//
// Other fields (e.g., device_class on entities) are stored in metadata for
// return-side enrichment but are not filterable.

export const KIND_REFRESH_TRIGGERS = {
  entity: "event-driven (entity_registry_updated) + nightly cron resweep",
  device: "event-driven (device_registry_updated) + nightly cron resweep",
  memory: "write-through (executeAIAction.save_memory)",
  observation: "write-through (executeAIAction.save_observation)",
  automation: "nightly cron",
  script: "nightly cron",
  scene: "nightly cron",
  area: "nightly cron",
  service: "nightly cron"
};

export const ALL_KINDS = [
  "entity", "automation", "script", "scene", "area",
  "device", "service", "memory", "observation"
];

// 32-bit FNV-1a — fast, deterministic, 8-hex-digit output. Used for
// vector ID truncation and embed-text change detection.
export function fnv1aHex(str) {
  let h = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Compute kind-prefixed Vectorize ID, safe within Vectorize's 64-byte cap.
// If the prefixed full form exceeds 64 bytes, truncate the ref portion and
// append a fnv1a hash of the original ref so the ID stays unique and stable.
export function vectorIdFor(kind, refId) {
  const prefix = kind + ":";
  const safeRef = String(refId || "");
  const full = prefix + safeRef;
  if (full.length <= 64) return full;
  // Reserve 9 bytes ("_" + 8 hex digits) for the disambiguating hash.
  const hashLen = 9;
  const budget = 64 - prefix.length - hashLen;
  if (budget < 1) {
    // Pathological: prefix alone leaves no room. Hash-only, hard cap to 64.
    return (prefix + fnv1aHex(safeRef)).slice(0, 64);
  }
  return prefix + safeRef.slice(0, budget) + "_" + fnv1aHex(safeRef);
}

// ---------------------------------------------------------------------------
// Noisy-switch patterns (entity-only). Keep in lockstep with HAWebSocket's
// runtime context filter — these patterns came from there originally.
// ---------------------------------------------------------------------------
export const NOISY_SWITCH_PATTERNS = [
  /_trigger_alarm_on_/,
  /_smart_track_/,
  /_smart_dual_track_/,
  /_privacy$/,
  /_privacy_zones$/,
  /_record_audio$/,
  /_record_to_sd_card$/,
  /_microphone_mute$/,
  /_microphone_noise_cancellation$/,
  /_lens_distortion/,
  /_flip(_fixed_lens)?$/,
  /_auto_track$/,
  /_notifications$/,
  /_rich_notifications$/,
  /_automatically_upgrade_firmware$/,
  /_media_sync$/,
  /_diagnose_mode$/,
  /_indicator_led$/,
  /_child_lock$/,
  /_led_trigger_indicator$/,
  /_scene_control_multi_tap/,
  /_disable_double_click$/
];

export function isNoisySwitch(entityId) {
  return NOISY_SWITCH_PATTERNS.some((p) => p.test(entityId));
}

// ---------------------------------------------------------------------------
// Entity classification — entity_category + is_noisy
// ---------------------------------------------------------------------------
// Exported so the DO snapshot serializer can apply the same trim policy as
// the index-time noise filter. Keep these and isNoisyEntity() in lockstep.
export const NOISY_DOMAINS = new Set(["update", "tts", "stt", "wake_word"]);
export const NOISY_SENSOR_DEVICE_CLASSES = new Set([
  "signal_strength", "data_rate", "data_size", "voltage", "current",
  "frequency", "power_factor", "irradiance"
]);
export const NOISY_SENSOR_UNITS = new Set(["dBm", "lqi", "LQI", "dB"]);
const NOISY_DIAG_REGEX_LIST = [
  /_(successful|failed)_commands_(tx|rx)\b/,
  /_(rx|tx)_(channel|throughput|rssi)\b/
];

// Returns "primary" | "diagnostic" | "config".
export function entityCategoryFor(entity, _state) {
  const c = entity && entity.entity_category;
  if (c === "diagnostic") return "diagnostic";
  if (c === "config") return "config";
  return "primary";
}

// Full noisy-entity ruleset. State is the HA states-API row (or null).
export function isNoisyEntity(entity, state) {
  if (!entity) return false;
  const entityId = entity.entity_id || "";
  if (!entityId) return false;
  const domain = entityId.split(".")[0] || "";

  if (entity.disabled_by) return true;
  if (entity.hidden_by) return true;

  const cat = entity.entity_category;
  if (cat === "config") return true;
  if (cat === "diagnostic") {
    const dc = (state && state.attributes && state.attributes.device_class) || "";
    if (dc !== "battery") return true;
  }

  if (NOISY_DOMAINS.has(domain)) return true;

  for (const re of NOISY_DIAG_REGEX_LIST) {
    if (re.test(entityId)) return true;
  }

  if (domain === "sensor") {
    const attrs = (state && state.attributes) || {};
    const dc = attrs.device_class || "";
    const unit = attrs.unit_of_measurement || "";
    if (NOISY_SENSOR_DEVICE_CLASSES.has(dc)) return true;
    if (NOISY_SENSOR_UNITS.has(unit)) return true;
  }

  if (domain === "switch" && isNoisySwitch(entityId)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Service noise heuristic — destructive/diagnostic services the agent should
// not be calling unprompted. Conservative on purpose; existing safeguards in
// the agent layer continue to gate destructive call_service invocations.
// ---------------------------------------------------------------------------
const NOISY_SERVICE_DOMAINS = new Set([
  "recorder", "system_log", "logger", "persistent_notification"
]);
const NOISY_SERVICE_FULL_NAMES = new Set([
  "homeassistant.restart",
  "homeassistant.stop"
]);

export function isNoisyService(domain, service) {
  if (NOISY_SERVICE_FULL_NAMES.has(domain + "." + service)) return true;
  if (NOISY_SERVICE_DOMAINS.has(domain)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Bracketed [topic-tag] extraction for observations.
// ---------------------------------------------------------------------------
export function extractTopicTag(text) {
  if (typeof text !== "string") return "";
  const m = text.match(/^\s*(\[[^\]]+\])/);
  return m ? m[1] : "";
}

/**
 * Canonical topic-tag derivation for observations.
 * - If text starts with [bracket-prefix], returns the lowercased prefix
 *   content (no brackets). Allowed chars: a-z, 0-9, underscore, hyphen.
 * - Otherwise returns fnv1aHex(text) as a stable fallback key.
 * Used as BOTH the D1 primary key AND the Vectorize ref_id for observations.
 */
export function topicTagFor(text) {
  const s = typeof text === "string" ? text : "";
  const m = s.match(/^\[([a-z0-9_-]+)\]/i);
  return m ? m[1].toLowerCase() : fnv1aHex(s);
}

// ---------------------------------------------------------------------------
// Embed-text builders — one per kind. Each returns a single string of at
// most 2000 characters, suitable for @cf/baai/bge-large-en-v1.5 with cls
// pooling (the index was built that way; mismatched pooling at query time
// yields near-random rankings).
// ---------------------------------------------------------------------------
const trunc = (v, n) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
};
const cap2k = (s) => (s.length > 2000 ? s.slice(0, 2000) : s);

export function buildEntityEmbedText(d) {
  const aliases = Array.isArray(d.aliases) ? d.aliases.join(", ") : "";
  const parts = [
    trunc(d.friendly_name, 200),
    trunc(d.entity_id, 100)
  ];
  if (d.area) parts.push("in " + trunc(d.area, 100));
  if (d.device_name) parts.push("device: " + trunc(d.device_name, 200));
  if (d.manufacturer) parts.push("by " + trunc(d.manufacturer, 100));
  if (d.model) parts.push("model " + trunc(d.model, 100));
  if (d.domain) parts.push("domain: " + trunc(d.domain, 50));
  if (d.device_class) parts.push("class: " + trunc(d.device_class, 50));
  if (aliases) parts.push("aliases: " + trunc(aliases, 300));
  return cap2k(parts.join(" | "));
}

export function buildAutomationEmbedText(d) {
  const aliases = Array.isArray(d.aliases) ? d.aliases.join(", ") : "";
  const parts = [
    "[automation] " + trunc(d.friendly_name || d.alias || d.id || "automation", 200)
  ];
  if (d.description) parts.push("description: " + trunc(d.description, 400));
  if (d.triggerSummary) parts.push("triggers: " + trunc(d.triggerSummary, 400));
  if (d.actionSummary) parts.push("actions: " + trunc(d.actionSummary, 400));
  parts.push("mode: " + trunc(d.mode || "single", 50));
  if (aliases) parts.push("aliases: " + trunc(aliases, 200));
  return cap2k(parts.join(" | "));
}

export function buildScriptEmbedText(d) {
  const parts = ["[script] " + trunc(d.friendly_name || d.entity_id, 200)];
  if (d.description) parts.push("description: " + trunc(d.description, 400));
  if (d.actionSummary) parts.push("actions: " + trunc(d.actionSummary, 800));
  return cap2k(parts.join(" | "));
}

export function buildSceneEmbedText(d) {
  const parts = ["[scene] " + trunc(d.friendly_name || d.entity_id, 200)];
  if (Array.isArray(d.entities) && d.entities.length > 0) {
    parts.push("entities: " + trunc(d.entities.join(", "), 800));
  }
  return cap2k(parts.join(" | "));
}

export function buildAreaEmbedText(d) {
  const parts = ["[area] " + trunc(d.name, 200)];
  if (d.floor_name) parts.push("floor: " + trunc(d.floor_name, 100));
  const aliases = Array.isArray(d.aliases) ? d.aliases.join(", ") : "";
  if (aliases) parts.push("aliases: " + trunc(aliases, 300));
  return cap2k(parts.join(" | "));
}

export function buildDeviceEmbedText(d) {
  const parts = ["[device] " + trunc(d.name, 200)];
  if (d.manufacturer) parts.push("manufacturer: " + trunc(d.manufacturer, 100));
  if (d.model) parts.push("model: " + trunc(d.model, 100));
  if (d.area) parts.push("area: " + trunc(d.area, 100));
  if (typeof d.entity_count === "number") {
    let entLine = "entities: " + d.entity_count;
    if (Array.isArray(d.sample_entities) && d.sample_entities.length > 0) {
      entLine += " (" + trunc(d.sample_entities.slice(0, 5).join(", "), 400) + ")";
    }
    parts.push(entLine);
  }
  return cap2k(parts.join(" | "));
}

export function buildServiceEmbedText(d) {
  const head = "[service] " + d.domain + "." + d.service;
  const label = d.name || (d.domain + "." + d.service);
  const desc = d.description || "";
  const fields = Array.isArray(d.fieldDescriptions) ? d.fieldDescriptions : [];
  const fieldLine = fields.length > 0 ? "fields: " + fields.join("; ") : "";
  const parts = [head, label];
  if (desc) parts.push(desc);
  if (fieldLine) parts.push(fieldLine);
  return cap2k(parts.filter(Boolean).join(" | "));
}

export function buildMemoryEmbedText(text) {
  return cap2k("[memory] " + (text || ""));
}

export function buildObservationEmbedText(text) {
  return cap2k("[observation] " + (text || ""));
}

// Dispatch by kind. For memory/observation, accepts either a raw string or
// `{ text }`. For other kinds, expects the per-kind source object.
export function buildEmbedText(kind, source) {
  switch (kind) {
    case "entity": return buildEntityEmbedText(source);
    case "automation": return buildAutomationEmbedText(source);
    case "script": return buildScriptEmbedText(source);
    case "scene": return buildSceneEmbedText(source);
    case "area": return buildAreaEmbedText(source);
    case "device": return buildDeviceEmbedText(source);
    case "service": return buildServiceEmbedText(source);
    case "memory": return buildMemoryEmbedText(typeof source === "string" ? source : (source && source.text) || "");
    case "observation": return buildObservationEmbedText(typeof source === "string" ? source : (source && source.text) || "");
    default:
      throw new Error("Unknown kind: " + kind);
  }
}

// ---------------------------------------------------------------------------
// Service field flatten — handles both shapes HA returns: fields may be a
// map of { fname: { name, description, ... } } or a flat array.
// ---------------------------------------------------------------------------
export function flattenServiceFields(serviceObj) {
  const out = [];
  const fields = serviceObj && serviceObj.fields;
  if (!fields || typeof fields !== "object") return out;
  for (const [fname, finfo] of Object.entries(fields)) {
    if (!fname) continue;
    const fdesc = finfo && typeof finfo === "object" ? (finfo.description || "") : "";
    if (fdesc) out.push(fname + " (" + String(fdesc).slice(0, 200) + ")");
    else out.push(fname);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trigger / action summaries for automations and scripts. Best-effort flatten
// of HA's automation YAML/JSON. Extracts the platform/service kind plus any
// referenced entity_ids; never throws on unexpected shapes.
// ---------------------------------------------------------------------------
export function summarizeTriggers(triggers) {
  if (!Array.isArray(triggers)) return "";
  const parts = [];
  for (const t of triggers) {
    if (!t || typeof t !== "object") continue;
    let s = t.platform || t.trigger || "trigger";
    const eid = t.entity_id;
    if (eid) {
      s += "(" + (Array.isArray(eid) ? eid.slice(0, 4).join(",") : eid) + ")";
    }
    parts.push(s);
  }
  return parts.join(", ");
}

export function summarizeActions(actions) {
  if (!Array.isArray(actions)) return "";
  const parts = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    let s = a.service || a.action || (a.choose ? "choose" : (a.repeat ? "repeat" : (a.wait_template ? "wait_template" : (a.delay ? "delay" : "action"))));
    const eid = (a.target && a.target.entity_id) || (a.data && a.data.entity_id) || a.entity_id;
    if (eid) {
      s += "(" + (Array.isArray(eid) ? eid.slice(0, 4).join(",") : eid) + ")";
    }
    parts.push(s);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Build the canonical metadata object for a doc, given precomputed pieces.
// Stores is_noisy as the string "true"/"false" because the metadata index is
// declared --type=string. The boolean is computed in JS, converted here.
// ---------------------------------------------------------------------------
export function buildMetadata({
  kind,
  ref_id,
  friendly_name,
  domain,
  area = "",
  entity_category = "primary",
  is_noisy = false,
  topic_tag = "",
  hash,
  created_at = null,
  extra = null
}) {
  const md = {
    kind,
    ref_id: String(ref_id || ""),
    friendly_name: String(friendly_name || ""),
    domain: String(domain || kind),
    area: String(area || "").toLowerCase(),
    entity_category: String(entity_category || "primary"),
    is_noisy: is_noisy ? "true" : "false",
    topic_tag: String(topic_tag || ""),
    hash: String(hash || "")
  };
  if (created_at) md.created_at = String(created_at);
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (md[k] === undefined && v !== undefined && v !== null) {
        md[k] = typeof v === "string" ? v : String(v);
      }
    }
  }
  return md;
}
