import { HAWebSocket } from "./ha-websocket.js";
import {
  ALL_KINDS,
  fnv1aHex,
  vectorIdFor,
  buildEmbedText,
  buildEntityEmbedText,
  buildAutomationEmbedText,
  buildScriptEmbedText,
  buildSceneEmbedText,
  buildAreaEmbedText,
  buildDeviceEmbedText,
  buildServiceEmbedText,
  buildMemoryEmbedText,
  buildObservationEmbedText,
  buildMetadata,
  entityCategoryFor,
  isNoisyEntity,
  isNoisyService,
  flattenServiceFields,
  summarizeTriggers,
  summarizeActions,
  extractTopicTag
} from "./vectorize-schema.js";


// src/worker.js
var CACHE_TTL = {
  STATES: 90, // was 30 — shorter than the 60s cron interval, causing stale reads
  ENTITY_STATE: 90, // was 15 — same issue; align with cron cadence
  SERVICES: 86400,
  ENTITY_REGISTRY: 3600,
  CALENDARS: 3600,
  AREAS: 86400,
  DEVICES: 86400,
  DASHBOARDS: 3600,
  FLOORS: 86400,
  LABELS: 86400
};
var CK = {
  STATES: "ha:states",
  SERVICES: "ha:services",
  ENTITY_REGISTRY: "ha:entity_registry",
  CALENDARS: "ha:calendars",
  AREAS: "ha:areas",
  DEVICES: "ha:devices",
  DASHBOARDS: "ha:dashboards",
  FLOORS: "ha:floors",
  LABELS: "ha:labels",
  state: (id) => "ha:state:" + id
};
var TOOLS = [
  // --- States ---
  {
    name: "list_entities",
    description: "List all entities in Home Assistant. Optionally filter by domain or area name.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Filter by domain (e.g., 'light', 'switch', 'sensor')" },
        area: { type: "string", description: "Filter by area name (e.g., 'Kitchen', 'Living Room')" },
        force_refresh: { type: "boolean", description: "Bypass cache" }
      }
    }
  },
  {
    name: "get_state",
    description: "Get the current state and all attributes of a specific entity.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "The entity ID" },
        force_refresh: { type: "boolean", description: "Bypass cache" }
      },
      required: ["entity_id"]
    }
  },
  {
    name: "get_states_by_domain",
    description: "Get all entity states for a specific domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "The domain (e.g., 'light', 'switch')" },
        force_refresh: { type: "boolean", description: "Bypass cache" }
      },
      required: ["domain"]
    }
  },
  {
    name: "get_states_by_area",
    description: "Get all entity states for entities in a specific area.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", description: "The area name" }
      },
      required: ["area"]
    }
  },
  // --- Services ---
  {
    name: "call_service",
    description: "Call any Home Assistant service.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Service domain" },
        service: { type: "string", description: "Service name" },
        data: { type: "object", description: "Service data" }
      },
      required: ["domain", "service"]
    }
  },
  {
    name: "list_services",
    description: "List all available services, optionally filtered by domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Filter by domain" },
        force_refresh: { type: "boolean" }
      }
    }
  },
  // --- Areas & Devices ---
  {
    name: "list_areas",
    description: "List all areas defined in Home Assistant.",
    inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } }
  },
  {
    name: "get_area",
    description: "Get details about a specific area including all entities in it.",
    inputSchema: {
      type: "object",
      properties: { area: { type: "string", description: "The area name" } },
      required: ["area"]
    }
  },
  {
    name: "list_devices",
    description: "List all devices in Home Assistant.",
    inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } }
  },
  {
    name: "get_device",
    description: "Get detailed information about a specific device.",
    inputSchema: {
      type: "object",
      properties: { device_id: { type: "string" } },
      required: ["device_id"]
    }
  },
  // --- Entity Registry ---
  {
    name: "get_entity_registry",
    description: "Get detailed entity registry information.",
    inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } }
  },
  {
    name: "list_disabled_entities",
    description: "List all currently disabled entities.",
    inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } }
  },
  {
    name: "update_entity_registry",
    description: "Update entity registry properties like name, icon, area, or disabled state.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        name: { type: "string" },
        icon: { type: "string" },
        area_id: { type: "string" },
        disabled_by: { type: "string" }
      },
      required: ["entity_id"]
    }
  },
  {
    name: "disable_entity",
    description: "Disable an entity in the entity registry.",
    inputSchema: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"] }
  },
  {
    name: "enable_entity",
    description: "Re-enable a previously disabled entity.",
    inputSchema: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"] }
  },
  {
    name: "bulk_disable_entities",
    description: "Disable multiple entities at once.",
    inputSchema: { type: "object", properties: { entity_ids: { type: "array", items: { type: "string" } } }, required: ["entity_ids"] }
  },
  {
    name: "bulk_enable_entities",
    description: "Re-enable multiple entities at once.",
    inputSchema: { type: "object", properties: { entity_ids: { type: "array", items: { type: "string" } } }, required: ["entity_ids"] }
  },
  // --- Automations ---
  {
    name: "list_automations",
    description: "List all automations with their current state.",
    inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } }
  },
  {
    name: "trigger_automation",
    description: "Manually trigger an automation.",
    inputSchema: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"] }
  },
  {
    name: "toggle_automation",
    description: "Enable or disable an automation.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, enable: { type: "boolean" } },
      required: ["entity_id", "enable"]
    }
  },
  {
    name: "get_automation_config",
    description: "Get the full configuration of a specific automation.",
    inputSchema: { type: "object", properties: { automation_id: { type: "string" } }, required: ["automation_id"] }
  },
  {
    name: "create_automation",
    description: "Create a new automation.",
    inputSchema: { type: "object", properties: { config: { type: "object" } }, required: ["config"] }
  },
  {
    name: "update_automation",
    description: "⚠️ Broken — returns 405 Method Not Allowed on this instance. Do not use. Make automation changes manually via 'Edit in YAML' in the HA UI instead.",
    inputSchema: {
      type: "object",
      properties: { automation_id: { type: "string" }, config: { type: "object" } },
      required: ["automation_id", "config"]
    }
  },
  {
    name: "delete_automation",
    description: "Delete an automation.",
    inputSchema: { type: "object", properties: { automation_id: { type: "string" } }, required: ["automation_id"] }
  },
  // --- Scripts & Scenes ---
  {
    name: "list_scripts",
    description: "List all scripts.",
    inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } }
  },
  {
    name: "run_script",
    description: "Execute a script, optionally with variables.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, variables: { type: "object" } },
      required: ["entity_id"]
    }
  },
  {
    name: "list_scenes",
    description: "List all scenes.",
    inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } }
  },
  {
    name: "activate_scene",
    description: "Activate a scene.",
    inputSchema: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"] }
  },
  // --- History & Logbook ---
  {
    name: "get_history",
    description: "Get state history for entities over a time period.",
    inputSchema: {
      type: "object",
      properties: {
        entity_ids: { type: "string", description: "Comma-separated entity IDs" },
        start_time: { type: "string", description: "ISO 8601 start time" },
        end_time: { type: "string", description: "ISO 8601 end time" }
      },
      required: ["entity_ids", "start_time"]
    }
  },
  {
    name: "get_logbook",
    description: "Get logbook entries.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        start_time: { type: "string" },
        end_time: { type: "string" }
      },
      required: ["start_time"]
    }
  },
  // --- System ---
  { name: "get_config", description: "Get Home Assistant configuration.", inputSchema: { type: "object" } },
  { name: "check_config", description: "Check if configuration is valid.", inputSchema: { type: "object" } },
  { name: "restart_ha", description: "Restart Home Assistant.", inputSchema: { type: "object" } },
  { name: "get_error_log", description: "Get the error log.", inputSchema: { type: "object" } },
  // --- Notifications ---
  {
    name: "send_notification",
    description: "Send a notification.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        title: { type: "string" },
        service: { type: "string", description: "Notify service name" }
      },
      required: ["message"]
    }
  },
  // --- Helpers ---
  {
    name: "set_input_boolean",
    description: "Set input_boolean state.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, state: { type: "boolean" } },
      required: ["entity_id", "state"]
    }
  },
  {
    name: "set_input_number",
    description: "Set input_number value.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, value: { type: "number" } },
      required: ["entity_id", "value"]
    }
  },
  {
    name: "set_input_select",
    description: "Set input_select option.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, option: { type: "string" } },
      required: ["entity_id", "option"]
    }
  },
  {
    name: "set_input_datetime",
    description: "Set input_datetime value.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        datetime: { type: "string" },
        date: { type: "string" },
        time: { type: "string" }
      },
      required: ["entity_id"]
    }
  },
  // --- Climate ---
  {
    name: "set_climate",
    description: "Control a thermostat/climate device.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        temperature: { type: "number" },
        hvac_mode: { type: "string" }
      },
      required: ["entity_id"]
    }
  },
  // --- Covers ---
  {
    name: "control_cover",
    description: "Control a cover (garage door, blinds, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        command: { type: "string" },
        position: { type: "number" }
      },
      required: ["entity_id", "command"]
    }
  },
  // --- Locks ---
  {
    name: "control_lock",
    description: "Control a lock.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, command: { type: "string" } },
      required: ["entity_id", "command"]
    }
  },
  // --- Media Players ---
  {
    name: "control_media_player",
    description: "Control a media player.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        command: { type: "string" },
        volume_level: { type: "number" }
      },
      required: ["entity_id", "command"]
    }
  },
  // --- Lights ---
  {
    name: "control_light",
    description: "Control a light with brightness, color, transition.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        command: { type: "string" },
        brightness: { type: "number" },
        color_temp: { type: "number" },
        rgb_color: { type: "array", items: { type: "number" } },
        transition: { type: "number" }
      },
      required: ["entity_id", "command"]
    }
  },
  // --- Templates ---
  {
    name: "render_template",
    description: "Render a Jinja2 template in Home Assistant context.",
    inputSchema: {
      type: "object",
      properties: { template: { type: "string" } },
      required: ["template"]
    }
  },
  // --- Floors & Labels ---
  { name: "list_floors", description: "List all floors.", inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } } },
  { name: "list_labels", description: "List all labels.", inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } } },
  // --- Weather & Presence ---
  { name: "get_persons", description: "Get all person entities.", inputSchema: { type: "object" } },
  { name: "get_sun", description: "Get sun state with sunrise/sunset.", inputSchema: { type: "object" } },
  { name: "get_weather", description: "Get weather state and forecast.", inputSchema: { type: "object" } },
  // --- Calendar ---
  { name: "list_calendars", description: "List all calendar entities.", inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } } },
  {
    name: "get_calendar_events",
    description: "Get events from a calendar.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, start: { type: "string" }, end: { type: "string" } },
      required: ["entity_id"]
    }
  },
  // --- Todo ---
  { name: "list_todo_lists", description: "List all todo list entities.", inputSchema: { type: "object" } },
  {
    name: "get_todo_items",
    description: "Get items from a todo list.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, status: { type: "string" } },
      required: ["entity_id"]
    }
  },
  {
    name: "add_todo_item",
    description: "Add an item to a todo list.",
    inputSchema: {
      type: "object",
      properties: { entity_id: { type: "string" }, item: { type: "string" } },
      required: ["entity_id", "item"]
    }
  },
  // --- Dashboard ---
  { name: "get_dashboard_list", description: "List all Lovelace dashboards.", inputSchema: { type: "object", properties: { force_refresh: { type: "boolean" } } } },
  {
    name: "get_dashboard_config",
    description: "Get a dashboard's full Lovelace configuration.",
    inputSchema: { type: "object", properties: { dashboard_id: { type: "string" } } }
  },
  { name: "get_dashboard_resources", description: "List all custom Lovelace resources.", inputSchema: { type: "object" } },
  {
    name: "update_dashboard_config",
    description: "Update a dashboard's Lovelace configuration. Always backup first.",
    inputSchema: {
      type: "object",
      properties: { dashboard_id: { type: "string" }, config: { type: "object" } },
      required: ["config"]
    }
  },
  {
    name: "backup_dashboard_config",
    description: "Save a dashboard backup as a persistent notification.",
    inputSchema: { type: "object", properties: { dashboard_id: { type: "string" } } }
  },
  // --- WebSocket Status ---
  { name: "websocket_status", description: "Check real-time WebSocket connection status.", inputSchema: { type: "object" } },
  // --- Search Related (WebSocket only) ---
  {
    name: "search_related",
    description: "Search for all items related to an entity, device, area, or automation. WebSocket only.",
    inputSchema: {
      type: "object",
      properties: {
        item_type: { type: "string", description: "'entity', 'device', 'area', 'automation', 'scene', 'script', 'group', or 'config_entry'" },
        item_id: { type: "string" }
      },
      required: ["item_type", "item_id"]
    }
  },
  // --- Vector Search ---
  {
    name: "vector_search",
    description: "Semantic search over the unified home knowledge index. Returns ranked matches across entities, automations, scripts, scenes, areas, devices, HA services, agent memories, and agent observations. By default filters out diagnostic/config/counter entities and destructive services; pass include_noisy: true to include them. Restrict to specific kinds via the kinds array.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query" },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: ["entity", "automation", "script", "scene", "area", "device", "service", "memory", "observation"]
          },
          description: "Restrict to these kinds. Omit for all kinds."
        },
        domain: { type: "string", description: "Entity domain filter (light/switch/sensor/...). Most meaningful with kind=entity." },
        area: { type: "string", description: "Area name filter." },
        top_k: { type: "number", description: "How many matches to return. Default 15, max 50." },
        include_noisy: { type: "boolean", description: "Include diagnostic/config entities and destructive services. Default false." }
      },
      required: ["query"]
    }
  },
  // --- AI Agent ---
  { name: "ai_status", description: "Check the autonomous AI agent status.", inputSchema: { type: "object" } },
  { name: "ai_enable", description: "Enable the autonomous AI agent.", inputSchema: { type: "object" } },
  { name: "ai_disable", description: "Disable the autonomous AI agent.", inputSchema: { type: "object" } },
  {
    name: "ai_log",
    description: "View the AI agent's recent action log.",
    inputSchema: { type: "object", properties: { count: { type: "number" } } }
  },
  { name: "ai_clear_log", description: "Clear the AI agent's action log.", inputSchema: { type: "object" } },
  { name: "ai_memory", description: "View the AI agent's learned memories.", inputSchema: { type: "object" } },
  { name: "ai_clear_memory", description: "Clear the AI agent's memory.", inputSchema: { type: "object" } },
  { name: "ai_observations", description: "View the AI agent's observations-in-progress — patterns and hypotheses being tracked before promotion to memory.", inputSchema: { type: "object" } },
  { name: "ai_clear_observations", description: "Clear the AI agent's observations list.", inputSchema: { type: "object" } },
  { name: "ai_clear_chat", description: "Clear the AI agent's chat conversation history.", inputSchema: { type: "object" } },
  { name: "ai_trigger", description: "Force the AI agent to evaluate pending events now.", inputSchema: { type: "object" } },
  {
    name: "ai_chat",
    description: "Send a message to the autonomous AI home agent and get its response. The agent can see all entity states and take actions like controlling lights, locks, covers, and climate. Use for debugging the agent, getting home status summaries, or issuing commands through the agent.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to send to the AI home agent" }
      },
      required: ["message"]
    }
  },
  {
    name: "talk_to_agent",
    description: "Duplicate of ai_chat — use ai_chat instead. This tool is identical in behavior and will be removed in a future version.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Your message to the agent" } },
      required: ["message"]
    }
  },
  // --- Cache Management ---
  { name: "cache_status", description: "Show cached data status.", inputSchema: { type: "object" } },
  {
    name: "clear_cache",
    description: "Clear cache to force fresh data.",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "array", items: { type: "string" } } }
    }
  },
  // --- Fire Event ---
  {
    name: "fire_event",
    description: "Fire a custom event in Home Assistant.",
    inputSchema: {
      type: "object",
      properties: { event_type: { type: "string" }, event_data: { type: "object" } },
      required: ["event_type"]
    }
  },
  // --- Agent State ---
  {
    name: "save_memory",
    description: "Append a memory entry to the AI agent's persistent memory store (capped at 100). Memories are also embedded into the knowledge index for semantic retrieval via vector_search.",
    inputSchema: {
      type: "object",
      properties: { memory: { type: "string", description: "The memory text to save" } },
      required: ["memory"]
    }
  },
  {
    name: "save_observation",
    description: "Append an observation to the AI agent's observation log (capped at 500). If 'replaces' is set, prior entries whose text starts with that prefix are removed first. Observations are embedded into the knowledge index for semantic retrieval via vector_search.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Observation text to save" },
        replaces: { type: "string", description: "Optional prefix — removes prior entries starting with this string before appending" }
      },
      required: ["text"]
    }
  },
  {
    name: "ai_observations",
    description: "View the AI agent's saved observations.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "ai_send_notification",
    description: "Send a push notification AND log it to the unified AI timeline. Unlike send_notification, this records the event in ai_log so it appears in the agent's activity history.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Notification body text" },
        title: { type: "string", description: "Optional notification title" }
      },
      required: ["message"]
    }
  }
];

