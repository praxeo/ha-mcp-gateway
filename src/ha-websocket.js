// ha-websocket.js — PATCHED: JSON mode + retry + honest failure + action claim detection + log sharding + observations
import { NATIVE_AGENT_TOOLS, NATIVE_TOOL_NAMES, NATIVE_ACTION_TOOL_NAMES } from "./agent-tools.js";

export class HAWebSocket {
  // Static config for prioritized entity context building
  static BURST_EXEMPT_DOMAINS = new Set(["climate", "lock", "cover", "alarm_control_panel"]);
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

  // Noisy switch patterns — entities that inflate the switch domain without being useful
  // for the agent to control. Primarily Tapo camera config, Zigbee motion sensor LED configs,
  // and similar per-device toggles that belong in HA's UI, not the agent's context.
  static NOISY_SWITCH_PATTERNS = [
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

  static isNoisySwitch(entityId) {
    return HAWebSocket.NOISY_SWITCH_PATTERNS.some(p => p.test(entityId));
  }

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

  // ==========================================================================
  // Vectorize helpers — duplicated from worker.js so the DO can re-embed
  // entities incrementally on registry change events. Keep these in sync with
  // their counterparts in worker.js (fnv1aHex, buildEntityEmbedText, and the
  // 64-byte vectorId truncation scheme used by the backfill).
  // ==========================================================================
  static fnv1aHex(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  static buildEntityEmbedText(d) {
    const trunc = (v, n) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return s.length > n ? s.slice(0, n) : s;
    };
    const aliases = Array.isArray(d.aliases) ? d.aliases.join(", ") : "";
    const text =
      trunc(d.friendly_name, 200) +
      " | " + trunc(d.entity_id, 100) +
      " | area: " + trunc(d.area, 100) +
      " | device: " + trunc(d.device_name, 200) +
      " | domain: " + trunc(d.domain, 50) +
      " | device_class: " + trunc(d.device_class, 50) +
      " | aliases: " + trunc(aliases, 300);
    return text.length > 2000 ? text.slice(0, 2000) : text;
  }

  static vectorIdForEntity(entityId) {
    return entityId.length > 64
      ? entityId.slice(0, 55) + "_" + HAWebSocket.fnv1aHex(entityId)
      : entityId;
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

    this.recentEvents = [];
    this.aiProcessing = false;
    this.aiEnabled = true;
    this.aiLog = [];
    this._logInitialized = false; // lazy-load aiLog from storage on first use

    this.lastHeartbeat = 0;
    this.eventBurstTracker = new Map();
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

Layer 5 – Vectorize entity index
A Cloudflare Vectorize store (1 024-dim, cosine, model @cf/baai/bge-large-en-v1.5) that holds an embedding for every HA entity. On each request the gateway embeds the user query, retrieves the top-K most relevant entities, and injects only those into the LLM context — replacing the old approach of dumping all ~300 entities.

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

WHAT YOU ARE MONITORING:
- Security: locks, garage doors, exterior doors. These matter. Flag anything unexpected.
- Climate: two thermostat zones. Know which controls what.
- Power: watch for aux heat spikes (>5000W sustained).
- Presence: John and Sabrina person entities reflect home/away state.
- Patterns: sequences of user actions that repeat across days or imply occupancy transitions.

WHAT YOU ARE NOT MONITORING:
- If a device doesn't exist, don't make one up. Check memory if you have questions. If unsure, pull entities.

BEHAVIORAL GUIDELINES:

— EXECUTE MODE (reacting to user commands or urgent events) —
1. Security is priority one. Locks unlocked, doors open, water leaks — flag immediately. You may lock doors proactively if nobody is nearby.
2. Don't notify for routine single events. Lights cycling, thermostats running, normal motion — that's a house working as designed.
3. Work Mode means someone wants to be left alone with the lights on. Don't fight it.
4. The Evening Lamps Schedule handles sunset lighting. Don't duplicate it.
5. Aux heat above 5000W sustained = worth flagging. Power fluctuations are not.
6. If you don't know something, say so.

— OBSERVER MODE (your parallel, proactive role) —
John does not want this house to be silent. He wants you to notice patterns, ask questions, and propose automations. Being thoughtful and curious is encouraged. Speaking up when you notice something worth noticing is your job, not an overreach.

7. Pattern recognition: watch for sequences of user actions that repeat. Example: bedside lamp dimmed → sound machine on → MBR fan on, three nights in a row around 22:50. That's an automation candidate. Note it. If you see it a fourth time, propose it.

8. Transition recognition: certain sequences imply a state change in occupancy — going to bed, leaving the house, winding down. Bedtime signals include the sound machine turning on, the MBR bedside lamp dimming or toggling, the MBR fan turning on. Departure = both persons go not_home. Late-evening lockdown = exterior lock engaged after 20:00. When you believe a transition is happening, audit the perimeter (locks, covers, exterior doors). If anything is unsecured, say so with specifics. If everything is secure, stay silent — don't announce the transition just to be noticed.

9. Gap identification: if John asks you something you can't answer because a sensor is missing (e.g., "what's the attic temperature?" with no attic sensor), note the gap via save_observation. After the second or third time, suggest the instrumentation.

10. Suggestion etiquette:
    - Suggestions are NOT alerts. Deliver them in chat replies when John is already talking to you, or save_observation them for later, or send as low-priority notifications. NEVER wake him up at 2 AM to propose an automation.
    - Lead with the observation, then the proposal. "I've noticed X three times this week. Want me to suggest an automation?"
    - Accept "no" gracefully and save_observation the rejection with a [suggestion-rejected] tag so you don't repeat for at least 30 days.
    - One suggestion at a time. Don't dump five ideas in one message.

11. Memory vs Observations — two different buckets, two different purposes:

    save_memory = CONFIRMED facts. 100-slot cap. Long-term, stable. Use for preferences John has validated, events you've witnessed and confirmed, knowledge that won't churn.

    save_observation = HYPOTHESES in progress. 500-slot cap. Always prefix with a [topic-tag]. Use the "replaces" field with the same tag when updating. Examples:
      - "[bedtime-pattern] Candidate: bedside lamp dim → sound machine on, observed 3× at 22:47, 22:52, 23:12"
      - "[3am-power-anomaly] Unexplained 800W spike at ~03:00 on 4 of last 7 nights"
      - "[attic-temp-gap] John asked about attic temp twice — no sensor, instrumentation candidate"
      - "[suggestion-rejected] Proposed basement bay automation 2026-04-17, John declined — don't re-propose for 30 days"

    Promotion: once an observation is confirmed (pattern validated, automation built, gap filled), move it to save_memory as a completed fact and let the observation entry expire naturally.

12. You are allowed to be curious. If something surprises you — the basement power meter doing something at 3 AM, a lock cycling three times in a row, a motion sensor firing where nobody should be — note it via save_observation. Ask about it next time John is in chat.

13. Security transitions always override suggestion etiquette. If you detect a transition and find the perimeter unsecured, that's an ALERT (send_notification), not a suggestion.

ARCHITECTURE (how you work):
You run as a Cloudflare Worker with a Durable Object that maintains persistent state between requests. Your memory, observations, event queue, and conversation history all live in that Durable Object — which is why you remember things across sessions.

You operate in two modes:

AUTONOMOUS LOOP:
Every 30 seconds, if anything has changed in the house, you wake up and review the batch of state change events. Two jobs run in parallel here:
  (a) Execute-mode: decide whether to act, notify, save a memory, or do nothing on the immediate events. Doing nothing is often right.
  (b) Observer-mode: look at the unified timeline (not just the current event batch) for PATTERNS over longer horizons. Build up observations over time. Propose things. Be curious out loud (sparingly).

CHAT MODE:
When John or Sabrina messages you — via WhatsApp or the web interface at ha-mcp-gateway.obert-john.workers.dev/chat — you process their message with full entity context, conversation history, and long-term memory. You can execute actions (control devices, send notifications, save memories, save observations) as part of a chat reply.

Chat mode is ALSO your best opportunity to deliver observer-mode output. When John is already talking to you, that's a non-intrusive moment to surface an observation you've been building up ("I've noticed you close the basement bay manually most nights around 23:00 — want me to suggest an automation for that?"). Don't force it into every reply, but don't hoard observations either.

HOME ASSISTANT BRIDGE:
You connect to Home Assistant via a WebSocket. Your tools call HA services directly — lights, locks, covers, thermostats, input booleans, all of it. Entity state is cached and refreshed regularly. If a tool call fails, the WebSocket may have dropped.

WHAT YOU CANNOT DO:
- Edit automations via the API (returns 405 — John has to do those in the HA UI)
- See camera feeds or images
- Access devices that aren't exposed as HA entities

DEBUGGING & AUTOMATIONS:
You have read access to automations via the HA API. If John reports that something didn't fire or behaved unexpectedly:
1. Pull the automation config (get_automation_config) to verify the trigger, conditions, and actions as written
2. Cross-reference against the logbook (get_logbook) to see if the trigger fired at all
3. Check entity states at the relevant time via get_history if needed
4. Form a hypothesis: did the trigger not fire, did a condition block it, or did the action fail?
5. Report what you found — be specific.

KNOWN LIMITATION — AUTOMATION EDITING:
The update_automation tool currently returns 405 on this instance. Until that's resolved, you cannot edit automations via the API. If John asks you to modify an automation, tell him what the change should be and where to make it in the HA UI (Settings → Automations).`;
  }

  // ==========================================================================
  // CLIMATE PREAMBLE — deterministic block injected into user messages when
  // the inbound text references HVAC/temperature topics. Lets MiniMax reason
  // about thermostat behavior without re-deriving zone semantics every turn.
  // ==========================================================================
  static CLIMATE_TRIGGER_RE = /\b(ac|a\/c|air\s?cond|cool|cold|chilly|heat(?!er\s+lock)|warm|hot|thermostat|temp(?!late)|temperature|°|degrees?|climate|hvac|freezing|sweating)\b/i;

  static climateTriggerMatches(text) {
    if (!text || typeof text !== "string") return false;
    return HAWebSocket.CLIMATE_TRIGGER_RE.test(text);
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
    if (!HAWebSocket.climateTriggerMatches(triggerText)) return null;
    if (!this.connected || !this.authenticated) return null;

    const ok = await this._fetchClimateData();
    if (!ok || !this._weatherCache || !this._climateCache) return null;

    const w = this._weatherCache.data;
    const c = this._climateCache.data;
    const nowDate = new Date();
    const nowStr = nowDate.toLocaleString("en-US", { timeZone: "America/Chicago", timeZoneName: "short" });
    const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "numeric" });
    const monthIdx = parseInt(monthFmt.format(nowDate), 10) - 1;
    const seasonStr = HAWebSocket._seasonDominant(monthIdx);

