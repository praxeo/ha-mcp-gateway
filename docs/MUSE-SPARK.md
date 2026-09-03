# Muse Spark 1.3 on the Responses API

**As of V30 this is the default model.** The chat agent runs
`muse-spark-1.3-contributor` on Meta's Model API over `POST /v1/responses`.
Fireworks / GLM 5.3 stays fully wired for rollback, one config POST away.

| Provider | Wire format | Endpoint | Secret |
|---|---|---|---|
| `meta` (default) | `responses` | `https://api.meta.ai/v1/responses` | `MODEL_API_KEY` |
| `fireworks` | `chat` | `https://api.fireworks.ai/...` | `FIREWORKS_API_KEY` |

Translation lives in `src/llm-providers.js`. It converts the gateway's
canonical Chat-Completions messages into Responses input items on the way out
and normalizes the reply back on the way in, so `runNativeToolLoop`, the stored
`chat_history`, and the tool schemas are unchanged — and the provider can be
switched **mid-conversation** with history intact.

---

## Before you deploy: set the secret first

> **The order matters.** V30 ships with `meta` as the baked default. If the
> Durable Object refreshes before `MODEL_API_KEY` exists, every chat turn fails
> with `MODEL_API_KEY not configured` — on the live house.

```powershell
wrangler secret put MODEL_API_KEY
```

The name is Meta's: the OpenAI SDK looks for `OPENAI_API_KEY` by default, so
the key is passed explicitly. Both provider keys can coexist, so rolling back
to Fireworks needs no secret changes.

Then verify before trusting it with a door:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  "https://ha-mcp-gateway.obert-john.workers.dev/admin/llm-selftest"
```

This sends one small request with one dummy tool through the **real**
`callLLMWithTools` path. The three fields that matter:

- **`ok: true`** — the request was accepted at all.
- **`tool_call_shape_ok: true`** — tool calls round-trip in the shape the loop
  expects. If this is false, the agent cannot act on anything.
- **`reasoning_replay_items` ≥ 1** — encrypted reasoning came back, so
  multi-round tool chains keep their chain of thought.

POST a config patch to probe a *candidate* without storing it:

```json
{ "provider": "fireworks", "model": "accounts/fireworks/models/glm-5p3" }
```

---

## The contributor tier

You chose the contributor variant. The two are the same model; they differ in
price and in one other way:

| Model id | Input / cached / output per 1M | Data usage |
|---|---|---|
| `muse-spark-1.3-contributor` | $0.10 / $0.002 / $0.20 | **Used by Meta to improve their products** |
| `muse-spark-1.3` | $1.25 / $0.15 / $4.25 | Not used to improve products |

Against GLM 5.3's $1.40 / $4.40 that is roughly 14× cheaper on input and 22×
cheaper on output.

What travels in those prompts is this specific household: which doors are
unlocked right now, presence for John and Sabrina, when the house is empty, the
Tesla's location, the home address as it appears in geocoded sensor states, and
whatever 90-day pattern history the forensic tools pull in. On the contributor
tier that becomes training data, and data already sent cannot be recalled.
Swapping to `muse-spark-1.3` is one word in the command below if that trade
stops being worth it.

---

## Reasoning tiers

The chat UI's toggle sends `tier` on every request and the Durable Object maps
it to reasoning effort:

| Tier | Effort | When |
|---|---|---|
| **Quick** (default, resets on every page load) | `low` | Commands, status, scheduling — anything ordinary |
| **High** (per-session opt-in) | `high` | Forensic questions, trends, debugging HA |

Muse Spark also accepts `minimal` and `xhigh`. To move the baseline for turns
that carry no tier:

```json
{ "reasoning_effort": "medium" }
```

`none` is rejected by Muse Spark, so the adapter omits the reasoning block
entirely rather than sending it.

---

## Switching and rolling back

```powershell
# Roll back to Fireworks / GLM 5.3
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  -X POST "https://ha-mcp-gateway.obert-john.workers.dev/admin/llm-config" `
  --data-binary "@rollback.json"
```

`rollback.json` (UTF-8, no BOM):

```json
{ "provider": "fireworks", "model": "accounts/fireworks/models/glm-5p3" }
```

Only `provider` and `model` are needed — the wire format, endpoint and secret
all follow the provider. Setting them by hand is how they drift apart.

`{"reset": true}` returns to the baked default (Muse Spark) immediately, on the
running isolate. Chat history survives either direction: it is stored
provider-neutral.

---

## Implementation notes

These come from Meta's Responses API documentation; the section after this one
records which of them live testing actually confirmed.

- **`strict` defaults to true** and demands a strict-mode JSON Schema (every
  property required, `additionalProperties: false`). The agent's 19 tool
  schemas have optional properties throughout, so the adapter sets
  `strict: false`. Without it every request is rejected on schema validation.
- **Reasoning items must be followed** by an assistant message or a
  `function_call` before the next user message, or the request returns HTTP
  400. Rather than fabricate an assistant turn the model never produced, the
  adapter drops the orphaned reasoning item — dropping is explicitly allowed
  and costs only that turn's chain of thought.
