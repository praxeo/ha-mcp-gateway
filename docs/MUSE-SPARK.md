# Switching the chat agent to Meta Muse Spark 1.3

The gateway can now talk to two providers over two wire formats:

| Provider | Wire format | Endpoint | Secret |
|---|---|---|---|
| `fireworks` | `chat` (`/v1/chat/completions`) | `api.fireworks.ai` | `FIREWORKS_API_KEY` |
| `meta` | `responses` (`/v1/responses`) | `api.meta.ai` | `MODEL_API_KEY` |

Translation lives in `src/llm-providers.js`. It converts the gateway's
canonical Chat-Completions messages into Responses API items on the way out and
normalizes the reply back on the way in, so `runNativeToolLoop`, the stored
`chat_history`, and the tool schemas are all unchanged. That means the provider
can be switched **mid-conversation** and history stays readable to both.

The baked default is still Fireworks / GLM 5.3. Muse Spark is selected at
runtime — no deploy, no Durable Object rename.

---

## Before you switch: read this once

You asked for the **contributor** variant. The two variants differ in exactly
one way beyond price:

| Model id | Input / cached / output per 1M | Data usage |
|---|---|---|
| `muse-spark-1.3-contributor` | $0.10 / $0.002 / $0.20 | **Used by Meta to improve their products** |
| `muse-spark-1.3` | $1.25 / $0.15 / $4.25 | Not used to improve products |

Contributor is roughly 12× cheaper on input and 21× cheaper on output — and
against today's GLM 5.3 rates ($1.40 / $4.40) it is about 14× and 22× cheaper.
That is a real saving.

What travels in those prompts, though, is this specific household: lock states
and which doors are unlocked right now, presence for John and Sabrina, when the
house is empty, the Tesla's location, the home address as it appears in geocoded
sensor states, and 90 days of daily-pattern history the forensic tools pull in.
On the contributor tier that becomes training data. That is a one-way door —
data already sent cannot be recalled — which is the only reason it is worth a
paragraph rather than a footnote.

Both variants are the same model and the same code path here. If you want the
economics without the data usage, `muse-spark-1.3` is a one-word change in the
commands below. Your call; the gateway does not care which you pick.

---

## Switching

### 1. Set the secret

```powershell
wrangler secret put MODEL_API_KEY
```

Note the name: Meta's own docs call it `MODEL_API_KEY`, and the OpenAI SDK
looks for `OPENAI_API_KEY` by default, so it has to be passed explicitly. The
gateway resolves the right secret per provider, so both keys can coexist and
switching back to Fireworks needs no secret changes.

### 2. Prove it works before it touches the house

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  -X POST "https://ha-mcp-gateway.obert-john.workers.dev/admin/llm-selftest" `
  --data-binary "@candidate.json"
```

where `candidate.json` (UTF-8, no BOM) is:

```json
{ "provider": "meta", "model": "muse-spark-1.3-contributor" }
```

This sends one tiny request with one dummy tool through the **real**
`callLLMWithTools` path, using the candidate config **without storing it**. A
bad model never becomes the live default. It reports:

```json
{
  "ok": true,
  "elapsed_ms": 900,
  "config": { "provider": "meta", "api": "responses", "model": "...", "endpoint": "https://api.meta.ai/v1/responses" },
  "returned_text": "...",
  "tool_call_count": 1,
  "tool_call_shape_ok": true,
  "reasoning_returned": true,
  "reasoning_replay_items": 1,
  "usage": { "prompt_tokens": 120, "completion_tokens": 40, ... }
}
```

The three that matter: **`tool_call_shape_ok: true`** (tool calls round-trip in
the shape the loop expects), **`reasoning_replay_items` ≥ 1** (multi-round
reasoning replay will work), and **`ok: true`**. If any of those are wrong,
stop — the chat path would fail the same way, only against the live house.

A `GET` with no body runs the same probe against whatever is currently live.

### 3. Make it the live model

```json
{ "provider": "meta", "model": "muse-spark-1.3-contributor" }
```

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" access curl `
  -X POST "https://ha-mcp-gateway.obert-john.workers.dev/admin/llm-config" `
  --data-binary "@switch.json"
```

Only `provider` and `model` are needed. The wire format and endpoint follow the
provider automatically (`meta` → `responses` → `api.meta.ai/v1/responses`), and
so does the secret. Setting them by hand is how they drift apart.

### 4. Rolling back

```json
{ "reset": true }
```

Clears the override and returns to the baked default (Fireworks / GLM 5.3)
immediately, on the running isolate. Chat history survives, because history is
stored provider-neutral.

---

## Reasoning effort

Meta accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; Fireworks
accepts `none`, `low`, `medium`, `high`. The config takes the union and clamps
per provider at call time, narrowing to the nearest supported level rather than
silently disabling reasoning. So `xhigh` is honored on Meta and becomes `high`
on Fireworks.

Per the tier plan, Quick is `low` and High is `high`. To try Muse Spark's extra
headroom on forensic questions:

```json
{ "reasoning_effort": "xhigh" }
```

---

## Implementation notes worth knowing

- **`strict` defaults to true** on the Responses API, which demands a
  strict-mode JSON Schema (every property required, `additionalProperties:
  false`). The agent's 19 tool schemas have optional properties throughout, so
  the adapter sets `strict: false` explicitly. Without it every request is
  rejected on schema validation.
- **Reasoning replay.** The Responses API returns reasoning as its own output
  items carrying `encrypted_content`. Those items are passed back verbatim on
  later rounds of the same turn, ahead of the function calls they produced —
  the model needs its own prior reasoning to continue a tool chain coherently.
  Requests use `store: false` with `include: ["reasoning.encrypted_content"]`,
  so nothing is persisted on Meta's side and replay still works.
- **History stays clean.** Those encrypted blobs are stripped before the turn
  is written to `chat_history`: they are large, meaningful only within their own
  turn, and bound to the provider that issued them. Keeping them would bloat
  every later prompt and break a mid-conversation provider switch.
- **System prompt** goes in `instructions`, the Responses API's dedicated slot,
  which keeps the stable cached prefix intact.
- **`max_output_tokens`**, not `max_tokens`. Sending the chat-format name is a
  silent no-op that lets a reply run to the model's own ceiling.
- **Session affinity.** The `x-session-affinity` header is a Fireworks-specific
  routing hint for its replica-local prompt cache; it is not sent to Meta.
- **Perf headers.** `server_ttft_ms` / `server_total_ms` in `chat_timing_ms`
  come from `fireworks-*` response headers and will be absent on Meta. Token
  counts, iteration timings, and `total` are unaffected; Meta's
  `input_tokens_details.cached_tokens` still populates `total_cached_tokens`.
- **The legacy `callLLM` path** (iteration-ceiling synthesis) has no tools, so
  it always speaks Chat Completions. Under a `responses` config it targets the
  same provider's chat endpoint rather than posting a chat body to a responses
  URL.

## What has not been verified

The adapter is built against Meta's published Responses API schema and has unit
coverage for every translation step, including a full tool-calling round trip
(`test/llm-providers.test.js`, 39 cases). It has **not** been run against the
live Meta API, because that needs `MODEL_API_KEY`, which only you can set.

That is exactly what step 2 is for. Run the self-test first; it is one request
and it exercises the real code path.
