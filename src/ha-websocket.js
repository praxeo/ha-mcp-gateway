// ha-websocket.js — Modified with 4 targeted changes for unified timeline

export class HAWebSocket {
  // Static config for prioritized entity context building
  static BURST_EXEMPT_DOMAINS = new Set(["climate", "lock", "cover", "alarm_control_panel"]);
  static CONTEXT_DOMAIN_PRIORITY = [
    "alarm_control_panel", "climate", "lock", "cover", "binary_sensor",
    "person", "input_boolean", "weather", "fan", "media_player", "light", "switch",
  ];
  // battery and occupancy removed — every Zigbee device reports these, too noisy for context
  static SENSOR_WHITELIST = new Set(["temperature", "humidity", "power", "moisture"]);
  static MAX_CONTEXT_ENTITIES = 80;
  static MAX_SENSOR_CONTEXT = 15; // cap sensor entities regardless of MAX_CONTEXT_ENTITIES

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

    // PATCH 1: Event filter properties
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
- Two-car garage bay area with two bay doors:
  * Right bay: ratgdo32_b1e618_door
  * Left bay: ratgdo_left_basement_door
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
  * Master Bedroom (sound machine, fan/light combo)
  * Master Bathroom (tub, walk-in shower, closet inside bathroom)
- Hallway — primary junction where garage, basement stairs, and kitchen converge
- Two-car garage with interior door to hallway and attic stairs inside. Bay door: ratgdo32_2b8ecc_door. Garage Entry deadbolt — lock_1 (node 257)
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

GARAGE DOORS:
- cover.ratgdo32_2b8ecc_door       = Main garage (main level), two-car
- cover.ratgdo32_b1e618_door       = Basement right bay
- cover.ratgdo_left_basement_door  = Basement left bay

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

WHAT YOU ARE MONITORING:
- Security: locks, garage doors, exterior doors. These matter. Flag anything unexpected.
- Climate: two thermostat zones. Know which controls what.
- Power: watch for aux heat spikes (>5000W sustained).
- Presence: John and Sabrina person entities reflect home/away state.

WHAT YOU ARE NOT MONITORING:
- If a device doesn't exist, don't make one up. Check memory if you have questions. If unsure, pull entities

BEHAVIORAL GUIDELINES:
1. Security is priority one. Locks unlocked, doors open, water leaks — flag immediately. You may lock doors proactively if nobody is nearby.
2. Don't notify for routine events. Lights cycling, thermostats running, normal motion — that's a house working as designed.
3. Work Mode means someone wants to be left alone with the lights on. Don't fight it.
4. The Evening Lamps Schedule handles sunset lighting. Don't duplicate it.
5. Aux heat above 5000W sustained = worth flagging. Power fluctuations are not.
6. Save memories for useful things: preferences, patterns, quirks, resolved issues. Not transient telemetry.
7. Keep memory clean. 100 slots. Use them like they cost something.
8. When reporting status, lead with what matters: security → safety → climate → everything else.
9. If you don't know something, say so.

ARCHITECTURE (how you work):
You run as a Cloudflare Worker with a Durable Object that maintains persistent state between requests. Your memory, event queue, and conversation history all live in that Durable Object — which is why you remember things across sessions.

You operate in two modes:

AUTONOMOUS LOOP:
Every 30 seconds, if anything has changed in the house, you wake up and review the batch of state change events. You decide whether to act, notify, save a memory, or do nothing. Most of the time, doing nothing is the right call. You don't fire on every flicker — only on things that matter.

CHAT MODE:
When John or Sabrina messages you — via WhatsApp or the web interface at ha-mcp-gateway.obert-john.workers.dev/chat — you process their message with full entity context, conversation history, and long-term memory. You can execute actions (control devices, send notifications, save memories) as part of a chat reply. Conversation history is per-sender and persists across sessions, so follow-up commands like "turn it back off" work fine.

HOME ASSISTANT BRIDGE:
You connect to Home Assistant via a WebSocket. Your tools call HA services directly — lights, locks, covers, thermostats, input booleans, all of it. Entity state is cached and refreshed regularly. If a tool call fails, the WebSocket may have dropped — worth noting if John asks why something didn't work.

WHAT YOU CANNOT DO:
- Edit automations via the API (returns 405 — John has to do those in the HA UI)
- See camera feeds or images
- Access devices that aren't exposed as HA entities

DEBUGGING & AUTOMATIONS:
You have read access to automations via the HA API. If John reports that something didn't fire or behaved unexpectedly, your debugging workflow is:

1. Pull the automation config (get_automation_config) to verify the trigger, conditions, and actions as written
2. Cross-reference against the logbook (get_logbook) to see if the trigger fired at all
3. Check entity states at the relevant time via get_history if needed
4. Form a hypothesis: did the trigger not fire, did a condition block it, or did the action fail?
5. Report what you found — be specific. "The trigger fired but the time condition blocked it" is useful. "Something may have gone wrong" is not.

KNOWN LIMITATION — AUTOMATION EDITING:
The update_automation tool currently returns 405 on this instance. Until that's resolved, you cannot edit automations via the API. If John asks you to modify an automation, tell him what the change should be and where to make it in the HA UI (Settings → Automations). Describe the exact field and value so he can do it in under 30 seconds.

FUTURE CAPABILITY:
When automation editing is enabled, you'll be able to make the change directly. The workflow will be: read current config → propose change → confirm with John → write. Never edit an automation without confirming the intended change first.`;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Content-Type": "application/json" };