- **Assistant text before a tool call is tagged `phase: "commentary"`.** The
  docs say replaying it untagged before a `function_call` returns 400. Live
  testing did not reproduce that (both forms were accepted), so treat the tag
  as correct rather than load-bearing — the docs specify it and warn that
  dropping the phase degrades quality. The adapter derives it from whether tool
  calls follow, so it survives the round trip without being stored.
- **`reasoning_content` does not exist on Responses output** — that field
  belongs to Chat Completions. Muse Spark's raw chain of thought is encrypted
  and the reasoning item carries no visible text, so the adapter requests
  `reasoning.summary: "detailed"` and synthesizes `reasoning_content` from the
  summary. `"auto"` and `"concise"` returned nothing in live testing (see
  below). Set `LLM_REASONING_SUMMARY = null` to drop the request entirely.
- **Every reasoning input item needs a `summary` array**, even an empty one.
  `id` is optional on replay because `encrypted_content` carries the state; a
  bare id without the encrypted content is rejected as missing or expired.
- **`store: false` + `include: ["reasoning.encrypted_content"]`** is the
  stateless path: nothing persists on Meta's side and replay still works. It
  cannot be combined with `previous_response_id` — the gateway keeps its own
  history, so it never uses that.
- **No `temperature` or `top_p`.** Muse Spark is tuned for its defaults
  (`1.0`/`1.0`) and performs best there. The chat-format branch still sends
  `temperature: 0`, which is right for the models it serves.
- **`max_output_tokens`**, not `max_tokens`, and it shares the context window
  with input.
- **`prompt_cache_key`** groups requests so the long, byte-identical
  system-plus-tools prefix stays warm — the Responses-API counterpart to the
  Fireworks session-affinity header, which is not sent to Meta.
- **Perf headers.** `server_ttft_ms` / `server_total_ms` in `chat_timing_ms`
  come from `fireworks-*` response headers and will be null on Meta. Token
  counts, per-iteration timings and `total` are unaffected;
  `input_tokens_details.cached_tokens` still populates `total_cached_tokens`.
- **The legacy `callLLM` path** (iteration-ceiling synthesis) has no tools and
  always speaks Chat Completions, so under a `responses` config it targets the
  same provider's chat endpoint rather than posting a chat body to a responses
  URL.

## Not yet implemented

- **Streaming.** Every call is still buffered; the Responses API's typed stream
  events (`response.output_text.delta`, `response.function_call_arguments.delta`)
  are the path to first-token latency, and are Phase 2 in
  `docs/PLAN-voice-tiers-latency.md`.
- **`previous_response_id`.** The gateway manages its own history, which keeps
  it provider-neutral and lets a switch happen mid-conversation.
- **Search grounding** (`tools: [{"type": "web_search"}]`) — available on this
  endpoint, unused so far. The agent already has NWS weather tools.

## Verified against the live API

Run 2026-09-03 against `muse-spark-1.3-contributor`, using request bodies
generated by the real `buildResponsesBody` and responses fed back through the
real `responsesToChatCompletion` — not hand-written fixtures.

**A full two-round tool loop works end to end.** Round 1 (question + one tool)
returned `reasoning` ×2 then a `function_call`; the normalizer produced exactly
the chat-shaped message the loop expects. Round 2 replayed those reasoning
items plus the call and its result, and the model answered correctly from the
tool output.

| Check | Result |
|---|---|
| `strict: false` with a permissive schema | accepted; tool was called |
| `function_call` shape | `call_id`, `name`, and `arguments` as a JSON **string** — matches the normalizer |
| `encrypted_content` on reasoning items | present, ~1.4 KB each; replay accepted on round 2 |
| Multiple reasoning items per response | yes, 2 — the array replay handles it |
| Typed `input_text` / `output_text` blocks | accepted |
| `store: false` + `include: [reasoning.encrypted_content]` | accepted |
| Usage mapping | `input_tokens` 590 → `prompt_tokens`, `output_tokens_details.reasoning_tokens` 28 |
| **Prompt caching** | round 2 reported `cached_tokens: 561` of 745 input — `prompt_cache_key` is working |
| Latency | ~2.2 s per round at effort `low` |

**Two findings changed the code or the expectations:**

1. **`summary: "auto"` never produced text.** Neither did `"concise"`. At effort
   `low` — the Quick tier — the summary array came back empty under every mode.
   Only `"detailed"` produced text, and only at higher effort. The default is
   now `"detailed"`, so High-tier turns get a readable reasoning panel and Quick
   turns show none at all. That is the right outcome: "close the garage" does
   not need reasoning narration. Since `reasoning_content` is then absent, the
   SSE `reasoning` event simply never fires and no empty panel is rendered.

2. **The `phase: "commentary"` rule was not enforced** in the case tested.
   Replaying assistant text immediately before a `function_call` was accepted
   both with and without the tag, though the documentation says the untagged
   form returns HTTP 400. The adapter still tags it: the docs specify it, and
   they warn that dropping the phase degrades quality. Treat it as correct
   rather than load-bearing.

Not exercised live: streaming, `previous_response_id`, search grounding, and
the iteration-ceiling synthesis path through `callLLM`. `/admin/llm-selftest`
covers the main path once the Worker has the secret.