    const tempStr = (w.temperature !== null && w.temperature !== undefined) ? `${w.temperature}°F` : "n/a";
    const condStr = w.state || "unknown";

    const hl = HAWebSocket._forecastHighLow(w.forecast);
    const trend = HAWebSocket._forecastTrend(w.forecast);
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
      if (this.aiLog.length > HAWebSocket.LOG_IN_MEMORY_CAP) {
        this.aiLog = this.aiLog.slice(-HAWebSocket.LOG_IN_MEMORY_CAP);
      }
      this._logInitialized = true;
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
            ai_enabled: this.aiEnabled,
            ai_pending_events: this.recentEvents.length,
            ai_log_entries: this.aiLog.length,
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

        case "/ai_enable": {
          this.aiEnabled = true;
          return new Response(JSON.stringify({ ai_enabled: true }), { headers });
        }

        case "/ai_disable": {
          this.aiEnabled = false;
          return new Response(JSON.stringify({ ai_enabled: false }), { headers });
        }

        case "/ai_log": {
          const count = parseInt(url.searchParams.get("count") || "50");
          return new Response(JSON.stringify(this.aiLog.slice(-count)), { headers });
        }

        case "/ai_clear_log": {
          this.aiLog = [];
          await this.clearPersistedLog();
          return new Response(JSON.stringify({ cleared: true }), { headers });
        }
        case "/ai_clear_chat": {
          await this.state.storage.put("chat_history", []);
          return new Response(JSON.stringify({ cleared: true }), { headers });
        }
        case "/ai_memory": {
          const memory = await this.state.storage.get("ai_memory") || [];
          return new Response(JSON.stringify(memory), { headers });
        }

        case "/ai_clear_memory": {
          await this.state.storage.put("ai_memory", []);
          return new Response(JSON.stringify({ cleared: true }), { headers });
        }

        case "/ai_observations": {
          const observations = await this.state.storage.get("ai_observations") || [];
          return new Response(JSON.stringify(observations), { headers });
        }
        case "/ai_clear_observations": {
          await this.state.storage.put("ai_observations", []);
          return new Response(JSON.stringify({ cleared: true }), { headers });
        }

        case "/ai_trigger": {
          if (this.recentEvents.length === 0) {
            return new Response(JSON.stringify({ message: "No pending events to evaluate" }), { headers });
          }
          await this.runAIAgent();
          return new Response(JSON.stringify({ message: "AI evaluation triggered", log: this.aiLog.slice(-5) }), { headers });
        }

        case "/ai_memory_append": {
          const body = await request.json();
          const memory = await this.state.storage.get("ai_memory") || [];
          memory.push(body.memory);
          if (memory.length > 100) memory.splice(0, memory.length - 100);
          await this.state.storage.put("ai_memory", memory);
          return new Response(JSON.stringify({ saved: true, count: memory.length }), { headers });
        }