const DANGEROUS_TOOLS = new Set([
  "restart_ha",
  "delete_automation",
  "update_automation",
  "create_automation",
  "bulk_disable_entities",
  "bulk_enable_entities",
  "disable_entity",
  "enable_entity",
  "update_entity_registry",
  "update_dashboard_config",
  "clear_cache",
  "fire_event",
]);

function getAgentToolset(role) {
  if (role === "mcp_external") return TOOLS;
  return TOOLS.filter(t => !DANGEROUS_TOOLS.has(t.name));
}

function mcpToOpenAITool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || { type: "object", properties: {} }
    }
  };
}

// ============================================================================
// CHAT_HTML - Chat UI served at /chat
// ============================================================================
const CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>HA Agent</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-hover: #1a1a26;
    --border: #1e1e2e;
    --text: #e2e2e8;
    --text-dim: #6e6e82;
    --accent: #3b82f6;
    --accent-dim: #1e3a5f;
    --user-bg: #1a2742;
    --agent-bg: #16161e;
    --success: #22c55e;
    --warning: #f59e0b;
    --error: #ef4444;
    --radius: 12px;
  }

  html, body {
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', -apple-system, sans-serif;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    max-width: 720px;
    margin: 0 auto;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }

  .header-icon {
    width: 36px; height: 36px;
    background: var(--accent-dim);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
  }

  .header-info h1 {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .header-status {
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .status-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--success);
    display: inline-block;
  }

  .status-dot.offline { background: var(--error); }

  .header-actions {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }

  .header-btn {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }

  .header-btn:hover { color: var(--text); border-color: var(--accent); }

  /* ── Messages ── */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
  }

  .messages::-webkit-scrollbar { width: 4px; }
  .messages::-webkit-scrollbar-track { background: transparent; }
  .messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  .msg {
    max-width: 88%;
    padding: 12px 16px;
    border-radius: var(--radius);
    font-size: 14px;
    line-height: 1.55;
    word-wrap: break-word;
    animation: msgIn 0.2s ease-out;
  }

  @keyframes msgIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .msg.user {
    align-self: flex-end;
    background: var(--user-bg);
    border: 1px solid #243b5e;
    border-bottom-right-radius: 4px;
  }

  .msg.agent {
    align-self: flex-start;
    background: var(--agent-bg);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
  }

  .msg.agent .agent-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
    font-family: 'JetBrains Mono', monospace;
  }

  .msg.agent .msg-text { white-space: pre-wrap; }

  .msg.agent .actions-taken {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: var(--success);
  }

  .msg.system {
    align-self: center;
    background: transparent;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
    padding: 4px 12px;
    max-width: 100%;
  }

  .msg.error {
    align-self: center;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.2);
    color: var(--error);
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
  }

  /* ── Message action buttons (copy / retry) ── */
  .msg-actions {
    display: flex;
    gap: 4px;
    margin-top: 8px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .msg:hover .msg-actions,
  .msg:focus-within .msg-actions { opacity: 1; }

  .msg.user .msg-actions { justify-content: flex-end; }

  .bubble-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: all 0.15s;
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }

  .bubble-btn:hover {
    color: var(--text);
    border-color: var(--accent);
    background: var(--surface-hover);
  }

  .bubble-btn svg { width: 11px; height: 11px; }

  .bubble-btn.copied {
    color: var(--success);
    border-color: var(--success);
  }

  .msg.error .bubble-btn {
    color: var(--error);
    border-color: rgba(239,68,68,0.4);
  }

  .msg.error .bubble-btn:hover {
    background: rgba(239,68,68,0.15);
    color: var(--error);
  }

  /* On touch devices, always show actions since hover doesn't apply */
  @media (hover: none) {
    .msg-actions { opacity: 0.65; }
  }

  /* ── Typing indicator ── */
  .typing {
    display: none;
    align-self: flex-start;
    padding: 12px 20px;
    background: var(--agent-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    border-bottom-left-radius: 4px;
    gap: 5px;
  }

  .typing.active { display: flex; }

  .typing span {
    width: 6px; height: 6px;
    background: var(--text-dim);
    border-radius: 50%;
    animation: bounce 1.2s infinite;
  }

  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }

  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); }
    30% { transform: translateY(-6px); }
  }

  /* ── Input ── */
  .input-area {
    padding: 12px 16px;
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    background: var(--surface);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px;
    transition: border-color 0.15s;
  }

  .input-row:focus-within { border-color: var(--accent); }

  #msgInput {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    padding: 10px 12px;
    resize: none;
    max-height: 120px;
    line-height: 1.4;
  }

  #msgInput::placeholder { color: var(--text-dim); }

  #sendBtn {
    width: 40px; height: 40px;
    background: var(--accent);
    border: none;
    border-radius: 10px;
    color: white;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
  }

  #sendBtn:hover { filter: brightness(1.15); }
  #sendBtn:disabled { opacity: 0.4; cursor: not-allowed; }

  #sendBtn svg { width: 18px; height: 18px; }

  /* ── Mic button (large, thumb-friendly) ── */
  #micBtn {
    width: 52px; height: 52px;
    background: var(--surface-hover);
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--text-dim);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  #micBtn:hover { color: var(--text); border-color: var(--accent); }
  #micBtn:disabled { opacity: 0.4; cursor: not-allowed; }
  #micBtn svg { width: 24px; height: 24px; }

  #micBtn.recording {
    background: var(--error);
    color: white;
    border-color: var(--error);
    animation: micPulse 1.2s infinite;
  }

  #micBtn.transcribing {
    color: var(--accent);
    border-color: var(--accent);
  }

  #micBtn.transcribing svg { animation: spin 0.9s linear infinite; }

  @keyframes micPulse {
    0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.55); }
    70%  { box-shadow: 0 0 0 12px rgba(239,68,68,0); }
    100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Welcome ── */
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 12px;
    color: var(--text-dim);
    text-align: center;
    padding: 40px 20px;
  }

  .welcome-icon {
    font-size: 40px;
    margin-bottom: 4px;
  }

  .welcome h2 {
    font-size: 18px;
    color: var(--text);
    font-weight: 600;
  }

  .welcome p {
    font-size: 13px;
    max-width: 300px;
    line-height: 1.5;
  }

  .quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
    margin-top: 8px;
  }

  .quick-btn {
    background: var(--surface-hover);
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 8px 14px;
    border-radius: 20px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }

  .quick-btn:hover {
    color: var(--text);
    border-color: var(--accent);
    background: var(--accent-dim);
  }

  /* ── Markdown-ish formatting ── */
  .msg-text strong, .msg-text b { color: #fff; font-weight: 600; }

  .msg.reasoning {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    color: #8a8a8a;
    background: rgba(255, 255, 255, 0.03);
    border-left: 2px solid #444;
    padding: 8px 12px;
    margin: 4px 0 4px 16px;
    white-space: pre-wrap;
    border-radius: 4px;
    opacity: 0.7;
  }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="header-icon">🏠</div>
    <div class="header-info">
      <h1>HA Agent</h1>
      <div class="header-status">
        <span class="status-dot" id="statusDot"></span>
        <span id="statusText">Connecting...</span>
      </div>
    </div>
    <div class="header-actions">
      <button class="header-btn" onclick="clearChat()">Clear</button>
    </div>
  </div>

  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <div class="welcome-icon">🏠</div>
      <h2>HA Agent</h2>
      <p>Chat with your smart home. Ask about status, control devices, or just say hello.</p>
      <div class="quick-actions">
        <button class="quick-btn" onclick="sendQuick('What is the status of the house?')">House status</button>
        <button class="quick-btn" onclick="sendQuick('Any alerts?')">Alerts</button>
        <button class="quick-btn" onclick="sendQuick('Toggle the garage bay door')">Toggle garage bay</button>
        <button class="quick-btn" onclick="sendQuick('Toggle the basement bay door')">Toggle basement bay</button>
        <button class="quick-btn" onclick="sendQuick('Set the temperature to 72')">Set temperature</button>
        <button class="quick-btn" onclick="sendQuick('Lock all the doors')">Lock doors</button>
        <button class="quick-btn" onclick="sendQuick('Unlock the front door')">Unlock front door</button>
      </div>
    </div>
  </div>

  <div class="typing" id="typing">
    <span></span><span></span><span></span>
  </div>

  <div class="input-area">
    <div class="input-row">
      <textarea id="msgInput" rows="1" placeholder="Message your home..." autocomplete="off"></textarea>
      <button id="micBtn" type="button" onclick="toggleMic()" aria-label="Voice input">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
      </button>
      <button id="sendBtn" onclick="send()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
  </div>
</div>

<script>
  const msgEl = document.getElementById('messages');
  const input = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const typing = document.getElementById('typing');
  const welcome = document.getElementById('welcome');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Enter to send (shift+enter for newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Check agent status on load
  checkStatus();

  function checkStatus() {
    fetch('/health')
      .then(r => r.json())
      .then(d => {
        const ok = d.websocket && d.websocket.connected;
        statusDot.className = 'status-dot' + (ok ? '' : ' offline');
        statusText.textContent = ok ? 'Online · ' + (d.websocket.cached_entities || 0) + ' entities' : 'Disconnected';
      })
      .catch(() => {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Unreachable';
      });
  }

  let lastUserMessage = null;

  // SVG icon helpers (template literals)
  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const ICON_RETRY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

  function sendQuick(text) {
    input.value = text;
    send();
  }

  function makeCopyBtn(text) {
    const btn = document.createElement('button');
    btn.className = 'bubble-btn';
    btn.type = 'button';
    btn.innerHTML = ICON_COPY + '<span>copy</span>';
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for non-secure contexts
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      btn.classList.add('copied');
      btn.innerHTML = ICON_CHECK + '<span>copied</span>';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = ICON_COPY + '<span>copy</span>';
      }, 1400);
    };
    return btn;
  }

  function makeRetryBtn() {
    const btn = document.createElement('button');
    btn.className = 'bubble-btn';
    btn.type = 'button';
    btn.innerHTML = ICON_RETRY + '<span>retry</span>';
    btn.onclick = () => {
      if (!lastUserMessage) return;
      // Remove the error bubble we're attached to
      const parent = btn.closest('.msg');
      if (parent && parent.parentNode) parent.parentNode.removeChild(parent);
      input.value = lastUserMessage;
      send();
    };
    return btn;
  }

  function addMsg(role, text, actions) {
    if (welcome) welcome.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'msg ' + role;

    if (role === 'agent') {
      const label = document.createElement('div');
      label.className = 'agent-label';
      label.textContent = 'agent';
      div.appendChild(label);

      const body = document.createElement('div');
      body.className = 'msg-text';
      // Basic markdown: **bold**
      body.innerHTML = text
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\n/g, '<br>');
      div.appendChild(body);

      if (actions && actions.length > 0) {
        const actDiv = document.createElement('div');
        actDiv.className = 'actions-taken';
        actDiv.textContent = '⚡ ' + actions.join(', ');
        div.appendChild(actDiv);
      }

      const acts = document.createElement('div');
      acts.className = 'msg-actions';
      acts.appendChild(makeCopyBtn(text));
      div.appendChild(acts);
    } else if (role === 'error') {
      const body = document.createElement('div');
      body.textContent = text;
      div.appendChild(body);

      const acts = document.createElement('div');
      acts.className = 'msg-actions';
      acts.style.opacity = '1'; // always visible on errors
      if (lastUserMessage) acts.appendChild(makeRetryBtn());
      acts.appendChild(makeCopyBtn(text));
      div.appendChild(acts);
    } else if (role === 'user') {
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = text;
      div.appendChild(body);

      const acts = document.createElement('div');
      acts.className = 'msg-actions';
      acts.appendChild(makeCopyBtn(text));
      div.appendChild(acts);
    } else {
      div.textContent = text;
    }

    msgEl.appendChild(div);
    msgEl.scrollTop = msgEl.scrollHeight;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    lastUserMessage = text;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    window.__chatRetried = false;

    addMsg('user', text);
    typing.classList.add('active');
    msgEl.scrollTop = msgEl.scrollHeight;

    let statusEl = null;

    function showStatus(msg) {
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'msg system';
        msgEl.appendChild(statusEl);
      }
      statusEl.textContent = msg;
      msgEl.scrollTop = msgEl.scrollHeight;
    }

    function clearStatus() {
      if (statusEl) { msgEl.removeChild(statusEl); statusEl = null; }
    }

    try {
      const resp = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ message: text })
      });

      if (!resp.ok || !resp.body) {
        typing.classList.remove('active');
        addMsg('error', 'Agent error: ' + resp.status);
        sendBtn.disabled = false;
        input.focus();
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let evt;
          try { evt = JSON.parse(line.slice(6)); } catch { continue; }

          if (evt.type === 'started') {
            // server alive — no UI action needed
          } else if (evt.type === 'reasoning') {
            addMsg('reasoning', evt.text);
          } else if (evt.type === 'thinking') {
            showStatus('Thinking…');
          } else if (evt.type === 'tool_call') {
            showStatus('⚡ ' + (evt.label || evt.name) + '…');
          } else if (evt.type === 'tool_result') {
            showStatus((evt.ok ? '✓ ' : '✗ ') + evt.name);
          } else if (evt.type === 'reply') {
            typing.classList.remove('active');
            clearStatus();
            addMsg('agent', evt.text || 'No response.');
          } else if (evt.type === 'error') {
            typing.classList.remove('active');
            clearStatus();
            addMsg('error', evt.message || 'Agent error');
          }
        }
      }

      typing.classList.remove('active');
      clearStatus();

    } catch (err) {
      const retryable = /load failed|network|fetch/i.test(err.message || '');
      if (retryable && !window.__chatRetried) {
        window.__chatRetried = true;
        showStatus('Reconnecting…');
        try {
          const resp2 = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({ message: text })
          });
          if (resp2.ok && resp2.body) {
            const reader = resp2.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split('\\n');
              buf = lines.pop();
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let evt;
                try { evt = JSON.parse(line.slice(6)); } catch { continue; }
                if (evt.type === 'started') {
                  // server alive
                } else if (evt.type === 'reasoning') {
                  addMsg('reasoning', evt.text);
                } else if (evt.type === 'thinking') {
                  showStatus('Thinking…');
                } else if (evt.type === 'tool_call') {
                  showStatus('⚡ ' + (evt.label || evt.name) + '…');
                } else if (evt.type === 'tool_result') {
                  showStatus((evt.ok ? '✓ ' : '✗ ') + evt.name);
                } else if (evt.type === 'reply') {
                  typing.classList.remove('active');
                  clearStatus();
                  addMsg('agent', evt.text || 'No response.');
                } else if (evt.type === 'error') {
                  typing.classList.remove('active');
                  clearStatus();
                  addMsg('error', evt.message || 'Agent error');
                }
              }
            }
            typing.classList.remove('active');
            clearStatus();
            window.__chatRetried = false;
            sendBtn.disabled = false;
            input.focus();
            return;
          }
        } catch (err2) {
          // fall through to error display
        }
        window.__chatRetried = false;
      }
      typing.classList.remove('active');
      clearStatus();
      addMsg('error', 'Failed to reach agent: ' + err.message);
    }

    sendBtn.disabled = false;
    input.focus();
  }

  function clearChat() {
    while (msgEl.children.length > 1) {
      msgEl.removeChild(msgEl.lastChild);
    }
    if (welcome) welcome.style.display = 'flex';
    lastUserMessage = null;
  }

  // ── Voice input (ElevenLabs Scribe) ──
  const micBtn = document.getElementById('micBtn');
  const ICON_MIC_HTML = micBtn.innerHTML;
  const ICON_STOP_HTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
  const ICON_SPIN_HTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10" opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>';

  let mediaRecorder = null;
  let audioChunks = [];
  let micStream = null;
  let isRecording = false;

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/mpeg',
      'audio/ogg;codecs=opus'
    ];
    for (const c of candidates) {
      try { if (MediaRecorder.isTypeSupported(c)) return c; } catch {}
    }
    return '';
  }

  async function toggleMic() {
    if (isRecording) { stopRecording(); return; }
    await startRecording();
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      addMsg('error', 'Voice input not supported in this browser.');
      return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      addMsg('error', 'Microphone access denied: ' + err.message);
      return;
    }
    const mime = pickMime();
    audioChunks = [];
    try {
      mediaRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
    } catch {
      mediaRecorder = new MediaRecorder(micStream);
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => transcribeAndSend();
    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.innerHTML = ICON_STOP_HTML;
    micBtn.setAttribute('aria-label', 'Stop recording');
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
    mediaRecorder.stop();
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.classList.add('transcribing');
    micBtn.innerHTML = ICON_SPIN_HTML;
    micBtn.disabled = true;
  }

  function resetMic() {
    micBtn.classList.remove('recording', 'transcribing');
    micBtn.innerHTML = ICON_MIC_HTML;
    micBtn.disabled = false;
    micBtn.setAttribute('aria-label', 'Voice input');
  }

  async function transcribeAndSend() {
    // Release the mic regardless of outcome
    if (micStream) {
      try { micStream.getTracks().forEach(t => t.stop()); } catch {}
      micStream = null;
    }

    if (!audioChunks.length) { resetMic(); return; }
    const mime = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
    const blob = new Blob(audioChunks, { type: mime });

    if (blob.size < 800) {
      resetMic();
      addMsg('error', 'No audio captured. Try again.');
      return;
    }

    try {
      const resp = await fetch('/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: blob
      });
      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 200); } catch {}
        throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail : ''));
      }
      const data = await resp.json();
      const text = (data.text || '').trim();
      resetMic();
      if (!text) { addMsg('error', 'Empty transcription.'); return; }
      input.value = text;
      send();
    } catch (err) {
      resetMic();
      addMsg('error', 'Transcription failed: ' + err.message);
    }
  }
