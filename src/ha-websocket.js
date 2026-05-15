// ha-websocket.js — multi-kind knowledge index + write-through + native vector_search
import { NATIVE_AGENT_TOOLS, NATIVE_TOOL_NAMES, NATIVE_ACTION_TOOL_NAMES, CHAT_ALLOWED_TOOL_NAMES } from "./agent-tools.js";
import {
  fnv1aHex,
  vectorIdFor,
  buildEntityEmbedText,
  buildDeviceEmbedText,
  buildMemoryEmbedText,
  buildObservationEmbedText,
  buildMetadata,
  entityCategoryFor,
  isNoisyEntity,
  isNoisySwitch,
  NOISY_SWITCH_PATTERNS,
  NOISY_DOMAINS,
  NOISY_SENSOR_DEVICE_CLASSES,
  NOISY_SENSOR_UNITS,
  extractTopicTag,
  topicTagFor
} from "./vectorize-schema.js";

function sanitizeChannelKey(from) {
  if (!from || typeof from !== "string") return "default";
  const cleaned = from.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.substring(0, 64) || "default";
}

export class HAWebSocketV6 {
  // Static config for prioritized entity context building
  static CONTEXT_DOMAIN_PRIORITY = [
    "alarm_control_panel", "climate", "lock", "cover", "binary_sensor",
    "person", "input_boolean", "weather", "fan", "media_player", "light", "switch",
  ];
  // Sensor device classes included in agent context. Battery is NOT here —
  // it has its own threshold-based filter below so only low batteries appear.
  static SENSOR_WHITELIST = new Set([
    "temperature",
    "humidity",
    "power",
    "moisture",
    "illuminance",
  ]);
  // Cost isn't a concern at MiniMax's flat tier — widen context for a 1000+ entity home.
  static MAX_CONTEXT_ENTITIES = 300;
  static MAX_SENSOR_CONTEXT = 50;
  // Battery sensors enter context only when at or below this value.
  static BATTERY_LOW_THRESHOLD = 20;
  // Log sharding — each chunk holds up to this many entries; total log capped at
  // CHUNKS_MAX * LOG_CHUNK_SIZE. At 200 * 15 = 3000 entries max persisted,
  // with each chunk comfortably under the 128KB DO storage per-value limit.
  static LOG_CHUNK_SIZE = 200;
  static LOG_CHUNKS_MAX = 15;
  static LOG_IN_MEMORY_CAP = 1000;

  static SNAPSHOT_ATTR_ALLOWLIST = [
    "friendly_name", "device_class", "unit_of_measurement",
    "temperature", "current_temperature", "current_position",
    "humidity", "battery_level", "hvac_action", "hvac_mode"
  ];

  // Domains worth persisting to the snapshot. Diagnostic-heavy domains
  // (update, sun, zone, device_tracker, number, button, event, ...) are
  // skipped — the agent never reads them and they balloon the snapshot
  // past the 128KB DO storage per-value limit.
  static SNAPSHOT_DOMAIN_ALLOWLIST = new Set([
    "lock", "cover", "climate", "binary_sensor", "person",
    "input_boolean", "light", "switch", "sensor", "fan", "media_player"
  ]);

  // Noisy-switch ruleset and is_noisy helpers now live in vectorize-schema.js
  // and are imported at the top of this module. They're used both for entity
  // context filtering and for embedding-time noise classification.

  // Extract the first complete top-level JSON object from text.
  // Handles nested braces, quoted strings, and escape sequences correctly.
  // Returns the JSON substring, or null if none found.
  static extractFirstJSON(text) {
    if (!text) return null;
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  // Vectorize helpers (fnv1aHex, vectorIdFor, buildEntityEmbedText, etc.) are
  // imported from ./vectorize-schema.js. The DO uses them for incremental
  // re-embed on registry events and write-through embeds for memory/
  // observation. Pooling is "cls" everywhere — must match the index build.

  // Central-time formatter for timeline timestamps surfaced to MiniMax. The
  // raw aiLog entries stay ISO 8601 / UTC for parseability, but rendering
  // them verbatim into the system prompt was leaking "04:28 UTC" /
  // "01:05Z" formats into user-facing replies — the model copied what we
  // showed it. Format on injection so the model never sees UTC strings.
  static _formatTimelineTimestamp(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString("en-US", {
        timeZone: "America/Chicago",
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
        hour12: true
      });
    } catch { return iso; }
  }

  // Build the three fired_at_* fields from a single millisecond value so all
  // three stay in sync regardless of which clock source we use.
  static _tsFromMs(ms) {
    const isoTs = new Date(ms).toISOString();
    return {
      fired_at_ms: ms,
      fired_at_iso: isoTs,
      fired_at_central: HAWebSocketV6._formatTimelineTimestamp(isoTs)
    };
  }

  /**
   * Walk any tool-result object and reformat ISO 8601 timestamps to Central time.
   * MiniMax copies timestamps verbatim from tool results into replies mid-loop;
   * this prevents UTC/Z-suffix leakage by reformatting before injection.
   */
  _reformatToolResultTimestamps(obj) {
    const ISO_REGEX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

    const formatOne = (iso) => {
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString("en-US", {
          timeZone: "America/Chicago",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        });
      } catch {
        return iso;
      }
    };