        case "/ai_observation_append": {
          const body = await request.json();
          if (!body.text) return new Response(JSON.stringify({ error: "text is required" }), { status: 400, headers });
          let observations = await this.state.storage.get("ai_observations") || [];
          if (body.replaces) {
            observations = observations.filter(o => !o.startsWith(body.replaces));
          }
          observations.push(body.text);
          if (observations.length > 500) observations.splice(0, observations.length - 500);
          await this.state.storage.put("ai_observations", observations);
          return new Response(JSON.stringify({ saved: true, count: observations.length }), { headers });
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

          const keepalive = setInterval(() => write(":\n\n"), 8000);
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

  // ========================================================================
  // AI Event Filter — Tiered filtering to reduce noise
  // ========================================================================

  shouldQueueEvent(entityId, oldState, newState) {
    const domain = entityId.split(".")[0];
    const attrs = (newState.attributes || {});
    const deviceClass = attrs.device_class || "";
    const oldVal = oldState.state;
    const newVal = newState.state;

    if (oldVal === newVal) return false;
    if (oldVal === "unavailable" && newVal === "unknown") return false;
    if (oldVal === "unknown" && newVal === "unavailable") return false;

    if (["lock", "alarm_control_panel", "person", "input_boolean"].includes(domain)) {
      return true;
    }

    if (domain === "cover") return true;

    if (domain === "binary_sensor") {
      const securityClasses = ["door", "window", "moisture", "smoke", "gas",
        "motion", "occupancy", "safety", "tamper", "problem"];
      if (securityClasses.includes(deviceClass)) return true;
      if (newVal === "unavailable" || oldVal === "unavailable") return true;
      return true;
    }

    if (domain === "light" || domain === "switch") {
      if (!isNaN(oldVal) && !isNaN(newVal)) return false;
      return true;
    }

    if (domain === "climate") {
      if (isNaN(oldVal) || isNaN(newVal)) return true;
      return Math.abs(parseFloat(newVal) - parseFloat(oldVal)) >= 1.0;
    }

    if (domain === "fan" || domain === "media_player") {
      return true;
    }

    if (domain === "sensor") {
      if (deviceClass === "battery") {
        const oldNum = parseFloat(oldVal);
        const newNum = parseFloat(newVal);
        if (!isNaN(oldNum) && !isNaN(newNum)) {
          return (oldNum - newNum) >= 5;
        }
        return true;
      }

      if (deviceClass === "power") {
        const oldNum = parseFloat(oldVal);
        const newNum = parseFloat(newVal);
        if (!isNaN(oldNum) && !isNaN(newNum)) {
          const crossedAuxThreshold =
            (oldNum < 5000 && newNum >= 5000) || (oldNum >= 5000 && newNum < 5000);
          const largeSwing = Math.abs(newNum - oldNum) >= 1000;
          return crossedAuxThreshold || largeSwing;
        }
        return false;
      }

      if (deviceClass === "temperature") {
        const oldNum = parseFloat(oldVal);
        const newNum = parseFloat(newVal);
        if (!isNaN(oldNum) && !isNaN(newNum)) {
          return Math.abs(newNum - oldNum) >= 2.0;
        }
        return true;
      }

      if (deviceClass === "humidity") {
        const oldNum = parseFloat(oldVal);
        const newNum = parseFloat(newVal);
        if (!isNaN(oldNum) && !isNaN(newNum)) {
          return Math.abs(newNum - oldNum) >= 5.0;
        }
        return true;
      }

      const noisyClasses = ["signal_strength", "energy", "voltage", "current",
        "frequency", "power_factor", "irradiance", "data_rate", "data_size"];
      if (noisyClasses.includes(deviceClass)) return false;

      const unit = attrs.unit_of_measurement || "";
      const noisyUnits = ["dBm", "lqi", "dB", "kWh", "MWh", "Wh", "mA", "V", "A"];
      if (noisyUnits.includes(unit)) return false;

      if (newVal === "unavailable" || oldVal === "unavailable") return true;

      const oldNum = parseFloat(oldVal);
      const newNum = parseFloat(newVal);
      if (!isNaN(oldNum) && !isNaN(newNum) && oldNum !== 0) {
        const pctChange = Math.abs((newNum - oldNum) / oldNum) * 100;
        return pctChange >= 10;
      }

      return true;
    }

    return true;
  }

  checkBurst(entityId, event) {
    const domain = entityId.split(".")[0];
    if (HAWebSocket.BURST_EXEMPT_DOMAINS.has(domain)) return event;

    const now = Date.now();
    const tracker = this.eventBurstTracker.get(entityId);

    if (!tracker) {
      this.eventBurstTracker.set(entityId, { count: 1, firstTime: now, lastEvent: event });
      return event;
    }

    const elapsed = now - tracker.firstTime;

    if (elapsed > 60000) {
      this.eventBurstTracker.set(entityId, { count: 1, firstTime: now, lastEvent: event });
      return event;
    }

    tracker.count++;
    tracker.lastEvent = event;

    if (tracker.count <= 3) {
      return event;
    }

    return null;
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

      if (this.aiEnabled && newState && oldState && newState.state !== oldState.state) {
        if (!this.shouldQueueEvent(newState.entity_id, oldState, newState)) {
          return;
        }

        const eventData = {
          entity_id: newState.entity_id,
          friendly_name: (newState.attributes || {}).friendly_name || newState.entity_id,
          old_state: oldState.state,
          new_state: newState.state,
          timestamp: new Date().toISOString(),
        };

        const passed = this.checkBurst(newState.entity_id, eventData);
        if (!passed) return;
        this.recentEvents.push(passed);
        if (this.recentEvents.length > 100) {
          this.recentEvents = this.recentEvents.slice(-100);
        }
        this.logAI('state_change',
          `${passed.friendly_name} (${passed.entity_id}): ${passed.old_state} → ${passed.new_state}`,
          passed
        );
      }
    }
  }

