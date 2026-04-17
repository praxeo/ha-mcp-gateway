// ha-websocket.js — PATCHED: JSON mode + retry + honest failure + action claim detection + log sharding + observations
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

        case "/ai_chat": {
          const body = await request.json();
          const response = await this.chatWithAgent(body.message, body.from || "default");
          return new Response(JSON.stringify(response), { headers });
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
    if (event.event_type === "state_changed" && event.data) {
      const newState = event.data.new_state;
      const oldState = event.data.old_state;

      if (newState) {
        this.stateCache.set(newState.entity_id, newState);
      } else if (event.data.entity_id) {
        this.stateCache.delete(event.data.entity_id);
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
        console.log("Real-time cache loaded:", this.stateCache.size, "entities");
      }
    } catch (err) { console.error("Failed to fetch states:", err.message); }
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
  // MiniMax API helper — OpenAI-compatible endpoint
  // JSON mode + temp drop for structured output reliability
  // ========================================================================
  async callMiniMax(messages, maxTokens = 2048, jsonMode = false) {
    const body = {
      model: "MiniMax-M2.7-highspeed",
      messages,
      max_tokens: maxTokens,
      temperature: jsonMode ? 0.3 : 0.7
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
  // LOG PERSISTENCE — sharded across multiple DO storage keys to stay under
  // the 128KB per-value limit. Each generation writes to slot = gen % CHUNKS_MAX.
  // A sibling metadata key (ai_log_chunk_gen_N) records which generation owns
  // each slot, so wrapped rotation doesn't read stale chunks.
  //
  // Storage keys used:
  //   ai_log_head              = { current: <generation number> }
  //   ai_log_chunk_<N>         = [entry, entry, ...] where N = gen % CHUNKS_MAX
  //   ai_log_chunk_gen_<N>     = <generation number> owning slot N
  // ==========================================================================
  async loadLogFromStorage() {
    const head = await this.state.storage.get("ai_log_head") || { current: 0 };
    const chunks = [];
    const start = Math.max(0, head.current - (HAWebSocket.LOG_CHUNKS_MAX - 1));
    for (let gen = start; gen <= head.current; gen++) {
      const slot = gen % HAWebSocket.LOG_CHUNKS_MAX;
      // Skip chunks whose slot has been overwritten by a later generation.
      const storedGen = await this.state.storage.get("ai_log_chunk_gen_" + slot);
      if (storedGen !== gen) continue;
      const chunk = await this.state.storage.get("ai_log_chunk_" + slot);
      if (Array.isArray(chunk)) chunks.push(...chunk);
    }
    return chunks;
  }

  async persistLogEntry(entry) {
    try {
      const head = await this.state.storage.get("ai_log_head") || { current: 0 };
      const slot = head.current % HAWebSocket.LOG_CHUNKS_MAX;
      const genKey = "ai_log_chunk_gen_" + slot;
      const chunkKey = "ai_log_chunk_" + slot;

      // If this slot is still owned by a prior generation (wrap happened or
      // first use after deploy onto a slot previously owned by generation N),
      // claim it fresh. Otherwise append to the existing in-progress chunk.
      const storedGen = await this.state.storage.get(genKey);
      let chunk;
      if (storedGen !== head.current) {
        chunk = [];
        await this.state.storage.put(genKey, head.current);
      } else {
        chunk = await this.state.storage.get(chunkKey) || [];
      }

      chunk.push(entry);
      await this.state.storage.put(chunkKey, chunk);

      // Chunk full? Rotate head forward; next write lands in next slot.
      if (chunk.length >= HAWebSocket.LOG_CHUNK_SIZE) {
        head.current += 1;
        await this.state.storage.put("ai_log_head", head);
      }
    } catch (err) {
      // Don't recurse via logAI — append directly to in-memory ring.
      console.error("persistLogEntry failed:", err.message);
      this.aiLog.push({
        type: "log_persist_error",
        message: err.message,
        data: {},
        timestamp: new Date().toISOString()
      });
    }
  }

  async clearPersistedLog() {
    for (let i = 0; i < HAWebSocket.LOG_CHUNKS_MAX; i++) {
      await this.state.storage.delete("ai_log_chunk_" + i).catch(() => {});
      await this.state.storage.delete("ai_log_chunk_gen_" + i).catch(() => {});
    }
    await this.state.storage.delete("ai_log_head").catch(() => {});
  }

  // ========================================================================
  // logAI — writes to in-memory ring buffer + sharded persistent storage
  // ========================================================================
  logAI(type, message, data) {
    const entry = { type, message, data, timestamp: new Date().toISOString() };
    this.aiLog.push(entry);
    if (this.aiLog.length > HAWebSocket.LOG_IN_MEMORY_CAP) {
      this.aiLog.splice(0, this.aiLog.length - HAWebSocket.LOG_IN_MEMORY_CAP);
    }
    console.log("AI LOG [" + type + "]:", message);
    this.persistLogEntry(entry).catch((err) => console.error("logAI persist:", err.message));
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

      const userMessage = `Current time: ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}

The following state changes just occurred:
${JSON.stringify(eventsToProcess, null, 1)}

Analyze these events AND the unified timeline above. Decide what actions to take, if any. Include observer-mode reasoning if you notice patterns worth tracking. Respond with JSON only.`;

      console.log("AI Agent processing", eventsToProcess.length, "events...");
      const response = await this.callMiniMax([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ], 16384, true);

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
    this.aiProcessing = false;
  }

  // ========================================================================
  // AI Agent — Chat Interface
  // JSON mode + prose pass-through + targeted retry + honest failure
  // ========================================================================
  async chatWithAgent(message, from = "default") {
    if (!this.env.MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not configured" };

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

    const userTurn = { role: "user", content: "Current time: " + now_str + "\n\n" + message };

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
      const response = await this.callMiniMax(messages, 8192, true);
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
  // ========================================================================
  async executeAIAction(action) {
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
      this.logAI("action_healed", "Rewrote HA-yaml action to call_service: " + healedDomain + "." + healedService, { original: action });
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
        this.logAI("action", "Called " + action.domain + "." + action.service, action.data || {});
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
              verifyData
            );
          } else {
            this.logAI(
              "action_verify_fail",
              `Could not verify state of ${entityId} — not in stateCache`,
              { entity_id: entityId }
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
        this.logAI("notification", action.message, { title: action.title });
        break;
      }
      case "save_memory": {
        console.log("AI saving memory:", action.memory);
        const memory = await this.state.storage.get("ai_memory") || [];
        memory.push(action.memory);
        if (memory.length > 100) memory.splice(0, memory.length - 100);
        await this.state.storage.put("ai_memory", memory);
        this.logAI("memory_saved", action.memory, {});
        break;
      }
      case "save_observation": {
        const text = typeof action.text === "string" ? action.text.trim() : "";
        if (!text) {
          this.logAI("observation_skipped", "save_observation called with empty text", action);
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
        this.logAI("observation_saved", text.substring(0, 200), { replaces: action.replaces || null });
        break;
      }
      default:
        this.logAI("unknown_action", "Unknown action type: " + action.type, action);
        throw new Error("Unknown action type: '" + (action.type || "undefined") + "' — expected call_service, send_notification, save_memory, or save_observation");
    }
  }

  // ========================================================================
  // Alarm handler — keepalive + AI agent trigger + heartbeat
  // ========================================================================
  async alarm() {
    if (!this.connected || !this.authenticated) {
      await this.connect();
    } else {
      try { this.ws.send(JSON.stringify({ type: "ping", id: this.msgId++ })); }
      catch { this.disconnect(); await this.connect(); }

      if (this.aiEnabled && this.recentEvents.length > 0 && !this.aiProcessing) {
        await this.runAIAgent();
      }

      const now = Date.now();
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