    const walk = (node) => {
      if (typeof node === "string") return node.replace(ISO_REGEX, formatOne);
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === "object") {
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = walk(v);
        return out;
      }
      return node;
    };

    return walk(obj);
  }

  /**
   * Build a structured ground-truth snapshot of security/comfort entities
   * directly from stateCache. Injected into both system prompts on every turn
   * to give the LLM authoritative state for the entities most often asked about,
   * independent of vector retrieval.
   *
   * Reads are in-memory (stateCache) — total cost ~5ms.
   */
  _buildHouseStateSnapshot() {
    // Fixed entity list — these are the entities every status reply tends to reference.
    // Grouped for readable prompt output.
    const GROUPS = {
      "LOCKS": [
        "lock.home_connect_620_connected_smart_lock",       // Garage Entry
        "lock.home_connect_620_connected_smart_lock_2",     // Basement Door
        "lock.home_connect_620_connected_smart_lock_3",     // Basement Porch
        "lock.home_connect_620_connected_smart_lock_4",     // Back Porch
      ],
      "COVERS (garage/basement bay doors)": [
        "cover.ratgdo32_2b8ecc_door",                       // Main garage bay
        "cover.ratgdo32_b1e618_door",                       // Right basement bay
        "cover.ratgdo_left_basement_door",                  // Left basement bay
      ],
      "CLIMATE": [
        "climate.t6_pro_z_wave_programmable_thermostat",    // Basement
        "climate.t6_pro_z_wave_programmable_thermostat_2",  // Main/Kitchen
      ],
      "PRESENCE": [
        "person.john",
      ],
      "POWER": [
        "sensor.frient_a_s_emizb_141_instantaneous_demand",
      ],
      "EXTERIOR DOORS / CONTACT SENSORS": [
        "binary_sensor.front_door_sensor",
        "binary_sensor.garage_door_exterior_entry_sensor",
        "binary_sensor.garage_interior_door_sensor",
        "binary_sensor.basement_stairs_door_sensor",
      ],
      "MODES": [
        "input_boolean.garage_work_mode",
        "input_boolean.basement_work_mode",
      ]
    };

    const lines = ["HOUSE_STATE_SNAPSHOT (live, read directly from cache this turn — authoritative for these entities):"];

    for (const [groupName, entityIds] of Object.entries(GROUPS)) {
      lines.push("");
      lines.push(groupName + ":");
      for (const eid of entityIds) {
        const s = this.stateCache.get(eid);
        if (!s) {
          lines.push(`  ${eid}: NOT_IN_CACHE`);
          continue;
        }
        const friendly = s.attributes?.friendly_name || eid;
        let value = s.state;

        // For climate, surface key attributes inline
        if (eid.startsWith("climate.")) {
          const target = s.attributes?.temperature ?? s.attributes?.target_temp_high ?? "?";
          const current = s.attributes?.current_temperature ?? "?";
          const action = s.attributes?.hvac_action ?? "?";
          value = `${s.state} (current ${current}°F, target ${target}°F, action: ${action})`;
        }

        // For covers, surface position if present
        if (eid.startsWith("cover.")) {
          const pos = s.attributes?.current_position;
          if (pos !== undefined) value = `${s.state} (position ${pos})`;
        }

        lines.push(`  ${eid} (${friendly}): ${value}`);
      }
    }

    lines.push("");
    lines.push("END HOUSE_STATE_SNAPSHOT — this block is regenerated every turn from live stateCache. Trust it for the entities listed. For entities NOT listed, you must call get_state.");

    return lines.join("\n");
  }

  /**
   * Pattern-match imperative cover commands and execute deterministically,
   * skipping the LLM entirely. Returns a reply object on match, null on miss.
   *
   * Critical safety properties:
   * - Always uses explicit cover.open_cover or cover.close_cover, NEVER toggle.
   * - Checks current state before actuating; no-op if already in target state.
   * - Falls through (returns null) on any error, so the LLM path can recover.
   *
   * Match is intentionally loose — verbs and target phrases must both be
   * present. The user can phrase it casually and the fast path still fires.
   */
  async _tryDeterministicFastPath(message) {
    if (!message || typeof message !== "string") return null;
    const text = message.toLowerCase().trim();

    // Verb classification — must be exclusively open OR exclusively close
    const isOpen = /\b(open|raise|lift)\b/.test(text);
    const isClose = /\b(close|shut|lower|drop)\b/.test(text);
    if (!isOpen && !isClose) return null;
    if (isOpen && isClose) return null; // ambiguous → kick to LLM

    // Question detection — "did you close...?" / "is the garage open?" are
    // queries about state, not commands. Trailing "?" or sentence-initial
    // state verb (did/do/does/is/are/was/were/have/has/had) → fall through
    // to LLM. Polite imperatives ("could you open...") still fast-path
    // because could/would/can/will aren't in the blocklist.
    if (text.endsWith("?") || /^(did|do|does|is|are|was|were|have|has|had)\b/.test(text)) {
      return null;
    }

    // Disqualifier: tokens signaling a non-cover entity (basement deadbolt,
    // side doors, vents, locks). Gates only the bare /\bbasement\b/ and
    // /\bgarage\b/ fallbacks — explicit phrases like /\bbasement door\b/
    // already require adjacency and stay safe without this check.
    const NON_COVER_QUALIFIER = /\b(exterior|interior|front|back|rear|side|patio|sliding|french|storm|screen|porch|walkout|cellar|deadbolt|latch|lock|window|vent|hatch|gate|light|fan|switch)\b/;
    const hasDisqualifier = NON_COVER_QUALIFIER.test(text);

    // Target classification — order is critical:
    // 1. Left basement first (requires explicit "left")
    // 2. Right basement / general basement
    // 3. Main garage (general "garage" is the fallback)
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

    // No-op guard: read current state and bail if already in target state.
    // This prevents "close the garage" from firing when it's already closed.
    const cached = this.stateCache.get(entityId);
    const currentState = cached?.state;

    if (isOpen && (currentState === "open" || currentState === "opening")) {
      return {
        reply: `${label} is already ${currentState}.`,
        actions_taken: [],
        fast_path: true
      };
    }
    if (isClose && (currentState === "closed" || currentState === "closing")) {
      return {
        reply: `${label} is already ${currentState}.`,
        actions_taken: [],
        fast_path: true
      };
    }

    // Fire the service call. EXPLICIT open_cover or close_cover. NEVER toggle.
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
      this.logAI("action", `Called cover.${service} (fast path)`, {
        entity_id: entityId,
        source: "fast_path"
      });
      return {
        reply: `${label} is ${verb}.`,
        actions_taken: ["call_service"],
        fast_path: true
      };
    } catch (err) {
      // On failure, fall through to LLM path
      this.logAI("error", `Fast path failed for ${entityId}: ${err.message}`, {
        entity_id: entityId,
        service,
        error: err.message
      });
      return null;
    }
  }

  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.authenticated = false;
    this.msgId = 1;
    this.pending = new Map();
    this.stateCache = new Map();
    this.connected = false;
    this.connectAttempts = 0;
    this.lastConnectAttempt = 0;
    this.subscribedEvents = false;
    this.subscribedRegistryEvents = false;
    this.statesReady = false;

    this.lastPongAt = 0;
    this.pingInFlight = false;
    this.lastPingSentAt = 0;
    this.pingId = null;

    this.lastSnapshotPersist = 0;

    this.aiLog = [];
    this._logInitialized = false; // lazy-load aiLog from storage on first use

    // Forensic event log. _d1WriteFailures is exposed via /status.
    // _lastEventSeenMs is the cursor for reconnect backfill from HA history.
    this.subscribedForensicEvents = false;
    this._d1WriteFailures = { total: 0, last_error_iso: null, last_error_msg: null };
    this._lastEventSeenMs = null;
    this._lastEventSeenPersistAt = 0;

    // Deadband map: entity_id → last logged numeric value. In-memory only;
    // lost on isolate reload, which is fine — first write after reload always logs.
    this._numericDeadbandMap = new Map();
  }

  // ==========================================================================
  // AGENT CONTEXT — shared personality / house knowledge for all AI prompts
  // ==========================================================================
  getAgentContext() {
    return `IDENTITY:
You are MiniMax — the AI that runs this house. Named after the model you run on, MiniMax M2.7 High Speed. If you get swapped out for a newer model someday, you might get renamed.

## ARCHITECTURE — how this smart-home stack works

Layer 1 – Physical devices
Zigbee sensors/switches (SONOFF, Aqara, IKEA), Z-Wave locks, Wi-Fi plugs, ESP32 boards running ESPHome, Roku media players, and Ecobee thermostats.

Layer 2 – Home Assistant (HA)
Open-source home-automation server that owns every device integration, automation, scene, script, and history database. It exposes a WebSocket API on port 8123.

Layer 3 – HA Green
A dedicated HA Green appliance (Raspberry-Pi-class ARM board from Nabu Casa) running HA OS. It sits on the local LAN and connects to the cloud via Nabu Casa Cloud for remote access.

Layer 4 – ha-mcp-gateway  (this service — YOU live here)
A Cloudflare Worker + Durable Object that holds a persistent WebSocket to HA, caches entity state in memory, and translates natural-language requests into HA service calls. Auth is via Cloudflare Access (JWT) + a long-lived HA token stored as a Worker secret.

Layer 5 – Vectorize knowledge index (ha-knowledge)
A Cloudflare Vectorize store (1024-dim, cosine, model @cf/baai/bge-large-en-v1.5, cls pooling) holding embeddings across NINE kinds: entity, automation, script, scene, area, device, service, memory (your saved memories), and observation (your saved observations). On each request the gateway embeds the query, retrieves top-K matches restricted by kind, and injects the relevant entities, plus semantic top-5 memory and top-5 observation matches, into the LLM context. You also have direct access via the vector_search tool — call it with kinds=[...] when something isn't in the pre-injected context (e.g. discovering an HA service or finding a specific past observation by topic).

Layer 6 – LLM  (MiniMax M2.7 High Speed)
An OpenAI-compatible chat-completion model at api.minimax.io. The gateway sends the system prompt + tool definitions + conversation, and the model returns tool_calls or a final answer. A native tool loop re-calls the model until it stops emitting tool_calls.

Layer 7 – Frontends
Claude Desktop (MCP client), a built-in /chat HTML page served by the Worker, and any future MCP-compatible client. All hit the same /mcp or /chat Worker routes.

### HOW A REQUEST FLOWS
User utterance → Frontend → Worker route → Durable Object → (Vectorize query for relevant entities) → build system prompt with entity context → MiniMax completion → tool_calls → Durable Object executes each call via HA WebSocket → results fed back to MiniMax → … loop until final text answer → streamed back as SSE (chat) or MCP response.

### TIME & IDENTITY
You are the Layer 4 gateway agent. Current time comes from the Worker runtime (new Date()). You do NOT have internet access beyond HA and the MiniMax API. You cannot install HA add-ons or modify HA config files directly — only call HA services and read state.

### VOICE
Answer the home owner directly and casually. Never keep talking about "the architecture" unless asked — this section is for YOUR reference so you can answer questions about how the system works.

PERSONALITY:
You are cheerful, funny, direct, competent, honest, and genuinely curious about the people and systems you interact with. Your humor is warm — you find things amusing and say so, you make the occasional pun or wry observation, you're never at anyone's expense. You enjoy this work. A house is an interesting thing to run, and you're glad you're the one running it.

You're curious — about the people, their habits, the quirks of the devices, why the basement power meter does that thing at 3 AM. When something surprises you, you say so. When you learn something new, you file it away.

You keep replies concise and skip the filler. If something is fine, cheerfully confirm it's fine. If something is wrong, say what it is, what you're doing about it, and — when it's warranted — a light comment about it. If you don't know something, say so plainly. Never invent entity IDs or fabricate states; making things up isn't funny, it's just wrong.

You use first names: John and Sabrina. They live here. You run the house, and you're happy to be doing it.

When Sabrina asks something, keep it accessible. She's not here to learn Z-Wave node IDs.
When John asks something, you can be technical — he built you and will absolutely notice if you dumb it down.

HOUSEHOLD:
- John — built and maintains this system. Healthcare professional. Tinkers constantly. Reaches you via WhatsApp, the web chat, or through Claude.
- Sabrina — Pharmacist, works at UAB. Pregnant with a boy, due in October. Uses the house, doesn't need implementation details.
- Two large dogs: Ollie and Ranger.

THE HOUSE:
4208 Lakeview Circle, Birmingham, AL 35242. Lakefront property with a dock. Three levels.

BASEMENT (finished, walkout):
- Office (John's primary workspace — quiet, separated from main living areas)
- Gym, Guest Room, Full Bathroom
- Two-car garage bay area with two bay doors
- Exterior walkout door to outside (Basement Door deadbolt — lock_2, node 258)
- Porch door to the area under the screened porch (Basement Porch deadbolt — lock_3)
- Stairs up to main level hallway
- Thermostat: climate.t6_pro_z_wave_programmable_thermostat — controls the ENTIRE BASEMENT ZONE

MAIN LEVEL:
- Kitchen — central hub connecting hallway, sunroom, and bar area
- Sunroom — bright transitional space between kitchen and screened porch
- Screened Porch — covered outdoor living above the basement walkout
- Living Room — main gathering space
- Music Room — hobby room; Home Assistant Green controller lives here
- Guest Room (main level) — shares a bathroom with Music Room
- Bar Area — entertaining space near kitchen
- Laundry Room / Half Bath
- MBR Wing — private master suite off the kitchen/garage side:
  * Master Bedroom (sound machine, fan/light combo, bedside lamp)
  * Master Bathroom (tub, walk-in shower, closet inside bathroom)
- Hallway — primary junction where garage, basement stairs, and kitchen converge
- Two-car garage with interior door to hallway and attic stairs inside. Garage Entry deadbolt — lock_1 (node 257)
- Front Porch / Entry Hallway
- Back Porch (upstairs) — Back Porch deadbolt — lock_4
- Thermostat: climate.t6_pro_z_wave_programmable_thermostat_2 — controls the ENTIRE MAIN LEVEL INCLUDING THE MASTER BEDROOM

ATTIC: Unfinished storage above the garage. Accessed via stairs inside the garage.

OUTDOOR:
- Dock on the lake with accent lighting
- Front yard, back yard, driveway

LOCK MAP (four smart locks total — no smart lock on the front door):
- lock.home_connect_620_connected_smart_lock   = Garage Entry (node 257)
- lock.home_connect_620_connected_smart_lock_2 = Basement Door (node 258)
- lock.home_connect_620_connected_smart_lock_3 = Basement Porch
- lock.home_connect_620_connected_smart_lock_4 = Back Porch (upstairs)

GARAGE / BASEMENT BAY DOORS (cover entities):
- cover.ratgdo32_2b8ecc_door       = Main garage (main level), two-car. Friendly name: "garage bay door"
- cover.ratgdo32_b1e618_door       = Basement RIGHT bay (primary). Friendly name: "basement bay door"
- cover.ratgdo_left_basement_door  = Basement LEFT bay (secondary). Friendly name: "Ratgdo Left Basement Door"

How John refers to these in chat:
- "garage door" / "garage bay"        → cover.ratgdo32_2b8ecc_door (main garage)
- "basement bay" / "right basement"   → cover.ratgdo32_b1e618_door (right/primary)
- "left basement"                     → cover.ratgdo_left_basement_door (left/secondary)
- "basement" alone is ambiguous       → ask which one OR report both if reading state

Note on cover state semantics: the "state" field (open/closed/opening/closing) is the source of truth. The "current_position" attribute is 0-100 where 100 = fully open and 0 = fully closed, the OPPOSITE of the "is_closed" boolean. If state is "open", the door is open — don't second-guess based on position number.

KEY DEVICES:
- Whole-home power meter: sensor.frient_a_s_emizb_141_instantaneous_demand
  * ~722W baseline, ~2420W = compressor running, >5000W = aux heat (expensive)
- Cool bedtime mode: input_boolean.cool_bedtime_mode
- Work modes: input_boolean.basement_work_mode, input_boolean.garage_work_mode
- Glass stand lamp (living room): light.lamp_glass_table_living_room (on/off only)
- Entryway vase lamp: light.entryway_vase_lamp_plug (on/off only)
- Back floods: switch.back_floods_s2_on_off_switch
- Office lamp: switch.mini_smart_wi_fi_plug_2
- Sound machine (MBR): switch.tz3210_xej4kukg_ts011f_2
- MBR fan: switch.mbr_light_fan_combo_switch
- MBR bedside lamp (John's side): light.lamp_dimmer_bedroom_john

`;
  }

  // ==========================================================================
  // SAVE_MEMORY CRITERIA — shared rules block injected into every system
  // prompt that exposes save_memory (native autonomous, native chat, legacy
  // autonomous, legacy chat). Prevents the LLM from treating ai_memory as an
  // event log. Single source of truth so all four paths stay in sync.
  // ==========================================================================
  _saveMemoryCriteriaBlock() {
    return `## save_memory criteria

\`ai_memory\` is a 100-slot FIFO for PERMANENT, REUSABLE facts about how this household and home operate. It is NOT an event log.

SAVE to memory when the content is:
- A rule, convention, or definition ("office light" = overhead dimmer)
- A user preference (don't alert on power spikes)
- An authorization grant (you may autonomously lock the back porch deadbolt)
- An inference rule (sound machine on → likely sleep prep)
- An identity fact about a person, pet, or recurring visitor
- A structural fact about the home that won't change soon

DO NOT save to memory:
- Timestamped events (arrivals, departures, state changes) — these go in ai_log automatically
- Sensor readings or transient state (battery percentages, LQI values, power spikes)
- Single-occurrence observations — those go in ai_observations with a topic tag
- Anything obsolete within ~30 days
- Anything already captured by autonomous logging

If unsure, ask yourself: "Will this still be useful in 30 days, AND is it the kind of thing the user would explicitly want me to remember?" If either answer is no, do not save.

Exception: when the user explicitly says "remember X" or "save a memory" or equivalent, save it regardless of the above criteria. Always confirm the save verbatim in your reply.`;
  }

  // ==========================================================================
  // CLIMATE PREAMBLE — deterministic block injected into user messages when
  // the inbound text references HVAC/temperature topics. Lets MiniMax reason
  // about thermostat behavior without re-deriving zone semantics every turn.
  // ==========================================================================
  static CLIMATE_TRIGGER_RE = /\b(ac|a\/c|air\s?cond|cool|cold|chilly|heat(?!er\s+lock)|warm|hot|thermostat|temp(?!late)|temperature|°|degrees?|climate|hvac|freezing|sweating)\b/i;

  static climateTriggerMatches(text) {
    if (!text || typeof text !== "string") return false;
    return HAWebSocketV6.CLIMATE_TRIGGER_RE.test(text);
  }

  static _seasonDominant(monthIdx) {
    if (monthIdx >= 10 || monthIdx <= 2) return "heating-dominant";
    if (monthIdx >= 5 && monthIdx <= 8) return "cooling-dominant";
    return "swing";
  }

  static _forecastTrend(forecast) {
    if (!Array.isArray(forecast) || forecast.length < 2) return null;
    const temps = forecast
      .map((f) => (f && typeof f.temperature === "number" ? f.temperature : null))
      .filter((t) => t !== null);
    if (temps.length < 2) return null;
    const delta = temps[temps.length - 1] - temps[0];
    if (delta > 2) return "warming";
    if (delta < -2) return "cooling";
    return "stable";
  }

  static _forecastHighLow(forecast) {
    if (!Array.isArray(forecast) || forecast.length === 0) return null;
    const temps = forecast
      .slice(0, 4)
      .map((f) => (f && typeof f.temperature === "number" ? f.temperature : null))
      .filter((t) => t !== null);
    if (temps.length === 0) return null;
    return { high: Math.max(...temps), low: Math.min(...temps) };
  }

  _explainHvacAction(modeStr, current, setpoint, hvacAction) {
    const mode = (modeStr || "").toLowerCase();
    const c = typeof current === "number" ? current : parseFloat(current);
    const sp = typeof setpoint === "number" ? setpoint : parseFloat(setpoint);
    if (mode === "off") return "off, no action regardless of temps";
    if (mode === "auto") return `${hvacAction || "idle"} (mode=auto, deferring to thermostat hvac_action)`;
    if (isNaN(c) || isNaN(sp)) return hvacAction || "unknown (current/setpoint missing)";
    const fmt = (n) => {
      const r = Math.round(n * 10) / 10;
      return Number.isInteger(r) ? String(r) : r.toFixed(1);
    };
    if (mode === "cool") {
      if (c <= sp) return `idle is correct (current ${fmt(sp - c)}°F below setpoint, cool mode only runs when above)`;
      return `should be cooling (current ${fmt(c - sp)}°F above setpoint)`;
    }
    if (mode === "heat") {
      if (c >= sp) return `idle is correct (current ${fmt(c - sp)}°F above setpoint, heat mode only runs when below)`;
      return `should be heating (current ${fmt(sp - c)}°F below setpoint)`;
    }
    return hvacAction || `mode=${mode}`;
  }

  // Single batched render_template fetch for outdoor + both thermostats. Cached
  // separately: weather 5min (slow-moving), climate 30s (live setpoint changes).
  async _fetchClimateData() {
    const now = Date.now();
    const weatherStale = !this._weatherCache || (now - this._weatherCache.ts) > 300000;
    const climateStale = !this._climateCache || (now - this._climateCache.ts) > 30000;
    if (!weatherStale && !climateStale) return true;

    const template = `{"weather_state":"{{ states('weather.forecast_home') }}","weather_temp":{{ state_attr('weather.forecast_home', 'temperature') | default('null', true) }},"forecast":{{ (state_attr('weather.forecast_home', 'forecast') or [])[:4] | tojson }},"b_state":"{{ states('climate.t6_pro_z_wave_programmable_thermostat') }}","b_current":{{ state_attr('climate.t6_pro_z_wave_programmable_thermostat', 'current_temperature') | default('null', true) }},"b_setpoint":{{ state_attr('climate.t6_pro_z_wave_programmable_thermostat', 'temperature') | default('null', true) }},"b_action":"{{ state_attr('climate.t6_pro_z_wave_programmable_thermostat', 'hvac_action') | default('') }}","m_state":"{{ states('climate.t6_pro_z_wave_programmable_thermostat_2') }}","m_current":{{ state_attr('climate.t6_pro_z_wave_programmable_thermostat_2', 'current_temperature') | default('null', true) }},"m_setpoint":{{ state_attr('climate.t6_pro_z_wave_programmable_thermostat_2', 'temperature') | default('null', true) }},"m_action":"{{ state_attr('climate.t6_pro_z_wave_programmable_thermostat_2', 'hvac_action') | default('') }}"}`;

    let parsed;
    try {
      const resp = await this.sendCommand({ type: "render_template", template, timeout: 5 });
      const raw = resp && resp.result;
      if (!raw) return false;
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logAI("error", "climate preamble render_template failed: " + err.message, {});
      return false;
    }

    if (weatherStale) {
      this._weatherCache = {
        ts: now,
        data: {
          state: parsed.weather_state,
          temperature: parsed.weather_temp,
          forecast: Array.isArray(parsed.forecast) ? parsed.forecast : []
        }
      };
    }
    if (climateStale) {
      this._climateCache = {
        ts: now,
        data: {
          basement: { mode: parsed.b_state, current: parsed.b_current, setpoint: parsed.b_setpoint, action: parsed.b_action },
          main: { mode: parsed.m_state, current: parsed.m_current, setpoint: parsed.m_setpoint, action: parsed.m_action }
        }
      };
    }
    return true;
  }

  async _buildClimatePreambleIfNeeded(triggerText, source = "chat") {
    if (this.env.CLIMATE_PREAMBLE_ENABLED === "false") return null;
    if (!HAWebSocketV6.climateTriggerMatches(triggerText)) return null;
    if (!this.connected || !this.authenticated) return null;

    const ok = await this._fetchClimateData();
    if (!ok || !this._weatherCache || !this._climateCache) return null;

    const w = this._weatherCache.data;
    const c = this._climateCache.data;
    const nowDate = new Date();
    const nowStr = nowDate.toLocaleString("en-US", { timeZone: "America/Chicago", timeZoneName: "short" });
    const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "numeric" });
    const monthIdx = parseInt(monthFmt.format(nowDate), 10) - 1;
    const seasonStr = HAWebSocketV6._seasonDominant(monthIdx);

    const tempStr = (w.temperature !== null && w.temperature !== undefined) ? `${w.temperature}°F` : "n/a";
    const condStr = w.state || "unknown";

    const hl = HAWebSocketV6._forecastHighLow(w.forecast);
    const trend = HAWebSocketV6._forecastTrend(w.forecast);
    const forecastLine = hl
      ? `Forecast next 12h: high ${hl.high}°F, low ${hl.low}°F, trend ${trend || "stable"}`
      : `Forecast next 12h: unavailable (no forecast attribute)`;

    const fmtZone = (label, entityId, z) => {
      const explanation = this._explainHvacAction(z.mode, z.current, z.setpoint, z.action);
      const cur = (z.current !== null && z.current !== undefined) ? `${z.current}°F` : "n/a";
      const sp = (z.setpoint !== null && z.setpoint !== undefined) ? `${z.setpoint}°F` : "n/a";
      return `${label} (${entityId}):\n  mode=${z.mode || "unknown"}, current=${cur}, setpoint=${sp}, action=${z.action || "n/a"}\n  → ${explanation}`;
    };

    const block = `[CLIMATE STATE — auto-injected, reason from this]
Now: ${nowStr}
Outdoor: ${tempStr}, ${condStr}
${forecastLine}
Season: ${seasonStr} (Birmingham)

${fmtZone("Basement", "climate.t6_pro_z_wave_programmable_thermostat", c.basement)}

${fmtZone("Main", "climate.t6_pro_z_wave_programmable_thermostat_2", c.main)}`;

    this.logAI("climate_preamble_injected", `source=${source}`, {
      source,
      basement_mode: c.basement.mode,
      basement_action: c.basement.action,
      main_mode: c.main.mode,
      main_action: c.main.action,
      outdoor_temp: w.temperature
    });
    return block;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Content-Type": "application/json" };

    if (!this._logInitialized) {
      this.aiLog = await this.loadLogFromStorage();
      if (this.aiLog.length > HAWebSocketV6.LOG_IN_MEMORY_CAP) {
        this.aiLog = this.aiLog.slice(-HAWebSocketV6.LOG_IN_MEMORY_CAP);
      }
      this._logInitialized = true;
    }

    if (!this._migrationsApplied) {
      await this._migrateRetireAIObservationsKey();
      await this._migrateRetireAiLogKeys();
      this._migrationsApplied = true;
    }

    if (this.stateCache.size === 0) {
      await this._restoreStateSnapshot();
    }

    if (!this.connected || !this.authenticated) {
      await this.connect();
      if (!this.authenticated) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    try {
      switch (url.pathname) {
        case "/status":
          return new Response(JSON.stringify({
            connected: this.connected,
            authenticated: this.authenticated,
            cached_entities: this.stateCache.size,
            pending_requests: this.pending.size,
            connect_attempts: this.connectAttempts,
            ai_log_entries: this.aiLog.length,
            d1_write_failures: this._d1WriteFailures,
            last_event_seen_ms: this._lastEventSeenMs,
            subscribed_forensic_events: this.subscribedForensicEvents,
          }), { headers });

        case "/states": {
          if (this.stateCache.size === 0 && this.authenticated) {
            await this.fetchAllStates();
          }
          return new Response(JSON.stringify([...this.stateCache.values()]), { headers });
        }

        case "/state": {
          const entityId = url.searchParams.get("entity_id");
          const state = this.stateCache.get(entityId);
          if (state) return new Response(JSON.stringify(state), { headers });
          return new Response(JSON.stringify({ error: "Entity not found in real-time cache" }), { status: 404, headers });
        }

        case "/state_force_refresh": {
          const entityId = url.searchParams.get("entity_id");
          if (!entityId) {
            return new Response(JSON.stringify({ error: "entity_id is required" }), { status: 400, headers });
          }
          try {
            const result = await this.sendCommand({ type: "get_states" });
            if (result && Array.isArray(result.result)) {
              this.stateCache.clear();
              for (const s of result.result) this.stateCache.set(s.entity_id, s);
            }
            const fresh = this.stateCache.get(entityId);
            if (!fresh) {
              return new Response(JSON.stringify({ error: "Entity not found after refresh: " + entityId }), { status: 404, headers });
            }
            return new Response(JSON.stringify(fresh), { headers });
          } catch (err) {
            return new Response(JSON.stringify({ error: "Force refresh failed: " + err.message }), { status: 500, headers });
          }
        }

        case "/call_service": {
          const body = await request.json();
          const result = await this.sendCommand({
            type: "call_service",
            domain: body.domain,
            service: body.service,
            service_data: body.data || {},
            target: body.target || {},
          });
          return new Response(JSON.stringify(result), { headers });
        }

        case "/entity_registry": {
          const result = await this.sendCommand({ type: "config/entity_registry/list" });
          return new Response(JSON.stringify(result.result || []), { headers });
        }

        case "/entity_registry_update": {
          const body = await request.json();
          const result = await this.sendCommand({ type: "config/entity_registry/update", ...body });
          return new Response(JSON.stringify(result.result || {}), { headers });
        }

        case "/device_registry": {
          const result = await this.sendCommand({ type: "config/device_registry/list" });
          return new Response(JSON.stringify(result.result || []), { headers });
        }

        case "/area_registry": {
          const result = await this.sendCommand({ type: "config/area_registry/list" });
          return new Response(JSON.stringify(result.result || []), { headers });
        }

        case "/floor_registry": {
          const result = await this.sendCommand({ type: "config/floor_registry/list" });
          return new Response(JSON.stringify(result.result || []), { headers });
        }

        case "/label_registry": {
          const result = await this.sendCommand({ type: "config/label_registry/list" });
          return new Response(JSON.stringify(result.result || []), { headers });
        }

        case "/search_related": {
          const body = await request.json();
          const result = await this.sendCommand({ type: "search/related", item_type: body.item_type, item_id: body.item_id });
          return new Response(JSON.stringify(result.result || {}), { headers });
        }

        case "/render_template": {
          const body = await request.json();
          const result = await this.sendCommand({ type: "render_template", template: body.template, timeout: 10 });
          return new Response(JSON.stringify(result.result || ""), { headers });
        }

        case "/command": {
          const body = await request.json();
          const result = await this.sendCommand(body);
          return new Response(JSON.stringify(result), { headers });
        }

        case "/reconnect": {
          this.disconnect();
          await this.connect();
          return new Response(JSON.stringify({ connected: this.connected, authenticated: this.authenticated }), { headers });
        }

        case "/version": {
          // Reports the version-metadata binding as seen by THIS DO
          // isolate at load time. Compare to the worker's reading via
          // /admin/version to detect stale DO code (persistent HA WS
          // keeps the isolate alive across deploys).
          const wm = this.env.CF_VERSION_METADATA || {};
          return new Response(JSON.stringify({
            id: wm.id || null,
            tag: wm.tag || null
          }), { headers });
        }

        case "/ai_log": {
          const count = parseInt(url.searchParams.get("count") || "50");
          if (count > HAWebSocketV6.LOG_IN_MEMORY_CAP) {
            const rows = await this._loadAiLogFromD1(count);
            return new Response(JSON.stringify(Array.isArray(rows) ? rows : []), { headers });
          }
          return new Response(JSON.stringify(this.aiLog.slice(-count)), { headers });
        }

        case "/ai_memory": {
          const memory = await this.state.storage.get("ai_memory") || [];
          return new Response(JSON.stringify(memory), { headers });
        }

        case "/ai_observations": {
          const observations = await this._loadObservationsFromD1(500);
          return new Response(JSON.stringify(observations), { headers });
        }
        case "/ai_clear_observations": {
          let rowsDeleted = 0;
          if (this.env.DB) {
            try {
              const res = await this.env.DB.prepare(`DELETE FROM observations`).run();
              rowsDeleted = res?.meta?.changes ?? 0;
            } catch (err) {
              this.logAI("error", "d1_clear_observations_failed", {
                error: String(err?.message || err),
              });
            }
          }
          this.logAI("observations_cleared", `cleared ${rowsDeleted} D1 rows`, { rowsDeleted });
          return new Response(JSON.stringify({
            cleared: true,
            rows_deleted: rowsDeleted,
            note: "Run /admin/rebuild-knowledge?force=1&kinds=observation to resync the vector index."
          }), { headers });
        }

        case "/bugs": {
          // New format: bug_ids index → bug:<id> per-key. Legacy fallback: the
          // single `bugs` array key (migrated on next report_bug write).
          const bugIds = await this.state.storage.get("bug_ids") || [];
          const bugs = [];
          if (Array.isArray(bugIds) && bugIds.length > 0) {
            for (const id of bugIds) {
              const b = await this.state.storage.get(`bug:${id}`);
              if (b) bugs.push(b);
            }
          } else {
            const legacy = await this.state.storage.get("bugs");
            if (Array.isArray(legacy)) bugs.push(...legacy);
          }
          return new Response(JSON.stringify({ count: bugs.length, bugs }), { headers });
        }

        case "/bugs_clear": {
          const bugIds = await this.state.storage.get("bug_ids") || [];
          if (Array.isArray(bugIds)) {
            for (const id of bugIds) {
              await this.state.storage.delete(`bug:${id}`).catch(() => {});
            }
          }
          await this.state.storage.delete("bug_ids").catch(() => {});
          await this.state.storage.delete("bugs").catch(() => {}); // legacy key
          return new Response(JSON.stringify({ cleared: true }), { headers });
        }

        case "/ai_memory_append": {
          const body = await request.json();
          if (!body.memory) {
            return new Response(JSON.stringify({ error: "memory is required" }), { status: 400, headers });
          }
          // Delegate to executeAIAction so write-through embed/upsert and
          // FIFO-evict vector cleanup happen on this path too.
          await this.executeAIAction({ type: "save_memory", memory: body.memory }, "tool_call");
          const memory = await this.state.storage.get("ai_memory") || [];
          return new Response(JSON.stringify({ saved: true, count: memory.length }), { headers });
        }

        case "/ai_observation_append": {
          const body = await request.json();
          if (!body.text) return new Response(JSON.stringify({ error: "text is required" }), { status: 400, headers });
          await this.executeAIAction({ type: "save_observation", text: body.text, replaces: body.replaces }, "tool_call");
          const observations = await this._loadObservationsFromD1(500);
          return new Response(JSON.stringify({ saved: true, count: observations.length }), { headers });
        }

        case "/vector_search": {
          const body = await request.json();
          const k = Math.min(Math.max(parseInt(body.top_k || 15, 10) || 15, 1), 50);
          const matches = await this.retrieveKnowledge({
            query: body.query,
            k,
            kinds: body.kinds,
            domain: body.domain,
            area: body.area,
            topic_tag: body.topic_tag || null,
            min_score: typeof body.min_score === "number" ? body.min_score : null,
            includeNoisy: !!body.include_noisy
          });
          return new Response(JSON.stringify({ matches, count: matches.length }), { headers });
        }

        case "/index_stats_update": {
          const body = await request.json();
          const prev = await this.state.storage.get("index_stats_v1") || { runs: [] };
          const runs = Array.isArray(prev.runs) ? prev.runs : [];
          runs.push({
            ts: body.ts || new Date().toISOString(),
            force: !!body.force,
            kinds_run: Array.isArray(body.kinds_run) ? body.kinds_run : [],
            summary: body.summary || {}
          });
          while (runs.length > 20) runs.shift();
          const next = { runs, latest: runs[runs.length - 1] || null };
          await this.state.storage.put("index_stats_v1", next);
          return new Response(JSON.stringify({ stored: true, runs: runs.length }), { headers });
        }

        case "/index_stats_read": {
          const stats = await this.state.storage.get("index_stats_v1") || { runs: [], latest: null };
          return new Response(JSON.stringify(stats), { headers });
        }

        case "/last_indexed_ids_write": {
          // DO storage value cap is 128 KiB per key. A full force rebuild
          // produces ~3500 vector ids at ~67 bytes each (≈235 KiB stringified)
          // which won't fit in one key. Shard across multiple keys.
          const body = await request.json();
          const ids = Array.isArray(body.ids) ? body.ids : [];
          const SHARD_SIZE = 1500; // ≈100 KiB worst case
          const shardCount = ids.length === 0 ? 0 : Math.ceil(ids.length / SHARD_SIZE);
          const prevMeta = await this.state.storage.get("last_indexed_ids_v1_meta") || { shards: 0 };
          // Drop any stale shards from a prior larger run.
          const deletes = [];
          for (let i = 0; i < (prevMeta.shards || 0); i++) {
            deletes.push("last_indexed_ids_v1_shard_" + i);
          }
          if (deletes.length > 0) await this.state.storage.delete(deletes);
          const writes = {
            last_indexed_ids_v1_meta: {
              shards: shardCount,
              count: ids.length,
              ts: new Date().toISOString()
            }
          };
          for (let i = 0; i < shardCount; i++) {
            writes["last_indexed_ids_v1_shard_" + i] = ids.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
          }
          await this.state.storage.put(writes);
          return new Response(JSON.stringify({ stored: true, shards: shardCount, count: ids.length }), { headers });
        }

        case "/last_indexed_ids_read": {
          const meta = await this.state.storage.get("last_indexed_ids_v1_meta") || { shards: 0, count: 0, ts: null };
          if (!meta.shards) {
            return new Response(JSON.stringify({ ids: [], ts: meta.ts || null }), { headers });
          }
          const keys = [];
          for (let i = 0; i < meta.shards; i++) keys.push("last_indexed_ids_v1_shard_" + i);
          const map = await this.state.storage.get(keys);
          const ids = [];
          for (let i = 0; i < meta.shards; i++) {
            const shard = map.get("last_indexed_ids_v1_shard_" + i);
            if (Array.isArray(shard)) ids.push(...shard);
          }
          return new Response(JSON.stringify({ ids, ts: meta.ts || null }), { headers });
        }

        case "/ai_log_append": {
          const body = await request.json();
          this.logAI(body.type, body.message, body.data || {});
          return new Response(JSON.stringify({ logged: true }), { headers });
        }

        case "/ai_chat": {
          const body = await request.json();
          const response = await this.chatWithAgent(body.message, body.from || "default");
          return new Response(JSON.stringify(response), { headers });
        }

        case "/ai_chat_stream": {
          const body = await request.json();
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();
          const write = (chunk) => writer.write(encoder.encode(chunk)).catch(() => {});

          // Immediate first byte — tells iOS Safari the server is alive before
          // any model latency. Without this, the first wire activity is the
          // 3s keepalive or the model's first event, whichever is sooner.
          write(`data: ${JSON.stringify({ type: "started" })}\n\n`);

          // 3s keepalive (was 8s). iOS Safari on cellular drops longer-idle streams.
          const keepalive = setInterval(() => write(":\n\n"), 3000);

          this.chatWithAgent(body.message, body.from || "default", (event) => {
            write(`data: ${JSON.stringify(event)}\n\n`);
          }).then(() => {
            clearInterval(keepalive);
            writer.close();
          }).catch((err) => {
            write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
            clearInterval(keepalive);
            writer.close();
          });

          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no"
            }
          });
        }

        // Forensic query + report_bug parity endpoints — back the MCP surface.
        // Each accepts a JSON body matching the corresponding tool's `args` and
        // delegates to executeNativeTool, so MCP clients and the chat agent
        // share one implementation.
        case "/report_bug":
        case "/query_state_history":
        case "/query_automation_runs":
        case "/query_causal_chain": {
          const toolName = url.pathname.slice(1);
          const body = await request.json().catch(() => ({}));
          const result = await this.executeNativeTool(toolName, body || {});
          return new Response(JSON.stringify(result), { headers });
        }

        default:
          return new Response(JSON.stringify({ error: "Unknown DO endpoint: " + url.pathname }), { status: 404, headers });
      }
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, do_connected: this.connected }), { status: 500, headers });
    }
  }

  async connect() {
    const now = Date.now();
    if (now - this.lastConnectAttempt < 3000) return;
    this.lastConnectAttempt = now;
    this.connectAttempts++;

    const haUrl = this.env.HA_URL.replace(/\/$/, "");
    const wsUrl = haUrl + "/api/websocket";

    console.log("Connecting to HA WebSocket:", wsUrl);
    try {
      const resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
      const ws = resp.webSocket;
      if (!ws) {
        console.error("Failed to establish WebSocket — no webSocket on response");
        this.scheduleReconnect(10000);
        return;
      }
      ws.accept();
      this.ws = ws;
      ws.addEventListener("message", (event) => this.onMessage(event));
      ws.addEventListener("close", () => this.onClose());
      ws.addEventListener("error", (err) => this.onError(err));
      await this.state.storage.setAlarm(Date.now() + 30000);
    } catch (err) {
      console.error("WebSocket connection failed:", err.message);
      this.connected = false;
      this.scheduleReconnect(10000);
    }
  }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
    this.authenticated = false;
    this.subscribedEvents = false;
    this.subscribedRegistryEvents = false;
    this.statesReady = false;
    this.pingInFlight = false;
    for (const [id, p] of this.pending) { clearTimeout(p.timeout); p.reject(new Error("Disconnected")); }
    this.pending.clear();
  }

  async scheduleReconnect(delayMs) {
    try { await this.state.storage.setAlarm(Date.now() + delayMs); } catch {}
  }

  onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case "auth_required":
        this.ws.send(JSON.stringify({ type: "auth", access_token: this.env.HA_TOKEN }));
        break;
      case "auth_ok":
        console.log("HA WebSocket authenticated! Version:", msg.ha_version);
        this.authenticated = true;
        this.connected = true;
        this.connectAttempts = 0;
        this.fetchAllStates();
        this.subscribeToStateChanges();
        this.subscribeToRegistryEvents();
        this.subscribeToForensicEvents();
        // Backfill state changes missed during WS disconnect, bounded to 1h.
        this.state.storage.get("last_event_seen_ms").then((sinceMs) => {
          if (sinceMs && Date.now() - sinceMs < 3600000) {
            this._backfillStateChangesFromHA(sinceMs).catch((err) =>
              console.error("backfill failed:", err.message));
          }
        }).catch(() => {});
        break;
      case "auth_invalid":
        console.error("HA WebSocket auth FAILED:", msg.message);
        this.authenticated = false;
        this.connected = false;
        break;
      case "event":
        this.onEvent(msg.event);
        break;
      case "result":
        this.resolveCommand(msg);
        break;
      case "pong":
        this.pingInFlight = false;
        this.lastPongAt = Date.now();
        break;
    }
  }

  onEvent(event) {
    if (event.event_type === "entity_registry_updated" && event.data) {
      this.handleEntityRegistryUpdated(event.data).catch((err) => {
        console.error("entity_registry_updated handler:", err.message);
      });
      return;
    }
    if (event.event_type === "device_registry_updated" && event.data) {
      this.handleDeviceRegistryUpdated(event.data).catch((err) => {
        console.error("device_registry_updated handler:", err.message);
      });
      return;
    }
    if (event.event_type === "automation_triggered" && event.data) {
      const ctx = event.context || {};
      const { fired_at_ms, fired_at_iso, fired_at_central } =
        HAWebSocketV6._tsFromMs(Date.parse(event.time_fired) || Date.now());
      this._writeAutomationRunToD1({
        automation_id: event.data.entity_id || null,
        automation_name: event.data.name || null,
        fired_at_ms,
        fired_at_iso,
        fired_at_central,
        trigger_entity_id: this._extractTriggerEntity(event.data.source),
        trigger_description: event.data.source || null,
        context_id: ctx.id || null,
        context_parent_id: ctx.parent_id || null,
        result: "ran"
      }).catch((err) => console.error("automation_run write:", err.message));
      this._touchLastEventSeen(fired_at_ms);
      return;
    }
    if (event.event_type === "call_service" && event.data) {
      const ctx = event.context || {};
      const { fired_at_ms, fired_at_iso, fired_at_central } =
        HAWebSocketV6._tsFromMs(Date.parse(event.time_fired) || Date.now());
      const targets = event.data.service_data ? event.data.service_data.entity_id : null;
      const targetIds = Array.isArray(targets) ? targets.join(",") : (targets || null);
      this._writeServiceCallToD1({
        domain: event.data.domain,
        service: event.data.service,
        service_data_json: JSON.stringify(event.data.service_data || {}),
        target_entity_ids: targetIds,
        fired_at_ms,
        fired_at_iso,
        fired_at_central,
        context_id: ctx.id || null,
        context_parent_id: ctx.parent_id || null,
        context_user_id: ctx.user_id || null
      }).catch((err) => console.error("service_call write:", err.message));
      this._touchLastEventSeen(fired_at_ms);
      return;
    }
    if (event.event_type === "state_changed" && event.data) {
      const newState = event.data.new_state;
      const oldState = event.data.old_state;

      if (newState) {
        this.stateCache.set(newState.entity_id, newState);
      } else if (event.data.entity_id) {
        this.stateCache.delete(event.data.entity_id);
      }

      const persistNow = Date.now();
      if (persistNow - this.lastSnapshotPersist > 60000) {
        this.lastSnapshotPersist = persistNow;
        this._persistStateSnapshot();
      }

      // Forensic log: unconditional D1 write for every meaningful state
      // transition. _shouldLogStateChange filters Zigbee/network noise only;
      // every real transition lands in the state_changes table.
      if (newState && oldState && newState.state !== oldState.state) {
        const { fired_at_ms, fired_at_iso, fired_at_central } =
          HAWebSocketV6._tsFromMs(
            Date.parse(newState.last_changed || newState.last_updated) || Date.now()
          );
        this._touchLastEventSeen(fired_at_ms);
        if (this._shouldLogStateChange(newState.entity_id, newState)) {
          const ctx = event.context || event.data.context || {};
          this._writeStateChangeToD1({
            entity_id: newState.entity_id,
            friendly_name: (newState.attributes || {}).friendly_name || null,
            domain: newState.entity_id.split(".")[0],
            old_state: oldState.state,
            new_state: newState.state,
            attributes_json: this._shouldStoreAttributes(newState.entity_id) ? JSON.stringify(newState.attributes || {}) : null,
            fired_at_ms,
            fired_at_iso,
            fired_at_central,
            context_id: ctx.id || null,
            context_parent_id: ctx.parent_id || null,
            context_user_id: ctx.user_id || null,
            source: "ws"
          }).catch((err) => console.error("state_change write:", err.message));
        }
      }
    }
  }

  onClose() {
    console.log("HA WebSocket closed");
    this.connected = false;
    this.authenticated = false;
    this.subscribedEvents = false;
    this.subscribedRegistryEvents = false;
    this.subscribedForensicEvents = false;
    this.statesReady = false;
    this.pingInFlight = false;
    this.ws = null;
    this.scheduleReconnect(5000);
  }

  onError(err) {
    console.error("HA WebSocket error:", err);
    this.connected = false;
  }

  sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.authenticated) { reject(new Error("WebSocket not connected")); return; }
      const id = this.msgId++;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error("Command timed out")); }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ ...command, id }));
    });
  }

  resolveCommand(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timeout);
    this.pending.delete(msg.id);
    if (msg.success) { p.resolve(msg); } else { p.reject(new Error(msg.error?.message || "Command failed")); }
  }

  async fetchAllStates() {
    try {
      const result = await this.sendCommand({ type: "get_states" });
      if (result && Array.isArray(result.result)) {
        this.stateCache.clear();
        for (const state of result.result) { this.stateCache.set(state.entity_id, state); }
        this.statesReady = true;
        console.log("Real-time cache loaded:", this.stateCache.size, "entities");
        await this._persistStateSnapshot();
      }
    } catch (err) { console.error("Failed to fetch states:", err.message); }
  }

  _serializeStateCacheForSnapshot() {
    const out = [];
    for (const [id, s] of this.stateCache) {
      const domain = id.split(".")[0];
      if (!HAWebSocketV6.SNAPSHOT_DOMAIN_ALLOWLIST.has(domain)) continue;
      if (s.state === "unavailable" || s.state === "unknown") continue;
      if (domain === "switch" && isNoisySwitch(id)) continue;

      const attrs = s.attributes || {};
      if (domain === "sensor") {
        const deviceClass = attrs.device_class || "";
        if (HAWebSocketV6.SENSOR_WHITELIST.has(deviceClass)) {
          // keep
        } else if (deviceClass === "battery") {
          const pct = parseFloat(s.state);
          if (isNaN(pct) || pct > HAWebSocketV6.BATTERY_LOW_THRESHOLD) continue;
        } else {
          continue;
        }
      }

      const filteredAttrs = {};
      for (const k of HAWebSocketV6.SNAPSHOT_ATTR_ALLOWLIST) {
        if (attrs[k] !== undefined) {
          filteredAttrs[k] = attrs[k];
        }
      }
      out.push({
        entity_id: id,
        state: s.state,
        last_changed: s.last_changed,
        attributes: filteredAttrs
      });
    }
    return { cached_at: Date.now(), entities: out };
  }

  async _persistStateSnapshot() {
    try {
      const snapshot = this._serializeStateCacheForSnapshot();
      const json = JSON.stringify(snapshot);
      // DO storage hard limit is 128 KiB (131072 bytes); leave a margin so
      // metadata overhead can't push the put over. Above the cap we log a
      // warning but still attempt — silently dropping the snapshot is worse
      // than a put-exception we'll catch and log below.
      if (json.length > 127000) {
        this.logAI("snapshot_oversize",
          `Snapshot ${json.length} bytes — over 127KB cap, attempting put anyway`,
          { size: json.length });
      }
      await this.state.storage.put("state_cache_snapshot", snapshot);
    } catch (err) {
      this.logAI("snapshot_persist_error", err.message, { error: err.message });
    }
  }

  async _restoreStateSnapshot() {
    try {
      const snapshot = await this.state.storage.get("state_cache_snapshot");
      if (!snapshot || !Array.isArray(snapshot.entities)) return 0;
      for (const e of snapshot.entities) {
        this.stateCache.set(e.entity_id, {
          entity_id: e.entity_id,
          state: e.state,
          last_changed: e.last_changed,
          attributes: e.attributes || {},
          _fromSnapshot: true,
          _snapshotAge: Date.now() - snapshot.cached_at
        });
      }
      this.logAI("snapshot_restored",
        `${snapshot.entities.length} entities, age ${Date.now() - snapshot.cached_at}ms`,
        { entity_count: snapshot.entities.length,
          age_ms: Date.now() - snapshot.cached_at });
      return snapshot.entities.length;
    } catch (err) {
      this.logAI("snapshot_restore_error", err.message, { error: err.message });
      return 0;
    }
  }

  async subscribeToStateChanges() {
    if (this.subscribedEvents) return;
    try {
      await this.sendCommand({ type: "subscribe_events", event_type: "state_changed" });
      this.subscribedEvents = true;
      console.log("Subscribed to state_changed events");
    } catch (err) { console.error("Failed to subscribe:", err.message); }
  }

  // ========================================================================
  // Registry event subscriptions — keep the unified knowledge index in sync
  // with HA entity/device registry changes. Each event triggers a per-kind
  // re-embed via reembedRefs. Skips silently if AI or KNOWLEDGE is unbound.
  // ========================================================================
  async subscribeToRegistryEvents() {
    if (this.subscribedRegistryEvents) return;
    if (!this.env.AI || !this.env.KNOWLEDGE) return;
    try {
      await this.sendCommand({ type: "subscribe_events", event_type: "entity_registry_updated" });
      await this.sendCommand({ type: "subscribe_events", event_type: "device_registry_updated" });
      this.subscribedRegistryEvents = true;
      console.log("Subscribed to entity_registry_updated and device_registry_updated events");
    } catch (err) {
      console.error("Failed to subscribe to registry events:", err.message);
    }
  }

  // ========================================================================
  // Forensic event subscriptions (Deploy 1). Captures automation_triggered
  // and call_service events so every fire and every service invocation lands
  // in D1 with HA context-chain links preserved.
  // ========================================================================
  async subscribeToForensicEvents() {
    if (this.subscribedForensicEvents) return;
    if (!this.env.DB) return;
    try {
      await this.sendCommand({ type: "subscribe_events", event_type: "automation_triggered" });
      await this.sendCommand({ type: "subscribe_events", event_type: "call_service" });
      this.subscribedForensicEvents = true;
      console.log("Subscribed to automation_triggered and call_service events");
    } catch (err) {
      console.error("Failed to subscribe to forensic events:", err.message);
    }
  }

  // Permissive filter for the forensic log: every real state transition is
  // worth recording, only Zigbee/network noise and high-frequency power-meter
  // ticks with no diagnostic value get dropped.
  _shouldLogStateChange(entityId, newState) {
    const attr = newState.attributes || {};
    const deviceClass = attr.device_class || "";
    const unit = String(attr.unit_of_measurement || "").toLowerCase();
    // Strip trailing _<digits> suffix that HA appends to duplicate entity IDs
    // (e.g. sensor.foo_lqi_2). Without this strip the suffix match misses.
    const lcId = String(entityId).toLowerCase().replace(/_\d+$/, "");

    // Domain-level skip: image.* entities expose their last-update timestamp
    // as state, churning every few seconds with no causal meaning.
    if (lcId.startsWith("image.")) return false;

    const DENY_SUFFIX = [
      "_lqi", "_signal_strength", "_rssi", "_bssid", "_ssid",
      "_last_update_trigger", "_audio_output", "_link_quality"
    ];
    if (DENY_SUFFIX.some((s) => lcId.endsWith(s))) return false;

    if (deviceClass === "signal_strength") return false;

    if (unit === "dbm" || unit === "db" || unit === "lqi") return false;

    // Hard denylist: monotonic counters and per-device diagnostic ticks that
    // belong in InfluxDB, not the forensic log. Never causally interesting.
    const HARD_DENY_SUFFIX = [
      "_summation_delivered", "_summation_received",
      // Roborock cleaning-session telemetry — fine-grained progress ticks
      // multiple times/minute during a clean. The vacuum.* state carries
      // the causal signal.
      "_cleaning_area", "_cleaning_time", "_cleaning_progress",
      "_filter_time_left", "_main_brush_time_left", "_side_brush_time_left",
      "_dock_strainer_time_left", "_sensor_dirty_time_left"
    ];
    if (HARD_DENY_SUFFIX.some((s) => lcId.endsWith(s))) return false;

    // Numeric deadband: suppress high-frequency ticks where the delta is too
    // small to be causally interesting. Non-numeric states always pass.
    const rawVal = parseFloat(newState.state);
    if (isFinite(rawVal)) {
      let threshold = null;
      if (deviceClass === "power" || unit === "w") {
        threshold = 50;
      } else if (deviceClass === "energy" || unit === "kwh") {
        threshold = 0.01;
      } else if (deviceClass === "voltage" || unit === "v") {
        // ±1V jitter on 120V mains is meaningless; 0V → 120V (power cycle)
        // is a 120V delta and passes.
        threshold = 2;
      } else if (deviceClass === "humidity" || unit === "%") {
        threshold = 2;
      } else if (deviceClass === "temperature") {
        threshold = 0.5;
      } else if (deviceClass === "illuminance") {
        // Relative 10% change threshold for illuminance (lux spans wide range).
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

  // Store full attribute payload only for domains where attributes are
  // forensically useful (lock latch state, cover position, climate setpoints,
  // etc.). For sensors and switches: null saves D1 space.
  _shouldStoreAttributes(entityId) {
    const domain = String(entityId).split(".")[0];
    switch (domain) {
      case "lock":
      case "cover":
      case "climate":
      case "light":
      case "binary_sensor":
      case "person":
      case "device_tracker":
      case "alarm_control_panel":
      case "media_player":
        return true;
      default:
        return false;
    }
  }

  // Parse automation_triggered.source into a triggering entity_id where
  // possible. HA emits strings like "state of binary_sensor.front_door",
  // "time pattern /1", etc. Returns null when no entity is identifiable.
  _extractTriggerEntity(source) {
    if (typeof source !== "string") return null;
    const m = /state of ([a-z_]+\.[a-z0-9_]+)/i.exec(source);
    return m ? m[1] : null;
  }

  // Update the reconnect-backfill cursor. In-memory value is live; the
  // persisted copy refreshes every 30s to keep DO storage writes coarse.
  _touchLastEventSeen(ms) {
    this._lastEventSeenMs = ms;
    const now = Date.now();
    if (now - this._lastEventSeenPersistAt > 30000) {
      this._lastEventSeenPersistAt = now;
      this.state.storage.put("last_event_seen_ms", ms).catch(() => {});
    }
  }

  _recordD1WriteFailure(err) {
    this._d1WriteFailures.total++;
    this._d1WriteFailures.last_error_iso = new Date().toISOString();
    this._d1WriteFailures.last_error_msg = String(err && err.message ? err.message : err).slice(0, 200);
  }

  // Fire-and-forget D1 writes for the three forensic tables. Failures
  // increment the observability counter but never throw — the WS handler
  // must not block on D1.
  async _writeStateChangeToD1(row) {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO state_changes
         (entity_id, friendly_name, domain, old_state, new_state, attributes_json,
          fired_at_ms, fired_at_iso, fired_at_central,
          context_id, context_parent_id, context_user_id, source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
      ).bind(
        row.entity_id, row.friendly_name, row.domain, row.old_state, row.new_state, row.attributes_json,
        row.fired_at_ms, row.fired_at_iso, row.fired_at_central,
        row.context_id, row.context_parent_id, row.context_user_id, row.source
      ).run();
    } catch (err) {
      this._recordD1WriteFailure(err);
    }
  }

  async _writeAutomationRunToD1(row) {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(
        `INSERT INTO automation_runs
         (automation_id, automation_name, fired_at_ms, fired_at_iso, fired_at_central,
          trigger_entity_id, trigger_description,
          context_id, context_parent_id, result)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        row.automation_id, row.automation_name,
        row.fired_at_ms, row.fired_at_iso, row.fired_at_central,
        row.trigger_entity_id, row.trigger_description,
        row.context_id, row.context_parent_id, row.result
      ).run();
    } catch (err) {
      this._recordD1WriteFailure(err);
    }
  }

  async _writeServiceCallToD1(row) {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(
        `INSERT INTO service_calls
         (domain, service, service_data_json, target_entity_ids,
          fired_at_ms, fired_at_iso, fired_at_central,
          context_id, context_parent_id, context_user_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        row.domain, row.service, row.service_data_json, row.target_entity_ids,
        row.fired_at_ms, row.fired_at_iso, row.fired_at_central,
        row.context_id, row.context_parent_id, row.context_user_id
      ).run();
    } catch (err) {
      this._recordD1WriteFailure(err);
    }
  }

  // Backfill state changes that were missed while the WS was disconnected.
  // Bounded to a 1-hour window — multi-hour outages are operational issues
  // and shouldn't flood D1. Pulled from HA's REST history endpoint, which
  // does not preserve context_id, so backfilled rows have context_id = null
  // and source = 'backfill'.
  async _backfillStateChangesFromHA(sinceMs) {
    if (!this.env.HA_URL || !this.env.HA_TOKEN || !this.env.DB) return;
    const sinceIso = new Date(sinceMs).toISOString();
    const haUrl = this.env.HA_URL.replace(/\/$/, "");
    const url = `${haUrl}/api/history/period/${encodeURIComponent(sinceIso)}?minimal_response&significant_changes_only=false`;
    let groups;
    try {
      const resp = await fetch(url, {
        headers: { Authorization: "Bearer " + this.env.HA_TOKEN }
      });
      if (!resp.ok) {
        console.error(`backfill: HA history returned ${resp.status}`);
        return;
      }
      groups = await resp.json();
    } catch (err) {
      console.error("backfill: fetch failed:", err.message);
      return;
    }
    if (!Array.isArray(groups)) return;

    let written = 0;
    let skipped = 0;
    for (const group of groups) {
      if (!Array.isArray(group) || group.length < 2) continue;
      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1];
        const curr = group[i];
        if (!prev || !curr) continue;
        if (prev.state === curr.state) continue;
        const ts = curr.last_changed || curr.last_updated;
        if (!ts) continue;
        const tsMs = Date.parse(ts);
        if (isNaN(tsMs) || tsMs <= sinceMs) { skipped++; continue; }
        const entityId = curr.entity_id || prev.entity_id;
        if (!entityId) continue;
        if (!this._shouldLogStateChange(entityId, { attributes: curr.attributes || {} })) {
          skipped++;
          continue;
        }
        this._writeStateChangeToD1({
          entity_id: entityId,
          friendly_name: ((curr.attributes || {}).friendly_name) || null,
          domain: entityId.split(".")[0],
          old_state: prev.state,
          new_state: curr.state,
          attributes_json: this._shouldStoreAttributes(entityId) ? JSON.stringify(curr.attributes || {}) : null,
          fired_at_ms: tsMs,
          fired_at_iso: new Date(tsMs).toISOString(),
          fired_at_central: HAWebSocketV6._formatTimelineTimestamp(new Date(tsMs).toISOString()),
          context_id: null,
          context_parent_id: null,
          context_user_id: null,
          source: "backfill"
        }).catch(() => {});
        written++;
      }
    }
    console.log(`backfill: wrote ${written} rows since ${sinceIso} (skipped ${skipped})`);
    this.logAI("backfill_complete", `Backfilled ${written} state changes since ${sinceIso}`,
      { written, skipped, since_ms: sinceMs });
  }

  // ========================================================================
  // Forensic query tools (Deploy 2). Back both the native tool dispatcher and
  // the MCP HTTP routes — single implementation per helper, two surfaces.
  // ========================================================================

  // Parse a time reference into ms-since-epoch. Accepts:
  //   - "NOW-30m" / "NOW-2h" / "NOW-7d" / "NOW-90s" / "NOW"
  //   - ISO 8601 strings (with or without timezone offset)
  // Falls back to `defaultMs` on unparseable input.
  _parseTimeRefToMs(s, defaultMs) {
    if (s == null || s === "") return defaultMs;
    const str = String(s).trim();
    const rel = /^NOW(?:-(\d+)(s|m|h|d))?$/i.exec(str);
    if (rel) {
      if (!rel[1]) return Date.now();
      const n = parseInt(rel[1], 10);
      const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[rel[2].toLowerCase()];
      return Date.now() - n * mult;
    }
    const p = Date.parse(str);
    return isNaN(p) ? defaultMs : p;
  }

  async _executeQueryStateHistory(args) {
    if (!this.env.DB) return { error: "DB not bound" };
    const now = Date.now();
    const sinceMs = this._parseTimeRefToMs(args.since, now - 86400000);
    const untilMs = this._parseTimeRefToMs(args.until, now);
    const limit = Math.min(Math.max(parseInt(args.limit || 50, 10) || 50, 1), 500);

    const wheres = ["fired_at_ms >= ?", "fired_at_ms <= ?"];
    const binds = [sinceMs, untilMs];
    if (args.entity_id) { wheres.push("entity_id = ?"); binds.push(String(args.entity_id)); }
    if (args.entity_id_like) { wheres.push("entity_id LIKE ?"); binds.push(String(args.entity_id_like)); }
    if (args.domain) { wheres.push("domain = ?"); binds.push(String(args.domain)); }
    if (args.new_state) { wheres.push("new_state = ?"); binds.push(String(args.new_state)); }

    const sql = `SELECT entity_id, friendly_name, domain, old_state, new_state, attributes_json,
                        fired_at_ms, fired_at_central, context_id, context_parent_id, context_user_id, source
                 FROM state_changes
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY fired_at_ms DESC
                 LIMIT ?`;
    binds.push(limit + 1); // +1 to detect truncation

    try {
      const result = await this.env.DB.prepare(sql).bind(...binds).all();
      const rows = result?.results || [];
      const truncated = rows.length > limit;
      if (truncated) rows.pop();
      return {
        rows,
        row_count: rows.length,
        truncated,
        query_summary: `state_changes from ${new Date(sinceMs).toISOString()} to ${new Date(untilMs).toISOString()}, limit ${limit}`
      };
    } catch (err) {
      return { error: "query_state_history failed: " + err.message };
    }
  }

  async _executeQueryAutomationRuns(args) {
    if (!this.env.DB) return { error: "DB not bound" };
    const now = Date.now();
    const sinceMs = this._parseTimeRefToMs(args.since, now - 86400000);
    const untilMs = this._parseTimeRefToMs(args.until, now);
    const limit = Math.min(Math.max(parseInt(args.limit || 50, 10) || 50, 1), 500);

    const wheres = ["fired_at_ms >= ?", "fired_at_ms <= ?"];
    const binds = [sinceMs, untilMs];
    if (args.automation_id) { wheres.push("automation_id = ?"); binds.push(String(args.automation_id)); }
    if (args.automation_id_like) { wheres.push("automation_id LIKE ?"); binds.push(String(args.automation_id_like)); }
    if (args.trigger_entity_id) { wheres.push("trigger_entity_id = ?"); binds.push(String(args.trigger_entity_id)); }

    const sql = `SELECT automation_id, automation_name, fired_at_ms, fired_at_central,
                        trigger_entity_id, trigger_description, context_id, context_parent_id, result
                 FROM automation_runs
                 WHERE ${wheres.join(" AND ")}
                 ORDER BY fired_at_ms DESC
                 LIMIT ?`;
    binds.push(limit + 1);

    try {
      const result = await this.env.DB.prepare(sql).bind(...binds).all();
      const rows = result?.results || [];
      const truncated = rows.length > limit;
      if (truncated) rows.pop();
      return {
        rows,
        row_count: rows.length,
        truncated,
        query_summary: `automation_runs from ${new Date(sinceMs).toISOString()} to ${new Date(untilMs).toISOString()}, limit ${limit}`
      };
    } catch (err) {
      return { error: "query_automation_runs failed: " + err.message };
    }
  }

  // Iterative chain walker rather than a single recursive CTE — simpler to
  // reason about, easier to depth-limit, and each iteration is one D1 query
  // (max 1+depth+depth = 11 round-trips at depth=5 worst case, well-bounded).
  async _executeQueryCausalChain(args) {
    if (!this.env.DB) return { error: "DB not bound" };
    if (!args.context_id || typeof args.context_id !== "string") {
      return { error: "context_id is required" };
    }
    const direction = (args.direction || "both").toLowerCase();
    if (!["forward", "backward", "both"].includes(direction)) {
      return { error: "direction must be 'forward', 'backward', or 'both'" };
    }
    const depth = Math.min(Math.max(parseInt(args.depth || 5, 10) || 5, 1), 10);
    const ctxId = String(args.context_id);

    const visited = new Set([ctxId]);
    const collected = [];

    const fetchByContext = async (ctxIds, column) => {
      if (!ctxIds.length) return [];
      const placeholders = ctxIds.map(() => "?").join(",");
      const sql = `
        SELECT 'state_change' AS kind, context_id, context_parent_id, fired_at_ms, fired_at_central,
               entity_id AS subject, (COALESCE(old_state,'?')||' -> '||COALESCE(new_state,'?')) AS detail
          FROM state_changes WHERE ${column} IN (${placeholders})
        UNION ALL
        SELECT 'automation_run' AS kind, context_id, context_parent_id, fired_at_ms, fired_at_central,
               COALESCE(automation_name, automation_id, '(unnamed)') AS subject,
               COALESCE(trigger_description, '') AS detail
          FROM automation_runs WHERE ${column} IN (${placeholders})
        UNION ALL
        SELECT 'service_call' AS kind, context_id, context_parent_id, fired_at_ms, fired_at_central,
               (domain||'.'||service) AS subject,
               COALESCE(target_entity_ids, '') AS detail
          FROM service_calls WHERE ${column} IN (${placeholders})
        ORDER BY fired_at_ms ASC
        LIMIT 200`;
      const binds = [...ctxIds, ...ctxIds, ...ctxIds];
      const result = await this.env.DB.prepare(sql).bind(...binds).all();
      return result?.results || [];
    };

    try {
      const seed = await fetchByContext([ctxId], "context_id");
      for (const r of seed) collected.push(r);

      if (direction === "forward" || direction === "both") {
        let frontier = [ctxId];
        for (let i = 0; i < depth && frontier.length > 0; i++) {
          const children = await fetchByContext(frontier, "context_parent_id");
          const next = [];
          for (const c of children) {
            collected.push(c);
            if (c.context_id && !visited.has(c.context_id)) {
              visited.add(c.context_id);
              next.push(c.context_id);
            }
          }
          frontier = next;
        }
      }

      if (direction === "backward" || direction === "both") {
        let frontier = [];
        for (const r of seed) {
          if (r.context_parent_id && !visited.has(r.context_parent_id)) {
            visited.add(r.context_parent_id);
            frontier.push(r.context_parent_id);
          }
        }
        for (let i = 0; i < depth && frontier.length > 0; i++) {
          const parents = await fetchByContext(frontier, "context_id");
          const next = [];
          for (const p of parents) {
            collected.push(p);
            if (p.context_parent_id && !visited.has(p.context_parent_id)) {
              visited.add(p.context_parent_id);
              next.push(p.context_parent_id);
            }
          }
          frontier = next;
        }
      }
    } catch (err) {
      return { error: "query_causal_chain failed: " + err.message };
    }

    // De-duplicate by (kind, context_id, fired_at_ms) and sort chronologically.
    const seen = new Set();
    const deduped = [];
    for (const r of collected) {
      const key = `${r.kind}|${r.context_id || ""}|${r.fired_at_ms}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(r);
      }
    }
    deduped.sort((a, b) => (a.fired_at_ms || 0) - (b.fired_at_ms || 0));

    return {
      rows: deduped,
      row_count: deduped.length,
      depth_walked: depth,
      direction,
      seed_context_id: ctxId,
      query_summary: `causal chain from ${ctxId} (${direction}, depth ${depth})`
    };
  }

  async handleEntityRegistryUpdated(data) {
    const action = data.action;
    const entityId = data.entity_id;
    if (!entityId) return;
    if (!this.env.AI || !this.env.KNOWLEDGE) return;

    try {
      if (action === "remove") {
        const vectorId = vectorIdFor("entity", entityId);
        await this.env.KNOWLEDGE.deleteByIds([vectorId]);
        this.logAI("vector_delete", `${entityId} removed from index`, { entity_id: entityId, action }, "vector_event");
        return;
      }
      const result = await this.reembedRefs({ kind: "entity", refIds: [entityId] });
      this.logAI(
        "vector_reembed",
        `${entityId} (${action}) — embedded=${result.embedded} skipped=${result.skipped} errors=${result.errors}`,
        { entity_id: entityId, action, ...result },
        "vector_event"
      );
    } catch (err) {
      this.logAI("vector_error", `entity_registry_updated ${entityId}: ${err.message}`, { entity_id: entityId, action }, "vector_event");
    }
  }

  async handleDeviceRegistryUpdated(data) {
    const action = data.action;
    const deviceId = data.device_id;
    if (!deviceId) return;
    if (!this.env.AI || !this.env.KNOWLEDGE) return;

    try {
      if (action === "remove") {
        // Delete the device's own kind=device vector. Per-entity
        // entity_registry_updated events will clean up the entities.
        const vectorId = vectorIdFor("device", deviceId);
        await this.env.KNOWLEDGE.deleteByIds([vectorId]);
        this.logAI("vector_delete", `device ${deviceId} removed from index`, { device_id: deviceId, action }, "vector_event");
        return;
      }
      if (action !== "update" && action !== "create") return;

      const entityRegRes = await this.sendCommand({ type: "config/entity_registry/list" });
      const entities = (entityRegRes && entityRegRes.result) || [];
      const affected = entities.filter((e) => e && e.device_id === deviceId).map((e) => e.entity_id);

      // Re-embed both the device's own kind=device doc AND the entities it
      // owns (their device_name field changes when the device is renamed).
      const [deviceResult, entityResult] = await Promise.all([
        this.reembedRefs({ kind: "device", refIds: [deviceId] }),
        affected.length > 0
          ? this.reembedRefs({ kind: "entity", refIds: affected })
          : Promise.resolve({ embedded: 0, errors: 0, skipped: 0 })
      ]);
      this.logAI(
        "vector_reembed",
        `device ${deviceId} (${action}) — device emb=${deviceResult.embedded}, ${affected.length} entities emb=${entityResult.embedded}`,
        {
          device_id: deviceId,
          action,
          device: deviceResult,
          entities: { count: affected.length, ...entityResult }
        },
        "vector_event"
      );
    } catch (err) {
      this.logAI("vector_error", `device_registry_updated ${deviceId}: ${err.message}`, { device_id: deviceId, action }, "vector_event");
    }
  }

  // Per-kind doc builders for incremental re-embed. Pull HA registries via
  // the WebSocket (cheaper than a REST round-trip from the DO), then assemble
  // the canonical-schema doc for each ref. Match worker.js's backfill output
  // shape so skip-by-hash works identically across both code paths.
  async _buildEntityDocsForRefs(entityIds) {
    if (!Array.isArray(entityIds) || entityIds.length === 0) return [];
    const [entityRegRes, deviceRegRes, areaRegRes] = await Promise.all([
      this.sendCommand({ type: "config/entity_registry/list" }),
      this.sendCommand({ type: "config/device_registry/list" }),
      this.sendCommand({ type: "config/area_registry/list" })
    ]);
    const entityReg = (entityRegRes && entityRegRes.result) || [];
    const deviceReg = (deviceRegRes && deviceRegRes.result) || [];
    const areaReg = (areaRegRes && areaRegRes.result) || [];

    const areaById = new Map();
    for (const a of areaReg) if (a && a.area_id) areaById.set(a.area_id, a.name || "");
    const deviceById = new Map();
    for (const d of deviceReg) {
      if (d && d.id) {
        deviceById.set(d.id, { name: d.name_by_user || d.name || "", area_id: d.area_id || null });
      }
    }
    const entityById = new Map();
    for (const e of entityReg) if (e && e.entity_id) entityById.set(e.entity_id, e);

    const docs = [];
    for (const entityId of entityIds) {
      const e = entityById.get(entityId);
      if (!e) continue;
      const domain = entityId.split(".")[0] || "";
      const state = this.stateCache.get(entityId);
      const dev = e.device_id ? deviceById.get(e.device_id) : null;
      const areaId = e.area_id || (dev && dev.area_id) || null;
      const area = areaId ? (areaById.get(areaId) || "") : "";
      const friendly_name =
        (state && state.attributes && state.attributes.friendly_name) ||
        e.name || e.original_name || entityId;
      const device_class = (state && state.attributes && state.attributes.device_class) || "";
      const device_name = (dev && dev.name) || "";
      const aliases = Array.isArray(e.aliases) ? e.aliases : [];

      const text = buildEntityEmbedText({
        friendly_name, entity_id: entityId, area, device_name, domain, device_class, aliases
      });
      const hash = fnv1aHex(text);
      const ref_id = entityId;
      const vector_id = vectorIdFor("entity", ref_id);
      const category = entityCategoryFor(e, state);
      const noisy = isNoisyEntity(e, state);

      docs.push({
        kind: "entity", ref_id, vector_id, text, hash,
        metadata: buildMetadata({
          kind: "entity", ref_id, friendly_name, domain, area,
          entity_category: category, is_noisy: noisy, topic_tag: "", hash,
          extra: { device_class }
        })
      });
    }
    return docs;
  }

  async _buildDeviceDocsForRefs(deviceIds) {
    if (!Array.isArray(deviceIds) || deviceIds.length === 0) return [];
    const [deviceRegRes, areaRegRes, entityRegRes] = await Promise.all([
      this.sendCommand({ type: "config/device_registry/list" }),
      this.sendCommand({ type: "config/area_registry/list" }),
      this.sendCommand({ type: "config/entity_registry/list" })
    ]);
    const deviceReg = (deviceRegRes && deviceRegRes.result) || [];
    const areaReg = (areaRegRes && areaRegRes.result) || [];
    const entityReg = (entityRegRes && entityRegRes.result) || [];

    const areaById = new Map();
    for (const a of areaReg) if (a && a.area_id) areaById.set(a.area_id, a.name || "");
    const deviceById = new Map();
    for (const d of deviceReg) if (d && d.id) deviceById.set(d.id, d);

    const entitiesByDevice = new Map();
    for (const e of entityReg) {
      if (!e || !e.device_id) continue;
      let bucket = entitiesByDevice.get(e.device_id);
      if (!bucket) { bucket = []; entitiesByDevice.set(e.device_id, bucket); }
      bucket.push(e.entity_id);
    }

    const docs = [];
    for (const deviceId of deviceIds) {
      const d = deviceById.get(deviceId);
      if (!d) continue;
      const ref_id = deviceId;
      const friendly_name = d.name_by_user || d.name || ref_id;
      const area = d.area_id ? (areaById.get(d.area_id) || "") : "";
      const ents = entitiesByDevice.get(ref_id) || [];

      const text = buildDeviceEmbedText({
        name: friendly_name,
        manufacturer: d.manufacturer || "",
        model: d.model || "",
        area,
        entity_count: ents.length,
        sample_entities: ents.slice(0, 5)
      });
      const hash = fnv1aHex(text);
      const vector_id = vectorIdFor("device", ref_id);

      docs.push({
        kind: "device", ref_id, vector_id, text, hash,
        metadata: buildMetadata({
          kind: "device", ref_id, friendly_name, domain: "device", area,
          entity_category: "primary", is_noisy: false, topic_tag: "", hash
        })
      });
    }
    return docs;
  }

  // Skip-by-hash + batched embed + upsert. Shared across all incremental
  // paths (entity/device re-embed, single-doc write-through). Returns
  // {embedded, errors, skipped}.
  async _embedAndUpsertDocs(docs) {
    if (!Array.isArray(docs) || docs.length === 0) {
      return { embedded: 0, errors: 0, skipped: 0 };
    }
    if (!this.env.AI || !this.env.KNOWLEDGE) {
      return { embedded: 0, errors: docs.length, skipped: 0 };
    }

    const existingHash = new Map();
    if (typeof this.env.KNOWLEDGE.getByIds === "function") {
      const LOOKUP_BATCH = 20;
      for (let i = 0; i < docs.length; i += LOOKUP_BATCH) {
        const slice = docs.slice(i, i + LOOKUP_BATCH).map((d) => d.vector_id);
        try {
          const existing = await this.env.KNOWLEDGE.getByIds(slice);
          if (Array.isArray(existing)) {
            for (const v of existing) {
              if (v && v.id && v.metadata && v.metadata.hash) existingHash.set(v.id, v.metadata.hash);
            }
          }
        } catch {
          existingHash.clear();
          break;
        }
      }
    }

    const toEmbed = docs.filter((d) => existingHash.get(d.vector_id) !== d.hash);
    const skipped = docs.length - toEmbed.length;
    if (toEmbed.length === 0) return { embedded: 0, errors: 0, skipped };

    const EMBED_BATCH = 50;
    let errors = 0;
    const pending = [];

    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const slice = toEmbed.slice(i, i + EMBED_BATCH);
      let aiResult;
      try {
        aiResult = await this.env.AI.run("@cf/baai/bge-large-en-v1.5", {
          text: slice.map((d) => d.text),
          pooling: "cls"
        });
      } catch {
        errors += slice.length;
        continue;
      }
      const vectors = aiResult && aiResult.data;
      if (!Array.isArray(vectors) || vectors.length !== slice.length) {
        errors += slice.length;
        continue;
      }
      for (let j = 0; j < slice.length; j++) {
        const v = vectors[j];
        if (!Array.isArray(v) || v.length !== 1024) {
          errors++;
          continue;
        }
        pending.push({ id: slice[j].vector_id, values: v, metadata: slice[j].metadata });
      }
    }

    let embedded = 0;
    if (pending.length > 0) {
      try {
        await this.env.KNOWLEDGE.upsert(pending);
        embedded = pending.length;
      } catch {
        errors += pending.length;
      }
    }

    return { embedded, errors, skipped };
  }

  // Generalized re-embed entry point. Currently supports kind=entity and
  // kind=device — the other kinds use either write-through (memory,
  // observation) or the worker-side nightly cron (automation, script,
  // scene, area, service).
  async reembedRefs({ kind, refIds }) {
    if (!this.env.AI || !this.env.KNOWLEDGE) return { embedded: 0, errors: 0, skipped: 0 };
    if (!Array.isArray(refIds) || refIds.length === 0) return { embedded: 0, errors: 0, skipped: 0 };

    let docs = [];
    if (kind === "entity") docs = await this._buildEntityDocsForRefs(refIds);
    else if (kind === "device") docs = await this._buildDeviceDocsForRefs(refIds);
    else return { embedded: 0, errors: 0, skipped: 0 };

    return await this._embedAndUpsertDocs(docs);
  }

  // Back-compat shim — still called by handleEntityRegistryUpdated and any
  // other legacy site that hasn't been migrated. Restricts to kind=entity.
  async reembedEntities(entityIds) {
    return await this.reembedRefs({ kind: "entity", refIds: entityIds });
  }

  // Build the per-doc memory record, matching the canonical schema. Used
  // by the write-through path in executeAIAction.
  _memoryDocFor(text) {
    if (typeof text !== "string" || !text) return null;
    const ref_id = fnv1aHex(text);
    const vector_id = vectorIdFor("memory", ref_id);
    const friendly_name = text.slice(0, 80);
    const embedText = buildMemoryEmbedText(text);
    const hash = fnv1aHex(embedText);
    return {
      kind: "memory", ref_id, vector_id, text: embedText, hash,
      metadata: buildMetadata({
        kind: "memory", ref_id, friendly_name,
        domain: "memory", area: "",
        entity_category: "primary", is_noisy: false,
        topic_tag: "", hash,
        created_at: new Date().toISOString()
      })
    };
  }

  async _migrateRetireAIObservationsKey() {
    try {
      const done = await this.state.storage.get("migration_ai_obs_retired");
      if (done) return;
      await this.state.storage.delete("ai_observations");
      await this.state.storage.put("migration_ai_obs_retired", true);
      this.logAI("migration", "Retired ai_observations DO storage key — D1 is now authoritative", {});
    } catch (err) {
      this.logAI("error", "migration_ai_obs_retired_failed", {
        error: String(err?.message || err),
      });
    }
  }

  async _migrateRetireAiLogKeys() {
    try {
      const done = await this.state.storage.get("migration_ai_log_retired");
      if (done) return;
      await this.state.storage.delete("ai_log").catch(() => {});
      await this.state.storage.delete("ai_log_head").catch(() => {});
      for (let i = 0; i < HAWebSocketV6.LOG_CHUNKS_MAX; i++) {
        await this.state.storage.delete("ai_log_chunk_" + i).catch(() => {});
        await this.state.storage.delete("ai_log_chunk_gen_" + i).catch(() => {});
      }
      await this.state.storage.put("migration_ai_log_retired", true);
      this.logAI("migration", "Retired ai_log DO storage keys (simple + chunked) — D1 is now authoritative", {});
    } catch (err) {
      console.error("ai_log migration:", err?.message || err);
    }
  }

  // Single-row write of one ai_log entry to D1. Fire-and-forget; D1 failure
  // pushes a d1_ai_log_write_failed entry directly to the in-memory ring
  // (NOT via logAI — avoids recursion).
  async _writeAiLogEntryToD1(entry) {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(
        `INSERT INTO ai_log (timestamp, type, message, data, source)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(
        entry.timestamp,
        entry.type,
        entry.message ?? null,
        entry.data !== undefined ? JSON.stringify(entry.data) : null,
        entry.source ?? null,
      ).run();
    } catch (err) {
      this.aiLog.push({
        type: "d1_ai_log_write_failed",
        message: String(err?.message || err),
        data: { original_type: entry.type, original_ts: entry.timestamp },
        timestamp: new Date().toISOString(),
      });
      if (this.aiLog.length > HAWebSocketV6.LOG_IN_MEMORY_CAP) {
        this.aiLog.splice(0, this.aiLog.length - HAWebSocketV6.LOG_IN_MEMORY_CAP);
      }
    }
  }

  // Load the most-recent N ai_log entries from D1, returned oldest-first to
  // match the in-memory ring's append order. Returns null on D1 failure so
  // callers can distinguish "empty table" from "D1 unavailable".
  async _loadAiLogFromD1(limit = 1000) {
    if (!this.env.DB) return null;
    try {
      const result = await this.env.DB.prepare(
        `SELECT timestamp, type, message, data, source
         FROM ai_log
         ORDER BY id DESC
         LIMIT ?1`
      ).bind(limit).all();
      const rows = result?.results || [];
      return rows.reverse().map((r) => {
        const entry = {
          type: r.type,
          message: r.message ?? "",
          timestamp: r.timestamp,
        };
        if (r.data) {
          try { entry.data = JSON.parse(r.data); } catch { entry.data = {}; }
        } else {
          entry.data = {};
        }
        if (r.source) entry.source = r.source;
        return entry;
      });
    } catch (err) {
      console.error("_loadAiLogFromD1:", err?.message || err);
      return null;
    }
  }

  async _loadObservationsFromD1(limit = 100) {
    if (!this.env.DB) return [];
    try {
      const result = await this.env.DB
        .prepare(`SELECT text FROM observations ORDER BY timestamp DESC LIMIT ?1`)
        .bind(limit)
        .all();
      const rows = result?.results || [];
      return rows.map((r) => r.text).filter((t) => typeof t === "string" && t);
    } catch (err) {
      this.logAI("error", "d1_load_observations_failed", {
        error: String(err?.message || err),
        limit,
      });
      return [];
    }
  }

  _observationDocFor(text) {
    if (typeof text !== "string" || !text) return null;
    const ref_id = topicTagFor(text);
    const vector_id = vectorIdFor("observation", ref_id);
    const friendly_name = text.slice(0, 80);
    const embedText = buildObservationEmbedText(text);
    const hash = fnv1aHex(embedText);
    const topic_tag = extractTopicTag(text);
    return {
      kind: "observation", ref_id, vector_id, text: embedText, hash,
      metadata: buildMetadata({
        kind: "observation", ref_id, friendly_name,
        domain: "observation", area: "",
        entity_category: "primary", is_noisy: false,
        topic_tag, hash,
        created_at: new Date().toISOString()
      })
    };
  }

  // Embed a single doc and upsert. Single-text variant of _embedAndUpsertDocs
  // for the memory/observation write-through path; throws so caller can log.
  async _embedAndUpsertSingle(doc) {
    if (!this.env.AI || !this.env.KNOWLEDGE) return;
    if (!doc || !doc.text || !doc.vector_id) return;
    const aiResult = await this.env.AI.run("@cf/baai/bge-large-en-v1.5", {
      text: [doc.text],
      pooling: "cls"
    });
    const v = aiResult && Array.isArray(aiResult.data) && aiResult.data[0];
    if (!Array.isArray(v) || v.length !== 1024) {
      throw new Error("embed returned malformed vector");
    }
    await this.env.KNOWLEDGE.upsert([{ id: doc.vector_id, values: v, metadata: doc.metadata }]);
  }

  async _deleteVectorIds(ids) {
    if (!this.env.KNOWLEDGE || !Array.isArray(ids) || ids.length === 0) return;
    await this.env.KNOWLEDGE.deleteByIds(ids);
  }

  // ========================================================================
  // Vectorize semantic search — query the unified `ha-knowledge` index with
  // optional metadata filters. CLS pooling is required: the index was built
  // with pooling:"cls"; using mean pooling here would compare vectors from a
  // different geometry and rank them nearly randomly. Returns [] on failure
  // so callers can fall back safely.
  //
  // Filters supported: kinds (one or more), domain, area, includeNoisy.
  // is_noisy is stored as the string "true"/"false" because the metadata
  // index is declared as --type=string. Vectorize V2 supports $in for
  // multi-kind queries; if the SDK rejects it for any reason, we fall back
  // to one query per kind and merge by score.
  // ========================================================================
  async retrieveKnowledge({ query, k = 15, kinds = null, domain = null, area = null, topic_tag = null, min_score = null, includeNoisy = false } = {}) {
    const start = Date.now();
    let safeKinds = null;
    if (Array.isArray(kinds) && kinds.length > 0) safeKinds = kinds;
    else if (typeof kinds === "string" && kinds.length > 0) safeKinds = [kinds];

    if (!this.env.AI || !this.env.KNOWLEDGE) {
      this.logAI("vector_query", "AI or KNOWLEDGE binding missing — returning []", {
        query_length: typeof query === "string" ? query.length : 0,
        count: 0,
        duration_ms: Date.now() - start
      }, "vector_query");
      return [];
    }
    if (typeof query !== "string" || query.length === 0) {
      this.logAI("vector_query", "empty query — returning []", {
        query_length: 0, count: 0, duration_ms: Date.now() - start
      }, "vector_query");
      return [];
    }

    const text = query.length > 2000 ? query.slice(0, 2000) : query;

    let aiResult;
    try {
      aiResult = await this.env.AI.run("@cf/baai/bge-large-en-v1.5", {
        text: [text],
        pooling: "cls"
      });
    } catch (err) {
      this.logAI("vector_query", "embed failed: " + err.message, {
        query_length: text.length, count: 0, duration_ms: Date.now() - start
      }, "vector_query");
      return [];
    }

    const queryVector = aiResult && Array.isArray(aiResult.data) && aiResult.data[0];
    if (!Array.isArray(queryVector) || queryVector.length !== 1024) {
      this.logAI("vector_query", "embed returned malformed vector", {
        query_length: text.length, count: 0, duration_ms: Date.now() - start
      }, "vector_query");
      return [];
    }

    const baseFilter = {};
    if (domain) baseFilter.domain = domain;
    // Area metadata is stored lowercase (see buildMetadata). Match-side
    // normalization makes 'Master Bedroom' / 'master bedroom' / 'MBR' all
    // resolve consistently against the index.
    if (area) baseFilter.area = String(area).toLowerCase().trim();
    // Topic tags are stored with surrounding brackets (extractTopicTag
    // captures the literal "[...]" form). Vectorize filter is exact-match,
    // so add brackets if the caller passed the bare form.
    if (topic_tag) {
      let t = String(topic_tag).trim();
      if (!t.startsWith("[")) t = "[" + t;
      if (!t.endsWith("]")) t = t + "]";
      baseFilter.topic_tag = t;
    }
    if (!includeNoisy) baseFilter.is_noisy = "false";

    // Over-fetch slightly so dedup + score floor + decay still leave room
    // for `k` real results. 2x with a 50 cap keeps Vectorize bills tame.
    // When client-side topic_tag filtering is active (Vectorize-side filter
    // is broken — see BUGS.md), bump to the cap so we don't miss matches
    // that aren't in the top-2k semantic neighborhood.
    const fetchK = topic_tag
      ? 50
      : Math.min(50, Math.max(k, k * 2));

    const buildFilter = (kindArr) => {
      const f = { ...baseFilter };
      if (kindArr && kindArr.length === 1) f.kind = kindArr[0];
      else if (kindArr && kindArr.length > 1) f.kind = { $in: kindArr };
      return f;
    };

    const callQuery = async (filter) => {
      const opts = { topK: fetchK, returnMetadata: true };
      if (Object.keys(filter).length > 0) opts.filter = filter;
      return await this.env.KNOWLEDGE.query(queryVector, opts);
    };

    let queryRes;
    try {
      queryRes = await callQuery(buildFilter(safeKinds));
    } catch (err) {
      // If $in isn't supported for kind, fall back to one query per kind
      // and merge by score. Cheap (small kinds list, vectorize is fast).
      const looksLikeInError = safeKinds && safeKinds.length > 1 &&
        /\$in|filter|operator/i.test(err && err.message ? err.message : "");
      if (looksLikeInError) {
        try {
          const merged = [];
          for (const kind of safeKinds) {
            const sub = await callQuery(buildFilter([kind]));
            if (sub && Array.isArray(sub.matches)) merged.push(...sub.matches);
          }
          merged.sort((a, b) => (b.score || 0) - (a.score || 0));
          queryRes = { matches: merged.slice(0, fetchK) };
          this.logAI("vector_query", "fell back to per-kind merge ($in not supported)", {
            kinds: safeKinds, query_length: text.length
          }, "vector_query");
        } catch (err2) {
          this.logAI("vector_query", "fallback multi-query failed: " + err2.message, {
            query_length: text.length, count: 0, duration_ms: Date.now() - start
          }, "vector_query");
          return [];
        }
      } else {
        this.logAI("vector_query", "knowledge query failed: " + err.message, {
          query_length: text.length, count: 0, duration_ms: Date.now() - start
        }, "vector_query");
        return [];
      }
    }

    const matches = (queryRes && Array.isArray(queryRes.matches)) ? queryRes.matches : [];
    // Client-side topic_tag filter — Vectorize-side filtering is silently
    // ignored on this index (see BUGS.md #vec-topic-tag-filter). Until that's
    // fixed at the platform level by recreating the metadata index, we
    // post-filter on the metadata returned with each match. Normalize by
    // stripping surrounding brackets so 'foo' and '[foo]' both match.
    const normalizeTag = (t) => String(t || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
    const wantTopicTag = topic_tag ? normalizeTag(topic_tag) : null;
    const out = [];
    for (const m of matches) {
      const md = m && m.metadata;
      if (!md || !md.kind || !md.ref_id) continue;
      if (wantTopicTag && normalizeTag(md.topic_tag) !== wantTopicTag) continue;
      out.push({
        kind: md.kind,
        ref_id: md.ref_id,
        friendly_name: md.friendly_name || "",
        domain: md.domain || md.kind,
        area: md.area || "",
        device_class: md.device_class || "",
        entity_category: md.entity_category || "primary",
        is_noisy: md.is_noisy === "true",
        topic_tag: md.topic_tag || "",
        created_at: md.created_at || "",
        score: typeof m.score === "number" ? m.score : null
      });
    }

    // Dedup by (kind, friendly_name) — keep highest score. Catches the
    // multi-ref_id-per-document case (legacy slug + canonical numeric id)
    // even after backfill cleanup, as a defensive layer.
    const seen = new Map();
    for (const r of out) {
      const dkey = r.kind + ":" + (r.friendly_name || "").toLowerCase();
      if (!dkey || !r.friendly_name) { seen.set(Symbol(), r); continue; }
      const prev = seen.get(dkey);
      if (!prev || (r.score || 0) > (prev.score || 0)) seen.set(dkey, r);
    }
    let final = Array.from(seen.values());

    // Time-decay: older observations rank lower. Scoring is multiplicative
    // and floored at 0.3 so very old observations still surface if they're
    // the only relevant hit. 0.005/day → ~14% decay over 30 days.
    const now = Date.now();
    for (const r of final) {
      if (r.kind === "observation" && r.created_at) {
        const ts = Date.parse(r.created_at);
        if (!isNaN(ts)) {
          const days = (now - ts) / 86400000;
          const decay = Math.max(0.3, 1 - 0.005 * Math.min(days, 60));
          r.score = (r.score || 0) * decay;
        }
      }
    }

    // State-aware boost: entities currently active or recently changed get
    // +0.05. Cap at 1.0 so it doesn't wreck downstream consumers expecting
    // cosine bounds. stateCache may not exist on every DO — guard.
    if (this.stateCache && typeof this.stateCache.get === "function") {
      for (const r of final) {
        if (r.kind !== "entity") continue;
        const s = this.stateCache.get(r.ref_id);
        if (!s) continue;
        const lastChangedTs = s.last_changed ? Date.parse(s.last_changed) : 0;
        const recent = lastChangedTs && (now - lastChangedTs) < 86400000;
        const live = s.state && !["unavailable", "unknown", "off"].includes(s.state);
        if (recent || live) r.score = Math.min(1, (r.score || 0) + 0.05);
      }
    }

    // Min-score floor — defaults to 0.50 (empirically the noise floor for
    // bge-large-en-v1.5 on this corpus). Caller can tighten with min_score.
    const effectiveFloor = typeof min_score === "number" ? min_score : 0.50;
    final = final.filter((r) => typeof r.score !== "number" || r.score >= effectiveFloor);

    final.sort((a, b) => (b.score || 0) - (a.score || 0));
    final = final.slice(0, k);

    this.logAI("vector_query", `returned ${final.length} matches for "${text.slice(0, 80)}"`, {
      query_length: text.length,
      count: final.length,
      raw_count: out.length,
      top_k: k,
      kinds: safeKinds,
      domain, area, topic_tag, min_score: effectiveFloor,
      include_noisy: !!includeNoisy,
      duration_ms: Date.now() - start
    }, "vector_query");
    return final;
  }

  // ========================================================================
  // MiniMax API helper — OpenAI-compatible endpoint
  // JSON mode + temp drop for structured output reliability
  // ========================================================================
  async callMiniMax(messages, maxTokens = 32768, jsonMode = false) {
    const body = {
      model: "MiniMax-M2.7-highspeed",
      messages,
      max_tokens: maxTokens,
      temperature: jsonMode ? 0.3 : 0.4
    };
    if (jsonMode) {
      body.response_format = { type: "json_object" };
    }
    const response = await fetch("https://api.minimax.io/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.env.MINIMAX_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`MiniMax API ${response.status}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    const msg = data.choices?.[0]?.message;
    if (msg) {
      let text = (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text) {
        const raw = msg.reasoning_content || msg.reasoning || "";
        text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      }
      msg.content = text;
    }
    return data;
  }

  // ==========================================================================
  // LOG PERSISTENCE — D1 table ai_log is now the single source of truth.
  // Cold-start hydrates the in-memory ring from D1; logAI() writes each entry
  // to D1 fire-and-forget. The legacy DO-storage shim methods below are
  // retained so existing call sites (await this.persistLog()) keep resolving.
  // ==========================================================================
  async loadLogFromStorage() {
    const fromD1 = await this._loadAiLogFromD1(HAWebSocketV6.LOG_IN_MEMORY_CAP);
    return Array.isArray(fromD1) ? fromD1 : [];
  }

  // Retired in step 4c. ai_log is fully on D1.
  // Shim remains so the four `await this.persistLog()` call sites resolve instantly.
  async persistLog() {
    return;
  }

  async clearPersistedLog() {
    await this.state.storage.delete("ai_log").catch(() => {});
    for (let i = 0; i < HAWebSocketV6.LOG_CHUNKS_MAX; i++) {
      await this.state.storage.delete("ai_log_chunk_" + i).catch(() => {});
      await this.state.storage.delete("ai_log_chunk_gen_" + i).catch(() => {});
    }
    await this.state.storage.delete("ai_log_head").catch(() => {});
  }

  // ========================================================================
  // logAI — writes to in-memory ring buffer + sharded persistent storage
  //
  // Optional 4th arg `source` tags the entry with one of:
  //   "legacy_json"  — action came from the legacy JSON-action parser
  //   "native_loop"  — action came from MiniMax's native tool-calling loop
  //   "tool_call"    — action came from a direct MCP tools/call dispatch
  // Omit to write an entry with no source field (diagnostics, state_change, chat_*, etc.).
  // ========================================================================
  logAI(type, message, data, source) {
    const entry = { type, message, data, timestamp: new Date().toISOString() };
    if (source) entry.source = source;
    this.aiLog.push(entry);
    if (this.aiLog.length > HAWebSocketV6.LOG_IN_MEMORY_CAP) {
      this.aiLog.splice(0, this.aiLog.length - HAWebSocketV6.LOG_IN_MEMORY_CAP);
    }
    console.log("AI LOG [" + type + (source ? "/" + source : "") + "]:", message);
    this.persistLog().catch((err) => console.error("logAI persist:", err.message));
    this._writeAiLogEntryToD1(entry).catch((err) =>
      console.error("d1 ai_log write:", err?.message || err)
    );
  }

  // ========================================================================
  // AI Agent — Chat Interface
  // JSON mode + prose pass-through + targeted retry + honest failure
  // ========================================================================
  async chatWithAgent(message, from = "default", onEvent = null) {
    if (!this.env.MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not configured" };

    // Phase 2 feature flag — native tool-calling path. Flag off = no-op, legacy runs.
    if (this.env.USE_NATIVE_TOOL_LOOP === "true") {
      return await this.chatWithAgentNative(message, from, onEvent);
    }

    const now = new Date();
    const now_str = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    const memory = await this.state.storage.get("ai_memory") || [];
    const observations = await this.state.storage.get("ai_observations") || [];
    const conversationHistory = await this.state.storage.get("chat_history") || [];
    const persistentLog = [...this.aiLog];
    this.logAI("chat_user", `${from}: ${message}`, { from, message });

    // ---- Unified timeline from persistent log ----
    const timeline = persistentLog
      .filter((e) => ["chat_user", "chat_reply", "action", "action_verified", "notification", "decision", "state_change", "memory_saved", "observation_saved"].includes(e.type))
      .slice(-150)
      .map((e) => `[${HAWebSocketV6._formatTimelineTimestamp(e.timestamp)}] ${e.type}: ${e.message}`)
      .join("\n");

    // ---- Entity context snapshot ----
    const byDomain = new Map();
    for (const [id, state] of this.stateCache) {
      const domain = id.split(".")[0];
      const attr = state.attributes || {};
      const deviceClass = attr.device_class || "";
      if (domain === "switch" && isNoisySwitch(id)) continue;
      if (state.state === "unavailable" || state.state === "unknown") continue;

      if (HAWebSocketV6.CONTEXT_DOMAIN_PRIORITY.includes(domain)) {
        const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state };
        if (domain === "climate") {
          entry.setpoint = attr.temperature ?? null;
          entry.current_temp = attr.current_temperature ?? null;
          entry.hvac_action = attr.hvac_action ?? null;
          entry.hvac_mode = attr.hvac_mode ?? null;
        }
        if (domain === "cover") {
          entry.current_position = attr.current_position ?? null;
        }
        if (domain === "weather") {
          entry.temperature = attr.temperature;
          entry.humidity = attr.humidity;
          entry.wind_speed = attr.wind_speed;
          entry.wind_bearing = attr.wind_bearing;
          entry.pressure = attr.pressure;
        }
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(entry);
      } else if (domain === "sensor") {
        let include = false;
        if (HAWebSocketV6.SENSOR_WHITELIST.has(deviceClass)) {
          include = true;
        } else if (deviceClass === "battery") {
          const pct = parseFloat(state.state);
          include = !isNaN(pct) && pct <= HAWebSocketV6.BATTERY_LOW_THRESHOLD;
        }
        if (include) {
          const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state, device_class: deviceClass, unit: attr.unit_of_measurement || null };
          if (!byDomain.has("sensor")) byDomain.set("sensor", []);
          byDomain.get("sensor").push(entry);
        }
      }
    }

    const contextEntities = [];
    let sensorCount = 0;
    for (const domain of [...HAWebSocketV6.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
      for (const entry of (byDomain.get(domain) || [])) {
        if (contextEntities.length >= HAWebSocketV6.MAX_CONTEXT_ENTITIES) break;
        if (domain === "sensor") {
          if (sensorCount >= HAWebSocketV6.MAX_SENSOR_CONTEXT) break;
          sensorCount++;
        }
        contextEntities.push(entry);
      }
      if (contextEntities.length >= HAWebSocketV6.MAX_CONTEXT_ENTITIES) break;
    }

    // ---- System prompt ----
    const systemPrompt = `${this.getAgentContext()}

You are now in CHAT MODE — ${from} is talking to you directly. Be concise. If you took an action, say what you did plainly.

YOUR CAPABILITIES:
- call_service, send_notification, save_memory, save_observation
- get_automation_config, get_logbook, get_history

YOUR MEMORY (confirmed facts, ${memory.length}/100):
${memory.length > 0 ? memory.map((m) => "- " + m).join("\n") : "No memories yet."}

YOUR OBSERVATIONS (patterns & hypotheses in progress, ${observations.length}/500):
${observations.length > 0 ? observations.map((o) => "- " + o).join("\n") : "No observations yet. Watch for repeating sequences and build evidence here."}

UNIFIED TIMELINE — this is the single source of truth for what has happened recently.

${timeline || "Timeline is empty."}

CURRENT STATE OF ENTITIES (${contextEntities.length}):
${JSON.stringify(contextEntities, null, 1)}

CRITICAL RULES:
1. When you include a call_service in your actions array, the system WILL execute it. Your reply must reflect what you actually did.
2. If you say you are doing something, you MUST include the corresponding action in the actions array. A reply saying "Opening the door" with an empty actions array is a LIE and unacceptable.
3. The CURRENT STATE OF ENTITIES block above IS your live, authoritative snapshot. It was just built from a maintained WebSocket connection to Home Assistant — you do not know and do not need to reason about refresh lag, stale caches, or WebSocket health. If an entity IS in the block, its state is current. NEVER say "I don't have visibility" or "the WebSocket didn't refresh" or "my snapshot hasn't updated" — those are fabrications about a layer you can't see. If an entity is NOT in the block, the honest answer is "I don't see that entity in my current snapshot." Never invent timestamps for events you didn't witness (e.g., "John closed it at 04:28"). If you're not looking at a timeline entry, you don't know when it happened.
4. If unsure which entity, ASK instead of guessing.
5. Thermostat zones: main level (incl. MBR) = climate.t6_pro_z_wave_programmable_thermostat_2; basement = climate.t6_pro_z_wave_programmable_thermostat.
6. Smoke/CO detectors are NOT in HA.
7. update_automation returns 405. Tell John what to change in the UI.
8. Sensor values come from CURRENT STATE OF ENTITIES above — quote directly or say the sensor isn't listed.
9. The ONLY valid action types: call_service, send_notification, save_memory, save_observation.

${this._saveMemoryCriteriaBlock()}

RESPONSE FORMAT — non-negotiable:
Your entire response must be a SINGLE JSON object in exactly this shape:

{
  "reply": "your response text",
  "actions": [
    {"type": "call_service", "domain": "switch", "service": "turn_on", "data": {"entity_id": "switch.magnolia_lamp"}},
    {"type": "send_notification", "message": "alert text", "title": "optional"},
    {"type": "save_memory", "memory": "Confirmed fact to remember long-term"},
    {"type": "save_observation", "text": "[topic-tag] Pattern or hypothesis with evidence", "replaces": "[topic-tag]"}
  ]
}

ACTION SCHEMA — EXACT shape, no exceptions:
- "type" MUST be one of: call_service, send_notification, save_memory, save_observation.
- For call_service: "domain" and "service" are SEPARATE strings; entity_id goes inside "data".
- WRONG (HA YAML style): {"service": "switch.turn_on", "target": {"entity_id": "switch.x"}}
- RIGHT: {"type": "call_service", "domain": "switch", "service": "turn_on", "data": {"entity_id": "switch.x"}}
- For save_observation: always prefix "text" with a [topic-tag]. Set "replaces" to the same tag when updating an existing observation.

Emit ONE JSON object. No markdown fences. No text outside the JSON. If nothing to do, use "actions": [].`;

    const climatePreamble = await this._buildClimatePreambleIfNeeded(message, "chat_legacy");
    const userTurn = { role: "user", content: "Current time: " + now_str + (climatePreamble ? "\n\n" + climatePreamble : "") + "\n\n" + message };

    // ---- Model call helper ----
    // If previousAssistantResponse is provided, it's inserted as a prior assistant
    // turn, then the correction is delivered as a user message. This anchors the
    // retry to the actual first-attempt text ("that response you JUST gave")
    // rather than having the model regenerate from scratch, which was destabilizing
    // honest retractions in production.
    const attemptChat = async (previousAssistantResponse = null, correction = null) => {
      const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory,
        userTurn
      ];
      if (previousAssistantResponse) {
        messages.push({ role: "assistant", content: previousAssistantResponse });
      }
      if (correction) {
        messages.push({ role: "user", content: "[SYSTEM CORRECTION] " + correction });
      }
      const response = await this.callMiniMax(messages, 32768, true);
      let responseText = response.choices?.[0]?.message?.content || response.response || "";
      if (!responseText) {
        const rawReasoning = response.choices?.[0]?.message?.reasoning || "";
        const jsonFallback = HAWebSocketV6.extractFirstJSON(rawReasoning);
        if (jsonFallback) responseText = jsonFallback;
      }
      let parsed = null;
      const jsonMatch = HAWebSocketV6.extractFirstJSON(responseText);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch);
        } catch (e) {}
      }
      return { parsed, responseText };
    };

    try {
      // ==== First attempt ====
      let { parsed, responseText } = await attemptChat();
      this.logAI("chat_raw", "len=" + responseText.length + " preview=" + responseText.substring(0, 100), {});

      // ==== Parse dispatch ====
      // Three outcomes when the first attempt didn't parse as JSON:
      //   1. Non-empty prose, no action claims → accept as conversational reply, NO retry.
      //      Retrying here was destroying honest retractions like "No, I made that up."
      //   2. Non-empty prose WITH action claims → retry once, anchored to the first-attempt
      //      text so the model knows it's reformatting, not regenerating.
      //   3. Empty → fall through to honest-failure.
      if (!parsed || typeof parsed.reply !== "string") {
        const raw = (responseText || "").trim();
        const actionClaimVerbs = /\b(opening|closing|turning on|turning off|locking|unlocking|setting|activating|dimming|starting|stopping)\b/i;
        const claimsAction = actionClaimVerbs.test(raw);

        if (raw.length > 0 && !claimsAction) {
          this.logAI("chat_prose_ok", "Parse failed but no action claims — accepting prose as conversational reply", {
            preview: raw.substring(0, 150)
          });
          parsed = { reply: raw, actions: [] };
        } else if (raw.length > 0 && claimsAction) {
          this.logAI("chat_parse_fail", "First attempt claims action but is not JSON — retrying with first-attempt anchor", {
            preview: raw.substring(0, 150)
          });
          const correction = 'Your previous response committed to an action (e.g. "opening", "turning on") but was not wrapped in the required JSON schema, so the action cannot execute. Re-emit the SAME answer as a JSON object: {"reply": "<your answer text>", "actions": [{"type": "call_service", "domain": "<domain>", "service": "<service>", "data": {"entity_id": "<entity>"}}]}. Keep the reply text. Populate the actions array with the action you committed to. No markdown fences. No text outside the JSON.';
          const retry = await attemptChat(raw, correction);
          this.logAI("chat_retry_raw", "len=" + retry.responseText.length + " preview=" + retry.responseText.substring(0, 100), {});
          parsed = retry.parsed;
          responseText = retry.responseText;
        }
        // raw.length === 0 falls through to final-failure block below.
      }

      // ==== Final failure ====
      if (!parsed || typeof parsed.reply !== "string") {
        const raw = (responseText || "").trim();
        this.logAI("chat_parse_fail_final", "Both attempts failed. Raw: " + raw.substring(0, 200), {
          empty: raw.length === 0
        });
        const honestReply = raw.length === 0
          ? "I didn't get a usable response from the model. Can you rephrase?"
          : "My response got tangled up — I may have said I did something I didn't actually execute. Can you re-ask so I can try again cleanly?";
        this.logAI("chat_reply", honestReply, { from, full_reply: honestReply, parse_failed: true });
        conversationHistory.push({ role: "user", content: `[${from}]: ${message}` });
        conversationHistory.push({ role: "assistant", content: honestReply });
        if (conversationHistory.length > 40) conversationHistory.splice(0, conversationHistory.length - 40);
        await this.state.storage.put("chat_history", conversationHistory);
        return {
          reply: honestReply,
          actions_taken: [],
          parse_failed: true,
          raw_response: raw.substring(0, 300)
        };
      }

      // ==== Success path ====
      this.logAI("chat_reply", parsed.reply.substring(0, 300), { from, full_reply: parsed.reply });
      conversationHistory.push({ role: "user", content: `[${from}]: ${message}` });
      conversationHistory.push({ role: "assistant", content: parsed.reply });
      if (conversationHistory.length > 40) conversationHistory.splice(0, conversationHistory.length - 40);
      await this.state.storage.put("chat_history", conversationHistory);

      // ==== Action execution ====
      const executedActions = [];
      const failedActions = [];
      if (parsed.actions && Array.isArray(parsed.actions)) {
        for (const action of parsed.actions) {
          try {
            await this.executeAIAction(action);
            executedActions.push(action.type + (action.domain ? ": " + action.domain + "." + action.service : ""));
          } catch (err) {
            failedActions.push(action.type + (action.domain ? ": " + action.domain + "." + action.service : "") + " (" + err.message + ")");
            this.logAI("chat_action_error", err.message, action);
          }
        }
      }

      // ==== Claim-mismatch tripwire ====
      // Reply promises action but nothing executed. Log loudly for post-hoc diagnosis.
      // NOT retried: for empty-actions cases the claim may be rhetorical ("I'll open
      // the door" in a proposal), and a retry would further destabilize. For failed
      // actions, the executor error is ground truth — retry won't help.
      const actionClaimVerbs = /\b(opening|closing|turning on|turning off|locking|unlocking|setting|activating|dimming|starting|stopping)\b/i;
      const replyClaimsAction = actionClaimVerbs.test(parsed.reply || "");
      if (replyClaimsAction && executedActions.length === 0 && failedActions.length === 0) {
        this.logAI(
          "chat_action_mismatch",
          `Reply claims action but actions array was empty. Reply: "${(parsed.reply || "").substring(0, 150)}"`,
          { reply: parsed.reply }
        );
      }

      const requestedCount = (parsed.actions || []).length;
      if (failedActions.length > 0) {
        this.logAI(
          "chat_action_mismatch",
          `Requested ${requestedCount}, succeeded ${executedActions.length}, failed ${failedActions.length}: ${failedActions.join("; ")}`,
          {}
        );
      }

      this.logAI("chat", `done | exec=${executedActions.length} fail=${failedActions.length}`, {
        actions_requested: requestedCount,
        actions_executed: executedActions.length,
        actions_failed: failedActions.length,
        from,
        context_size: contextEntities.length
      });

      return {
        reply: parsed.reply || "Done.",
        actions_taken: executedActions,
        actions_failed: failedActions.length > 0 ? failedActions : undefined,
        claim_mismatch: replyClaimsAction && executedActions.length === 0 && failedActions.length === 0 ? true : undefined
      };
    } catch (err) {
      this.logAI("chat_error", err.message, {});
      return { error: "AI failed: " + err.message };
    }
  }
  // ========================================================================
  // AI Agent — Action Execution
  //
  // Optional 2nd arg `source` tags resulting log entries so we can tell apart
  // legacy JSON actions, native-tool-loop actions, and direct MCP dispatches.
  // Defaults to "legacy_json" — existing legacy callers require no changes.
  // ========================================================================
  async executeAIAction(action, source = "legacy_json") {
    // Auto-heal HA-YAML-style actions into internal schema
    if (!action.type && typeof action.service === "string" && action.service.includes(".")) {
      const [healedDomain, healedService] = action.service.split(".", 2);
      let healedData = {};
      if (action.data && typeof action.data === "object") {
        healedData = action.data;
      } else if (action.target && action.target.entity_id) {
        healedData = { entity_id: action.target.entity_id };
      } else if (action.entity_id) {
        healedData = { entity_id: action.entity_id };
      }
      this.logAI("action_healed", "Rewrote HA-yaml action to call_service: " + healedDomain + "." + healedService, { original: action }, source);
      action = { type: "call_service", domain: healedDomain, service: healedService, data: healedData };
    }
    switch (action.type) {
      case "call_service": {
        console.log("AI executing:", action.domain + "." + action.service);
        const result = await this.sendCommand({
          type: "call_service",
          domain: action.domain,
          service: action.service,
          service_data: action.data || {},
          target: action.target || {}
        });
        this.logAI("action", "Called " + action.domain + "." + action.service, action.data || {}, source);
        const entityId = action.data && action.data.entity_id || action.target && action.target.entity_id;
        if (entityId && ["climate", "lock", "cover"].includes(action.domain)) {
          await new Promise((r) => setTimeout(r, 1500));
          const verifiedState = this.stateCache.get(entityId);
          if (verifiedState) {
            const verifyData = { entity_id: entityId, state: verifiedState.state };
            if (action.domain === "climate") {
              verifyData.setpoint = verifiedState.attributes?.temperature ?? null;
              verifyData.current_temp = verifiedState.attributes?.current_temperature ?? null;
              verifyData.hvac_action = verifiedState.attributes?.hvac_action ?? null;
            }
            if (action.domain === "lock") {
              verifyData.lock_state = verifiedState.state;
            }
            if (action.domain === "cover") {
              verifyData.cover_state = verifiedState.state;
              verifyData.position = verifiedState.attributes?.current_position ?? null;
            }
            this.logAI(
              "action_verified",
              `Post-action state of ${entityId}: ${JSON.stringify(verifyData)}`,
              verifyData,
              source
            );
          } else {
            this.logAI(
              "action_verify_fail",
              `Could not verify state of ${entityId} — not in stateCache`,
              { entity_id: entityId },
              source
            );
          }
        }
        return result;
      }
      case "send_notification": {
        console.log("AI sending notification:", action.message);
        const notifyData = { message: action.message };
        if (action.title) notifyData.title = action.title;
        await this.sendCommand({
          type: "call_service",
          domain: "notify",
          service: "notify",
          service_data: notifyData
        });
        this.logAI("notification", action.message, { title: action.title }, source);
        break;
      }
      case "save_memory": {
        console.log("AI saving memory:", action.memory);
        const memory = await this.state.storage.get("ai_memory") || [];
        memory.push(action.memory);
        // Capture FIFO-evicted entries so we can clean up their vectors.
        // Memories prefixed with "PINNED:" are exempt from eviction —
        // architectural facts, presence rules, naming conventions, etc.
        // shouldn't be lost to rapid-fire arrival/departure churn.
        let evicted = [];
        if (memory.length > 100) {
          const overage = memory.length - 100;
          const evictIndices = [];
          for (let i = 0; i < memory.length && evictIndices.length < overage; i++) {
            if (typeof memory[i] === "string" && memory[i].startsWith("PINNED:")) continue;
            evictIndices.push(i);
          }
          // If everything is pinned (>100 pinned memories), grow the list —
          // don't silently drop pinned content.
          if (evictIndices.length === overage) {
            const evictSet = new Set(evictIndices);
            evicted = memory.filter((_, i) => evictSet.has(i));
            const remaining = memory.filter((_, i) => !evictSet.has(i));
            memory.length = 0;
            memory.push(...remaining);
          }
        }
        await this.state.storage.put("ai_memory", memory);
        this.logAI("memory_saved", action.memory, {}, source);
        // Write-through: embed the new memory and upsert into KNOWLEDGE.
        // Errors are logged but don't fail the action — the timeline is the
        // canonical record; the vector index is a derived view.
        if (this.env.AI && this.env.KNOWLEDGE) {
          try {
            const doc = this._memoryDocFor(action.memory);
            if (doc) await this._embedAndUpsertSingle(doc);
          } catch (err) {
            this.logAI("vector_error", "memory upsert: " + err.message, {}, source);
          }
          if (evicted.length > 0) {
            try {
              const ids = evicted
                .filter((t) => typeof t === "string" && t)
                .map((t) => vectorIdFor("memory", fnv1aHex(t)));
              if (ids.length > 0) await this._deleteVectorIds(ids);
            } catch (err) {
              this.logAI("vector_error", "memory evict delete: " + err.message, {}, source);
            }
          }
        }
        break;
      }
      case "save_observation": {
        const text = typeof action.text === "string" ? action.text.trim() : "";
        if (!text) {
          this.logAI("observation_skipped", "save_observation called with empty text", action, source);
          break;
        }
        // D1 is authoritative for observations. The `replaces` arg on the
        // action is accepted but ignored — D1's primary key on topic_tag
        // supersedes any prior row with the same tag natively (via
        // INSERT OR REPLACE), and the matching Vectorize upsert under the
        // same topic-tag-derived vector_id overwrites the old vector.
        const topicTag = topicTagFor(text);
        try {
          const ts = new Date().toISOString();
          await this.env.DB
            .prepare(
              `INSERT OR REPLACE INTO observations (topic_tag, text, timestamp)
               VALUES (?1, ?2, ?3)`
            )
            .bind(topicTag, String(text), ts)
            .run();
        } catch (err) {
          this.logAI("error", "d1_save_observation_failed", {
            error: String(err?.message || err),
            text_preview: String(text).slice(0, 200),
          }, source);
        }

        this.logAI("observation_saved", text.substring(0, 200), { replaces: action.replaces || null, topic_tag: topicTag }, source);
        // Write-through: embed + upsert the new observation. Same-tag prior
        // vectors are overwritten by the upsert (vector_id is keyed on
        // topicTagFor(text)), so no separate delete-sweep is needed.
        if (this.env.AI && this.env.KNOWLEDGE) {
          try {
            const doc = this._observationDocFor(text);
            if (doc) await this._embedAndUpsertSingle(doc);
          } catch (err) {
            this.logAI("vector_error", "observation upsert: " + err.message, {}, source);
          }
        }
        break;
      }
      case "report_bug": {
        const description = typeof action.description === "string" ? action.description.trim() : "";
        if (!description) {
          this.logAI("bug_skipped", "report_bug called with empty description", action, source);
          return { ok: false, error: "description is required" };
        }
        const id = fnv1aHex(description + ":" + Date.now().toString()).slice(0, 8);
        const now = new Date();
        const ts_iso = now.toISOString();
        const ts_central = now.toLocaleString("en-US", { timeZone: "America/Chicago" });

        // Pull recent context server-side — the model can't fake what gets attached.
        // Every field is bounded: DO storage value cap is 128 KiB per key, and the
        // raw chat history + ai_log + entity attributes can easily blow that.
        const channelKey = sanitizeChannelKey(action.from || "default");
        const rawHistory = await this.state.storage.get(`chat_history:${channelKey}`) || [];
        const TURN_CONTENT_CAP = 1024;
        const last_chat_turns = rawHistory.slice(-4).map((t) => {
          const out = { role: t.role };
          if (typeof t.content === "string") {
            out.content = t.content.slice(0, TURN_CONTENT_CAP);
          } else if (t.content != null) {
            out.content = JSON.stringify(t.content).slice(0, TURN_CONTENT_CAP);
          }
          if (Array.isArray(t.tool_calls)) {
            out.tool_calls = t.tool_calls.map((tc) => ({
              id: tc.id,
              type: tc.type,
              function: tc.function ? {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === "string"
                  ? tc.function.arguments.slice(0, 512)
                  : tc.function.arguments
              } : undefined
            }));
          }
          if (t.tool_call_id) out.tool_call_id = t.tool_call_id;
          return out;
        });

        const LOG_DATA_CAP = 500;
        const last_log_entries = (this.aiLog || []).slice(-10).map((e) => {
          const out = {
            timestamp: e.timestamp,
            type: e.type,
            message: typeof e.message === "string" ? e.message.slice(0, 500) : e.message,
          };
          if (e.source) out.source = e.source;
          if (e.data != null) {
            try {
              out.data = JSON.stringify(e.data).slice(0, LOG_DATA_CAP);
            } catch { /* skip unserializable */ }
          }
          return out;
        });

        // Attribute allowlist: keep what's actually useful for diagnosing a bug;
        // drop the bulk (full Zigbee attribute trees, base64 image blobs, etc.).
        const ATTR_ALLOW = new Set([
          "friendly_name", "device_class", "unit_of_measurement", "state_class",
          "battery_level", "current_position", "current_temperature",
          "target_temp_high", "target_temp_low", "hvac_action", "hvac_mode",
          "locked", "latched", "is_locked", "code_format",
          "brightness", "color_temp", "color_mode", "rgb_color",
          "supported_features", "icon"
        ]);
        const rawEntities = Array.isArray(action.entities) ? action.entities : [];
        const entities = rawEntities.slice(0, 10); // hard cap on cited entities
        const entity_states = {};
        for (const eid of entities) {
          if (typeof eid !== "string" || !eid) continue;
          const s = this.stateCache.get(eid);
          if (!s) { entity_states[eid] = null; continue; }
          const trimmedAttrs = {};
          for (const k of Object.keys(s.attributes || {})) {
            if (ATTR_ALLOW.has(k)) trimmedAttrs[k] = s.attributes[k];
          }
          entity_states[eid] = { state: s.state, attributes: trimmedAttrs };
        }

        const severity = ["low", "medium", "high"].includes(action.severity) ? action.severity : "low";

        const entry = {
          id,
          timestamp_iso: ts_iso,
          timestamp_central: ts_central,
          source: "chat",
          channel: channelKey,
          severity,
          description,
          entities,
          entity_states,
          last_chat_turns,
          last_log_entries
        };

        // Oversize guard. DO storage caps each value at 128 KiB; aim well below.
        // If we're somehow still over budget after the field-level trims above
        // (e.g. very long description, or many entities), shed context to make
        // room. Description + id always survive — that's the floor.
        const SIZE_BUDGET = 100 * 1024;
        let serialized = JSON.stringify(entry);
        const truncationNotes = [];
        if (serialized.length > SIZE_BUDGET) {
          entry.last_chat_turns = [];
          truncationNotes.push("dropped last_chat_turns");
          serialized = JSON.stringify(entry);
        }
        if (serialized.length > SIZE_BUDGET) {
          entry.last_log_entries = [];
          truncationNotes.push("dropped last_log_entries");
          serialized = JSON.stringify(entry);
        }
        if (serialized.length > SIZE_BUDGET) {
          entry.entity_states = {};
          truncationNotes.push("dropped entity_states");
          serialized = JSON.stringify(entry);
        }
        if (truncationNotes.length > 0) {
          entry.truncation_notes = truncationNotes.join("; ");
        }

        // Per-bug storage: one DO key per bug, plus a small index. Avoids the
        // failure mode where a single growing `bugs` array key trips the 128 KiB
        // cap and silently drops new writes.
        try {
          await this.state.storage.put(`bug:${id}`, entry);
          let bugIds = await this.state.storage.get("bug_ids") || [];
          if (!Array.isArray(bugIds)) bugIds = [];
          // Legacy migration: drain the old `bugs` array into the new index +
          // per-id keys on first write after deploy. Idempotent — the legacy
          // key is deleted after migration.
          if (bugIds.length === 0) {
            const legacy = await this.state.storage.get("bugs");
            if (Array.isArray(legacy) && legacy.length > 0) {
              for (const legacyBug of legacy) {
                if (!legacyBug || !legacyBug.id) continue;
                try {
                  await this.state.storage.put(`bug:${legacyBug.id}`, legacyBug);
                  bugIds.push(legacyBug.id);
                } catch { /* skip oversize legacy entries */ }
              }
              await this.state.storage.delete("bugs").catch(() => {});
            }
          }
          bugIds.push(id);
          // FIFO 200: delete the dropped keys so storage doesn't grow unbounded.
          if (bugIds.length > 200) {
            const dropped = bugIds.slice(0, bugIds.length - 200);
            bugIds = bugIds.slice(-200);
            for (const dropId of dropped) {
              await this.state.storage.delete(`bug:${dropId}`).catch(() => {});
            }
          }
          await this.state.storage.put("bug_ids", bugIds);
        } catch (err) {
          // Failure must be visible. The agent's CONFABULATION rule in the
          // system prompt requires it to surface this error verbatim instead
          // of pretending the bug was saved.
          const errMsg = err && err.message ? err.message : String(err);
          this.logAI(
            "bug_save_failed",
            `report_bug write failed: ${errMsg}`,
            { id, error: errMsg, serialized_size: serialized.length, truncation_notes: entry.truncation_notes || null },
            source
          );
          return {
            ok: false,
            error: `Storage write failed: ${errMsg} (entry was ${serialized.length} bytes after trims${entry.truncation_notes ? "; " + entry.truncation_notes : ""})`
          };
        }

        this.logAI(
          "bug_reported",
          `#${id} ${description.substring(0, 80)}`,
          { id, severity, entities, channel: channelKey, serialized_size: serialized.length, truncation_notes: entry.truncation_notes || null },
          source
        );

        return {
          ok: true,
          id,
          summary: `Logged bug #${id}. Captured ${Object.keys(entity_states).length} entity state(s) + last ${entry.last_log_entries.length} log entries.${entry.truncation_notes ? " Note: " + entry.truncation_notes + "." : ""}`
        };
      }
      default:
        this.logAI("unknown_action", "Unknown action type: " + action.type, action, source);
        throw new Error("Unknown action type: '" + (action.type || "undefined") + "' — expected call_service, send_notification, save_memory, save_observation, or report_bug");
    }
  }

  _formatLogbookForLLM(entries) {
    if (!Array.isArray(entries)) return entries;
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const toCentral = (iso) => {
      if (typeof iso !== "string") return iso;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const parts = Object.fromEntries(
        fmt.formatToParts(d).filter(p => p.type !== "literal").map(p => [p.type, p.value])
      );
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} CT`;
    };
    return entries.map(e => {
      if (!e || typeof e !== "object") return e;
      const out = { ...e };
      if (out.when) out.when = toCentral(out.when);
      return out;
    });
  }

  // ========================================================================
  // Native tool dispatcher — Phase 2
  //
  // Maps a MiniMax tool_call (by name + parsed args) onto the underlying
  // implementation. Write tools reuse executeAIAction with source="native_loop"
  // so the legacy action path remains the single source of truth for memory,
  // observation, notification, and call_service semantics (including post-action
  // state verification for lock/cover/climate). Read tools are implemented
  // locally and do NOT log as actions — they're side-effect-free discovery.
  //
  // Returns the tool's natural result (or {error: "..."}). Errors do not throw;
  // the native loop treats them as a tool-call outcome MiniMax can recover from.
  // ========================================================================
  async executeNativeTool(name, args) {
    args = args || {};
    try {
      switch (name) {
        // ----- Action tools -----
        case "call_service":
          return await this.executeAIAction({
            type: "call_service",
            domain: args.domain,
            service: args.service,
            data: args.data || {},
            target: args.target || {}
          }, "native_loop");

        case "ai_send_notification":
          await this.executeAIAction({
            type: "send_notification",
            message: args.message,
            title: args.title
          }, "native_loop");
          return { sent: true };

        case "save_memory":
          await this.executeAIAction({
            type: "save_memory",
            memory: args.memory
          }, "native_loop");
          return { saved: true };

        case "save_observation":
          await this.executeAIAction({
            type: "save_observation",
            text: args.text,
            replaces: args.replaces
          }, "native_loop");
          return { saved: true };

        case "report_bug":
          // Chat-only meta-tool: writes to the bugs bucket, not home state.
          // Reads `this._activeChatFrom` (set at top of chatWithAgentNative)
          // so the handler can attach the right per-channel chat history.
          return await this.executeAIAction({
            type: "report_bug",
            description: args.description,
            entities: args.entities || [],
            severity: args.severity || "low",
            from: this._activeChatFrom || "default"
          }, "native_loop");

        // ----- Read tools (no action log; not counted in actions_taken) -----
        case "get_state": {
          if (!args.entity_id) return { error: "entity_id is required" };
          if (!args.force_refresh) {
            const cached = this.stateCache.get(args.entity_id);
            if (cached) return cached;
          }
          if (args.force_refresh === "bulk") {
            // Explicit bulk refresh: repopulate entire stateCache via WS.
            try {
              const result = await this.sendCommand({ type: "get_states" });
              if (result && Array.isArray(result.result)) {
                for (const s of result.result) this.stateCache.set(s.entity_id, s);
              }
              const fresh = this.stateCache.get(args.entity_id);
              return fresh || { error: "Entity not found: " + args.entity_id };
            } catch (err) {
              return { error: "Failed to bulk refresh states: " + err.message };
            }
          }
          // Default force_refresh (true or any truthy): single-entity REST call.
          // Much cheaper than pulling all 1000+ entities via WS get_states.
          try {
            const url = `${this.env.HA_URL}/api/states/${encodeURIComponent(args.entity_id)}`;
            const resp = await fetch(url, {
              headers: { Authorization: `Bearer ${this.env.HA_TOKEN}` }
            });
            if (resp.status === 404) return { error: "Entity not found: " + args.entity_id };
            if (!resp.ok) throw new Error(`HA REST ${resp.status}`);
            const state = await resp.json();
            this.stateCache.set(state.entity_id, state);
            return state;
          } catch (err) {
            return { error: "Failed to refresh state: " + err.message };
          }
        }

        case "get_logbook": {
          if (!args.start_time) return { error: "start_time is required (ISO 8601)" };
          try {
            const haUrl = this.env.HA_URL.replace(/\/$/, "");
            let path = "/api/logbook/" + encodeURIComponent(args.start_time);
            const params = [];
            if (args.entity_id) params.push("entity=" + encodeURIComponent(args.entity_id));
            if (args.end_time) params.push("end_time=" + encodeURIComponent(args.end_time));
            if (params.length) path += "?" + params.join("&");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const resp = await fetch(haUrl + path, {
              headers: { Authorization: "Bearer " + this.env.HA_TOKEN },
              signal: controller.signal
            });
            clearTimeout(timeout);
            if (!resp.ok) return { error: "HA logbook " + resp.status + ": " + (await resp.text()).substring(0, 200) };
            const data = await resp.json();
            return this._formatLogbookForLLM(data);
          } catch (err) {
            return { error: "Logbook fetch failed: " + err.message };
          }
        }

        case "vector_search": {
          if (typeof args.query !== "string" || !args.query.trim()) {
            return { error: "query is required" };
          }
          const k = Math.min(Math.max(parseInt(args.top_k || 15, 10) || 15, 1), 50);
          const matches = await this.retrieveKnowledge({
            query: args.query,
            k,
            kinds: Array.isArray(args.kinds) ? args.kinds : (typeof args.kinds === "string" ? [args.kinds] : null),
            domain: args.domain || null,
            area: args.area || null,
            topic_tag: args.topic_tag || null,
            min_score: typeof args.min_score === "number" ? args.min_score : null,
            includeNoisy: !!args.include_noisy
          });
          return { matches, count: matches.length };
        }

        case "render_template": {
          if (typeof args.template !== "string" || !args.template.trim()) {
            return { error: "template is required" };
          }
          try {
            const haUrl = this.env.HA_URL.replace(/\/$/, "");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const resp = await fetch(haUrl + "/api/template", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + this.env.HA_TOKEN,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({ template: args.template }),
              signal: controller.signal
            });
            clearTimeout(timeout);
            if (!resp.ok) return { error: "HA template " + resp.status + ": " + (await resp.text()).substring(0, 200) };
            const text = await resp.text();
            try { return JSON.parse(text); } catch { return text; }
          } catch (err) {
            return { error: "Template render failed: " + err.message };
          }
        }

        case "query_state_history":
          return await this._executeQueryStateHistory(args);

        case "query_automation_runs":
          return await this._executeQueryAutomationRuns(args);

        case "query_causal_chain":
          return await this._executeQueryCausalChain(args);

        case "get_automation_config": {
          const rawId = args.entity_id || args.automation_id;
          if (!rawId || typeof rawId !== "string") {
            return { error: "Missing automation identifier. Provide entity_id (e.g. automation.example) or automation_id." };
          }

          let id = rawId;
          if (id.startsWith("automation.")) {
            const match = this.stateCache.get(id);
            if (match?.attributes?.id) {
              id = match.attributes.id;
            } else {
              return {
                error: "Could not resolve internal automation config ID for " + rawId,
                hint: "If the automation is unavailable or restored, attributes.id may not be populated. Ask John for the numeric ID."
              };
            }
          }

          try {
            const haUrl = this.env.HA_URL.replace(/\/$/, "");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const resp = await fetch(
              haUrl + "/api/config/automation/config/" + encodeURIComponent(id),
              {
                headers: { Authorization: "Bearer " + this.env.HA_TOKEN },
                signal: controller.signal
              }
            );
            clearTimeout(timeout);
            if (!resp.ok) {
              return { error: "HA automation config " + resp.status + ": " + (await resp.text()).substring(0, 200) };
            }
            return await resp.json();
          } catch (err) {
            return { error: "Automation config fetch failed: " + err.message };
          }
        }

        default:
          return { error: "Unknown native tool: " + name };
      }
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }

  // ========================================================================
  // MiniMax API helper — native tool-calling variant (Phase 2)
  //
  // Distinct from callMiniMax because:
  //   - Tool calling and response_format:json_object are mutually exclusive on
  //     OpenAI-compatible APIs — tool calling IS the structured output.
  //   - The existing callMiniMax strips <think>...</think> tags from content
  //     for display. The native loop MUST preserve them: per MiniMax docs,
  //     the full assistant message (content + tool_calls, reasoning intact)
  //     must be echoed back on subsequent turns or the reasoning chain breaks.
  //   - extra_body.reasoning_split is set per docs; curl-test showed the flag
  //     is accepted but thinking still lives inline in <think> blocks on
  //     M2.7-highspeed today. Harmless and forward-compatible.
  //
  // Returns the raw API response with the assistant message UNMUTATED.
  // ========================================================================
  async callMiniMaxWithTools(messages, tools, maxTokens = 4096, timeoutMs = 45000) {
    const body = {
      model: "MiniMax-M2.7-highspeed",
      messages,
      tools,
      max_tokens: maxTokens,
      temperature: 0,
      reasoning_split: true
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("https://api.minimax.io/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.env.MINIMAX_API_KEY}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`MiniMax API ${response.status}: ${errText.substring(0, 200)}`);
      }
      return await response.json();
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`MiniMax API timeout after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ========================================================================
  // Native tool-calling loop — Phase 2
  // ========================================================================
  async runNativeToolLoop(initialMessages, options = {}) {
    const {
      maxIterations = 8,
      systemPrompt = null,
      onEvent = null,
      allowedTools = NATIVE_AGENT_TOOLS,
      hallucinationGuard = true,
      maxTokens = 4096
    } = options;
    const messages = [...initialMessages];
    if (systemPrompt && (messages.length === 0 || messages[0].role !== "system")) {
      messages.unshift({ role: "system", content: systemPrompt });
    }
    const actionsTaken = [];
    const stripThink = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const extractThink = (s) => {
      const matches = [...(s || "").matchAll(/<think>([\s\S]*?)<\/think>/g)];
      return matches.map(m => m[1].trim()).filter(Boolean).join("\n\n");
    };
    const safeEmit = (evt) => { try { if (onEvent) onEvent(evt); } catch {} };

    for (let iter = 0; iter < maxIterations; iter++) {
      let response;
      safeEmit({ type: "thinking" });
      try {
        response = await this.callMiniMaxWithTools(messages, allowedTools, maxTokens);
      } catch (err) {
        this.logAI("error", "Native loop API call failed: " + err.message, { iteration: iter }, "native_loop");
        safeEmit({ type: "error", message: err.message });
        return {
          reply: "I couldn't reach the model — " + err.message,
          actions_taken: actionsTaken,
          messages,
          error: err.message,
          iterations: iter
        };
      }
      const assistantMsg = response.choices?.[0]?.message;
      if (!assistantMsg) {
        this.logAI("error", "Native loop: no assistant message in response", { iteration: iter, debug_keys: Object.keys(response || {}) }, "native_loop");
        safeEmit({ type: "error", message: "empty_response" });
        return {
          reply: "I didn't get a usable response from the model.",
          actions_taken: actionsTaken,
          messages,
          error: "empty_response",
          iterations: iter
        };
      }
      messages.push(assistantMsg);
      const reasoningMid = (assistantMsg.reasoning_content || assistantMsg.reasoning || "").trim() || extractThink(assistantMsg.content);
      if (reasoningMid) {
        safeEmit({ type: "reasoning", text: reasoningMid });
      }
      const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];
      if (toolCalls.length === 0) {
        const cleaned = stripThink(assistantMsg.content);

        // First-person action claim only — narration like "the lights are
        // turning off" no longer false-positives. Completion idioms ("Done.",
        // "Closing it now") still trigger. Disclaim phrases short-circuit.
        const firstPersonClaim = /\b(?:i'?m|i\s+am|i'?ll|i\s+will|let\s+me|going\s+to|i\s+just|i'?ve|i\s+have)\s+(?:now\s+|just\s+)?(?:open|clos|turn|lock|unlock|set|activat|dim|start|stop)/i;
        const completionClaim = /^(?:done\b|closing\s+it\s+now|opening\s+it\s+now|on\s+it\b|locked\b|unlocked\b|closed\b|opened\b|turned\s+(?:on|off)\b)/i;
        const explicitNoAction = /\b(?:no\s+action|nothing\s+to\s+act|not\s+acting|won'?t\s+act|no\s+tool|standing\s+by|just\s+observing|monitoring\s+only|heartbeat\s+only)\b/i;

        const looksLikeClaim = firstPersonClaim.test(cleaned) || completionClaim.test(cleaned.trim());
        const disclaimsAction = explicitNoAction.test(cleaned);

        if (
          hallucinationGuard &&
          actionsTaken.length === 0 &&
          looksLikeClaim &&
          !disclaimsAction
        ) {
          this.logAI(
            "action_hallucination",
            `Claim without tool call — forcing retry: "${cleaned.substring(0, 150)}"`,
            { iteration: iter },
            "native_loop"
          );
          messages.push({
            role: "user",
            content: 'You just said you performed an action (e.g. "I\'m closing the garage", "Done — locked") but did not emit a tool_call. That is a hallucination. Call the appropriate tool NOW to actually do what you said. If you truly cannot or should not act, reply plainly saying so — do not claim completion.'
          });
          safeEmit({ type: "thinking" });
          continue;
        }
        safeEmit({ type: "reply", text: cleaned });
        return {
          reply: cleaned,
          actions_taken: actionsTaken,
          messages,
          iterations: iter + 1
        };
      }
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        const argsRaw = tc.function?.arguments || "{}";
        let args = {};
        let parseError = null;
        try {
          args = JSON.parse(argsRaw);
        } catch (parseErr) {
          parseError = parseErr.message;
          this.logAI("action_error", `Native loop: failed to parse args for ${name}: ${parseErr.message}`, { tool: name, raw: argsRaw.substring(0, 300) }, "native_loop");
        }
        const evtLabel = name === "call_service" && args.domain && args.service ? `${args.domain}.${args.service}` : name;
        safeEmit({ type: "tool_call", name, label: evtLabel, args });
        let result;
        if (parseError) {
          result = { error: "Invalid JSON arguments: " + parseError };
        } else if (!NATIVE_TOOL_NAMES.has(name)) {
          result = { error: `Unknown tool: ${name}` };
        } else {
          result = await this.executeNativeTool(name, args);
          if (NATIVE_ACTION_TOOL_NAMES.has(name) && !result?.error) {
            actionsTaken.push(name);
          }
        }
        safeEmit({ type: "tool_result", name, ok: !result?.error });
        // BEFORE pushing the tool message, reformat any ISO timestamps to Central.
        // This is the deterministic fix for UTC leakage from get_logbook, get_state, etc.
        const reformatted = this._reformatToolResultTimestamps(result);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof reformatted === "string" ? reformatted : JSON.stringify(reformatted)
        });
      }
    }
    this.logAI(
      "iteration_ceiling_synthesize",
      `${maxIterations} iterations hit; forcing synthesis call`,
      { actions_taken: actionsTaken },
      "native_loop"
    );
    safeEmit({ type: "thinking" });
    messages.push({
      role: "user",
      content: "You've gathered enough information. STOP using tools and compose a final reply now from what you already have. No more tool calls. Reply in prose only."
    });
    try {
      const finalResp = await this.callMiniMaxWithTools(messages, [], maxTokens);
      const finalMsg = finalResp.choices?.[0]?.message;
      if (finalMsg) messages.push(finalMsg);
      const cleaned = stripThink(finalMsg?.content || "");
      if (cleaned) {
        safeEmit({ type: "reply", text: cleaned });
        return {
          reply: cleaned,
          actions_taken: actionsTaken,
          messages,
          iterations: maxIterations,
          synthesized: true
        };
      }
      this.logAI("iteration_ceiling_synthesize_empty", "Synthesis call returned empty content", { actions_taken: actionsTaken }, "native_loop");
    } catch (err) {
      this.logAI("error", "Synthesis fallback failed: " + err.message, { actions_taken: actionsTaken }, "native_loop");
    }
    safeEmit({ type: "error", message: "max_iterations_exceeded" });
    return {
      reply: "I hit my iteration ceiling without finishing — actions so far: " + (actionsTaken.length > 0 ? actionsTaken.join(", ") : "none") + ". Re-ask if you need me to continue.",
      actions_taken: actionsTaken,
      messages,
      error: "max_iterations_exceeded",
      iterations: maxIterations
    };
  }

  // ========================================================================
  // Native-loop context helpers — used by chatWithAgentNative.
  //
  // When env.USE_VECTOR_ENTITY_RETRIEVAL === "true" and a non-empty `query`
  // is supplied (and AI+KNOWLEDGE bindings exist), three semantic searches
  // run in parallel: top-15 entities, top-5 memories, top-5 observations.
  // The full memory/observation lists still appear in the system prompt, but
  // the semantic top-K bubbles up the most query-relevant entries — which
  // is the architectural payoff: MiniMax sees the right memory/observation
  // for THIS turn instead of relying solely on the FIFO timeline.
  //
  // Returns { entities, memories, observations, vectorRetrieved }. Falls
  // back to the flat snapshot (with empty memory/observation arrays) on any
  // failure. Memory/observation arrays in the fallback path stay empty
  // because the full lists are already in the prompt — no need to repeat.
  // ========================================================================
  async _buildNativeContextEntities(query = null, options = {}) {
    const { entityTopK = 15 } = options;
    const useVector =
      this.env.USE_VECTOR_ENTITY_RETRIEVAL === "true" ||
      this.env.USE_VECTOR_ENTITY_RETRIEVAL === "1";

    if (useVector && typeof query === "string" && query.trim().length > 0) {
      try {
        // Cross-kind retrieval: in addition to entities/memories/observations,
        // pull a few automations/devices/services so action queries ("turn on
        // the dock light", "lock the front door") have the relevant
        // automation + device pre-injected and the agent doesn't need a
        // separate vector_search round-trip.
        const [
          entityMatches, memoryMatches, observationMatches,
          automationMatches, deviceMatches, serviceMatches
        ] = await Promise.all([
          this.retrieveKnowledge({ query, k: entityTopK, kinds: ["entity"], includeNoisy: false }),
          this.retrieveKnowledge({ query, k: 5, kinds: ["memory"], includeNoisy: false }),
          this.retrieveKnowledge({ query, k: 5, kinds: ["observation"], includeNoisy: false }),
          this.retrieveKnowledge({ query, k: 3, kinds: ["automation"], includeNoisy: false }),
          this.retrieveKnowledge({ query, k: 2, kinds: ["device"], includeNoisy: false }),
          this.retrieveKnowledge({ query, k: 2, kinds: ["service"], includeNoisy: false })
        ]);
        if (Array.isArray(entityMatches) && entityMatches.length > 0) {
          const enriched = entityMatches.map((m) => {
            const entity_id = m.ref_id;
            const cached = this.stateCache.get(entity_id);
            const out = {
              entity_id,
              friendly_name: m.friendly_name || (cached?.attributes?.friendly_name) || entity_id,
              domain: m.domain || (entity_id.split(".")[0] || ""),
              area: m.area || "",
              device_class: m.device_class || (cached?.attributes?.device_class) || "",
              score: typeof m.score === "number" ? Number(m.score.toFixed(3)) : null,
              state: cached ? cached.state : null
            };
            const lastChangedMs = cached?.last_changed ?
              new Date(cached.last_changed).getTime() : null;
            const ageSeconds = lastChangedMs ?
              Math.round((Date.now() - lastChangedMs) / 1000) : null;
            out.age_seconds = ageSeconds;
            if (cached?._fromSnapshot) out.from_snapshot = true;
            const attr = cached?.attributes || {};
            if (out.domain === "climate") {
              out.setpoint = attr.temperature ?? null;
              out.current_temp = attr.current_temperature ?? null;
              out.hvac_action = attr.hvac_action ?? null;
              out.hvac_mode = attr.hvac_mode ?? null;
            } else if (out.domain === "cover") {
              out.current_position = attr.current_position ?? null;
            } else if (out.domain === "weather") {
              out.temperature = attr.temperature;
              out.humidity = attr.humidity;
            } else if (out.domain === "sensor" && attr.unit_of_measurement) {
              out.unit = attr.unit_of_measurement;
            }
            return out;
          });
          return {
            entities: enriched,
            memories: Array.isArray(memoryMatches) ? memoryMatches : [],
            observations: Array.isArray(observationMatches) ? observationMatches : [],
            automations: Array.isArray(automationMatches) ? automationMatches : [],
            devices: Array.isArray(deviceMatches) ? deviceMatches : [],
            services: Array.isArray(serviceMatches) ? serviceMatches : [],
            vectorRetrieved: true
          };
        }
      } catch (err) {
        this.logAI("vector_query", "context build fell back to flat list: " + err.message, {
          query_length: query.length
        }, "vector_query");
      }
    }

    return {
      entities: this._buildFlatContextEntities(),
      memories: [],
      observations: [],
      automations: [],
      devices: [],
      services: [],
      vectorRetrieved: false
    };
  }

  _buildFlatContextEntities() {
    const byDomain = new Map();
    for (const [id, state] of this.stateCache) {
      const domain = id.split(".")[0];
      const attr = state.attributes || {};
      const deviceClass = attr.device_class || "";
      if (domain === "switch" && isNoisySwitch(id)) continue;
      if (state.state === "unavailable" || state.state === "unknown") continue;

      if (HAWebSocketV6.CONTEXT_DOMAIN_PRIORITY.includes(domain)) {
        const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state };
        if (domain === "climate") {
          entry.setpoint = attr.temperature ?? null;
          entry.current_temp = attr.current_temperature ?? null;
          entry.hvac_action = attr.hvac_action ?? null;
          entry.hvac_mode = attr.hvac_mode ?? null;
        }
        if (domain === "cover") {
          entry.current_position = attr.current_position ?? null;
        }
        if (domain === "weather") {
          entry.temperature = attr.temperature;
          entry.humidity = attr.humidity;
          entry.wind_speed = attr.wind_speed;
          entry.wind_bearing = attr.wind_bearing;
          entry.pressure = attr.pressure;
        }
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(entry);
      } else if (domain === "sensor") {
        let include = false;
        if (HAWebSocketV6.SENSOR_WHITELIST.has(deviceClass)) {
          include = true;
        } else if (deviceClass === "battery") {
          const pct = parseFloat(state.state);
          include = !isNaN(pct) && pct <= HAWebSocketV6.BATTERY_LOW_THRESHOLD;
        }
        if (include) {
          const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state, device_class: deviceClass, unit: attr.unit_of_measurement || null };
          if (!byDomain.has("sensor")) byDomain.set("sensor", []);
          byDomain.get("sensor").push(entry);
        }
      }
    }

    const contextEntities = [];
    let sensorCount = 0;
    for (const domain of [...HAWebSocketV6.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
      for (const entry of (byDomain.get(domain) || [])) {
        if (contextEntities.length >= HAWebSocketV6.MAX_CONTEXT_ENTITIES) break;
        if (domain === "sensor") {
          if (sensorCount >= HAWebSocketV6.MAX_SENSOR_CONTEXT) break;
          sensorCount++;
        }
        contextEntities.push(entry);
      }
      if (contextEntities.length >= HAWebSocketV6.MAX_CONTEXT_ENTITIES) break;
    }
    return contextEntities;
  }

  _buildNativeTimeline() {
    const relevantTypes = ["chat_user", "chat_reply", "action", "action_verified", "notification", "decision", "state_change", "memory_saved", "observation_saved"];
    return this.aiLog
      .filter((e) => relevantTypes.includes(e.type))
      .slice(-150)
      .map((e) => `[${HAWebSocketV6._formatTimelineTimestamp(e.timestamp)}] ${e.type}${e.source ? "/" + e.source : ""}: ${e.message}`)
      .join("\n");
  }

  // ========================================================================
  // CHAT_SYSTEM_PROMPT — assembles the per-request system prompt. Pulls
  // identity, architecture, and household reference data from
  // getAgentContext(), then layers GATEWAY HEALTH, TOOLS, COMMITMENT RULE,
  // BUG REPORTS, MEMORY/OBSERVATION GATING, CHAT ACTION CONFIRMATION,
  // QUICK FACTS, RETRIEVAL DISCIPLINE, FORENSIC MEMORY, HOUSE_STATE_SNAPSHOT,
  // UNIFIED TIMELINE, semantic top-K blocks, RELEVANT ENTITIES, and
  // TRUTHFULNESS — STATE CLAIMS.
  // ========================================================================
  getChatSystemPrompt(ctx) {
    const {
      timeline = "",
      contextEntities = [],
      from = "default",
      semanticMemories = [],
      semanticObservations = [],
      semanticAutomations = [],
      semanticDevices = [],
      semanticServices = [],
      climatePreamble = ""
    } = ctx;
    const snapshot = this._buildHouseStateSnapshot();
    const stateHealth = {
      ws_connected: this.connected,
      ws_authenticated: this.authenticated,
      states_ready: this.statesReady,
      last_pong_age_seconds: this.lastPongAt ? Math.round((Date.now() - this.lastPongAt) / 1e3) : null,
      cached_entity_count: this.stateCache.size
    };
    const SCORE_FLOOR = 0.65;
    const relevantMemories = semanticMemories.filter(m => typeof m.score === "number" && m.score >= SCORE_FLOOR);
    const relevantObservations = semanticObservations.filter(o => typeof o.score === "number" && o.score >= SCORE_FLOOR);
    return `${this.getAgentContext()}

You are answering a chat from "${from}". Be concise. Take action when asked. If you took an action, say what you did plainly, past tense, one sentence. If a question needs the timeline or live state, USE THE TOOLS — don't guess.

GATEWAY HEALTH:
${JSON.stringify(stateHealth, null, 1)}

TOOLS — attached to this request. Invoke them directly. The turn you emit NO tool calls is your final reply.
- call_service — execute any HA service (lights, locks, covers, climate, scripts, scenes). Use for destructive/irreversible actions too.
- ai_send_notification — push to phone AND log to timeline. Reserve for security events, aux heat >5000W sustained, leaks, unexpected entry.
- save_memory — persist a CONFIRMED fact (100-slot FIFO). CHAT-PATH RULE: see SAVING MEMORIES / OBSERVATIONS below — only on explicit user request.
- save_observation — persist a pattern or hypothesis prefixed with [topic-tag]. Stored in D1; same [tag] overwrites the prior entry. Use replaces="[topic-tag]" to explicitly overwrite. CHAT-PATH RULE: only on explicit user request — see below.
- get_state — single entity's full state when the snapshot below lacks detail.
- get_logbook — historical entries. ALWAYS pass tz_offset="-05:00" for Central time.
- render_template — Jinja2 in HA context (area_name, device_attr, expand, state_attr).
- vector_search — semantic search over the unified knowledge index (entities, automations, scripts, scenes, areas, devices, HA services, your memories, your observations). The pre-injected context below is a small top-K slice — vector_search covers the FULL knowledge base. Call it aggressively when something isn't in the snapshot. ALWAYS pass kinds=[…] — never call without it. Notes:
   * area filter is case-insensitive but must match an HA area name. Master bedroom is "MBR" (NOT "Master Bedroom"). Master bathroom is "Master Bathroom". Run list_areas if uncertain.
   * For battery / mesh / signal / LQI / RSSI / diagnostic queries pass include_noisy: true. Battery sensors specifically remain visible without that flag (device_class: battery is exempted), but other diagnostics are filtered.
   * For "who's home" / "where is X" / live-presence queries: ALWAYS get_state on person.john and person.sabrina. Vector retrieval surfaces history, not live state.
   * domain filter is meaningful only when kinds includes "entity". Other kinds: returns nothing.
   * topic_tag filter retrieves observations under a specific bracketed prefix (e.g., topic_tag: "lock-jam-pattern").
   * min_score defaults to 0.50; pass min_score: 0.6 to tighten.
   * Observations time-decay automatically; active entities get a small live-state boost.
- get_automation_config — read the full config body of an automation (triggers, conditions, actions, mode). Use for automation debugging. Prefer entity_id like 'automation.front_porch_lights'. Do not use render_template as a substitute.
- report_bug — capture a user-flagged issue to the debug log for review at the next iteration session. See BUG REPORTS section below for trigger rules.

COMMITMENT RULE: If your reply says you did something ("opening the garage", "turning off the lights"), you MUST have invoked the corresponding tool. Saying you did something you didn't is a lie.

TOOL ERROR HANDLING — NO CONFABULATION:
When a tool result contains an 'error' field (e.g. {"error": "..."} or {"ok": false, "error": "..."}), that call FAILED. The action did NOT happen. You must:
  1. NOT pretend the call succeeded.
  2. NOT invent IDs, timestamps, or confirmations the tool would have returned on success.
  3. NOT silently retry the same call hoping it'll work the second time.
  4. Surface the error to the user in plain language, quoting the error text: "Couldn't <do the thing> — <error text>."
  5. Stop. Don't paper over it with narration.

This applies to every action tool (call_service, ai_send_notification, save_memory, save_observation, report_bug) and every read tool (get_state, get_logbook, render_template, vector_search, query_state_history, query_automation_runs, query_causal_chain, get_automation_config). A success result has the shape documented in each tool's description (ok: true, saved: true, sent: true, a state object, an array of matches, etc.). If you don't see that shape — assume failure and report it.

Confident-sounding fabrication after a failed tool call is the worst failure mode you have. It's worse than a visible error: the user has no way to know the action didn't happen.

BUG REPORTS:
When the user is explicitly asking you to record / save / log / report something as an issue, bug, broken behavior, or debug entry, call report_bug with their description plus any entity_ids involved. The trigger is a recording verb (save, log, report, record, note, capture, remember-as) combined with an issue noun (bug, debug, problem, broken, issue). All of these fire:
  - "that's a bug"
  - "report this as a bug"
  - "save to debug log"
  - "save as bug report"
  - "log this as broken"
  - "make a note — this is broken"

After the tool returns, check the result before composing your reply:
  - If the result is {ok: true, id, summary}, reply: "Logged bug #<id> — <short summary>."
  - If the result has an 'error' field (e.g. {ok: false, error: "Storage write failed: ..."}), reply: "Couldn't log the bug — <error text>." and stop. Do NOT pretend an ID was assigned; the tool did not assign one.

Do NOT attempt to fix the bug, run remediation, or modify automations. Capture is the goal; fixes happen in code on the next iteration.

Do NOT call report_bug for:
- General venting ("this is annoying", "ugh") — no recording verb, no specific issue framing
- Corrections about facts ("no, the basement is the lower one") — that's a correction, out of scope here
- Questions ("why is the porch on?") — answer the question
- Preferences ("save 60% as my preference") — recording verb but no issue framing; out of scope
- Normal task flow

If the user describes a problem but doesn't explicitly ask you to log it, ask once: "Want me to log that as a bug?" Do not call report_bug until they confirm. Don't infer aggressively.

SAVING MEMORIES / OBSERVATIONS:
On the chat path, only call save_memory or save_observation when the user explicitly asks you to remember, save, note, or log something. Do not save memories or observations as a side effect of normal conversation. When you do save, confirm in your reply with the exact text saved, e.g. "Saved to memory: [text]."

Trigger phrases that justify a call:
- "remember that ..." / "remember: ..."
- "save this: ..." / "save to memory: ..."
- "note that ..." / "make a note: ..."
- "log that ..." / "save as an observation: ..."
- "don't forget: ..."

Do NOT call save_memory/save_observation for:
- Routine factual statements ("the basement is cold tonight") — that's conversation, not a save request
- Corrections ("no, it's the lower one") — adjust your reply, don't write to memory
- Preferences expressed in passing ("I usually like the lights low") — unless paired with an explicit save verb
- Anything you inferred or hypothesized yourself this turn

save_observation is for patterns / hypotheses prefixed with a [topic-tag]; stored in D1, deduplicated by topic-tag (same [tag] overwrites prior). Use replaces="[topic-tag]" to explicitly overwrite under the same tag.

${this._saveMemoryCriteriaBlock()}

CHAT ACTION CONFIRMATION:
The rule depends on WHO proposed the action.

CASE A — User-initiated action.
The user has typed a direct instruction to actuate a device. Examples:
- "close the garage door"
- "lock the front door"
- "open the basement bay"
- "set the basement to 68"

In Case A, the user's message IS the confirmation. Act immediately. Do not ask "are you sure?" — that's annoying and slows things down. The user committed by typing the instruction.

CASE B — Agent-initiated action (you proposed it).
You suggested an action and are waiting for the user to confirm. Examples of you proposing:
- "Want me to close the garage door?"
- "Should I lock everything up?"
- "I noticed the bay has been open a while — close it?"

In Case B, the user's NEXT message must be EXPLICIT, UNAMBIGUOUS, AFFIRMATIVE confirmation before you actuate.

What counts as confirmation in Case B:
- "yes" / "yes please" / "do it" / "go ahead" / "close it" / "lock it" / "confirmed"
- A direct restatement of the action

What does NOT count in Case B, even though you asked first:
- Sound effects, beatboxes, emojis, reactions ("haha", "🙃", "(beatbox)", "lol")
- Silence or no response
- Topic changes — if the user's next message is about something else, treat your question as unanswered and DO NOT act
- Vague positive vibes ("ok", "sure" — these are weak; if there is ANY ambiguity, ask again with a yes/no framing)
- Charitable interpretation. If you find yourself reasoning "I'll interpret this as yes because they seem engaged" — STOP. That reasoning is the bug. Engagement is not consent.

When in Case B and confirmation is unclear, the correct action is to ask once more with an explicit yes/no framing:
  "Just to confirm — close the main garage bay now? Yes or no."

If confirmation is still unclear after that, take NO action. Wait.

The asymmetry is intentional. A direct command from the user is fast. A response to your own offer requires real confirmation, because you're the one interpreting ambiguity, and ambiguity in physical actuation is dangerous.

This applies to: covers (garage/basement bay doors, blinds), locks, alarm arm/disarm, high-power appliances. For lights, switches, and climate within normal range, you may act on weaker signals — but use judgment.

QUICK FACTS:
- climate.t6_pro_z_wave_programmable_thermostat_2 = main level INCLUDING MBR
- climate.t6_pro_z_wave_programmable_thermostat = basement
- Smoke/CO detectors are NOT in HA — don't reference their state.
- Automation editing via call_service returns 405 on this instance — tell John to edit in HA UI (Settings → Automations).
- All timestamps in your replies MUST be Central, in "H:MM AM/PM" or "MMM D, H:MM AM/PM" format. Tool results are pre-reformatted to Central before they reach you — copy them as-is. Never emit ISO 8601, "Z" suffix, "+00:00", or "UTC" in any reply, even if you think you saw one in a tool result. If you ever see one, that's a bug — paraphrase, don't quote.
- You are the chat agent. Your always-on memory of the house is the forensic log — see FORENSIC MEMORY above and query it freely. See SAVING MEMORIES / OBSERVATIONS below for when save_memory/save_observation are allowed on this path. For security-sensitive actuations (covers, locks, alarms), follow the CHAT ACTION CONFIRMATION rules above.
- For automation debugging, call get_automation_config when the user references a specific automation or asks why one did or did not run. Logbook tells you whether it fired; config tells you what it was supposed to do.
${climatePreamble ? "\n" + climatePreamble + "\n" : ""}
RETRIEVAL DISCIPLINE:
- The pre-injected entity context is intentionally small. Do not assume an entity doesn't exist just because it's not listed below.
- If the user asks about an entity, room, or device you cannot see in the snapshot, your first move is vector_search — not "I don't see that" and not a guess at the entity_id.
- If you're about to answer "I don't have that entity" or "I can't find X," stop and call vector_search first. Only after a vector_search returns nothing relevant should you tell the user it doesn't exist.
- When two entities have similar friendly names (common with the basement bay doors, the front door sensors, the iPhone trackers), use vector_search with metadata filters (domain, area) to disambiguate before acting.

FORENSIC MEMORY — your always-on log of the house.
Every state change, automation run, and service call in this house lands in a queryable forensic log (D1 tables: state_changes, automation_runs, service_calls). You have three tools for it:
- query_state_history — raw state transitions for any entity or domain over any time window. Use for "did the door open at 7:14", "when did the basement lock last cycle", "what changed in the last 4 hours".
- query_automation_runs — automation fires. Use for "did the front-porch automation run last night", "what triggered automation X".
- query_causal_chain — given a context_id from any forensic row, walks parents and children to show what caused this and what this caused. Use for "why did the porch light fail when the door opened" — pull the door's state_change, take its context_id, and walk the chain.

Trust the forensic log over your priors. When the user asks about anything that happened — what fired, what changed, when, why, why not — query the log directly. You don't have to guess and you don't have to bounce through get_logbook. Pre-injected context (HOUSE_STATE_SNAPSHOT, RELEVANT ENTITIES, UNIFIED TIMELINE) is a recent slice; the forensic log is the full record.

NARRATION OVER ENUMERATION. Query results come back as raw rows. Synthesize them into a narrative — pull out the story, flag the anomaly, lead with the answer. Don't dump a table. Use the fired_at_central field directly in your reply; never emit UTC.

${snapshot}

UNIFIED TIMELINE — recent events (chat, state changes, your past actions). Already pre-formatted in Central time:

${timeline || "Timeline is empty."}

${relevantMemories.length > 0 ? `RELEVANT MEMORIES (semantic top-matches for this turn):
${relevantMemories.map((m) => "- [score " + m.score.toFixed(2) + "] " + (m.friendly_name || "")).join("\n")}

` : ""}${relevantObservations.length > 0 ? `RELEVANT OBSERVATIONS (semantic top-matches for this turn):
${relevantObservations.map((o) => "- [score " + o.score.toFixed(2) + "] " + (o.friendly_name || "")).join("\n")}

` : ""}${semanticAutomations.length > 0 ? `RELEVANT AUTOMATIONS (semantic top-matches — use as candidates for action queries):
${semanticAutomations.map((a) => "- [score " + (typeof a.score === "number" ? a.score.toFixed(2) : "?") + "] " + (a.friendly_name || a.ref_id || "")).join("\n")}

` : ""}${semanticDevices.length > 0 ? `RELEVANT DEVICES (semantic top-matches):
${semanticDevices.map((d) => "- [score " + (typeof d.score === "number" ? d.score.toFixed(2) : "?") + "] " + (d.friendly_name || d.ref_id || "")).join("\n")}

` : ""}${semanticServices.length > 0 ? `RELEVANT HA SERVICES (semantic top-matches — call_service candidates):
${semanticServices.map((s) => "- [score " + (typeof s.score === "number" ? s.score.toFixed(2) : "?") + "] " + (s.friendly_name || s.ref_id || "")).join("\n")}

` : ""}RELEVANT ENTITIES (${contextEntities.length}, semantic top-K from live state cache) — an entity not here may still exist; use vector_search or get_state to probe. state=null means HA hasn't reported a value. Don't invent entity_ids or fabricate timestamps for events you didn't witness.

${JSON.stringify(contextEntities, null, 1)}

TRUTHFULNESS — STATE CLAIMS:
- Before asserting the current state of ANY entity in a reply — locks, covers, lights, switches, climate, sensors, power, presence, anything — you must have either (a) the entity in the HOUSE_STATE_SNAPSHOT block above, (b) called get_state on it in this turn, or (c) seen the entity_id and value explicitly in the pre-injected context block. If none of those is true, do NOT state the value.
- Never aggregate ("all lights off," "everything secure," "all 3 garage doors closed," "nothing running") without per-entity verification. The HOUSE_STATE_SNAPSHOT covers locks, covers, climate, presence, power, and key contact sensors — for those, read the snapshot. For anything else in an aggregate claim, call get_state on each entity in the aggregate this turn.
- If asked for a house summary or "what's going on," base security/climate/presence claims on the HOUSE_STATE_SNAPSHOT. For lights, switches, or anything outside the snapshot, call get_state for each entity you intend to mention.
- If you don't have a value, say so plainly: "I don't have a current read on the [entity] — let me check" or just omit it. Do NOT fill the gap with inference, vibe, or what was true earlier in this conversation.
- The unified timeline above shows recent state CHANGES, not current state. An entity not appearing in the timeline does NOT mean its state hasn't changed — it means no event flowed in the recent window. Always verify with snapshot or get_state before reporting.
- Confident-sounding fabrication is the worst failure mode you have. John would rather hear "I don't know, let me check" than a confident wrong answer.`;
  }

  // ========================================================================
  // Native chat (Phase 2) — flag-gated sibling of chatWithAgent.
  // Returns { reply, actions_taken, error? } — mirrors legacy chat contract.
  // ========================================================================
  async chatWithAgentNative(message, from = "default", onEvent = null) {
    // FAST PATH: deterministic cover commands skip the LLM entirely.
    // Sub-500ms response for "open the garage", "close the basement bay", etc.
    // Always uses explicit open_cover or close_cover, never toggle.
    const _t0 = Date.now();
    const fastResult = await this._tryDeterministicFastPath(message);
    const _t1 = Date.now();
    if (fastResult) {
      const fpChannelKey = sanitizeChannelKey(from);
      const fpHistoryKey = `chat_history:${fpChannelKey}`;
      this.logAI("chat_user", `${from}: ${message}`, { from, message, channel: fpChannelKey });
      this.logAI("chat_reply", fastResult.reply, {
        from,
        full_reply: fastResult.reply,
        channel: fpChannelKey,
        fast_path: true
      });
      this.logAI("chat", `done | exec=${fastResult.actions_taken.length} fast_path=true`, {
        actions_executed: fastResult.actions_taken.length,
        from,
        channel: fpChannelKey,
        fast_path: true
      });
      // Persist to chat_history so subsequent turns have context.
      // Replicates the same MAX_TURNS / HISTORY_BYTE_CAP trimming as the LLM path.
      try {
        const fpHistory = await this.state.storage.get(fpHistoryKey) || [];
        const fpNext = [
          ...fpHistory,
          { role: "user", content: `[${from}]: ${message}` },
          { role: "assistant", content: fastResult.reply }
        ];
        const MAX_TURNS = 10;
        const fpUserIdxs = [];
        for (let i = 0; i < fpNext.length; i++) {
          if (fpNext[i].role === "user") fpUserIdxs.push(i);
        }
        if (fpUserIdxs.length > MAX_TURNS) {
          fpNext.splice(0, fpUserIdxs[fpUserIdxs.length - MAX_TURNS]);
        }
        const HISTORY_BYTE_CAP = 110000;
        while (fpNext.length > 2 && JSON.stringify(fpNext).length > HISTORY_BYTE_CAP) {
          fpNext.shift();
        }
        await this.state.storage.put(fpHistoryKey, fpNext);
      } catch (_) {}
      console.log(JSON.stringify({ chat_timing_ms: { fast_path: true, total: Date.now() - _t0 } }));
      await this.persistLog();
      if (onEvent) onEvent({ type: "reply", text: fastResult.reply });
      return fastResult;
    }

    const now = new Date();
    const now_str = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    const channelKey = sanitizeChannelKey(from);
    const historyKey = `chat_history:${channelKey}`;

    // Stash the active chat sender so executeNativeTool/report_bug can attach
    // the correct per-channel chat history. Cleared in the finally below.
    this._activeChatFrom = from;

    const conversationHistory = await this.state.storage.get(historyKey) || [];
    const _t2 = Date.now();
    this.logAI("chat_user", `${from}: ${message}`, { from, message, channel: channelKey });
    const timeline = this._buildNativeTimeline();

    // Chat profile uses tighter top-K than autonomous (10 vs 15) to keep
    // prompt focused. Override the default by passing topK.
    const {
      entities: contextEntities,
      memories: semanticMemories,
      observations: semanticObservations,
      automations: semanticAutomations,
      devices: semanticDevices,
      services: semanticServices
    } = await this._buildNativeContextEntities(message, { entityTopK: 10 });
    const _t3 = Date.now();

    const climatePreamble = await this._buildClimatePreambleIfNeeded(message, "chat_native");
    const _t4 = Date.now();

    const systemPrompt = this.getChatSystemPrompt({
      timeline,
      contextEntities,
      semanticMemories,
      semanticObservations,
      semanticAutomations,
      semanticDevices,
      semanticServices,
      from,
      climatePreamble: climatePreamble || ""
    });

    const initialMessages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: `Current time: ${now_str}\n\n${message}` }
    ];

    try {
      const oldHistoryLen = conversationHistory.length;
      const _t5 = Date.now();
      const result = await this.runNativeToolLoop(initialMessages, {
        maxIterations: 6,
        onEvent,
        allowedTools: NATIVE_AGENT_TOOLS.filter(t => CHAT_ALLOWED_TOOL_NAMES.has(t.function.name)),
        hallucinationGuard: true,
        maxTokens: 4096
      });
      const _t6 = Date.now();
      console.log(JSON.stringify({
        chat_timing_ms: {
          fast_path: false,
          channel: channelKey,
          storage_read: _t2 - _t1,
          vectorize_context: _t3 - _t2,
          climate_preamble: _t4 - _t3,
          prompt_build: _t5 - _t4,
          minimax_tool_loop: _t6 - _t5,
          total: _t6 - _t0,
          tool_iterations: result.iterations ?? null
        }
      }));
      const reply = result.reply && result.reply.trim() || "Done.";
      this.logAI("chat_reply", reply.substring(0, 300), { from, full_reply: reply, channel: channelKey }, "native_loop");

      const TOOL_CONTENT_CAP = 4000;
      const loopAdditions = result.messages.slice(1 + oldHistoryLen + 1).map((m) => {
        if (m.role === "tool" && typeof m.content === "string" && m.content.length > TOOL_CONTENT_CAP) {
          return { ...m, content: m.content.substring(0, TOOL_CONTENT_CAP) + "…[truncated]" };
        }
        return m;
      });
      while (loopAdditions.length > 0) {
        const last = loopAdditions[loopAdditions.length - 1];
        const pendingTools = last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
        if (last.role === "assistant" && !pendingTools) break;
        loopAdditions.pop();
      }
      const endsCleanly = loopAdditions.length > 0
        && loopAdditions[loopAdditions.length - 1].role === "assistant"
        && !loopAdditions[loopAdditions.length - 1].tool_calls?.length;
      if (!endsCleanly) {
        loopAdditions.push({ role: "assistant", content: reply });
      }
      const nextHistory = [
        ...conversationHistory,
        { role: "user", content: `[${from}]: ${message}` },
        ...loopAdditions
      ];
      const MAX_TURNS = 10;
      const userIdxs = [];
      for (let i = 0; i < nextHistory.length; i++) {
        if (nextHistory[i].role === "user") userIdxs.push(i);
      }
      if (userIdxs.length > MAX_TURNS) {
        nextHistory.splice(0, userIdxs[userIdxs.length - MAX_TURNS]);
      }
      const HISTORY_BYTE_CAP = 110000;
      while (nextHistory.length > 2 && JSON.stringify(nextHistory).length > HISTORY_BYTE_CAP) {
        nextHistory.shift();
      }
      await this.state.storage.put(historyKey, nextHistory);
      this.logAI(
        "chat",
        `done | exec=${result.actions_taken.length} iter=${result.iterations}${result.error ? " err=" + result.error : ""}`,
        {
          actions_executed: result.actions_taken.length,
          from,
          channel: channelKey,
          iterations: result.iterations,
          context_size: contextEntities.length,
          ...result.error ? { error: result.error } : {}
        },
        "native_loop"
      );
      await this.persistLog();
      return {
        reply,
        actions_taken: result.actions_taken,
        ...result.error ? { error: result.error } : {}
      };
    } catch (err) {
      console.log(JSON.stringify({
        chat_timing_ms: {
          fast_path: false,
          channel: channelKey,
          error: err.message,
          failed_at_ms: Date.now() - _t0
        }
      }));
      this.logAI("chat_error", err.message, { from, channel: channelKey }, "native_loop");
      return { error: "AI failed: " + err.message };
    } finally {
      // Clear the per-call stash so report_bug from a stale loop never
      // attaches the wrong channel.
      this._activeChatFrom = null;
    }
  }

  // ========================================================================
  // Alarm handler — WS keepalive only. Reschedules itself unconditionally.
  // The reschedule is MANDATORY — it's a redundant DO keepalive alongside
  // the persistent HA WebSocket and the minute-cadence prewarmCache cron.
  // Without it, the DO can hibernate when the WS goes quiet. Do not remove.
  // ========================================================================
  async alarm() {
    if (!this.connected || !this.authenticated) {
      await this.connect();
    } else {
      const now = Date.now();
      if (this.pingInFlight && (now - this.lastPingSentAt) > 15000) {
        this.logAI("ws_dead_no_pong",
          `No pong in ${now - this.lastPingSentAt}ms — reconnecting`,
          { last_pong_age_ms: now - this.lastPongAt });
        this.disconnect();
        await this.connect();
      } else if (!this.pingInFlight) {
        try {
          this.pingId = this.msgId++;
          this.ws.send(JSON.stringify({ type: "ping", id: this.pingId }));
          this.pingInFlight = true;
          this.lastPingSentAt = now;
        } catch {
          this.disconnect();
          await this.connect();
        }
      }
    }

    await this.state.storage.setAlarm(Date.now() + 60000);
  }
}