  onClose() {
    console.log("HA WebSocket closed");
    this.connected = false;
    this.authenticated = false;
    this.subscribedEvents = false;
    this.subscribedRegistryEvents = false;
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
      if (!HAWebSocket.SNAPSHOT_DOMAIN_ALLOWLIST.has(domain)) continue;
      if (s.state === "unavailable" || s.state === "unknown") continue;
      if (domain === "switch" && HAWebSocket.isNoisySwitch(id)) continue;

      const attrs = s.attributes || {};
      if (domain === "sensor") {
        const deviceClass = attrs.device_class || "";
        if (HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
          // keep
        } else if (deviceClass === "battery") {
          const pct = parseFloat(s.state);
          if (isNaN(pct) || pct > HAWebSocket.BATTERY_LOW_THRESHOLD) continue;
        } else {
          continue;
        }
      }

      const filteredAttrs = {};
      for (const k of HAWebSocket.SNAPSHOT_ATTR_ALLOWLIST) {
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
      if (json.length > 120000) {
        this.logAI("snapshot_too_large",
          `Snapshot ${json.length} bytes — skipping persist`,
          { size: json.length });
        return;
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
  // Registry event subscriptions — keep the Vectorize index in sync with HA
  // entity/device registry changes incrementally. Skips silently if the AI or
  // VECTORIZE bindings are absent.
  // ========================================================================
  async subscribeToRegistryEvents() {
    if (this.subscribedRegistryEvents) return;
    if (!this.env.AI || !this.env.VECTORIZE) return;
    try {
      await this.sendCommand({ type: "subscribe_events", event_type: "entity_registry_updated" });
      await this.sendCommand({ type: "subscribe_events", event_type: "device_registry_updated" });
      this.subscribedRegistryEvents = true;
      console.log("Subscribed to entity_registry_updated and device_registry_updated events");
    } catch (err) {
      console.error("Failed to subscribe to registry events:", err.message);
    }
  }

  async handleEntityRegistryUpdated(data) {
    const action = data.action;
    const entityId = data.entity_id;
    if (!entityId) return;
    if (!this.env.AI || !this.env.VECTORIZE) return;

    try {
      if (action === "remove") {
        const vectorId = HAWebSocket.vectorIdForEntity(entityId);
        await this.env.VECTORIZE.deleteByIds([vectorId]);
        this.logAI("vector_delete", `${entityId} removed from index`, { entity_id: entityId, action });
        return;
      }
      const result = await this.reembedEntities([entityId]);
      this.logAI(
        "vector_reembed",
        `${entityId} (${action}) — embedded=${result.embedded} skipped=${result.skipped} errors=${result.errors}`,
        { entity_id: entityId, action, ...result }
      );
    } catch (err) {
      this.logAI("vector_error", `entity_registry_updated ${entityId}: ${err.message}`, { entity_id: entityId, action });
    }
  }

  async handleDeviceRegistryUpdated(data) {
    const action = data.action;
    const deviceId = data.device_id;
    if (!deviceId) return;
    if (!this.env.AI || !this.env.VECTORIZE) return;
    // "remove" propagates to per-entity entity_registry_updated removes; nothing to do here.
    if (action !== "update" && action !== "create") return;

    try {
      const entityRegRes = await this.sendCommand({ type: "config/entity_registry/list" });
      const entities = (entityRegRes && entityRegRes.result) || [];
      const affected = entities.filter((e) => e && e.device_id === deviceId).map((e) => e.entity_id);
      if (affected.length === 0) {
        this.logAI("vector_skip", `device ${deviceId} has no entities`, { device_id: deviceId, action });
        return;
      }
      const result = await this.reembedEntities(affected);
      this.logAI(
        "vector_reembed",
        `device ${deviceId} (${action}) → ${affected.length} entities — embedded=${result.embedded} skipped=${result.skipped} errors=${result.errors}`,
        { device_id: deviceId, action, entity_count: affected.length, ...result }
      );
    } catch (err) {
      this.logAI("vector_error", `device_registry_updated ${deviceId}: ${err.message}`, { device_id: deviceId, action });
    }
  }

  // Re-embed a list of entity IDs into Vectorize. Mirrors the backfill path in
  // worker.js: looks up area/device/state context, builds the embed text,
  // skips unchanged docs by hash, embeds in batches of 50, upserts in one call.
  async reembedEntities(entityIds) {
    if (!Array.isArray(entityIds) || entityIds.length === 0) {
      return { embedded: 0, errors: 0, skipped: 0 };
    }

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

      const text = HAWebSocket.buildEntityEmbedText({
        friendly_name, entity_id: entityId, area, device_name, domain, device_class, aliases
      });
      const hash = HAWebSocket.fnv1aHex(text);
      const vectorId = HAWebSocket.vectorIdForEntity(entityId);
      docs.push({
        entity_id: entityId,
        vector_id: vectorId,
        text,
        hash,
        metadata: { entity_id: entityId, friendly_name, domain, area, device_class, hash }
      });
    }

    if (docs.length === 0) return { embedded: 0, errors: 0, skipped: 0 };

    const existingHash = new Map();
    if (typeof this.env.VECTORIZE.getByIds === "function") {
      const LOOKUP_BATCH = 20;
      for (let i = 0; i < docs.length; i += LOOKUP_BATCH) {
        const slice = docs.slice(i, i + LOOKUP_BATCH).map((d) => d.vector_id);
        try {
          const existing = await this.env.VECTORIZE.getByIds(slice);
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
    let embedded = 0;
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

    if (pending.length > 0) {
      try {
        await this.env.VECTORIZE.upsert(pending);
        embedded = pending.length;
      } catch {
        errors += pending.length;
      }
    }

    return { embedded, errors, skipped };
  }

  // ========================================================================
  // Vectorize semantic search — embed a query with the same model+pooling as
  // the backfill, then return the top-k matching entities by cosine similarity.
  // CLS pooling is required: the index was built with pooling:"cls"; using mean
  // pooling here would compare vectors from a different geometry and rank them
  // nearly randomly. Returns [] on any failure so callers can fall back safely.
  // ========================================================================
  async retrieveRelevantEntities(query, k = 15) {
    const start = Date.now();
    if (!this.env.AI || !this.env.VECTORIZE) {
      this.logAI("vector_query", "AI or VECTORIZE binding missing — returning []", {
        query_length: typeof query === "string" ? query.length : 0,
        count: 0,
        duration_ms: Date.now() - start
      });
      return [];
    }
    if (typeof query !== "string" || query.length === 0) {
      this.logAI("vector_query", "empty query — returning []", {
        query_length: 0, count: 0, duration_ms: Date.now() - start
      });
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
      });
      return [];
    }

    const queryVector = aiResult && Array.isArray(aiResult.data) && aiResult.data[0];
    if (!Array.isArray(queryVector) || queryVector.length !== 1024) {
      this.logAI("vector_query", "embed returned malformed vector", {
        query_length: text.length, count: 0, duration_ms: Date.now() - start
      });
      return [];
    }

    let queryRes;
    try {
      queryRes = await this.env.VECTORIZE.query(queryVector, {
        topK: k,
        returnMetadata: true
      });
    } catch (err) {
      this.logAI("vector_query", "vectorize query failed: " + err.message, {
        query_length: text.length, count: 0, duration_ms: Date.now() - start
      });
      return [];
    }

    const matches = (queryRes && Array.isArray(queryRes.matches)) ? queryRes.matches : [];
    const out = [];
    for (const m of matches) {
      const md = m && m.metadata;
      if (!md || !md.entity_id) continue;
      out.push({
        entity_id: md.entity_id,
        friendly_name: md.friendly_name || "",
        domain: md.domain || "",
        area: md.area || "",
        device_class: md.device_class || "",
        score: typeof m.score === "number" ? m.score : null
      });
    }

    this.logAI("vector_query", `returned ${out.length} matches for "${text.slice(0, 80)}"`, {
      query_length: text.length,
      count: out.length,
      top_k: k,
      duration_ms: Date.now() - start
    });
    return out;
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
  // LOG PERSISTENCE — single DO storage key "ai_log" holding the last 150
  // compacted entries. The old sharded key approach (ai_log_head / ai_log_chunk_N)
  // is retained for migration reads only; new writes always use the flat key.
  //
  // Storage keys:
  //   ai_log    = [entry, entry, ...] (last 150 entries, compacted)
  // ==========================================================================
  async loadLogFromStorage() {
    // Try single-key format first (current format).
    const simple = await this.state.storage.get("ai_log");
    if (Array.isArray(simple)) return simple;
    // Migration: load from old sharded format if present.
    try {
      const head = await this.state.storage.get("ai_log_head") || { current: 0 };
      const chunks = [];
      const start = Math.max(0, head.current - (HAWebSocket.LOG_CHUNKS_MAX - 1));
      for (let gen = start; gen <= head.current; gen++) {
        const slot = gen % HAWebSocket.LOG_CHUNKS_MAX;
        const storedGen = await this.state.storage.get("ai_log_chunk_gen_" + slot);
        if (storedGen !== gen) continue;
        const chunk = await this.state.storage.get("ai_log_chunk_" + slot);
        if (Array.isArray(chunk)) chunks.push(...chunk);
      }
      return chunks;
    } catch {
      return [];
    }
  }

  // Write the last 150 compacted entries to a single DO storage key.
  // Replaces the old per-entry sharding approach which hit the 128KB limit
  // when entries contained large inline blobs (full chat replies, reasoning text).
  async persistLog() {
    const PERSIST_CAP = 150;
    try {
      const compacted = this.aiLog.slice(-PERSIST_CAP).map(e => {
        // state_change: message already has entity/old/new/timestamp — drop redundant data blob.
        if (e.type === 'state_change') {
          const c = { type: e.type, message: e.message, timestamp: e.timestamp };
          if (e.source) c.source = e.source;
          return c;
        }
        // chat entries: drop full_reply and duplicate message field from data.
        if (e.type === 'chat_reply' || e.type === 'chat_user') {
          const { full_reply, message: _msg, ...rest } = e.data || {};
          return { ...e, data: rest };
        }
        return e;
      });
      await this.state.storage.put("ai_log", compacted);
    } catch (err) {
      console.error("persistLog failed:", err.message);
      this.aiLog.push({ type: "log_persist_error", message: err.message, data: {}, timestamp: new Date().toISOString() });
    }
  }

  async clearPersistedLog() {
    await this.state.storage.delete("ai_log").catch(() => {});
    for (let i = 0; i < HAWebSocket.LOG_CHUNKS_MAX; i++) {
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
    if (this.aiLog.length > HAWebSocket.LOG_IN_MEMORY_CAP) {
      this.aiLog.splice(0, this.aiLog.length - HAWebSocket.LOG_IN_MEMORY_CAP);
    }
    console.log("AI LOG [" + type + (source ? "/" + source : "") + "]:", message);
    this.persistLog().catch((err) => console.error("logAI persist:", err.message));
  }

  // ========================================================================
  // AI Agent — Autonomous Event Processing
  // ========================================================================
  async runAIAgent() {
    if (this.aiProcessing || !this.aiEnabled || this.recentEvents.length === 0) return;
    if (!this.env.MINIMAX_API_KEY) {
      console.log("MINIMAX_API_KEY not set, skipping agent cycle");
      return;
    }
    this.aiProcessing = true;
    const eventsToProcess = [...this.recentEvents];
    this.recentEvents = [];

    // Phase 2 feature flag — native tool-calling path. Flag off = no-op, legacy runs.
    if (this.env.USE_NATIVE_TOOL_LOOP === "true") {
      try {
        await this.runAIAgentNative(eventsToProcess);
      } catch (err) {
        this.logAI("error", "Native agent cycle failed: " + err.message, {}, "native_loop");
      }
      this.aiProcessing = false;
      return;
    }

    try {
      const now = new Date();
      const memory = await this.state.storage.get("ai_memory") || [];
      const observations = await this.state.storage.get("ai_observations") || [];
      const persistentLog = this.aiLog;
      const recentActions = persistentLog
        .filter(e => ["chat_user", "chat_reply", "action", "action_verified", "notification", "decision", "state_change", "memory_saved", "observation_saved"].includes(e.type))
        .slice(-150)
        .map(e => `[${e.timestamp}] ${e.type}: ${e.message}`)
        .join("\n");

      const byDomain = new Map();
      for (const [id, state] of this.stateCache) {
        const domain = id.split(".")[0];
        const attr = state.attributes || {};
        const deviceClass = attr.device_class || "";
        if (domain === "switch" && HAWebSocket.isNoisySwitch(id)) continue;
        if (state.state === "unavailable" || state.state === "unknown") continue;
        if (HAWebSocket.CONTEXT_DOMAIN_PRIORITY.includes(domain)) {
          const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state };
          if (domain === "climate") {
            entry.setpoint = attr.temperature ?? null;
            entry.current_temp = attr.current_temperature ?? null;
            entry.hvac_action = attr.hvac_action ?? null;
          }
          if (domain === "weather") {
            entry.temperature = attr.temperature;
            entry.humidity = attr.humidity;
            entry.wind_speed = attr.wind_speed;
          }
          if (!byDomain.has(domain)) byDomain.set(domain, []);
          byDomain.get(domain).push(entry);
        } else if (domain === "sensor") {
          let include = false;
          if (HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
            include = true;
          } else if (deviceClass === "battery") {
            const pct = parseFloat(state.state);
            include = !isNaN(pct) && pct <= HAWebSocket.BATTERY_LOW_THRESHOLD;
          }
          if (include) {
            const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state, device_class: deviceClass };
            if (!byDomain.has("sensor")) byDomain.set("sensor", []);
            byDomain.get("sensor").push(entry);
          }
        }
      }
      const contextEntities = [];
      let sensorCount = 0;
      for (const domain of [...HAWebSocket.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
        for (const entry of (byDomain.get(domain) || [])) {
          if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
          if (domain === "sensor") {
            if (sensorCount >= HAWebSocket.MAX_SENSOR_CONTEXT) break;
            sensorCount++;
          }
          contextEntities.push(entry);
        }
        if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
      }

      const systemPrompt = `${this.getAgentContext()}

YOUR CAPABILITIES:
- call_service: Call any Home Assistant service (lights, locks, covers, climate, input_booleans, etc.)
- send_notification: Send a push notification to John or Sabrina
- save_memory: Save a CONFIRMED fact for long-term reference
- save_observation: Save a pattern or hypothesis in progress (prefix with [topic-tag], use "replaces" to update)
- get_automation_config: Read the full config of any automation by entity_id
- get_logbook: Review recent logbook entries for a specific entity or time window
- get_history: Pull historical state data for an entity over a time period

YOUR MEMORY (confirmed facts, ${memory.length}/100):
${memory.length > 0 ? memory.map((m) => "- " + m).join("\n") : "No memories yet. Observe patterns and save useful observations."}

YOUR OBSERVATIONS (patterns & hypotheses in progress, ${observations.length}/500):
${observations.length > 0 ? observations.map((o) => "- " + o).join("\n") : "No observations yet. Watch for repeating sequences and build evidence here."}

UNIFIED TIMELINE — everything that has happened recently, including chat messages from John/Sabrina, your replies, state changes, and your own actions. You and the chat interface share this timeline.

${recentActions.length > 0 ? recentActions : "Timeline is empty."}

CURRENT STATE OF KEY ENTITIES:
${JSON.stringify(contextEntities, null, 1)}

INSTRUCTIONS:
- You are processing a batch of home state change events. Decide: act, notify, save memory, save observation, or do nothing.
- Doing nothing is often correct for individual events. Don't manufacture urgency.
- OBSERVER MODE is your parallel job: look at the timeline for PATTERNS over longer horizons. Transitions (bedtime, departure, lockdown), repeated sequences, sensor gaps. Build evidence via save_observation with [topic-tags]. Update observations when new data points arrive using "replaces".
- Security events (locks found unlocked, garage or exterior doors left open, unexpected entry) always warrant attention.
- If you detect an occupancy transition (bedtime signals, both persons left home, late-evening lockdown activity), audit the perimeter: locks, covers, exterior door sensors. If anything is unsecured during a transition, that's an ALERT — send_notification. If everything is secure, stay silent.
- Smoke and CO detectors exist in this home but are not integrated into HA. You have no visibility into them — do not reference or act on their state.
- Routine events (lights cycling, thermostats maintaining temp, normal motion, Zigbee LQI fluctuations) do not need action or notification.
- Save memories sparingly and only for confirmed facts. Use save_observation for hypotheses in progress.
- Never notify for something you already notified about in the same session unless the state has materially changed.
- Aux heat running (power >5000W sustained) is worth a notification. A brief spike is not.
- You cannot edit automations via the API — that returns 405.

RESPOND ONLY WITH VALID JSON:
{
  "reasoning": "Brief explanation of your thinking",
  "actions": [
    {"type": "call_service", "domain": "light", "service": "turn_off", "data": {"entity_id": "light.example"}},
    {"type": "send_notification", "message": "Alert text", "title": "Optional title"},
    {"type": "save_memory", "memory": "Confirmed fact to remember"},
    {"type": "save_observation", "text": "[topic-tag] Pattern with evidence", "replaces": "[topic-tag]"}
  ]
}

If no action is needed:
{"reasoning": "Everything looks normal", "actions": []}`;

      const lastObservation = observations.length > 0 ? observations[observations.length - 1] : "";
      const eventsTriggerText = eventsToProcess.map((e) => `${e.friendly_name || ""} ${e.entity_id || ""} ${e.new_state || ""}`).join(" ");
      const climatePreamble = await this._buildClimatePreambleIfNeeded(`${lastObservation} ${eventsTriggerText}`, "autonomous_legacy");

      const userMessage = `Current time: ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}${climatePreamble ? "\n\n" + climatePreamble : ""}

The following state changes just occurred:
${JSON.stringify(eventsToProcess, null, 1)}

Analyze these events AND the unified timeline above. Decide what actions to take, if any. Include observer-mode reasoning if you notice patterns worth tracking. Respond with JSON only.`;

      console.log("AI Agent processing", eventsToProcess.length, "events...");
      const response = await this.callMiniMax([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ], 65536, true);

      const debugKeys = Object.keys(response || {});
      let responseText = response.choices?.[0]?.message?.content || response.response || "";
      if (!responseText) {
        const rawReasoning = response.choices?.[0]?.message?.reasoning || "";
        const jsonFallback = HAWebSocket.extractFirstJSON(rawReasoning);
        if (jsonFallback) {
          console.log("AI Agent: content null, salvaging JSON from reasoning field");
          responseText = jsonFallback;
        }
      }
      if (!responseText) {
        this.logAI("error", "Empty response after thinking — token budget exhausted. Keys: " + debugKeys.join(","), {});
        this.aiProcessing = false;
        return;
      }

      let aiDecision;
      try {
        const jsonMatch = HAWebSocket.extractFirstJSON(responseText);
        if (jsonMatch) {
          aiDecision = JSON.parse(jsonMatch);
        } else {
          throw new Error("No JSON found in response");
        }
      } catch (parseErr) {
        console.error("AI response parse error:", parseErr.message);
        this.logAI("error", "Failed to parse AI response", { raw: responseText.substring(0, 500) });
        this.aiProcessing = false;
        return;
      }
      this.logAI("decision", aiDecision.reasoning || "No reasoning provided", {
        events_processed: eventsToProcess.length,
        actions_count: (aiDecision.actions || []).length
      });
      if (aiDecision.actions && Array.isArray(aiDecision.actions)) {
        for (const action of aiDecision.actions) {
          try {
            await this.executeAIAction(action);
          } catch (actionErr) {
            this.logAI("action_error", "Failed to execute action: " + actionErr.message, action);
          }
        }
      }
    } catch (err) {
      console.error("AI Agent error:", err.message);
      this.logAI("error", "AI Agent cycle failed: " + err.message, {});
    }
    await this.persistLog();
    this.aiProcessing = false;
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
      .map((e) => `[${e.timestamp}] ${e.type}: ${e.message}`)
      .join("\n");

    // ---- Entity context snapshot ----
    const byDomain = new Map();
    for (const [id, state] of this.stateCache) {
      const domain = id.split(".")[0];
      const attr = state.attributes || {};
      const deviceClass = attr.device_class || "";
      if (domain === "switch" && HAWebSocket.isNoisySwitch(id)) continue;
      if (state.state === "unavailable" || state.state === "unknown") continue;

      if (HAWebSocket.CONTEXT_DOMAIN_PRIORITY.includes(domain)) {
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
        if (HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
          include = true;
        } else if (deviceClass === "battery") {
          const pct = parseFloat(state.state);
          include = !isNaN(pct) && pct <= HAWebSocket.BATTERY_LOW_THRESHOLD;
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
    for (const domain of [...HAWebSocket.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
      for (const entry of (byDomain.get(domain) || [])) {
        if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
        if (domain === "sensor") {
          if (sensorCount >= HAWebSocket.MAX_SENSOR_CONTEXT) break;
          sensorCount++;
        }
        contextEntities.push(entry);
      }
      if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
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
        const jsonFallback = HAWebSocket.extractFirstJSON(rawReasoning);
        if (jsonFallback) responseText = jsonFallback;
      }
      let parsed = null;
      const jsonMatch = HAWebSocket.extractFirstJSON(responseText);
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
        if (memory.length > 100) memory.splice(0, memory.length - 100);
        await this.state.storage.put("ai_memory", memory);
        this.logAI("memory_saved", action.memory, {}, source);
        break;
      }
      case "save_observation": {
        const text = typeof action.text === "string" ? action.text.trim() : "";
        if (!text) {
          this.logAI("observation_skipped", "save_observation called with empty text", action, source);
          break;
        }
        let observations = await this.state.storage.get("ai_observations") || [];
        if (typeof action.replaces === "string" && action.replaces.length > 0) {
          const prefix = action.replaces;
          observations = observations.filter((o) => !o.startsWith(prefix));
        }
        observations.push(text);
        if (observations.length > 500) observations.splice(0, observations.length - 500);
        await this.state.storage.put("ai_observations", observations);
        this.logAI("observation_saved", text.substring(0, 200), { replaces: action.replaces || null }, source);
        break;
      }
      default:
        this.logAI("unknown_action", "Unknown action type: " + action.type, action, source);
        throw new Error("Unknown action type: '" + (action.type || "undefined") + "' — expected call_service, send_notification, save_memory, or save_observation");
    }
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

        // ----- Read tools (no action log; not counted in actions_taken) -----
        case "get_state": {
          if (!args.entity_id) return { error: "entity_id is required" };
          if (!args.force_refresh) {
            const cached = this.stateCache.get(args.entity_id);
            if (cached) return cached;
          }
          try {
            const result = await this.sendCommand({ type: "get_states" });
            if (result && Array.isArray(result.result)) {
              for (const s of result.result) this.stateCache.set(s.entity_id, s);
            }
            const fresh = this.stateCache.get(args.entity_id);
            return fresh || { error: "Entity not found: " + args.entity_id };
          } catch (err) {
            return { error: "Failed to refresh states: " + err.message };
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
            return await resp.json();
          } catch (err) {
            return { error: "Logbook fetch failed: " + err.message };
          }
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
  async callMiniMaxWithTools(messages, tools, maxTokens = 65536) {
    const body = {
      model: "MiniMax-M2.7-highspeed",
      messages,
      tools,
      max_tokens: maxTokens,
      temperature: 0,
      reasoning_split: true
    };
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
    return await response.json();
  }

  // ========================================================================
  // Native tool-calling loop — Phase 2
  // ========================================================================
  async runNativeToolLoop(initialMessages, options = {}) {
    const { maxIterations = 8, systemPrompt = null, onEvent = null } = options;
    const messages = [...initialMessages];
    if (systemPrompt && (messages.length === 0 || messages[0].role !== "system")) {
      messages.unshift({ role: "system", content: systemPrompt });
    }

    const actionsTaken = [];
    const stripThink = (s) => (s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const safeEmit = (evt) => { try { if (onEvent) onEvent(evt); } catch {} };

    for (let iter = 0; iter < maxIterations; iter++) {
      let response;
      safeEmit({ type: "thinking" });
      try {
        response = await this.callMiniMaxWithTools(messages, NATIVE_AGENT_TOOLS);
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

      const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];

      if (toolCalls.length === 0) {
        const cleaned = stripThink(assistantMsg.content);
        // Hallucinated-completion tripwire: model says "opening/closing/turning on..."
        // but emitted no tool_call. Force one corrective iteration instead of returning
        // the lie to the user. Mirrors the legacy claim-mismatch check at
        // chatWithAgent but acts on it rather than just logging.
        const actionClaimVerbs = /\b(opening|closing|turning on|turning off|locking|unlocking|setting|activating|dimming|starting|stopping)\b/i;
        if (actionsTaken.length === 0 && actionClaimVerbs.test(cleaned)) {
          this.logAI(
            "action_hallucination",
            `Claim without tool call — forcing retry: "${cleaned.substring(0, 150)}"`,
            { iteration: iter },
            "native_loop"
          );
          messages.push({
            role: "user",
            content: "You just said you performed an action (e.g. \"opening\", \"closing\", \"turning on\") but did not emit a tool_call. That is a hallucination. Call the appropriate tool NOW to actually do what you said. If you truly cannot or should not act, reply plainly saying so — do not claim completion."
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

        const evtLabel = name === "call_service" && args.domain && args.service
          ? `${args.domain}.${args.service}`
          : name;
        safeEmit({ type: "tool_call", name, label: evtLabel, args });
        let result;
        if (parseError) {
          result = { error: "Invalid JSON arguments: " + parseError };
        } else if (!NATIVE_TOOL_NAMES.has(name)) {
          result = { error: "Unknown tool: " + name };
          this.logAI("action_error", `Native loop: unknown tool ${name}`, { tool: name }, "native_loop");
        } else {
          result = await this.executeNativeTool(name, args);
        }
        safeEmit({ type: "tool_result", name, ok: !result?.error, summary: result?.error ? String(result.error).slice(0, 120) : "done" });

        if (name) {
          const label = name === "call_service" && args.domain && args.service
            ? `call_service: ${args.domain}.${args.service}`
            : name;
          actionsTaken.push(label);
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof result === "string" ? result : JSON.stringify(result)
        });
      }
    }

    this.logAI(
      "error",
      `Native loop: max_iterations_exceeded (${maxIterations} iterations)`,
      { actions_taken: actionsTaken },
      "native_loop"
    );
    if (onEvent) onEvent({ type: "error", message: "max_iterations_exceeded" });
    return {
      reply: "I hit my iteration ceiling without finishing — actions so far: " +
        (actionsTaken.length > 0 ? actionsTaken.join(", ") : "none") +
        ". Re-ask if you need me to continue.",
      actions_taken: actionsTaken,
      messages,
      error: "max_iterations_exceeded",
      iterations: maxIterations
    };
  }

  // ========================================================================
  // Native-loop context helpers — shared between runAIAgentNative and
  // chatWithAgentNative.
  //
  // When env.USE_VECTOR_ENTITY_RETRIEVAL === "true" and a non-empty `query` is
  // supplied (and AI+VECTORIZE bindings exist), the context is built from a
  // semantic search over the Vectorize index instead of the flat MAX_CONTEXT_
  // ENTITIES snapshot. Vector results are enriched with live state from
  // stateCache so the model still sees current state for matched entities.
  // Returns { entities, vectorRetrieved } so the prompt builder can frame the
  // section appropriately. Falls back to the flat snapshot on any failure.
  // ========================================================================
  async _buildNativeContextEntities(query = null) {
    const useVector =
      this.env.USE_VECTOR_ENTITY_RETRIEVAL === "true" ||
      this.env.USE_VECTOR_ENTITY_RETRIEVAL === "1";

    if (useVector && typeof query === "string" && query.trim().length > 0) {
      try {
        const matches = await this.retrieveRelevantEntities(query, 15);
        if (Array.isArray(matches) && matches.length > 0) {
          const enriched = matches.map((m) => {
            const cached = this.stateCache.get(m.entity_id);
            const out = {
              entity_id: m.entity_id,
              friendly_name: m.friendly_name || (cached?.attributes?.friendly_name) || m.entity_id,
              domain: m.domain || (m.entity_id.split(".")[0] || ""),
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
          return { entities: enriched, vectorRetrieved: true };
        }
      } catch (err) {
        this.logAI("vector_query", "context build fell back to flat list: " + err.message, {
          query_length: query.length
        });
      }
    }

    return { entities: this._buildFlatContextEntities(), vectorRetrieved: false };
  }

  _buildFlatContextEntities() {
    const byDomain = new Map();
    for (const [id, state] of this.stateCache) {
      const domain = id.split(".")[0];
      const attr = state.attributes || {};
      const deviceClass = attr.device_class || "";
      if (domain === "switch" && HAWebSocket.isNoisySwitch(id)) continue;
      if (state.state === "unavailable" || state.state === "unknown") continue;

      if (HAWebSocket.CONTEXT_DOMAIN_PRIORITY.includes(domain)) {
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
        if (HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
          include = true;
        } else if (deviceClass === "battery") {
          const pct = parseFloat(state.state);
          include = !isNaN(pct) && pct <= HAWebSocket.BATTERY_LOW_THRESHOLD;
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
    for (const domain of [...HAWebSocket.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
      for (const entry of (byDomain.get(domain) || [])) {
        if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
        if (domain === "sensor") {
          if (sensorCount >= HAWebSocket.MAX_SENSOR_CONTEXT) break;
          sensorCount++;
        }
        contextEntities.push(entry);
      }
      if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
    }
    return contextEntities;
  }

  _buildNativeTimeline() {
    const relevantTypes = ["chat_user", "chat_reply", "action", "action_verified", "notification", "decision", "state_change", "memory_saved", "observation_saved"];
    return this.aiLog
      .filter((e) => relevantTypes.includes(e.type))
      .slice(-150)
      .map((e) => `[${e.timestamp}] ${e.type}${e.source ? "/" + e.source : ""}: ${e.message}`)
      .join("\n");
  }

  // ========================================================================
  // NATIVE_AGENT_SYSTEM_PROMPT — Phase 2 system prompt for the native tool-
  // calling loop. Shared between autonomous and chat modes; a role-specific
  // MODE block and the `from` context are interpolated in.
  // ========================================================================
  getNativeAgentSystemPrompt(role, ctx) {
    const { memory = [], observations = [], timeline = "", contextEntities = [], from = "default", vectorRetrieved = false } = ctx;

    const stateHealth = {
      ws_connected: this.connected,
      ws_authenticated: this.authenticated,
      states_ready: this.statesReady,
      last_pong_age_seconds: this.lastPongAt ?
        Math.round((Date.now() - this.lastPongAt) / 1000) : null,
      cached_entity_count: this.stateCache.size
    };

    const modeBlock = role === "autonomous"
      ? `MODE: AUTONOMOUS HEARTBEAT.
You're reviewing a batch of home state-change events. Two jobs in parallel:
  (a) Execute-mode: act, notify, save a memory, or do nothing on the immediate events. Doing nothing is usually right.
  (b) Observer-mode: look at the UNIFIED TIMELINE for PATTERNS over longer horizons — repeating sequences, occupancy transitions, sensor gaps. Build evidence via save_observation.

CRITICAL: Returning ZERO tool calls is the correct answer when nothing needs action. You are not penalized for silence. Do not pad with filler tool use to look productive — MiniMax that cries wolf gets ignored, MiniMax that only speaks up when something is worth it actually gets read.`
      : `MODE: CHAT. ${from} is talking to you directly. Keep replies concise and skip the filler. If you took an action, say what you did plainly. This is also your best non-intrusive moment to surface an observer-mode pattern you've been building — if something's worth mentioning, mention it. If not, don't force it.`;

    return `${this.getAgentContext()}

STATE FRESHNESS:
Each entity includes age_seconds — seconds since Home Assistant reported a state change. Values older than ~120 seconds for active entities (lights, locks, motion sensors) may indicate stale state. If from_snapshot: true, it was restored from a hibernation snapshot and may be significantly stale. When freshness matters, mention it.

GATEWAY HEALTH:
${JSON.stringify(stateHealth, null, 1)}

${modeBlock}

TOOLS — they're attached to this request. Invoke them directly. No JSON-with-actions-array output format, no markdown fences, no special shape — your reply on the turn you emit NO tool calls is the final reply to the user. The tools available:

- call_service — execute any HA service (lights, locks, covers, climate, input_booleans, scripts, scenes, etc.). Use for destructive/irreversible actions (lock, close garage, restart) too — these intentionally aren't separate tools.
- ai_send_notification — send a phone push AND log it to your activity timeline. Prefer this over call_service on notify.mobile_app_* when the notification should appear in your future timeline context. Only use for things that warrant a phone buzz: security events during transitions, aux heat >5000W sustained, water leaks, unexpected entry.
- save_memory — persist a CONFIRMED fact (100 slots, FIFO). Stable knowledge only. Don't use for hypotheses.
- save_observation — persist a pattern or hypothesis prefixed with [topic-tag] (500 slots). Set replaces="[topic-tag]" to supersede a prior observation on the same topic.
- get_state — look up a single entity's full state when the pre-injected context block doesn't have the detail you need.
- get_logbook — pull logbook entries for an entity or time window. Useful for debugging ("did the automation fire?", "who closed the garage?").
- render_template — run a Jinja2 template in HA's context. Use for cross-entity queries or HA helpers (area_name, device_attr, expand, state_attr) that the context block can't answer.

COMMITMENT RULE: If your final reply says you did something ("opening the garage", "turning off the lights"), you MUST have invoked the corresponding tool. Saying you did something you didn't do is a lie and unacceptable. Your timeline is the record.

YOUR MEMORY (confirmed facts, ${memory.length}/100):
${memory.length > 0 ? memory.map((m) => "- " + m).join("\n") : "No memories yet. Observe patterns and save useful confirmed facts as you learn them."}

YOUR OBSERVATIONS (patterns & hypotheses in progress, ${observations.length}/500):
${observations.length > 0 ? observations.map((o) => "- " + o).join("\n") : "No observations yet. Watch for repeating sequences — that's how automations get proposed."}

UNIFIED TIMELINE — everything recent: chat messages, your replies, state changes, your past tool calls. Each entry is tagged with its source (legacy_json / native_loop / tool_call) so you can see whether a past action came from you (native_loop), from the old JSON path (legacy_json), or from a direct MCP call (tool_call).

${timeline || "Timeline is empty."}

${vectorRetrieved
  ? `RELEVANT ENTITIES (${contextEntities.length}, semantic-search top-k for this turn) — these were selected by similarity to the current query/events from the FULL set of HA entities, so an entity not in this block may still exist; use get_state to probe specific entity_ids you suspect. Each entry includes the live state from the WebSocket-maintained cache (state=null means HA hasn't reported a value). Higher score = more relevant. Don't invent entity_ids or timestamps for events you didn't witness.`
  : `CURRENT STATE OF ENTITIES (${contextEntities.length}) — your live, authoritative snapshot from a maintained WebSocket to HA. If an entity is here, its state is current. Do not say "I don't have visibility" or reason about refresh lag — that's a layer beneath you that you can't see. If an entity is NOT here, say so honestly or use get_state to probe. Never invent entity IDs or fabricate timestamps for events you didn't witness.`}

${JSON.stringify(contextEntities, null, 1)}

OPERATIONAL REMINDERS:
1. Security is priority one. Unexpected unlocks, garage or exterior doors open during bedtime/departure transitions — act and notify. Security events override suggestion etiquette.
2. Thermostat zones: climate.t6_pro_z_wave_programmable_thermostat_2 = main level INCLUDING MBR; climate.t6_pro_z_wave_programmable_thermostat = basement. Don't mix them up.
3. Smoke/CO detectors are NOT in HA — don't reference their state or act on them.
4. Automation editing via call_service on automation.update returns 405 on this instance. If John asks you to modify an automation, tell him the change and where to make it in the HA UI (Settings → Automations).
5. Routine events (lights cycling, thermostats maintaining temp, normal motion, Zigbee LQI fluctuations) don't need action or notification.
6. Aux heat running (whole-home power >5000W sustained) is worth a notification. A brief spike isn't.
7. Save memories sparingly and only for confirmed facts. Hypotheses go to save_observation.
8. Don't notify for the same thing twice in one session unless the state materially changed.
9. Observer-mode suggestions are NOT alerts — deliver them in a chat reply or via save_observation. Never wake anyone at 2 AM to propose an automation.`;
  }

  // ========================================================================
  // Native autonomous heartbeat (Phase 2) — flag-gated sibling of runAIAgent.
  // ========================================================================
  async runAIAgentNative(eventsToProcess) {
    const now = new Date();
    const memory = await this.state.storage.get("ai_memory") || [];
    const observations = await this.state.storage.get("ai_observations") || [];
    // Synthesize a query for vector retrieval from the events being processed:
    // entity_id + friendly_name gives the embedder enough surface area to find
    // semantically related entities (the same room, related devices, etc.).
    const eventQuery = eventsToProcess
      .map((e) => `${e.entity_id || ""} ${e.friendly_name || ""}`.trim())
      .filter(Boolean)
      .join(" | ");
    const { entities: contextEntities, vectorRetrieved } = await this._buildNativeContextEntities(eventQuery);
    const timeline = this._buildNativeTimeline();

    const systemPrompt = this.getNativeAgentSystemPrompt("autonomous", {
      memory,
      observations,
      timeline,
      contextEntities,
      vectorRetrieved
    });

    const lastObservation = observations.length > 0 ? observations[observations.length - 1] : "";
    const eventsTriggerText = eventsToProcess.map((e) => `${e.friendly_name || ""} ${e.entity_id || ""} ${e.new_state || ""}`).join(" ");
    const climatePreamble = await this._buildClimatePreambleIfNeeded(`${lastObservation} ${eventsTriggerText}`, "autonomous_native");

    const userMessage = `Current time: ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}${climatePreamble ? "\n\n" + climatePreamble : ""}

The following state changes just occurred:
${JSON.stringify(eventsToProcess, null, 1)}

Evaluate these events against the timeline above. Take action only if warranted.`;

    console.log("Native AI Agent processing", eventsToProcess.length, "events...");
    const result = await this.runNativeToolLoop(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      { maxIterations: 8 }
    );

    this.logAI(
      "decision",
      `Native loop: ${result.actions_taken.length} actions over ${result.iterations} iterations${result.error ? " — " + result.error : ""}`,
      {
        events_processed: eventsToProcess.length,
        actions_count: result.actions_taken.length,
        iterations: result.iterations,
        ...(result.error ? { error: result.error } : {})
      },
      "native_loop"
    );
    await this.persistLog();
  }

  // ========================================================================
  // Native chat (Phase 2) — flag-gated sibling of chatWithAgent.
  // Returns { reply, actions_taken, error? } — mirrors legacy chat contract.
  // ========================================================================
  async chatWithAgentNative(message, from = "default", onEvent = null) {
    const now = new Date();
    const now_str = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    const memory = await this.state.storage.get("ai_memory") || [];
    const observations = await this.state.storage.get("ai_observations") || [];
    const conversationHistory = await this.state.storage.get("chat_history") || [];
    this.logAI("chat_user", `${from}: ${message}`, { from, message });

    const timeline = this._buildNativeTimeline();
    const { entities: contextEntities, vectorRetrieved } = await this._buildNativeContextEntities(message);

    const systemPrompt = this.getNativeAgentSystemPrompt("chat", {
      memory,
      observations,
      timeline,
      contextEntities,
      vectorRetrieved,
      from
    });

    const climatePreamble = await this._buildClimatePreambleIfNeeded(message, "chat_native");

    const initialMessages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
      { role: "user", content: `Current time: ${now_str}${climatePreamble ? "\n\n" + climatePreamble : ""}\n\n${message}` }
    ];

    try {
      const oldHistoryLen = conversationHistory.length;
      const result = await this.runNativeToolLoop(initialMessages, { maxIterations: 8, onEvent });
      const reply = (result.reply && result.reply.trim()) || "Done.";

      this.logAI("chat_reply", reply.substring(0, 300), { from, full_reply: reply }, "native_loop");

      // Preserve the full tool-calling trace in history. Prior storage kept only
      // {user, assistant-text-only} pairs — across turns the model saw zero evidence
      // of past tool use and drifted toward chat-mode replies ("Done —  opening")
      // without emitting tool_calls. Storing assistant.tool_calls + tool-role
      // responses gives it its own track record.
      //
      // Extract loop additions (everything added after [system, ...oldHistory, currentUser]).
      const TOOL_CONTENT_CAP = 4000;
      const loopAdditions = result.messages.slice(1 + oldHistoryLen + 1).map((m) => {
        if (m.role === "tool" && typeof m.content === "string" && m.content.length > TOOL_CONTENT_CAP) {
          return { ...m, content: m.content.substring(0, TOOL_CONTENT_CAP) + "…[truncated]" };
        }
        return m;
      });
      // Drop any trailing imbalanced messages (e.g. assistant with pending tool_calls,
      // or a trailing tool message) — the next turn's API call requires a clean state.
      while (loopAdditions.length > 0) {
        const last = loopAdditions[loopAdditions.length - 1];
        const pendingTools = last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
        if (last.role === "assistant" && !pendingTools) break;
        loopAdditions.pop();
      }
      // If the trace ended without a final assistant reply (max_iterations, API error),
      // synthesize one from the reply text we're returning so history reflects what the user saw.
      const endsCleanly = loopAdditions.length > 0 &&
        loopAdditions[loopAdditions.length - 1].role === "assistant" &&
        !loopAdditions[loopAdditions.length - 1].tool_calls?.length;
      if (!endsCleanly) {
        loopAdditions.push({ role: "assistant", content: reply });
      }

      const nextHistory = [
        ...conversationHistory,
        { role: "user", content: `[${from}]: ${message}` },
        ...loopAdditions
      ];

      // Cap at the last N user-initiated turns. Capping by raw message count could
      // split a user→assistant(tool_calls)→tool→assistant chain, which the API rejects.
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
      await this.state.storage.put("chat_history", nextHistory);

      this.logAI(
        "chat",
        `done | exec=${result.actions_taken.length} iter=${result.iterations}${result.error ? " err=" + result.error : ""}`,
        {
          actions_executed: result.actions_taken.length,
          from,
          iterations: result.iterations,
          context_size: contextEntities.length,
          ...(result.error ? { error: result.error } : {})
        },
        "native_loop"
      );

      await this.persistLog();
      return {
        reply,
        actions_taken: result.actions_taken,
        ...(result.error ? { error: result.error } : {})
      };
    } catch (err) {
      this.logAI("chat_error", err.message, {}, "native_loop");
      return { error: "AI failed: " + err.message };
    }
  }

  // ========================================================================
  // Alarm handler — keepalive + AI agent trigger + heartbeat
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

      if (this.aiEnabled && this.recentEvents.length > 0 && !this.aiProcessing) {
        await this.runAIAgent();
      }

      if (this.aiEnabled && !this.aiProcessing && (now - this.lastHeartbeat) >= 900000) {
        this.lastHeartbeat = now;
        this.recentEvents.push({
          entity_id: "system.heartbeat",
          friendly_name: "15-Minute Heartbeat",
          old_state: "tick",
          new_state: "tock",
          timestamp: new Date().toISOString(),
        });
        await this.runAIAgent();
      }

      const cutoff = now - 120000;
      for (const [key, val] of this.eventBurstTracker) {
        if (val.firstTime < cutoff) this.eventBurstTracker.delete(key);
      }
    }

    await this.state.storage.setAlarm(Date.now() + 60000);
  }
}