</script>
</body>
</html>`;

async function haRequest(env, method, path, body) {
  const url = env.HA_URL.replace(/\/$/, "") + path;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  const options = {
    method,
    signal: controller.signal,
    headers: {
      Authorization: "Bearer " + env.HA_TOKEN,
      "Content-Type": "application/json"
    }
  };
  if (body !== void 0) options.body = JSON.stringify(body);
  try {
    const response = await fetch(url, options);
    clearTimeout(timeout);
    const text = await response.text();
    if (!response.ok) return { error: true, status: response.status, statusText: response.statusText, body: text };
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    clearTimeout(timeout);
    throw new Error("HA request failed (" + method + " " + path + "): " + err.message);
  }
}
function getDO(env) {
  if (!env.HA_WS) return null;
  const id = env.HA_WS.idFromName("ha-websocket-singleton");
  return env.HA_WS.get(id);
}
async function doFetch(env, path, body) {
  const stub = getDO(env);
  if (!stub) return null;
  try {
    const options = { headers: { "Content-Type": "application/json" } };
    if (body) {
      options.method = "POST";
      options.body = JSON.stringify(body);
    }
    const resp = await stub.fetch("http://do" + path, options);
    if (resp.ok) return await resp.json();
  } catch {
  }
  return null;
}
async function callServiceWS(env, domain, service, data, target) {
  const doResult = await doFetch(env, "/call_service", {
    domain,
    service,
    data: data || {},
    target: target || {}
  });
  if (doResult && !doResult.error) return doResult;
  return await haRequest(env, "POST", "/api/services/" + domain + "/" + service, data || {});
}
async function cacheGet(env, key) {
  if (!env.HA_CACHE) return null;
  try {
    return await env.HA_CACHE.get(key, "json");
  } catch {
    return null;
  }
}
async function cacheSet(env, key, value, ttl) {
  if (!env.HA_CACHE || value && value.error) return;
  try {
    await env.HA_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
  }
}
async function cacheDel(env, ...keys) {
  if (!env.HA_CACHE) return;
  await Promise.all(keys.map((k) => env.HA_CACHE.delete(k).catch(() => {
  })));
}
async function getStates(env, force) {
  const doStates = await doFetch(env, "/states");
  if (doStates && Array.isArray(doStates) && doStates.length > 0) {
    await cacheSet(env, CK.STATES, doStates, CACHE_TTL.STATES);
    return doStates;
  }
  if (!force) {
    const hit = await cacheGet(env, CK.STATES);
    if (hit) return hit;
  }
  const data = await haRequest(env, "GET", "/api/states");
  if (Array.isArray(data)) await cacheSet(env, CK.STATES, data, CACHE_TTL.STATES);
  return data;
}
async function getEntityState(env, entity_id, force) {
  if (force) {
    // Bypass stateCache and KV: issue a fresh WebSocket get_states via the DO.
    const fresh = await doFetch(env, "/state_force_refresh?entity_id=" + encodeURIComponent(entity_id));
    if (fresh && !fresh.error) {
      await cacheSet(env, CK.state(entity_id), fresh, CACHE_TTL.ENTITY_STATE);
      return fresh;
    }
    // DO unavailable or WebSocket error — fall through to REST API.
    const data = await haRequest(env, "GET", "/api/states/" + entity_id);
    if (data && !data.error) await cacheSet(env, CK.state(entity_id), data, CACHE_TTL.ENTITY_STATE);
    return data;
  }
  const doState = await doFetch(env, "/state?entity_id=" + encodeURIComponent(entity_id));
  if (doState && !doState.error) return doState;
  const key = CK.state(entity_id);
  const hit = await cacheGet(env, key);
  if (hit) return hit;
  const data = await haRequest(env, "GET", "/api/states/" + entity_id);
  if (data && !data.error) await cacheSet(env, key, data, CACHE_TTL.ENTITY_STATE);
  return data;
}
async function getServices(env, force) {
  if (!force) {
    const hit = await cacheGet(env, CK.SERVICES);
    if (hit) return hit;
  }
  const data = await haRequest(env, "GET", "/api/services");
  if (Array.isArray(data)) await cacheSet(env, CK.SERVICES, data, CACHE_TTL.SERVICES);
  return data;
}
async function getEntityRegistry(env, force) {
  const doReg = await doFetch(env, "/entity_registry");
  if (doReg && Array.isArray(doReg) && doReg.length > 0) {
    await cacheSet(env, CK.ENTITY_REGISTRY, doReg, CACHE_TTL.ENTITY_REGISTRY);
    return doReg;
  }
  if (!force) {
    const hit = await cacheGet(env, CK.ENTITY_REGISTRY);
    if (hit) return hit;
  }
  const data = await haRequest(env, "GET", "/api/config/entity_registry");
  if (Array.isArray(data)) await cacheSet(env, CK.ENTITY_REGISTRY, data, CACHE_TTL.ENTITY_REGISTRY);
  return data;
}
async function getAreaRegistry(env, force) {
  const doAreas = await doFetch(env, "/area_registry");
  if (doAreas && Array.isArray(doAreas) && doAreas.length > 0) {
    await cacheSet(env, CK.AREAS, doAreas, CACHE_TTL.AREAS);
    return doAreas;
  }
  if (!force) {
    const hit = await cacheGet(env, CK.AREAS);
    if (hit) return hit;
  }
  const data = await haRequest(env, "GET", "/api/config/area_registry");
  if (Array.isArray(data)) await cacheSet(env, CK.AREAS, data, CACHE_TTL.AREAS);
  return data;
}
async function getDeviceRegistry(env, force) {
  const doDev = await doFetch(env, "/device_registry");
  if (doDev && Array.isArray(doDev) && doDev.length > 0) {
    const cleaned = doDev.map((d) => ({
      id: d.id,
      name: d.name_by_user || d.name || "Unknown",
      manufacturer: d.manufacturer || "Unknown",
      model: d.model || "Unknown",
      area_id: d.area_id
    }));
    await cacheSet(env, CK.DEVICES, cleaned, CACHE_TTL.DEVICES);
    return cleaned;
  }
  if (!force) {
    const hit = await cacheGet(env, CK.DEVICES);
    if (hit) return hit;
  }
  const entities = await getEntityRegistry(env, force);
  if (!Array.isArray(entities)) return [];
  const deviceMap = {};
  for (const e of entities) {
    if (!e.device_id) continue;
    if (!deviceMap[e.device_id]) deviceMap[e.device_id] = { id: e.device_id, area_id: e.area_id || null, platform: e.platform || null, entities: [] };
    deviceMap[e.device_id].entities.push({ entity_id: e.entity_id, name: e.name || e.original_name || null });
    if (e.area_id && !deviceMap[e.device_id].area_id) deviceMap[e.device_id].area_id = e.area_id;
  }
  const data = Object.values(deviceMap);
  if (data.length) await cacheSet(env, CK.DEVICES, data, CACHE_TTL.DEVICES);
  return data;
}
async function getFloorRegistry(env, force) {
  const doFloors = await doFetch(env, "/floor_registry");
  if (doFloors && Array.isArray(doFloors) && doFloors.length > 0) {
    await cacheSet(env, CK.FLOORS, doFloors, CACHE_TTL.FLOORS);
    return doFloors;
  }
  if (!force) {
    const hit = await cacheGet(env, CK.FLOORS);
    if (hit) return hit;
  }
  const data = await haRequest(env, "GET", "/api/config/floor_registry");
  if (Array.isArray(data)) await cacheSet(env, CK.FLOORS, data, CACHE_TTL.FLOORS);
  return data;
}
async function getLabelRegistry(env, force) {
  const doLabels = await doFetch(env, "/label_registry");
  if (doLabels && Array.isArray(doLabels) && doLabels.length > 0) {
    await cacheSet(env, CK.LABELS, doLabels, CACHE_TTL.LABELS);
    return doLabels;
  }
  if (!force) {
    const hit = await cacheGet(env, CK.LABELS);
    if (hit) return hit;
  }
  const data = await haRequest(env, "GET", "/api/config/label_registry");
  if (Array.isArray(data)) await cacheSet(env, CK.LABELS, data, CACHE_TTL.LABELS);
  return data;
}
async function getCalendars(env, force) {
  if (!force) {
    const hit = await cacheGet(env, CK.CALENDARS);
    if (hit) return hit;
  }
  const data = await haRequest(env, "GET", "/api/calendars");
  if (Array.isArray(data)) {
    await cacheSet(env, CK.CALENDARS, data, CACHE_TTL.CALENDARS);
    return data;
  }
  if (data && data.error && data.status === 404) return [];
  return data;
}
async function getDashboardList(env, force) {
  if (!force) {
    const hit = await cacheGet(env, CK.DASHBOARDS);
    if (hit) return hit;
  }
  const result = await haRequest(env, "GET", "/api/lovelace/dashboards");
  if (Array.isArray(result)) {
    await cacheSet(env, CK.DASHBOARDS, result, CACHE_TTL.DASHBOARDS);
    return result;
  }
  if (result && result.error && result.status === 404) return [{ url_path: null, title: "Home", mode: "storage" }];
  return result;
}
async function invalidateStates(env) {
  await cacheDel(env, CK.STATES);
}
async function invalidateRegistry(env) {
  await cacheDel(env, CK.ENTITY_REGISTRY, CK.STATES);
}
function sanitizeForTemplate(str) {
  if (typeof str !== "string") return "";
  return str.replace(/["'\\{}%#]/g, "");
}
function normalizeAutomationConfig(config) {
  const n = Object.assign({ mode: "single" }, config);
  if (n.trigger && !n.triggers) {
    n.triggers = n.trigger;
    delete n.trigger;
  }
  if (n.condition && !n.conditions) {
    n.conditions = n.condition;
    delete n.condition;
  }
  if (n.action && !n.actions) {
    n.actions = n.action;
    delete n.action;
  }
  return n;
}
async function handleTool(env, name, args) {
  switch (name) {
    // ---- States ----
    case "list_entities": {
      if (args.area) {
        const safeArea = sanitizeForTemplate(args.area);
        const template = '{% set ns = namespace(entities=[]) %}{% for state in states %}{% set area = area_name(state.entity_id) %}{% if area and area|lower == "' + safeArea.toLowerCase() + '" %}{% set ns.entities = ns.entities +[state.entity_id ~ ": " ~ state.state ~ " (" ~ state.attributes.friendly_name ~ ")"] %}{% endif %}{% endfor %}{{ ns.entities | join("\\n") }}';
        return await haRequest(env, "POST", "/api/template", { template });
      }
      const states = await getStates(env, args.force_refresh);
      let filtered = states;
      if (args.domain) filtered = filtered.filter((s) => s.entity_id.startsWith(args.domain + "."));
      return filtered.map((s) => ({ entity_id: s.entity_id, state: s.state, friendly_name: s.attributes.friendly_name }));
    }
    case "get_state":
      return await getEntityState(env, args.entity_id, args.force_refresh);
    case "get_states_by_domain": {
      const states = await getStates(env, args.force_refresh);
      return states.filter((s) => s.entity_id.startsWith(args.domain + ".")).map((s) => {
        const a = Object.assign({}, s.attributes);
        delete a.entity_picture;
        delete a.supported_features;
        delete a.icon;
        delete a.options;
        return { entity_id: s.entity_id, state: s.state, friendly_name: s.attributes.friendly_name, attributes: a };
      });
    }
    case "get_states_by_area": {
      const safeArea = sanitizeForTemplate(args.area);
      const template = '{% set ns = namespace(entities=[]) %}{% for state in states %}{% set area = area_name(state.entity_id) %}{% if area and area|lower == "' + safeArea.toLowerCase() + '" %}{% set ns.entities = ns.entities +[{"entity_id": state.entity_id, "state": state.state, "friendly_name": state.attributes.friendly_name}] %}{% endif %}{% endfor %}{{ ns.entities | to_json }}';
      return await haRequest(env, "POST", "/api/template", { template });
    }
    // ---- Services ----
    case "call_service": {
      const result = await callServiceWS(env, args.domain, args.service, args.data);
      await invalidateStates(env);
      return result;
    }
    case "list_services": {
      const services = await getServices(env, args.force_refresh);
      if (args.domain) return services.filter((s) => s.domain === args.domain);
      return services.map((s) => ({ domain: s.domain, services: Object.keys(s.services) }));
    }
    // ---- Areas & Devices ----
    case "list_areas":
      return await getAreaRegistry(env, args.force_refresh);
    case "get_area": {
      const safeArea = sanitizeForTemplate(args.area);
      const template = '{% set target_area = "' + safeArea + '" %}{% for state in states %}{% set area = area_name(state.entity_id) %}{% if area and area|lower == target_area|lower %}{{ state.entity_id }}: {{ state.state }} ({{ state.attributes.friendly_name }})\n{% endif %}{% endfor %}';
      return await haRequest(env, "POST", "/api/template", { template });
    }
    case "list_devices":
      return await getDeviceRegistry(env, args.force_refresh);
    case "get_device": {
      const [devices, entities] = await Promise.all([getDeviceRegistry(env), getEntityRegistry(env)]);
      if (!Array.isArray(devices)) return { error: "Could not fetch device registry" };
      const device = devices.find((d) => d.id === args.device_id || d.name === args.device_id);
      if (!device) return { error: "Device not found" };
      return { device, entities: Array.isArray(entities) ? entities.filter((e) => e.device_id === device.id) : [] };
    }
    // ---- Entity Registry ----
    case "get_entity_registry":
      return await getEntityRegistry(env, args.force_refresh);
    case "list_disabled_entities": {
      const reg = await getEntityRegistry(env, args.force_refresh);
      return Array.isArray(reg) ? reg.filter((e) => e.disabled_by !== null) : reg;
    }
    case "update_entity_registry": {
      const updates = {};
      if (args.name !== void 0) updates.name = args.name;
      if (args.icon !== void 0) updates.icon = args.icon;
      if (args.area_id !== void 0) updates.area_id = args.area_id;
      if (args.disabled_by !== void 0) updates.disabled_by = args.disabled_by;
      const result = await haRequest(env, "POST", "/api/config/entity_registry/" + args.entity_id, updates);
      await invalidateRegistry(env);
      return result;
    }
    case "disable_entity": {
      const r = await haRequest(env, "POST", "/api/config/entity_registry/" + args.entity_id, { disabled_by: "user" });
      await invalidateRegistry(env);
      return r;
    }
    case "enable_entity": {
      const r = await haRequest(env, "POST", "/api/config/entity_registry/" + args.entity_id, { disabled_by: null });
      await invalidateRegistry(env);
      return r;
    }
    case "bulk_disable_entities": {
      const results = await Promise.all(args.entity_ids.map((id) => haRequest(env, "POST", "/api/config/entity_registry/" + id, { disabled_by: "user" })));
      await invalidateRegistry(env);
      return results;
    }
    case "bulk_enable_entities": {
      const results = await Promise.all(args.entity_ids.map((id) => haRequest(env, "POST", "/api/config/entity_registry/" + id, { disabled_by: null })));
      await invalidateRegistry(env);
      return results;
    }
    // ---- Automations ----
    case "list_automations": {
      const states = await getStates(env, args.force_refresh);
      return states.filter((s) => s.entity_id.startsWith("automation.")).map((s) => ({
        entity_id: s.entity_id,
        state: s.state,
        friendly_name: s.attributes.friendly_name,
        last_triggered: s.attributes.last_triggered,
        id: s.attributes.id
      }));
    }
    case "trigger_automation": {
      const result = await callServiceWS(env, "automation", "trigger", { entity_id: args.entity_id });
      await invalidateStates(env);
      return result;
    }
    case "toggle_automation": {
      const svc = args.enable ? "turn_on" : "turn_off";
      const result = await callServiceWS(env, "automation", svc, { entity_id: args.entity_id });
      await invalidateStates(env);
      return result;
    }
    case "get_automation_config": {
      let id = args.automation_id;
      if (id.startsWith("automation.")) {
        const states = await getStates(env, false);
        const match = states.find((s) => s.entity_id === id);
        if (match && match.attributes && match.attributes.id) id = match.attributes.id;
        else return { error: "Could not find internal ID for " + args.automation_id };
      }
      return await haRequest(env, "GET", "/api/config/automation/config/" + id);
    }
    case "create_automation": {
      const config = normalizeAutomationConfig(args.config);
      if (!config.id) config.id = "mcp_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 9);
      const result = await haRequest(env, "POST", "/api/config/automation/config/" + config.id, config);
      await callServiceWS(env, "automation", "reload", {});
      await invalidateStates(env);
      return { ...result, generated_id: config.id };
    }
    case "update_automation": {
      let id = args.automation_id;
      if (id.startsWith("automation.")) {
        const states = await getStates(env, false);
        const match = states.find((s) => s.entity_id === id);
        if (match && match.attributes && match.attributes.id) id = match.attributes.id;
        else return { error: "Could not find internal ID for " + args.automation_id };
      }
      const config = normalizeAutomationConfig(Object.assign({}, args.config, { id }));
      const result = await haRequest(env, "POST", "/api/config/automation/config/" + id, config);
      await callServiceWS(env, "automation", "reload", {});
      await invalidateStates(env);
      return result;
    }
    case "delete_automation": {
      let id = args.automation_id;
      if (id.startsWith("automation.")) {
        const states = await getStates(env, false);
        const match = states.find((s) => s.entity_id === id);
        if (match && match.attributes && match.attributes.id) id = match.attributes.id;
        else return { error: "Could not find internal ID for " + args.automation_id };
      }
      const result = await haRequest(env, "DELETE", "/api/config/automation/config/" + id);
      await callServiceWS(env, "automation", "reload", {});
      await invalidateStates(env);
      return result;
    }
    // ---- Scripts & Scenes ----
    case "list_scripts": {
      const states = await getStates(env, args.force_refresh);
      return states.filter((s) => s.entity_id.startsWith("script.")).map((s) => ({ entity_id: s.entity_id, state: s.state, friendly_name: s.attributes.friendly_name }));
    }
    case "run_script": {
      const result = await callServiceWS(env, "script", "turn_on", { entity_id: args.entity_id, variables: args.variables || {} });
      await invalidateStates(env);
      return result;
    }
    case "list_scenes": {
      const states = await getStates(env, args.force_refresh);
      return states.filter((s) => s.entity_id.startsWith("scene.")).map((s) => ({ entity_id: s.entity_id, friendly_name: s.attributes.friendly_name }));
    }
    case "activate_scene": {
      const result = await callServiceWS(env, "scene", "turn_on", { entity_id: args.entity_id });
      await invalidateStates(env);
      return result;
    }
    // ---- History & Logbook ----
    case "get_history": {
      let path = "/api/history/period/" + encodeURIComponent(args.start_time) + "?filter_entity_id=" + encodeURIComponent(args.entity_ids);
      if (args.end_time) path += "&end_time=" + encodeURIComponent(args.end_time);
      return await haRequest(env, "GET", path);
    }
    case "get_logbook": {
      let path = "/api/logbook/" + encodeURIComponent(args.start_time);
      const params = [];
      if (args.entity_id) params.push("entity=" + encodeURIComponent(args.entity_id));
      if (args.end_time) params.push("end_time=" + encodeURIComponent(args.end_time));
      if (params.length) path += "?" + params.join("&");
      return await haRequest(env, "GET", path);
    }
    // ---- System ----
    case "get_config":
      return await haRequest(env, "GET", "/api/config");
    case "check_config":
      return await haRequest(env, "POST", "/api/config/core/check_config");
    case "restart_ha": {
      const res = await callServiceWS(env, "homeassistant", "restart", {});
      await cacheDel(env, ...Object.values(CK).filter((v) => typeof v === "string"));
      return res;
    }
    case "get_error_log": {
      const result = await haRequest(env, "GET", "/api/error_log");
      if (result && result.error && result.status === 404) return { error: "error_log not available via remote access." };
      return result;
    }
    // ---- Notifications ----
    case "send_notification": {
      const svc = args.service || "notify";
      const data = { message: args.message };
      if (args.title) data.title = args.title;
      return await callServiceWS(env, "notify", svc, data);
    }
    // ---- Helpers ----
    case "set_input_boolean": {
      const svc = args.state ? "turn_on" : "turn_off";
      const r = await callServiceWS(env, "input_boolean", svc, { entity_id: args.entity_id });
      await invalidateStates(env);
      return r;
    }
    case "set_input_number": {
      const r = await callServiceWS(env, "input_number", "set_value", { entity_id: args.entity_id, value: args.value });
      await invalidateStates(env);
      return r;
    }
    case "set_input_select": {
      const r = await callServiceWS(env, "input_select", "select_option", { entity_id: args.entity_id, option: args.option });
      await invalidateStates(env);
      return r;
    }
    case "set_input_datetime": {
      const data = { entity_id: args.entity_id };
      if (args.datetime) data.datetime = args.datetime;
      if (args.date) data.date = args.date;
      if (args.time) data.time = args.time;
      const r = await callServiceWS(env, "input_datetime", "set_datetime", data);
      await invalidateStates(env);
      return r;
    }
    // ---- Climate ----
    case "set_climate": {
      if (args.temperature !== void 0) await callServiceWS(env, "climate", "set_temperature", { entity_id: args.entity_id, temperature: args.temperature });
      if (args.hvac_mode) await callServiceWS(env, "climate", "set_hvac_mode", { entity_id: args.entity_id, hvac_mode: args.hvac_mode });
      await invalidateStates(env);
      return await getEntityState(env, args.entity_id, true);
    }
    // ---- Covers ----
    case "control_cover": {
      const data = { entity_id: args.entity_id };
      if (args.position !== void 0) data.position = args.position;
      const r = await callServiceWS(env, "cover", args.command, data);
      await invalidateStates(env);
      return r;
    }
    // ---- Locks ----
    case "control_lock": {
      const r = await callServiceWS(env, "lock", args.command, { entity_id: args.entity_id });
      await invalidateStates(env);
      return r;
    }
    // ---- Media Players ----
    case "control_media_player": {
      const cmdMap = { play: "media_play", pause: "media_pause", stop: "media_stop", next: "media_next_track", previous: "media_previous_track", volume_set: "volume_set", turn_on: "turn_on", turn_off: "turn_off" };
      const svc = cmdMap[args.command] || args.command;
      const data = { entity_id: args.entity_id };
      if (args.volume_level !== void 0) data.volume_level = args.volume_level;
      const r = await callServiceWS(env, "media_player", svc, data);
      await invalidateStates(env);
      return r;
    }
    // ---- Lights ----
    case "control_light": {
      const data = { entity_id: args.entity_id };
      if (args.brightness !== void 0) data.brightness = args.brightness;
      if (args.color_temp !== void 0) data.color_temp = args.color_temp;
      if (args.rgb_color !== void 0) data.rgb_color = args.rgb_color;
      if (args.transition !== void 0) data.transition = args.transition;
      const r = await callServiceWS(env, "light", args.command, data);
      await invalidateStates(env);
      return r;
    }
    // ---- Templates ----
    case "render_template":
      return await haRequest(env, "POST", "/api/template", { template: args.template });
    // ---- Floors & Labels ----
    case "list_floors":
      return await getFloorRegistry(env, args.force_refresh);
    case "list_labels":
      return await getLabelRegistry(env, args.force_refresh);
    // ---- Weather & Presence ----
    case "get_persons":
      return (await getStates(env)).filter((s) => s.entity_id.startsWith("person."));
    case "get_sun":
      return await getEntityState(env, "sun.sun", true);
    case "get_weather":
      return (await getStates(env)).find((s) => s.entity_id.startsWith("weather.")) || { error: "No weather entity" };
    // ---- Calendars ----
    case "list_calendars":
      return await getCalendars(env, args.force_refresh);
    case "get_calendar_events": {
      const now = /* @__PURE__ */ new Date();
      const start = args.start || now.toISOString();
      const end = args.end || new Date(now.getTime() + 7 * 864e5).toISOString();
      return await haRequest(env, "GET", "/api/calendars/" + args.entity_id + "?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end));
    }
    // ---- Todo ----
    case "list_todo_lists": {
      const states = await getStates(env);
      return states.filter((s) => s.entity_id.startsWith("todo.")).map((s) => ({ entity_id: s.entity_id, state: s.state, friendly_name: s.attributes.friendly_name }));
    }
    case "get_todo_items": {
      const data = { entity_id: args.entity_id };
      if (args.status) data.status = args.status;
      return await haRequest(env, "POST", "/api/services/todo/get_items", data);
    }
    case "add_todo_item": {
      const r = await callServiceWS(env, "todo", "add_item", { entity_id: args.entity_id, item: args.item });
      await invalidateStates(env);
      return r;
    }
    // ---- Dashboard ----
    case "get_dashboard_list":
      return await getDashboardList(env, args.force_refresh);
    case "get_dashboard_config": {
      const path = args.dashboard_id ? "/api/lovelace/config/" + args.dashboard_id : "/api/lovelace/config";
      return await haRequest(env, "GET", path);
    }
    case "get_dashboard_resources":
      return await haRequest(env, "GET", "/api/lovelace/resources");
    case "update_dashboard_config": {
      const path = args.dashboard_id ? "/api/lovelace/config/" + args.dashboard_id : "/api/lovelace/config";
      const r = await haRequest(env, "POST", path, args.config);
      await cacheDel(env, CK.DASHBOARDS);
      return r;
    }
    case "backup_dashboard_config": {
      const path = args.dashboard_id ? "/api/lovelace/config/" + args.dashboard_id : "/api/lovelace/config";
      const config = await haRequest(env, "GET", path);
      if (config && !config.error) {
        const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        const label = args.dashboard_id || "default";
        await haRequest(env, "POST", "/api/services/persistent_notification/create", {
          title: "Dashboard Backup: " + label + " (" + ts + ")",
          message: "```json\n" + JSON.stringify(config, null, 2) + "\n```",
          notification_id: "dashboard_backup_" + label + "_" + ts
        });
        return { success: true, message: "Backup saved as persistent notification", dashboard_id: label, timestamp: ts };
      }
      return config;
    }
    // ---- WebSocket Status ----
    case "websocket_status": {
      const status = await doFetch(env, "/status");
      if (status) return status;
      return { connected: false, reason: "HA_WS not configured or not responding" };
    }
    // ---- Search Related ----
    case "search_related": {
      const r = await doFetch(env, "/search_related", { item_type: args.item_type, item_id: args.item_id });
      if (r) return r;
      return { error: "search_related requires WebSocket Durable Object" };
    }
    // ---- Vector Search ----
    case "vector_search": {
      const body = {
        query: args.query,
        kinds: Array.isArray(args.kinds) ? args.kinds : null,
        domain: args.domain || null,
        area: args.area || null,
        top_k: args.top_k,
        include_noisy: !!args.include_noisy
      };
      const r = await doFetch(env, "/vector_search", body);
      if (r) return r;
      return { error: "vector_search requires Durable Object" };
    }
    // ---- AI Agent ----
    case "ai_status": {
      const status = await doFetch(env, "/status");
      if (status) return { ai_enabled: status.ai_enabled, ai_pending_events: status.ai_pending_events, ai_log_entries: status.ai_log_entries, websocket_connected: status.connected };
      return { error: "Durable Object not responding" };
    }
    case "ai_enable":
      return await doFetch(env, "/ai_enable") || { error: "DO not responding" };
    case "ai_disable":
      return await doFetch(env, "/ai_disable") || { error: "DO not responding" };
    case "ai_log": {
      const count = args.count || 50;
      return await doFetch(env, "/ai_log?count=" + count) || { error: "DO not responding" };
    }
    case "ai_clear_log":
      return await doFetch(env, "/ai_clear_log") || { error: "DO not responding" };
    case "ai_memory":
      return await doFetch(env, "/ai_memory") || { error: "DO not responding" };
    case "ai_clear_memory":
      return await doFetch(env, "/ai_clear_memory") || { error: "DO not responding" };
    case "ai_observations":
      return await doFetch(env, "/ai_observations") || { error: "DO not responding" };
    case "ai_clear_observations":
      return await doFetch(env, "/ai_clear_observations") || { error: "DO not responding" };
    case "ai_clear_chat":
      return await doFetch(env, "/ai_clear_chat") || { error: "DO not responding" };
    case "ai_trigger":
      return await doFetch(env, "/ai_trigger") || { error: "DO not responding" };
    case "ai_chat": {
      const result = await doFetch(env, "/ai_chat", { message: args.message });
      if (result) return result;
      return { error: "Durable Object not responding" };
    }
    case "talk_to_agent": {
      const result = await doFetch(env, "/ai_chat", { message: args.message });
      if (result) return result;
      return { error: "Durable Object not responding" };
    }
    // ---- Events ----
    case "fire_event":
      return await haRequest(env, "POST", "/api/events/" + args.event_type, args.event_data || {});
    // ---- Agent State ----
    case "save_memory": {
      const r = await doFetch(env, "/ai_memory_append", { memory: args.memory });
      return r || { error: "DO not responding" };
    }
    case "save_observation": {
      const r = await doFetch(env, "/ai_observation_append", {
        text: args.text,
        replaces: args.replaces
      });
      return r || { error: "DO not responding" };
    }
    case "ai_send_notification": {
      const notifyData = { message: args.message };
      if (args.title) notifyData.title = args.title;
      const result = await callServiceWS(env, "notify", "notify", notifyData);
      await doFetch(env, "/ai_log_append", {
        type: "notification",
        message: args.message,
        data: { title: args.title || null, source: "tool_call" }
      });
      return result;
    }
    // ---- Cache Management ----
    case "cache_status": {
      if (!env.HA_CACHE) return { error: "HA_CACHE not bound" };
      const staticKeys = Object.entries(CK).filter(([, v]) => typeof v === "string").map(([label, key]) => ({ label, key }));
      const cacheResults = await Promise.all(staticKeys.map(async ({ label, key }) => {
        const val = await env.HA_CACHE.get(key, "json");
        return { label, key, cached: val !== null, entries: Array.isArray(val) ? val.length : val ? 1 : 0 };
      }));
      const doStatus = await doFetch(env, "/status");
      return { cache: cacheResults, websocket: doStatus || { connected: false } };
    }
    case "clear_cache": {
      if (!env.HA_CACHE) return { error: "HA_CACHE not bound" };
      const keyMap = { states: CK.STATES, services: CK.SERVICES, entity_registry: CK.ENTITY_REGISTRY, calendars: CK.CALENDARS, areas: CK.AREAS, devices: CK.DEVICES, dashboards: CK.DASHBOARDS, floors: CK.FLOORS, labels: CK.LABELS };
      const toClear = args.keys && args.keys.length ? args.keys.map((k) => keyMap[k]).filter(Boolean) : Object.values(keyMap);
      await cacheDel(env, ...toClear);
      return { cleared: toClear };
    }
    default:
      throw new Error("Unknown tool: " + name);
  }
}

// ============================================================================
// Knowledge backfill — multi-kind unified Vectorize index (`ha-knowledge`).
//
// Replaces the entity-only backfillEntityVectors. Pulls source data per kind,
// builds canonical-schema docs, hashes embed text for change detection, then
// embeds in batches of 50 (cls pooling — index was created that way) and
// upserts in batches of 1000.
//
// kinds: an optional array; omitted means all of ALL_KINDS.
// ============================================================================

async function fetchAutomationConfigSafe(env, internalId) {
  if (!internalId) return null;
  try {
    const r = await haRequest(env, "GET", "/api/config/automation/config/" + internalId);
    if (r && !r.error) return r;
  } catch {}
  return null;
}

async function fetchScriptConfigSafe(env, scriptObjectId) {
  if (!scriptObjectId) return null;
  try {
    const r = await haRequest(env, "GET", "/api/config/script/config/" + scriptObjectId);
    if (r && !r.error) return r;
  } catch {}
  return null;
}

async function fetchSceneConfigSafe(env, sceneObjectId) {
  if (!sceneObjectId) return null;
  try {
    const r = await haRequest(env, "GET", "/api/config/scene/config/" + sceneObjectId);
    if (r && !r.error) return r;
  } catch {}
  return null;
}

async function buildEntityDocs(env) {
  const [entityRegistry, areaRegistry, deviceRegistry, states] = await Promise.all([
    getEntityRegistry(env, false),
    getAreaRegistry(env, false),
    getDeviceRegistry(env, false),
    getStates(env, false)
  ]);
  if (!Array.isArray(entityRegistry) || entityRegistry.length === 0) return [];

  const areaById = new Map();
  if (Array.isArray(areaRegistry)) {
    for (const a of areaRegistry) if (a && a.area_id) areaById.set(a.area_id, a.name || "");
  }
  const deviceById = new Map();
  if (Array.isArray(deviceRegistry)) {
    for (const d of deviceRegistry) {
      if (d && d.id) deviceById.set(d.id, { name: d.name_by_user || d.name || "", area_id: d.area_id || null });
    }
  }
  const stateById = new Map();
  if (Array.isArray(states)) {
    for (const s of states) if (s && s.entity_id) stateById.set(s.entity_id, s);
  }

  const docs = [];
  for (const e of entityRegistry) {
    const entity_id = e && e.entity_id;
    if (!entity_id) continue;
    const domain = entity_id.split(".")[0] || "";
    const state = stateById.get(entity_id);
    const dev = e.device_id ? deviceById.get(e.device_id) : null;
    const areaId = e.area_id || (dev && dev.area_id) || null;
    const area = areaId ? (areaById.get(areaId) || "") : "";
    const friendly_name =
      (state && state.attributes && state.attributes.friendly_name) ||
      e.name || e.original_name || entity_id;
    const device_class =
      (state && state.attributes && state.attributes.device_class) || "";
    const device_name = (dev && dev.name) || "";
    const aliases = Array.isArray(e.aliases) ? e.aliases : [];

    const text = buildEntityEmbedText({
      friendly_name, entity_id, area, device_name, domain, device_class, aliases
    });
    const hash = fnv1aHex(text);
    const ref_id = entity_id;
    const vector_id = vectorIdFor("entity", ref_id);
    const category = entityCategoryFor(e, state);
    const noisy = isNoisyEntity(e, state);

    docs.push({
      kind: "entity",
      ref_id,
      vector_id,
      text,
      hash,
      metadata: buildMetadata({
        kind: "entity",
        ref_id,
        friendly_name,
        domain,
        area,
        entity_category: category,
        is_noisy: noisy,
        topic_tag: "",
        hash,
        extra: { device_class }
      })
    });
  }
  return docs;
}

async function buildAutomationDocs(env) {
  const states = await getStates(env, false);
  if (!Array.isArray(states)) return [];
  const automations = states.filter((s) => s.entity_id.startsWith("automation."));

  const docs = [];
  // Bounded concurrency to avoid hammering HA's REST API.
  const BATCH = 8;
  for (let i = 0; i < automations.length; i += BATCH) {
    const slice = automations.slice(i, i + BATCH);
    const configs = await Promise.all(slice.map((s) => {
      const internalId = s.attributes && s.attributes.id;
      return internalId ? fetchAutomationConfigSafe(env, internalId) : Promise.resolve(null);
    }));

    for (let j = 0; j < slice.length; j++) {
      const s = slice[j];
      const cfg = configs[j];
      const internalId = (s.attributes && s.attributes.id) || s.entity_id;
      const friendly_name = (s.attributes && s.attributes.friendly_name) || s.entity_id;

      let triggerSummary = "";
      let actionSummary = "";
      let description = "";
      let aliases = [];
      let mode = "single";

      if (cfg && typeof cfg === "object") {
        description = cfg.description || "";
        aliases = Array.isArray(cfg.aliases) ? cfg.aliases : [];
        mode = cfg.mode || "single";
        const triggers = cfg.triggers || cfg.trigger;
        const actions = cfg.actions || cfg.action;
        if (Array.isArray(triggers)) triggerSummary = summarizeTriggers(triggers);
        if (Array.isArray(actions)) actionSummary = summarizeActions(actions);
      }

      const text = buildAutomationEmbedText({
        friendly_name,
        alias: cfg && cfg.alias,
        id: internalId,
        description,
        triggerSummary,
        actionSummary,
        mode,
        aliases
      });
      const hash = fnv1aHex(text);
      const ref_id = String(internalId);
      const vector_id = vectorIdFor("automation", ref_id);

      docs.push({
        kind: "automation",
        ref_id,
        vector_id,
        text,
        hash,
        metadata: buildMetadata({
          kind: "automation",
          ref_id,
          friendly_name,
          domain: "automation",
          area: "",
          entity_category: "primary",
          is_noisy: false,
          topic_tag: "",
          hash,
          extra: { entity_id: s.entity_id }
        })
      });
    }
  }
  return docs;
}

async function buildScriptDocs(env) {
  const states = await getStates(env, false);
  if (!Array.isArray(states)) return [];
  const scripts = states.filter((s) => s.entity_id.startsWith("script."));

  const docs = [];
  const BATCH = 8;
  for (let i = 0; i < scripts.length; i += BATCH) {
    const slice = scripts.slice(i, i + BATCH);
    const configs = await Promise.all(slice.map((s) => {
      const objectId = s.entity_id.split(".")[1];
      return objectId ? fetchScriptConfigSafe(env, objectId) : Promise.resolve(null);
    }));

    for (let j = 0; j < slice.length; j++) {
      const s = slice[j];
      const cfg = configs[j];
      const friendly_name = (s.attributes && s.attributes.friendly_name) || s.entity_id;

      let description = "";
      let actionSummary = "";
      if (cfg && typeof cfg === "object") {
        description = cfg.description || "";
        const sequence = cfg.sequence || cfg.actions || cfg.action;
        if (Array.isArray(sequence)) actionSummary = summarizeActions(sequence);
      }

      const text = buildScriptEmbedText({
        friendly_name,
        entity_id: s.entity_id,
        description,
        actionSummary
      });
      const hash = fnv1aHex(text);
      const ref_id = s.entity_id;
      const vector_id = vectorIdFor("script", ref_id);

      docs.push({
        kind: "script",
        ref_id,
        vector_id,
        text,
        hash,
        metadata: buildMetadata({
          kind: "script",
          ref_id,
          friendly_name,
          domain: "script",
          area: "",
          entity_category: "primary",
          is_noisy: false,
          topic_tag: "",
          hash
        })
      });
    }
  }
  return docs;
}

async function buildSceneDocs(env) {
  const states = await getStates(env, false);
  if (!Array.isArray(states)) return [];
  const scenes = states.filter((s) => s.entity_id.startsWith("scene."));

  const docs = [];
  const BATCH = 8;
  for (let i = 0; i < scenes.length; i += BATCH) {
    const slice = scenes.slice(i, i + BATCH);
    const configs = await Promise.all(slice.map((s) => {
      const objectId = s.entity_id.split(".")[1];
      return objectId ? fetchSceneConfigSafe(env, objectId) : Promise.resolve(null);
    }));

    for (let j = 0; j < slice.length; j++) {
      const s = slice[j];
      const cfg = configs[j];
      const friendly_name = (s.attributes && s.attributes.friendly_name) || s.entity_id;
      let entities = [];
      if (cfg && cfg.entities && typeof cfg.entities === "object") {
        entities = Object.keys(cfg.entities);
      } else if (s.attributes && Array.isArray(s.attributes.entity_id)) {
        entities = s.attributes.entity_id;
      }

      const text = buildSceneEmbedText({
        friendly_name,
        entity_id: s.entity_id,
        entities
      });
      const hash = fnv1aHex(text);
      const ref_id = s.entity_id;
      const vector_id = vectorIdFor("scene", ref_id);

      docs.push({
        kind: "scene",
        ref_id,
        vector_id,
        text,
        hash,
        metadata: buildMetadata({
          kind: "scene",
          ref_id,
          friendly_name,
          domain: "scene",
          area: "",
          entity_category: "primary",
          is_noisy: false,
          topic_tag: "",
          hash
        })
      });
    }
  }
  return docs;
}

async function buildAreaDocs(env) {
  const [areas, floors] = await Promise.all([
    getAreaRegistry(env, false),
    getFloorRegistry(env, false)
  ]);
  if (!Array.isArray(areas)) return [];
  const floorById = new Map();
  if (Array.isArray(floors)) {
    for (const f of floors) if (f && f.floor_id) floorById.set(f.floor_id, f.name || "");
  }

  const docs = [];
  for (const a of areas) {
    if (!a || !a.area_id) continue;
    const ref_id = a.area_id;
    const friendly_name = a.name || ref_id;
    const aliases = Array.isArray(a.aliases) ? a.aliases : [];
    const floor_name = a.floor_id ? (floorById.get(a.floor_id) || "") : "";

    const text = buildAreaEmbedText({
      name: friendly_name,
      floor_name,
      aliases
    });
    const hash = fnv1aHex(text);
    const vector_id = vectorIdFor("area", ref_id);

    docs.push({
      kind: "area",
      ref_id,
      vector_id,
      text,
      hash,
      metadata: buildMetadata({
        kind: "area",
        ref_id,
        friendly_name,
        domain: "area",
        area: friendly_name,
        entity_category: "primary",
        is_noisy: false,
        topic_tag: "",
        hash
      })
    });
  }
  return docs;
}

async function buildDeviceDocs(env) {
  const [deviceRegistry, areaRegistry, entityRegistry] = await Promise.all([
    getDeviceRegistry(env, false),
    getAreaRegistry(env, false),
    getEntityRegistry(env, false)
  ]);
  if (!Array.isArray(deviceRegistry)) return [];
  const areaById = new Map();
  if (Array.isArray(areaRegistry)) {
    for (const a of areaRegistry) if (a && a.area_id) areaById.set(a.area_id, a.name || "");
  }
  // Count entities per device + collect a small sample per device.
  const entitiesByDevice = new Map();
  if (Array.isArray(entityRegistry)) {
    for (const e of entityRegistry) {
      if (!e || !e.device_id) continue;
      let bucket = entitiesByDevice.get(e.device_id);
      if (!bucket) { bucket = []; entitiesByDevice.set(e.device_id, bucket); }
      bucket.push(e.entity_id);
    }
  }

  const docs = [];
  for (const d of deviceRegistry) {
    if (!d || !d.id) continue;
    const ref_id = d.id;
    const friendly_name = d.name || d.id;
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
      kind: "device",
      ref_id,
      vector_id,
      text,
      hash,
      metadata: buildMetadata({
        kind: "device",
        ref_id,
        friendly_name,
        domain: "device",
        area,
        entity_category: "primary",
        is_noisy: false,
        topic_tag: "",
        hash
      })
    });
  }
  return docs;
}

async function buildServiceDocs(env) {
  const services = await getServices(env, false);
  if (!Array.isArray(services)) return [];
  const docs = [];
  for (const domainObj of services) {
    if (!domainObj || !domainObj.domain) continue;
    const domain = domainObj.domain;
    const svcMap = domainObj.services;
    if (!svcMap || typeof svcMap !== "object") continue;
    for (const [service, info] of Object.entries(svcMap)) {
      if (!service) continue;
      const fields = flattenServiceFields(info);
      const text = buildServiceEmbedText({
        domain,
        service,
        name: (info && info.name) || "",
        description: (info && info.description) || "",
        fieldDescriptions: fields
      });
      const hash = fnv1aHex(text);
      const ref_id = domain + "." + service;
      const vector_id = vectorIdFor("service", ref_id);
      const noisy = isNoisyService(domain, service);
      const friendly_name = ref_id;

      docs.push({
        kind: "service",
        ref_id,
        vector_id,
        text,
        hash,
        metadata: buildMetadata({
          kind: "service",
          ref_id,
          friendly_name,
          domain,
          area: "",
          entity_category: "primary",
          is_noisy: noisy,
          topic_tag: "",
          hash
        })
      });
    }
  }
  return docs;
}

async function buildMemoryDocs(env) {
  const memory = await doFetch(env, "/ai_memory");
  if (!Array.isArray(memory)) return [];
  const docs = [];
  for (const text of memory) {
    if (typeof text !== "string" || !text) continue;
    const ref_id = fnv1aHex(text);
    const vector_id = vectorIdFor("memory", ref_id);
    const friendly_name = text.slice(0, 80);
    const embedText = buildMemoryEmbedText(text);
    const hash = fnv1aHex(embedText);

    docs.push({
      kind: "memory",
      ref_id,
      vector_id,
      text: embedText,
      hash,
      metadata: buildMetadata({
        kind: "memory",
        ref_id,
        friendly_name,
        domain: "memory",
        area: "",
        entity_category: "primary",
        is_noisy: false,
        topic_tag: "",
        hash
      })
    });
  }
  return docs;
}

async function buildObservationDocs(env) {
  const observations = await doFetch(env, "/ai_observations");
  if (!Array.isArray(observations)) return [];
  const docs = [];
  for (const text of observations) {
    if (typeof text !== "string" || !text) continue;
    const ref_id = fnv1aHex(text);
    const vector_id = vectorIdFor("observation", ref_id);
    const friendly_name = text.slice(0, 80);
    const embedText = buildObservationEmbedText(text);
    const hash = fnv1aHex(embedText);
    const topic_tag = extractTopicTag(text);

    docs.push({
      kind: "observation",
      ref_id,
      vector_id,
      text: embedText,
      hash,
      metadata: buildMetadata({
        kind: "observation",
        ref_id,
        friendly_name,
        domain: "observation",
        area: "",
        entity_category: "primary",
        is_noisy: false,
        topic_tag,
        hash
      })
    });
  }
  return docs;
}

async function buildKindDocs(env, kind) {
  switch (kind) {
    case "entity": return await buildEntityDocs(env);
    case "automation": return await buildAutomationDocs(env);
    case "script": return await buildScriptDocs(env);
    case "scene": return await buildSceneDocs(env);
    case "area": return await buildAreaDocs(env);
    case "device": return await buildDeviceDocs(env);
    case "service": return await buildServiceDocs(env);
    case "memory": return await buildMemoryDocs(env);
    case "observation": return await buildObservationDocs(env);
    default:
      throw new Error("Unknown kind: " + kind);
  }
}

async function backfillKnowledge(env, { force = false, kinds = null } = {}) {
  if (!env.AI || !env.KNOWLEDGE) {
    throw new Error("AI or KNOWLEDGE binding not configured");
  }

  const targetKinds = Array.isArray(kinds) && kinds.length > 0
    ? kinds.filter((k) => ALL_KINDS.includes(k))
    : [...ALL_KINDS];

  // Build docs per kind. Failures in one kind are logged and we continue.
  const perKindStats = {};
  const allDocs = [];
  for (const kind of targetKinds) {
    const t0 = Date.now();
    let docs = [];
    try {
      docs = await buildKindDocs(env, kind);
    } catch (err) {
      console.error("buildKindDocs(" + kind + ") failed:", err.message);
      perKindStats[kind] = { found: 0, error: err.message, build_ms: Date.now() - t0 };
      continue;
    }
    perKindStats[kind] = { found: docs.length, build_ms: Date.now() - t0 };
    for (const d of docs) allDocs.push(d);
  }

  // Skip-by-hash: look up existing vectors in batches of 20.
  const existingHash = new Map();
  if (!force && typeof env.KNOWLEDGE.getByIds === "function" && allDocs.length > 0) {
    const LOOKUP_BATCH = 20;
    for (let i = 0; i < allDocs.length; i += LOOKUP_BATCH) {
      const slice = allDocs.slice(i, i + LOOKUP_BATCH).map((d) => d.vector_id);
      try {
        const existing = await env.KNOWLEDGE.getByIds(slice);
        if (Array.isArray(existing)) {
          for (const v of existing) {
            if (v && v.id && v.metadata && v.metadata.hash) existingHash.set(v.id, v.metadata.hash);
          }
        }
      } catch (err) {
        console.warn("KNOWLEDGE.getByIds failed, will re-embed all:", err.message);
        existingHash.clear();
        break;
      }
    }
  }

  const toEmbed = [];
  let skipped = 0;
  for (const d of allDocs) {
    if (!force && existingHash.get(d.vector_id) === d.hash) skipped++;
    else toEmbed.push(d);
  }

  const EMBED_BATCH = 50;
  const UPSERT_BATCH = 1000;
  let embedded = 0;
  let errors = 0;
  let pending = [];

  const flushUpsert = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      await env.KNOWLEDGE.upsert(batch);
    } catch (err) {
      console.error("KNOWLEDGE.upsert failed:", err.message);
      errors += batch.length;
      embedded -= batch.length;
    }
  };

  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    const slice = toEmbed.slice(i, i + EMBED_BATCH);
    let aiResult;
    try {
      aiResult = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
        text: slice.map((d) => d.text),
        pooling: "cls"
      });
    } catch (err) {
      console.error("Embedding batch failed:", err.message);
      errors += slice.length;
      continue;
    }

    const vectors = aiResult && aiResult.data;
    if (!Array.isArray(vectors) || vectors.length !== slice.length) {
      console.error("Embedding batch returned malformed result");
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
      embedded++;
      if (pending.length >= UPSERT_BATCH) await flushUpsert();
    }
  }
  await flushUpsert();

  return {
    total_docs: allDocs.length,
    embedded,
    skipped,
    errors,
    kinds: perKindStats
  };
}

async function handleMCP(request, env) {
  const { id, method, params } = request;
  try {
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ha-mcp-gateway", version: "5.1.0" } } };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: getAgentToolset("mcp_external") } };
      case "tools/call": {
        const result = await handleTool(env, params.name, params.arguments || {});
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] } };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
    }
  } catch (error) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: error.message } };
  }
}
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (!env.HA_URL || !env.HA_TOKEN) return new Response(JSON.stringify({ error: "Missing config" }), { status: 500, headers: corsHeaders });
    if (url.pathname === "/health") {
      const doStatus = await doFetch(env, "/status");
      return new Response(JSON.stringify({
        status: "ok",
        version: "5.1.0",
        tools: TOOLS.length,
        cache: env.HA_CACHE ? "enabled" : "disabled",
        knowledge: env.KNOWLEDGE ? "bound" : "unbound",
        websocket: doStatus || { connected: false }
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (url.pathname === "/transcribe") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
      }
      if (!env.ELEVENLABS_API_KEY) {
        return new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      try {
        const audioBlob = await request.blob();
        if (audioBlob.size === 0) {
          return new Response(JSON.stringify({ error: "Empty audio body" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const ct = (request.headers.get("Content-Type") || "audio/webm").toLowerCase();
        let filename = "audio.webm";
        if (ct.includes("mp4") || ct.includes("aac") || ct.includes("m4a")) filename = "audio.m4a";
        else if (ct.includes("mpeg")) filename = "audio.mp3";
        else if (ct.includes("wav")) filename = "audio.wav";
        else if (ct.includes("ogg")) filename = "audio.ogg";

        const form = new FormData();
        form.append("file", audioBlob, filename);
        form.append("model_id", "scribe_v1");

        const elevResp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
          body: form
        });
        const respText = await elevResp.text();
        if (!elevResp.ok) {
          return new Response(JSON.stringify({
            error: "ElevenLabs error",
            status: elevResp.status,
            body: respText.slice(0, 500)
          }), {
            status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        let data;
        try { data = JSON.parse(respText); } catch { data = { text: respText }; }
        return new Response(JSON.stringify({
          text: data.text || "",
          language_code: data.language_code
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }
    if (url.pathname === "/refresh") {
      try {
        const testReq = await haRequest(env, "GET", "/api/states");
        if (testReq && testReq.error) return new Response(JSON.stringify({ status: "HA_CONNECTION_FAILED", reason: testReq }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        ctx.waitUntil(this.prewarmCache(env, true));
        return new Response(JSON.stringify({ status: "success", message: "Found " + (testReq.length || 0) + " states. Pre-warming cache." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ status: "CRITICAL_ERROR", message: err.message }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    if (url.pathname === "/chat") {
      if (request.method === "GET") {
        const msg = url.searchParams.get("m") || url.searchParams.get("message");
        if (!msg) {
          return new Response(CHAT_HTML, {
            headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" }
          });
        }
        const result = await doFetch(env, "/ai_chat", { message: msg, from: "web" });
        return new Response(JSON.stringify(result || { error: "Agent not responding" }, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      if (request.method === "POST") {
        try {
          const body = await request.json();
          if (!body.message || typeof body.message !== "string") {
            return new Response(JSON.stringify({ error: "Missing or invalid 'message' field" }), {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
          const accept = request.headers.get("Accept") || "";
          if (accept.includes("text/event-stream")) {
            const stub = getDO(env);
            if (!stub) {
              return new Response(JSON.stringify({ error: "Agent not available" }), {
                status: 503,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
              });
            }
            const streamResp = await stub.fetch("http://do/ai_chat_stream", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: body.message, from: "web" })
            });
            return new Response(streamResp.body, {
              headers: {
                ...corsHeaders,
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no"
              }
            });
          }
          const result = await doFetch(env, "/ai_chat", { message: body.message, from: "web" });
          return new Response(JSON.stringify(result || { error: "Agent not responding" }, null, 2), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), {
            status: 400, headers: corsHeaders
          });
        }
      }
    }
    if (url.pathname === "/twilio") {
    if (request.method === "POST") {
    try {
      const form = await request.formData();
      const msg = form.get("Body");
      const from = form.get("From") || "default";
      if (!msg) {
        return new Response("<Response></Response>", {
          headers: { ...corsHeaders, "Content-Type": "text/xml" }
        });
      }

      // Race against 10s timeout — Twilio requires response within 15s
      let result;
      try {
        const chatPromise = doFetch(env, "/ai_chat", { message: msg, from });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 13000)
        );
        result = await Promise.race([chatPromise, timeoutPromise]);
      } catch (err) {
        console.error("Twilio doFetch failed:", err.message);
        result = null;
      }

      const reply = (result?.reply || "On it — give me a moment and try again.")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      return new Response(
        `<Response><Message><Body>${reply}</Body></Message></Response>`,
        { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );

    } catch (e) {
      console.error("Twilio handler error:", e.message);
      return new Response(
        `<Response><Message><Body>Sorry, something went wrong.</Body></Message></Response>`,
        { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );
    }
  }
}
    // Multi-kind knowledge backfill. Body is optional; query params control
    // behavior:
    //   ?force=1                    re-embed everything regardless of hash
    //   ?kinds=entity,automation    comma-separated subset (default: all)
    if (url.pathname === "/admin/rebuild-knowledge") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (!env.AI || !env.KNOWLEDGE) {
        return new Response(JSON.stringify({ error: "AI or KNOWLEDGE binding not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      const t0 = Date.now();
      try {
        const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
        const kindsParam = url.searchParams.get("kinds");
        const kinds = kindsParam
          ? kindsParam.split(",").map((s) => s.trim()).filter(Boolean)
          : null;
        const summary = await backfillKnowledge(env, { force, kinds });
        return new Response(JSON.stringify({ ...summary, duration_ms: Date.now() - t0 }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, duration_ms: Date.now() - t0 }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }
    if (url.pathname === "/mcp" || url.pathname === "/") {
      if (env.MCP_AUTH_TOKEN) {
        const auth = request.headers.get("Authorization");
        if (!auth || auth.slice(7) !== env.MCP_AUTH_TOKEN) return new Response("Unauthorized", { status: 401 });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        const mcpReq = await request.json();
        const response = await handleMCP(mcpReq, env);
        return new Response(JSON.stringify(response), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: corsHeaders });
      }
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    // Cron dispatcher — branch on the matched cron pattern. The minute-level
    // "* * * * *" trigger runs cache prewarm; "30 8 * * *" runs the heavy
    // daily knowledge resync. event.cron is the matched pattern.
    if (event && event.cron === "30 8 * * *") {
      ctx.waitUntil(this.dailyKnowledgeResync(env));
      return;
    }
    ctx.waitUntil(this.prewarmCache(env));
  },
  async prewarmCache(env, forceAll = false) {
  if (!env.HA_CACHE) return;
  // Force DO to wake and reconnect if needed
  const doStatus = await doFetch(env, "/status");
  const doConnected = doStatus && doStatus.connected && doStatus.authenticated;
  console.log("Pre-warming cache... DO connected:", !!doConnected);
  if (!doConnected) {
    console.log("DO cold or disconnected — forcing reconnect...");
    await doFetch(env, "/reconnect").catch(() => {});
    await new Promise(r => setTimeout(r, 2000)); // give HA WS time to auth
  }
  try {
    if (!doConnected) await getStates(env, true);
      const currentMinute = (/* @__PURE__ */ new Date()).getMinutes();
      if (forceAll || currentMinute % 15 === 0) {
        console.log("Running heavy cache pre-warm...");
        await Promise.all([
          getServices(env, true),
          getEntityRegistry(env, true),
          getAreaRegistry(env, true),
          getDeviceRegistry(env, true),
          getFloorRegistry(env, true),
          getLabelRegistry(env, true)
        ]);
      }
      console.log("Cache pre-warm completed.");
    } catch (error) {
      console.error("Cache pre-warm failed:", error);
    }
  },
  // Daily heavy resync — re-embeds the kinds that aren't already covered by
  // event-driven (entity/device on registry events) or write-through (memory/
  // observation in executeAIAction) updates. Skips unchanged docs by hash so
  // a full daily run typically completes with most docs in the skipped column.
  async dailyKnowledgeResync(env) {
    if (!env.AI || !env.KNOWLEDGE) {
      console.log("dailyKnowledgeResync: AI or KNOWLEDGE binding missing — skipping");
      return;
    }
    const t0 = Date.now();
    try {
      const summary = await backfillKnowledge(env, {
        force: false,
        kinds: ["automation", "script", "scene", "area", "device", "service"]
      });
      console.log(
        "dailyKnowledgeResync: " + JSON.stringify({ ...summary, duration_ms: Date.now() - t0 })
      );
    } catch (err) {
      console.error("dailyKnowledgeResync failed:", err.message);
    }
  }
};
export {
  HAWebSocket,
  worker_default as default
};
