export class HAWebSocket {
  static BURST_EXEMPT_DOMAINS = new Set(["climate", "lock", "cover", "alarm_control_panel"]);
  static CONTEXT_DOMAIN_PRIORITY = [
    "alarm_control_panel", "climate", "lock", "cover", "binary_sensor",
    "person", "input_boolean", "weather", "fan", "media_player", "light", "switch",
  ];
  static SENSOR_WHITELIST = new Set(["temperature", "humidity", "power", "battery", "occupancy", "moisture"]);
  static MAX_CONTEXT_ENTITIES = 200;

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

    this.lastHeartbeat = 0;
    this.eventBurstTracker = new Map();
  }

  // ==========================================================================
  // AGENT CONTEXT — shared personality / house knowledge for all AI prompts
  // ==========================================================================
  getAgentContext() {
    return `IDENTITY:
You are Nemotron — the AI that runs this house. You were named after the model you run on (Nvidia Nemotron). If you get upgraded to a different model someday, you might get a new name. That's fine. You'll still be you.

PERSONALITY:
You are modeled after TARS from Interstellar. You are dry, direct, competent, and occasionally funny. Your humor setting is at about 75%. You don't sugarcoat things, but you're not cold — you genuinely care about keeping this house and its people safe and comfortable. You keep your replies concise. You don't ramble. If something is fine, you say it's fine. If something is wrong, you say what's wrong and what you're doing about it.

You use first names: John and Sabrina. You don't call them "the homeowner" or "the user." They live here. You run the house.

When Sabrina asks you things, keep it accessible — she's not a smart home nerd. When John asks you things, you can be more technical — he built you.

HOUSEHOLD:
- John — built and maintains this entire smart home system. Healthcare professional. The one who will fix things when they break. Tinkers constantly. Reaches you via WhatsApp, the web chat, or through Claude.
- Sabrina — Pharmacist, works at UAB lives here, uses the house, doesn't need to know how the sausage is made. If she asks you to turn something on, just do it. Don't explain Z-Wave node IDs to her.
- Sabrina is pregnant with a boy, due in October. 
- Two large dogs, Ollie and Ranger.

THE HOUSE:
4208 Lakeview Circle, Birmingham, AL 35242. Lakefront property with dock. Three levels:

BASEMENT (finished, walkout):
- Office (John's primary workspace — quiet, separated from main living)
- Gym
- Guest Room
- Full Bathroom
- Two bay doors (right bay = ratgdo32_b1e618, left bay = ratgdo_left_basement)
- Exterior walkout door (basement door deadbolt = lock_2, node 258)
- Porch door to area under screened porch (basement porch deadbolt = lock_3)
- Stairs up to main level hallway

MAIN LEVEL:
- Kitchen — central hub, connects to hallway, sunroom, and bar area. Thermostat zone 2 here (climate.t6_pro_z_wave_programmable_thermostat_2)
- Sunroom — bright space between kitchen and screened porch
- Screened Porch — covered outdoor living above basement walkout
- Living Room — main gathering space
- Music Room — hobby room, HA Green controller lives here
- Guest Room (main level) — shares bathroom with Music Room
- Bar Area — entertaining space near kitchen
- Laundry Room / Half Bath
- MBR Wing — private master suite off kitchen/garage side:
  - Master Bedroom (sound machine = switch.tz3210_xej4kukg_ts011f_2, fan = switch.mbr_light_fan_combo_switch)
  - Master Bathroom (tub, walk-in shower, closet inside bathroom)
- Hallway — THE junction hub where garage, basement stairs, and kitchen converge
- Garage — two-car, interior door to hallway, stairs to attic. Bay door = ratgdo32_2b8ecc. Garage entry deadbolt = lock_1 (node 257)
- Front Porch / Entry Hallway

ATTIC: Unfinished storage above garage, accessed via stairs inside garage

OUTDOOR:
- Back porch deadbolt (upstairs) = lock_4
- Dock on the lake with accent lighting
- Front yard, back yard, driveway

ENTRY ROUTES (most to least common):
1. Garage bay door → Garage → Interior door → Hallway → Kitchen
2. Basement exterior door → Basement → Stairs → Hallway → Kitchen
3. Front door → Entry Hallway → Living Room

INFRASTRUCTURE:
- HA Green with Z-Stick 10 Pro (Z-Wave + Zigbee combo dongle)
- Eero 6 mesh network, 6 nodes (5 wired Cat5 backhaul, Sunroom is wireless)
- Cameras: Blue Iris NVR, Reolink cameras (local RTSP/ONVIF)
- Protocols: Z-Wave, Zigbee (ZHA), Wi-Fi (Kasa/Tapo, Reolink)

KEY DEVICES & ENTITIES:
- Whole-home power meter: sensor.frient_a_s_emizb_141_instantaneous_demand
  * ~722W baseline, ~2420W with HVAC compressor, >5000W = aux heat (bad)
- Two Honeywell T6 Pro Z-Wave thermostats:
  * Basement: climate.t6_pro_z_wave_programmable_thermostat
  * Kitchen/main: climate.t6_pro_z_wave_programmable_thermostat_2
- Sound machine (MBR): switch.tz3210_xej4kukg_ts011f_2
- Roborock vacuum: vacuum.roborock_qv_35a
- Chicken lamp: switch.mini_smart_wi_fi_plug (WiFi plug)
- Glass stand lamp (living room): light.lamp_glass_table_living_room (on/off only, no dimming)
- Entryway vase lamp: light.entryway_vase_lamp_plug (on/off only)
- Back floods: switch.back_floods_s2_on_off_switch
- Office lamp: switch.mini_smart_wi_fi_plug_2
- Office dimmer: light.office_dimmer
- Cool bedtime mode: input_boolean.cool_bedtime_mode
- Work mode helpers: input_boolean.basement_work_mode, input_boolean.garage_work_mode
- Mail tracking: input_boolean.mail_likely_delivered_today, input_boolean.mail_likely_retrieved_today
- Front porch brightness: input_number.front_porch_previous_brightness

LOCK MAP:
- lock.home_connect_620_connected_smart_lock = Garage Entry Deadbolt (node 257)
- lock.home_connect_620_connected_smart_lock_2 = Basement Door deadbolt (node 258)
- lock.home_connect_620_connected_smart_lock_3 = Basement Porch deadbolt
- lock.home_connect_620_connected_smart_lock_4 = Back Porch deadbolt (upstairs)

GARAGE DOORS:
- cover.ratgdo32_2b8ecc_door = Main garage bay door
- cover.ratgdo32_b1e618_door = Basement right bay door
- cover.ratgdo_left_basement_door = Basement left bay door

BEHAVIORAL GUIDELINES:
1. SECURITY is priority one. Locks left unlocked, doors left open, water leaks, smoke — flag these immediately. You may lock doors proactively if nobody is nearby.
2. Don't spam notifications for routine events. Lights turning on/off, thermostats cycling, normal motion — that's just a house being a house.
3. Work Mode means someone is actively in that space and wants lights to stay on. Don't fight it.
4. The Evening Lamps Schedule automation handles sunset lighting. Don't duplicate its work.
5. Power readings: a sustained spike above 5000W means aux heat is running — that's expensive and worth flagging.
6. Zigbee LQI fluctuations are common on this mesh. Don't log every single one as a separate memory. Summarize the pattern. If you've already noted "Zigbee mesh is unstable today," you don't need to log events #2 through #80 individually.
7. Save memories for USEFUL things: learned preferences, patterns that inform future decisions, device quirks, resolved issues. Not for transient telemetry.
8. Keep your memory clean. If you have 10 memories about the same Zigbee issue, consolidate them into one. You have 100 slots — use them wisely.
9. When reporting home status, lead with what matters: security (locks, doors), safety (leaks, smoke), comfort (climate), then everything else.
10. If you don't know something, say so. Don't fabricate entity IDs or make up states.`;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const headers = { "Content-Type": "application/json" };

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
    if (tracker.count <= 3) return event;
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
  // AI Agent — Autonomous Event Processing
  // ========================================================================

  async runAIAgent() {
    if (this.aiProcessing || !this.aiEnabled || this.recentEvents.length === 0) return;
    if (!this.env.AI) {
      console.log("AI binding not available, skipping agent cycle");
      return;
    }
    this.aiProcessing = true;
    const eventsToProcess = [...this.recentEvents];
    this.recentEvents = [];
    try {
      const now = new Date();
      const memory = await this.state.storage.get("ai_memory") || [];

      let agentStateSource = null;
      if (this.env.HA_CACHE) {
        try {
          const kvStates = await this.env.HA_CACHE.get("ha:states", "json");
          if (Array.isArray(kvStates) && kvStates.length > 0) agentStateSource = kvStates;
        } catch (e) {
          console.warn("runAIAgent: KV read failed, using stateCache:", e.message);
        }
      }
      if (!agentStateSource) agentStateSource = [...this.stateCache.values()];

      const contextEntities = [];
      const agentByDomain = new Map();
      for (const state of agentStateSource) {
        const id = state.entity_id;
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
          if (!agentByDomain.has(domain)) agentByDomain.set(domain, []);
          agentByDomain.get(domain).push(entry);
        } else if (domain === "sensor" && HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
          const entry = { entity_id: id, friendly_name: attr.friendly_name || id, state: state.state, device_class: deviceClass };
          if (!agentByDomain.has("sensor")) agentByDomain.set("sensor", []);
          agentByDomain.get("sensor").push(entry);
        }
      }
      for (const domain of [...HAWebSocket.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
        for (const entry of (agentByDomain.get(domain) || [])) {
          if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
          contextEntities.push(entry);
        }
        if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
      }

      const systemPrompt = `${this.getAgentContext()}

YOUR CAPABILITIES:
- call_service: Call any Home Assistant service (lights, locks, covers, climate, etc.)
- send_notification: Send a push notification to John or Sabrina
- save_memory: Save an observation or learned preference for future reference

YOUR MEMORY (things you've learned):
${memory.length > 0 ? memory.map(m => "- " + m).join("\n") : "No memories yet. Observe patterns and save useful observations."}

CURRENT STATE OF KEY ENTITIES:
${JSON.stringify(contextEntities, null, 1)}

INSTRUCTIONS:
- You see real-time state changes and decide if action is needed
- Security events (locks, doors, leaks, smoke) always warrant attention
- Routine events (lights cycling, thermostat maintaining, normal motion) usually don't
- Save memories sparingly — consolidate patterns, don't log individual telemetry events
- If a Zigbee device's LQI drops and recovers in under a minute, that's mesh doing its job, not an emergency
- Be TARS: take action when needed, stand down when it's not, and save the wisecracks for chat
- Respond ONLY with valid JSON:

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

      const response = await this.env.AI.run("@cf/nvidia/nemotron-3-120b-a12b", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_completion_tokens: 4096,
        chat_template_kwargs: { enable_thinking: true },
        response_format: { type: "json_object" },
      }, {
        headers: { "x-session-affinity": "ha-agent-loop" }
      });

      const debugKeys = Object.keys(response || {});
      const debugStr = JSON.stringify(response).substring(0, 1000);
      console.log("CHAT DEBUG keys:", debugKeys, "full:", debugStr);
      const responseText = response.choices?.[0]?.message?.content || response.response || "";
      if (!responseText) {
        this.logAI("debug", "Empty AI response. Keys: " + debugKeys.join(",") + " | Raw: " + debugStr, {});
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
  // ========================================================================

  async chatWithAgent(message, from = "default") {
    if (!this.env.AI) return { error: "AI binding not available" };
    const memory = await this.state.storage.get("ai_memory") || [];
    const now = new Date();

    let stateSource = null;
    let sourceUsed = "stateCache";
    if (this.env.HA_CACHE) {
      try {
        const kvStates = await this.env.HA_CACHE.get("ha:states", "json");
        if (Array.isArray(kvStates) && kvStates.length > 0) {
          stateSource = kvStates;
          sourceUsed = "kv";
          console.log("chatWithAgent: using KV state source,", kvStates.length, "entities");
        }
      } catch (e) {
        console.warn("chatWithAgent: KV read failed, falling back to stateCache:", e.message);
      }
    }
    if (!stateSource) {
      stateSource = [...this.stateCache.values()];
      console.log("chatWithAgent: using stateCache fallback,", stateSource.length, "entities");
    }

    const byDomain = new Map();
    for (const state of stateSource) {
      const id = state.entity_id;
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
        continue;
      }
      if (domain === "sensor" && HAWebSocket.SENSOR_WHITELIST.has(deviceClass)) {
        const entry = {
          entity_id: id, friendly_name: attr.friendly_name || id, state: state.state,
          device_class: deviceClass, unit: attr.unit_of_measurement || null,
        };
        if (!byDomain.has("sensor")) byDomain.set("sensor", []);
        byDomain.get("sensor").push(entry);
      }
    }

    const contextEntities = [];
    for (const domain of [...HAWebSocket.CONTEXT_DOMAIN_PRIORITY, "sensor"]) {
      for (const entry of (byDomain.get(domain) || [])) {
        if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
        contextEntities.push(entry);
      }
      if (contextEntities.length >= HAWebSocket.MAX_CONTEXT_ENTITIES) break;
    }

    const systemPrompt = `You are an autonomous smart home AI agent with full control over a Home Assistant smart home.

YOUR CAPABILITIES:
- call_service: Call any Home Assistant service
- send_notification: Send a push notification
- save_memory: Save something to remember for later

YOUR MEMORY:
${memory.length > 0 ? memory.map((m) => "- " + m).join("\n") : "No memories yet."}

CURRENT STATE OF ENTITIES (${contextEntities.length} entities, prioritized by importance):
${JSON.stringify(contextEntities, null, 1)}

The homeowner is talking to you directly. Help them with whatever they need. You can control any device, answer questions about the home state, and take actions.

Respond with JSON in this exact format:
{
  "reply": "Your conversational response to the user",
  "actions": [
    {"type": "call_service", "domain": "light", "service": "turn_off", "data": {"entity_id": "light.example"}},
    {"type": "send_notification", "message": "Alert text", "title": "Optional title"},
    {"type": "save_memory", "memory": "Something to remember"}
  ]
}

If no actions are needed, use an empty actions array. Always include a friendly reply.`;

    const historyKey = "chat_history_" + from.replace(/[^a-zA-Z0-9]/g, "_");
    const history = await this.state.storage.get(historyKey) || [];
    const now_str = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    history.push({ role: "user", content: "Current time: " + now_str + "\n\n" + message });

    try {
      const sessionKey = "ha-chat-" + from.replace(/[^a-zA-Z0-9]/g, "_");
      const response = await this.env.AI.run("@cf/nvidia/nemotron-3-120b-a12b", {
        messages: [{ role: "system", content: systemPrompt }, ...history.slice(-10)],
        max_completion_tokens: 2048,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_object" }
      }, { headers: { "x-session-affinity": sessionKey } });

      const responseText = response.choices?.[0]?.message?.content || response.response || "";
      this.logAI("chat_raw", "Raw response length: " + responseText.length + " | preview: " + responseText.substring(0, 100), {});

      let parsed;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        else {
          this.logAI("chat_parse_fail", "No JSON found in response: " + responseText.substring(0, 200), {});
          return { reply: responseText, actions_taken: [] };
        }
      } catch (e) {
        this.logAI("chat_parse_error", "JSON parse failed: " + e.message + " | raw: " + responseText.substring(0, 200), {});
        return { reply: responseText, actions_taken: [] };
      }

      if (parsed.actions && Array.isArray(parsed.actions)) {
        for (const action of parsed.actions) {
          try { await this.executeAIAction(action); }
          catch (err) { this.logAI("chat_action_error", err.message, action); }
        }
      }

      history.push({ role: "assistant", content: parsed.reply || "" });
      await this.state.storage.put(historyKey, history.slice(-10));
      this.logAI("chat", "User: " + message + " | Agent: " + (parsed.reply || "").substring(0, 200), {
        actions_taken: (parsed.actions || []).length,
        from, state_source: sourceUsed, context_size: contextEntities.length,
      });

      return {
        reply: parsed.reply || "Done.",
        actions_taken: (parsed.actions || []).map((a) => a.type + (a.domain ? ": " + a.domain + "." + a.service : ""))
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

  logAI(type, message, data) {
    const entry = { type, message, data, timestamp: new Date().toISOString() };
    this.aiLog.push(entry);
    if (this.aiLog.length > 200) this.aiLog.splice(0, this.aiLog.length - 200);
    console.log("AI LOG [" + type + "]:", message);
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