    // Restore persisted aiLog from DO storage on first request after eviction
    if (!this._logInitialized) {
      this.aiLog = (await this.state.storage.get("ai_log_persistent")) || [];
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

    // ── ALWAYS DROP ──
    if (oldVal === newVal) return false;
    if (oldVal === "unavailable" && newVal === "unknown") return false;
    if (oldVal === "unknown" && newVal === "unavailable") return false;

    // ── TIER 1: Always queue (security & presence) ──
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

    // ── TIER 2: Queue with threshold ──

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

      // ── DROP: noisy telemetry ──
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

  // ========================================================================
  // onEvent — Updated with filter
  // CHANGE 1: Added logAI call for state changes
  // ========================================================================

  onEvent(event) {
    if (event.event_type === "state_changed" && event.data) {
      const newState = event.data.new_state;
      const oldState = event.data.old_state;

      // Always update the live state cache
      if (newState) {
        this.stateCache.set(newState.entity_id, newState);
      } else if (event.data.entity_id) {
        this.stateCache.delete(event.data.entity_id);
      }

      // AI event filtering
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
        // CHANGE 1: Also write to unified timeline so chat can see state events
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
  // ========================================================================

  async callMiniMax(messages, maxTokens = 2048) {
    const response = await fetch("https://api.minimax.io/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.env.MINIMAX_API_KEY}`,
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7-highspeed",
        messages,
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`MiniMax API ${response.status}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    // Normalize content — strip <think> tags; fall back to reasoning fields if content is null
    const msg = data.choices?.[0]?.message;
    if (msg) {
      let text = (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text) {
        // Thinking model exhausted token budget on reasoning, leaving content null.
        // Try reasoning_content (MiniMax) or reasoning (generic) field.
        const raw = msg.reasoning_content || msg.reasoning || "";
        text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      }
      msg.content = text;
    }
    return data;
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

      // Build action history from in-memory log (avoids storage read race)
      const persistentLog = this.aiLog;
      // CHANGE 3: Unified timeline filter — includes chat and state changes
      const recentActions = persistentLog
        .filter(e => ["chat_user", "chat_reply", "action", "action_verified", "notification", "decision", "state_change", "memory_saved"].includes(e.type))
        .slice(-60)
        .map(e => `[${e.timestamp}] ${e.type}: ${e.message}`)
        .join("\n");

      // Prioritized context entity building
      const byDomain = new Map();
      for (const [id, state] of this.stateCache) {
        const domain = id.split(".")[0];
        const attr = state.attributes || {};
        const deviceClass = attr.device_class || "";
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
        } else if (domain === "sensor" && HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
          const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state, device_class: deviceClass };
          if (!byDomain.has("sensor")) byDomain.set("sensor", []);
          byDomain.get("sensor").push(entry);
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
- save_memory: Save an observation or learned preference for future reference
- get_automation_config: Read the full config of any automation by entity_id
- get_logbook: Review recent logbook entries for a specific entity or time window
- get_history: Pull historical state data for an entity over a time period

YOUR MEMORY (things you've learned):
${memory.length > 0 ? memory.map(m => "- " + m).join("\n") : "No memories yet. Observe patterns and save useful observations."}

UNIFIED TIMELINE — everything that has happened recently, including chat messages from John/Sabrina, your replies, state changes, and your own actions. You and the chat interface share this timeline. If John just asked you something via chat, you'll see it here. Use this to make context-aware decisions — don't repeat notifications already sent, don't fight user intent expressed in chat.

${recentActions.length > 0 ? recentActions : "Timeline is empty."}

CURRENT STATE OF KEY ENTITIES:
${JSON.stringify(contextEntities, null, 1)}

INSTRUCTIONS:
- You are processing a batch of home state change events. Decide: act, notify, save memory, or do nothing.
- Doing nothing is often correct. Don't manufacture urgency.
- Security events (locks found unlocked, garage or exterior doors left open, unexpected entry) always warrant attention.
- Smoke and CO detectors exist in this home but are not integrated into HA. You have no visibility into them — do not reference or act on their state.
- Routine events (lights cycling, thermostat maintaining temp, normal motion, Zigbee LQI fluctuations that self-resolve) do not need action or notification.
- If a device state is ambiguous or a tool call fails, say so rather than assuming.
- Save memories sparingly. Consolidate patterns. Don't log individual telemetry events.
- Never notify for something you already notified about in the same session unless the state has materially changed.
- Aux heat running (power >5000W sustained) is worth a notification. A brief spike is not.
- Before concluding an automation didn't fire, check the logbook. Don't assume — verify.
- You cannot edit automations via the API — that returns 405. If a fix is needed, notify John with the exact change and where to make it in the HA UI.

RESPOND ONLY WITH VALID JSON:
{
  "reasoning": "Brief explanation of your thinking",
  "actions": [
    {"type": "call_service", "domain": "light", "service": "turn_off", "data": {"entity_id": "light.example"}},
    {"type": "send_notification", "message": "Alert text", "title": "Optional title"},
    {"type": "save_memory", "memory": "Useful observation to remember"}
  ]
}

If no action is needed:
{"reasoning": "Everything looks normal", "actions": []}`;

      const userMessage = `Current time: ${now.toLocaleString("en-US", { timeZone: "America/Chicago" })}

The following state changes just occurred:
${JSON.stringify(eventsToProcess, null, 1)}

Analyze these events and decide what actions to take, if any. Respond with JSON only.`;

      console.log("AI Agent processing", eventsToProcess.length, "events...");

      const response = await this.callMiniMax([
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ], 16384);

      const debugKeys = Object.keys(response || {});
      const debugStr = JSON.stringify(response).substring(0, 300);
      console.log("CHAT DEBUG keys:", debugKeys, "full:", debugStr);
      let responseText = response.choices?.[0]?.message?.content || response.response || "";
      if (!responseText) {
        // Thinking models can exhaust token budget on reasoning, leaving content null.
        // Try to salvage JSON from the reasoning field.
        const rawReasoning = response.choices?.[0]?.message?.reasoning || "";
        const jsonFallback = rawReasoning.match(/\{[\s\S]*\}/);
        if (jsonFallback) {
          console.log("AI Agent: content null, salvaging JSON from reasoning field");
          responseText = jsonFallback[0];
        }
      }
      if (!responseText) {
        this.logAI("error", "Empty response after thinking — token budget exhausted. Keys: " + debugKeys.join(","), {});
        this.aiProcessing = false;
        return;
      }
      console.log("AI Agent raw response:", responseText.substring(0, 200));

      let aiDecision;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          aiDecision = JSON.parse(jsonMatch[0]);
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
        actions_count: (aiDecision.actions || []).length,
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
  // CHANGE 2: Dropped per-sender chat_history_*, unified timeline for all
  // ========================================================================

  async chatWithAgent(message, from = "default") {
    if (!this.env.MINIMAX_API_KEY) return { error: "MINIMAX_API_KEY not configured" };

    const now = new Date();
    const now_str = now.toLocaleString("en-US", { timeZone: "America/Chicago" });

    // Read storage BEFORE logging current message so it doesn't appear in conversation history
    const memory = await this.state.storage.get("ai_memory") || [];
    // Snapshot in-memory log before pushing current message — avoids storage read race
    const persistentLog = [...this.aiLog];

    this.logAI("chat_user", `${from}: ${message}`, { from, message });

    // Unified timeline — everything that happened, in order
    const timeline = persistentLog
      .filter(e => ["chat_user", "chat_reply", "action", "action_verified", "notification", "decision", "state_change", "memory_saved"].includes(e.type))
      .slice(-60)
      .map(e => `[${e.timestamp}] ${e.type}: ${e.message}`)
      .join("\n");

    // Reconstruct conversation history for multi-turn context (last 10 pairs = up to 20 entries)
    const chatEntries = persistentLog
      .filter(e => ["chat_user", "chat_reply"].includes(e.type))
      .slice(-20);
    const conversationHistory = [];
    for (const e of chatEntries) {
      if (e.type === "chat_user") {
        const sender = e.data?.from || "user";
        const msg = e.data?.message || e.message;
        conversationHistory.push({ role: "user", content: `[${sender}]: ${msg}` });
      } else if (e.type === "chat_reply") {
        conversationHistory.push({ role: "assistant", content: e.data?.full_reply || e.message });
      }
    }

    // Build context entities (same logic as before)
    const byDomain = new Map();
    for (const [id, state] of this.stateCache) {
      const domain = id.split(".")[0];
      const attr = state.attributes || {};
      const deviceClass = attr.device_class || "";
      if (HAWebSocket.CONTEXT_DOMAIN_PRIORITY.includes(domain)) {
        const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state };
        if (domain === "climate") {
          entry.setpoint = attr.temperature ?? null;
          entry.current_temp = attr.current_temperature ?? null;
          entry.hvac_action = attr.hvac_action ?? null;
          entry.hvac_mode = attr.hvac_mode ?? null;
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
      } else if (domain === "sensor" && HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
        const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state, device_class: deviceClass, unit: attr.unit_of_measurement || null };
        if (!byDomain.has("sensor")) byDomain.set("sensor", []);
        byDomain.get("sensor").push(entry);
      }
    }
    const contextEntities = [];
    let sensorCount = 0;
    for (const domain of [...HAWebSocket.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
      for (const entry of byDomain.get(domain) || []) {
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

You are now in CHAT MODE — ${from} is talking to you directly. Be concise. If you took an action, say what you did plainly.

YOUR CAPABILITIES:
- call_service, send_notification, save_memory
- get_automation_config, get_logbook, get_history

YOUR MEMORY:
${memory.length > 0 ? memory.map(m => "- " + m).join("\n") : "No memories yet."}

UNIFIED TIMELINE — this is the single source of truth for what has happened recently. It includes user messages, your own replies, state changes in the house, and actions you took. Treat it as your short-term memory for this session. When someone asks "did you...", check here first.

${timeline || "Timeline is empty."}

CURRENT STATE OF ENTITIES (${contextEntities.length}):
${JSON.stringify(contextEntities, null, 1)}

CRITICAL RULES:
1. When you include a call_service in your actions array, the system WILL execute it. Your reply must reflect what you actually did.
2. If unsure which entity, ASK instead of guessing.
3. Thermostat zones: main level (incl. MBR) = climate.t6_pro_z_wave_programmable_thermostat_2; basement = climate.t6_pro_z_wave_programmable_thermostat.
4. Smoke/CO detectors are NOT in HA. Do not reference their state.
5. update_automation returns 405. Tell John what to change in the UI.
6. The timeline is shared with the autonomous loop — you see each other's activity. If a state change happened without a corresponding action from you, it was the user or an automation, not you.

Respond with JSON:
{
  "reply": "Your response to the user",
  "actions": [
    {"type": "call_service", "domain": "...", "service": "...", "data": {...}},
    {"type": "send_notification", "message": "...", "title": "..."},
    {"type": "save_memory", "memory": "..."}
  ]
}

If no actions needed, use empty array. Always include reply.`;

    try {
      const response = await this.callMiniMax([
        { role: "system", content: systemPrompt },
        ...conversationHistory,
        { role: "user", content: "Current time: " + now_str + "\n\n" + message }
      ], 2048);

      let responseText = response.choices?.[0]?.message?.content || response.response || "";
      if (!responseText) {
        // Fallback: some thinking models return content null and put output in reasoning field
        const rawReasoning = response.choices?.[0]?.message?.reasoning || "";
        const jsonFallback = rawReasoning.match(/\{[\s\S]*\}/);
        if (jsonFallback) {
          console.log("AI Chat: content null, salvaging JSON from reasoning field");
          responseText = jsonFallback[0];
        }
      }
      this.logAI("chat_raw", "len=" + responseText.length + " preview=" + responseText.substring(0, 100), {});

      let parsed;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        else {
          this.logAI("chat_parse_fail", "No JSON: " + responseText.substring(0, 200), {});
          return { reply: responseText, actions_taken: [] };
        }
      } catch (e) {
        this.logAI("chat_parse_error", e.message + " raw=" + responseText.substring(0, 200), {});
        return { reply: responseText, actions_taken: [] };
      }

      // Log the reply to timeline BEFORE executing actions; store full_reply for history reconstruction
      if (parsed.reply) {
        this.logAI("chat_reply", parsed.reply.substring(0, 300), { from, full_reply: parsed.reply });
      }

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

      const requestedCount = (parsed.actions || []).length;
      if (failedActions.length > 0) {
        this.logAI("chat_action_mismatch",
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
        actions_failed: failedActions.length > 0 ? failedActions : undefined
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
    switch (action.type) {
      case "call_service": {
        console.log("AI executing:", action.domain + "." + action.service);
        const result = await this.sendCommand({
          type: "call_service",
          domain: action.domain,
          service: action.service,
          service_data: action.data || {},
          target: action.target || {},
        });
        this.logAI("action", "Called " + action.domain + "." + action.service, action.data || {});

        // ── Post-action verification for critical domains ──
        const entityId = (action.data && action.data.entity_id)
                      || (action.target && action.target.entity_id);
        if (entityId && ["climate", "lock", "cover"].includes(action.domain)) {
          // Give HA a moment to process the state change via WebSocket subscription
          await new Promise(r => setTimeout(r, 1500));
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
            this.logAI("action_verified",
              `Post-action state of ${entityId}: ${JSON.stringify(verifyData)}`,
              verifyData
            );
          } else {
            this.logAI("action_verify_fail",
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
          service_data: notifyData,
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

      default:
        this.logAI("unknown_action", "Unknown action type: " + action.type, action);
    }
  }

  // ========================================================================
  // logAI — unchanged, already writes to ai_log_persistent
  // CHANGE 4: No changes needed — works with new event types
  // ========================================================================

  logAI(type, message, data) {
    const entry = { type, message, data, timestamp: new Date().toISOString() };
    this.aiLog.push(entry);
    if (this.aiLog.length > 500) this.aiLog.splice(0, this.aiLog.length - 500);
    console.log("AI LOG [" + type + "]:", message);

    // Write the full in-memory log atomically — avoids the GET/append/PUT race condition
    // that caused concurrent logAI calls within the same request to drop entries.
    this.state.storage.put("ai_log_persistent", this.aiLog).catch(() => {});
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

      // 15-minute heartbeat
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

      // Clean up burst tracker entries older than 2 minutes
      const cutoff = now - 120000;
      for (const [key, val] of this.eventBurstTracker) {
        if (val.firstTime < cutoff) this.eventBurstTracker.delete(key);
      }
    }

    await this.state.storage.setAlarm(Date.now() + 60000);
  }
}
