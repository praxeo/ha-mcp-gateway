// agent-tools.js — Native tool-calling schema for MiniMax (Phase 2)
//
// These OpenAI-compatible function-tool definitions are passed to MiniMax on
// every agent turn when USE_NATIVE_TOOL_LOOP === "true". MiniMax returns
// tool_calls which the dispatcher (executeNativeTool on HAWebSocket) maps to
// the same underlying logic the legacy JSON-action parser uses — no duplicate
// action implementations.
//
// Shape reference (OpenAI / MiniMax M2.7-highspeed):
//   Request:  tools: [{type: "function", function: {name, description, parameters}}]
//   Response: choices[0].message.tool_calls[] = [{id, type: "function",
//             function: {name, arguments: "<json string>"}}]
//   Note:     `arguments` is a STRING — JSON.parse before dispatch.

// Action tools — mutate state, logged with source: "native_loop"
const ACTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "call_service",
      description:
        "Call any Home Assistant service to control a device or trigger behavior. " +
        "Use this for lights, locks, covers, climate, input_booleans, scripts, scenes, " +
        "media players — anything you need to actually DO in the house. The domain and " +
        "service are separate strings (e.g., domain='light', service='turn_on'). Put " +
        "entity_id and any service-specific parameters (brightness, temperature, etc.) " +
        "inside the `data` object.",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Service domain — e.g., 'light', 'switch', 'lock', 'cover', 'climate', 'notify', 'script', 'scene', 'input_boolean'."
          },
          service: {
            type: "string",
            description: "Service name within the domain — e.g., 'turn_on', 'turn_off', 'toggle', 'set_temperature', 'lock', 'open_cover'."
          },
          data: {
            type: "object",
            description: "Service data, including entity_id and any domain-specific parameters (brightness, rgb_color, temperature, position, etc.).",
            additionalProperties: true
          },
          target: {
            type: "object",
            description: "Optional HA target object. Usually leave empty and put entity_id in data instead.",
            additionalProperties: true
          }
        },
        required: ["domain", "service"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ai_send_notification",
      description:
        "Send a push notification to John or Sabrina AND record it in your activity " +
        "timeline (ai_log). This is the semantic difference vs. a raw call_service on " +
        "notify.mobile_app_*: going through this tool means you 'own' the notification — " +
        "it appears in the unified timeline you read back on future turns, so you'll " +
        "remember having sent it. Use ONLY for things that warrant a phone buzz — " +
        "security events during transitions (unlocked lock when both users leave, garage " +
        "left open at bedtime), sustained aux heat above 5000W, water leaks, unexpected " +
        "entry. Do NOT use for routine state changes, suggestions, or pattern observations " +
        "— those go to save_observation or a chat reply. Never notify for the same thing " +
        "twice in one session unless it materially changed.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Notification body text. Be specific — say what's happening and, if relevant, what you're doing about it."
          },
          title: {
            type: "string",
            description: "Optional title shown above the message."
          }
        },
        required: ["message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description:
        "Save a CONFIRMED fact for long-term reference. 100-slot FIFO cap. Use only for " +
        "stable, validated facts — preferences John has confirmed, events you've witnessed " +
        "and verified, knowledge that won't churn. Do NOT use for hypotheses, patterns in " +
        "progress, or speculative observations — those go to save_observation. Once a " +
        "memory is saved, it persists across sessions until FIFO eviction.",
      parameters: {
        type: "object",
        properties: {
          memory: {
            type: "string",
            description: "The confirmed fact, stated plainly. One fact per call."
          }
        },
        required: ["memory"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_observation",
      description:
        "Save a pattern, hypothesis, or gap-in-progress. 500-slot FIFO cap. ALWAYS prefix " +
        "the text with a [topic-tag] like [bedtime-pattern], [3am-power-anomaly], " +
        "[attic-temp-gap], or [suggestion-rejected]. Use the `replaces` field with the " +
        "SAME tag to supersede a prior observation on that topic — this deletes all " +
        "entries starting with the prefix before appending the new one. Observations " +
        "are where you build evidence over time before promoting to save_memory.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Observation text, MUST start with a [topic-tag]. Include evidence — timestamps, counts, contextual detail."
          },
          replaces: {
            type: "string",
            description: "Optional [topic-tag] prefix. If set, all existing observations starting with this exact prefix are deleted before appending the new text. Use the same tag as the one in `text` when updating."
          }
        },
        required: ["text"]
      }
    }
  }
];

// Read tools — side-effect-free, used for mid-loop discovery. Not logged as actions.
const READ_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_state",
      description:
        "Get the current state and full attributes of a single entity. Use when you need " +
        "detail beyond what's in the pre-injected entity context block — specific attribute " +
        "values, current_position for covers, full climate setpoints, etc. Don't call this " +
        "for entities already present in your context snapshot unless you suspect staleness.",
      parameters: {
        type: "object",
        properties: {
          entity_id: {
            type: "string",
            description: "Fully-qualified entity ID, e.g., 'lock.home_connect_620_connected_smart_lock'."
          },
          force_refresh: {
            type: "boolean",
            description: "Bypass cache and fetch fresh from HA. Default false."
          }
        },
        required: ["entity_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_logbook",
      description:
        "Fetch Home Assistant logbook entries for event attribution and pattern verification. " +
        "Use to check WHO or WHAT triggered a state change, to verify an automation fired " +
        "(or didn't), or to confirm a pattern across a time window. Requires start_time in " +
        "ISO 8601 format. Prefer narrow windows — this can return a lot of data.",
      parameters: {
        type: "object",
        properties: {
          entity_id: {
            type: "string",
            description: "Optional entity ID to scope the logbook to a single entity."
          },
          start_time: {
            type: "string",
            description: "ISO 8601 start time, e.g., '2026-04-17T00:00:00-05:00'."
          },
          end_time: {
            type: "string",
            description: "Optional ISO 8601 end time. Defaults to now on the HA side."
          }
        },
        required: ["start_time"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "render_template",
      description:
        "Render a Jinja2 template in Home Assistant's context. Use for discovery queries " +
        "the pre-injected context can't answer — e.g., 'all entities in area X with state Y', " +
        "cross-entity aggregations, or HA-native helper functions like area_name, " +
        "device_attr, expand, state_attr. Keep templates compact; HA evaluates these " +
        "synchronously.",
      parameters: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description: "The Jinja2 template string to render."
          }
        },
        required: ["template"]
      }
    }
  }
];

export const NATIVE_AGENT_TOOLS = [...ACTION_TOOLS, ...READ_TOOLS];

// Fast membership check for the dispatcher on HAWebSocket.
export const NATIVE_TOOL_NAMES = new Set(
  NATIVE_AGENT_TOOLS.map((t) => t.function.name)
);

// Subset that mutates state — these get logged as actions with source: "native_loop"
// and counted in `actions_taken`. Read tools do not.
export const NATIVE_ACTION_TOOL_NAMES = new Set(
  ACTION_TOOLS.map((t) => t.function.name)
);
