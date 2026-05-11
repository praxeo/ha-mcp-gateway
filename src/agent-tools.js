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
        "memory is saved, it persists across sessions until FIFO eviction. Memories are " +
        "also embedded into the knowledge index so vector_search can surface them by topic.",
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
        "are embedded into the knowledge index so vector_search can surface them by topic.",
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
        "(or didn't), or to confirm a pattern across a time window. Prefer narrow windows " +
        "— this can return a lot of data. CRITICAL: start_time and end_time MUST include an " +
        "explicit timezone offset (e.g., '-05:00' for CDT, '-06:00' for CST). A naive ISO " +
        "string like '2026-04-17T20:00:00' may be interpreted as UTC and shift your window " +
        "5–6 hours into a quiet period, returning empty results. When in doubt, use '-05:00' " +
        "(this household is America/Chicago).",
      parameters: {
        type: "object",
        properties: {
          entity_id: {
            type: "string",
            description: "Optional entity ID to scope the logbook to a single entity."
          },
          start_time: {
            type: "string",
            description: "ISO 8601 start time WITH timezone offset, e.g., '2026-04-17T20:00:00-05:00'. Never pass a naive ISO without offset."
          },
          end_time: {
            type: "string",
            description: "Optional ISO 8601 end time WITH timezone offset, e.g., '2026-04-18T04:00:00-05:00'. Defaults to now if omitted."
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
  },
  {
    type: "function",
    function: {
      name: "vector_search",
      description:
        "Semantic search across the unified home knowledge index. Returns ranked matches " +
        "across entities, automations, scripts, scenes, areas, devices, HA services, your " +
        "saved memories, and your saved observations. ALWAYS pass kinds=[…] — never call " +
        "without it; mixed-kind queries can be dominated by services or duplicates. The " +
        "area filter is case-insensitive but must match an HA area name (e.g., 'MBR' for " +
        "the master bedroom — NOT 'Master Bedroom'). The domain filter is entity-only and " +
        "returns nothing for non-entity kinds. Pass include_noisy: true for diagnostic / " +
        "battery / mesh / signal / LQI / RSSI queries; battery sensors specifically remain " +
        "visible without that flag. Use topic_tag to retrieve observations under a specific " +
        "[bracket-prefix]. Default min_score floor is 0.50 (empirical noise floor); pass " +
        "min_score: 0.6 to tighten. Observations time-decay automatically; entities " +
        "currently active or recently changed get a small live-state boost. top_k defaults " +
        "to 15, max 50.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural-language query — describe what you're looking for."
          },
          kinds: {
            type: "array",
            items: {
              type: "string",
              enum: ["entity", "automation", "script", "scene", "area", "device", "service", "memory", "observation"]
            },
            description: "Restrict to these kinds. ALWAYS provide — omitting can produce service-dominated or duplicate-heavy results."
          },
          domain: {
            type: "string",
            description: "Entity domain filter (light, switch, sensor, ...). Only meaningful with kinds=['entity']."
          },
          area: {
            type: "string",
            description: "Area name filter (case-insensitive). Must match an HA area name — e.g., 'MBR' for master bedroom, 'Master Bathroom' for master bath."
          },
          topic_tag: {
            type: "string",
            description: "Filter to observations/memories with this exact [bracket-prefix] (e.g., 'lock-jam-pattern', 'basement-bay-afternoon-pattern')."
          },
          min_score: {
            type: "number",
            description: "Minimum cosine score (0-1). Defaults to 0.50; results below are pruned. Pass 0.6+ to tighten."
          },
          top_k: {
            type: "number",
            description: "How many matches to return. Default 15, max 50."
          },
          include_noisy: {
            type: "boolean",
            description: "Include diagnostic/config/counter entities and destructive services. Default false. Set true for battery / mesh / LQI / signal / diagnostic queries."
          }
        },
        required: ["query", "kinds"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_automation_config",
      description:
        "Get the full Home Assistant configuration body for a specific automation, " +
        "including triggers, conditions, actions, mode, alias, and description. Use this " +
        "for automation debugging when the user asks why an automation did or did not run, " +
        "what an automation does, or whether an automation's YAML/config is correct. " +
        "Prefer entity_id like 'automation.front_porch_lights'. Do not rely on " +
        "render_template or automation state attributes for full automation debugging — " +
        "those do not expose the trigger/condition/action body.",
      parameters: {
        type: "object",
        properties: {
          entity_id: {
            type: "string",
            description: "Automation entity ID, e.g. 'automation.front_porch_lights'. Preferred."
          },
          automation_id: {
            type: "string",
            description: "Home Assistant internal automation config ID. Optional fallback if entity_id is not available."
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "report_bug",
      description:
        "Capture a user-flagged issue to the debug log for review at the next iteration " +
        "session. Call this when the user is explicitly asking you to record / save / log / " +
        "report / note something as a bug, problem, broken behavior, or debug entry. The " +
        "trigger is the combination of a recording verb (save, log, report, record, note, " +
        "capture, remember-as) plus an issue noun (bug, debug, problem, broken, issue). " +
        "Examples: \"that's a bug\", \"save to debug log\", \"save as bug report\", \"log " +
        "this as broken\", \"report this as a bug\", \"make a note of this — it's broken\". " +
        "Do NOT call for general venting (\"this is annoying\"), corrections (\"no, " +
        "actually...\"), questions (\"why is X on?\"), preference setting (\"save 60% as " +
        "my preference\"), or normal task flow. If the user's intent is unclear, ask " +
        "\"Want me to log that as a bug?\" and only call on explicit confirmation. After " +
        "calling, reply briefly that it's logged. Do NOT attempt to fix the bug — fixes " +
        "happen in code on the next iteration.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "What the bug is, in the user's words plus minimal model framing if needed for clarity. One or two sentences."
          },
          entities: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of entity_ids involved in the bug. Include any the user named or that vector_search/get_state has surfaced as relevant."
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "User-stated severity if given; otherwise default to 'low'. Use 'high' only when the user explicitly indicates urgency or a safety concern."
          }
        },
        required: ["description"]
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
// and counted in `actions_taken`. Read tools (incl. vector_search) do not.
export const NATIVE_ACTION_TOOL_NAMES = new Set(
  ACTION_TOOLS.map((t) => t.function.name)
);

// Names of tools the CHAT profile is allowed to expose to MiniMax.
// save_memory and save_observation are gated by a prompt-level rule (only on
// explicit user request), not by tool absence — the user can now say "remember
// X" or "note that Y" and have it written immediately, rather than waiting on
// the autonomous heartbeat to pick it up.
// report_bug is chat-only — autonomous has no user to flag bugs.
export const CHAT_ALLOWED_TOOL_NAMES = new Set([
  "call_service",
  "ai_send_notification",
  "save_memory",
  "save_observation",
  "get_state",
  "get_logbook",
  "render_template",
  "vector_search",
  "get_automation_config",
  "report_bug"
]);
