// stt.js - all ElevenLabs STT (Scribe) + keyterm biasing in one place.

export const STT_CACHE_KEY = "ha:stt_keyterms";
export const STT_CACHE_TTL = 3600;

export const STT_KEYTERM_DOMAINS = new Set([
  "light", "switch", "lock", "cover", "climate", "scene", "script",
  "fan", "media_player", "input_boolean", "vacuum", "person"
]);

// Vocabulary the transcriber has no way to learn from entity names.
export const STT_FIXED_KEYTERMS = [
  "Ranger", "John", "Sabrina",
  "Tesla", "Model Y", "precondition", "sentry mode", "charge limit", "charge port",
  "garage", "main garage", "basement bay", "left basement", "garage entry",
  "back porch", "front door", "basement door", "basement porch", "deadbolt",
  "thermostat", "setpoint", "main level", "basement", "upstairs", "downstairs",
  "drop lights", "bedside lamp", "porch light", "dining room", "living room"
];

export const STT_KEYTERM_MAX = 1000;
export const STT_KEYTERM_MAXLEN = 50;

export const STT_CONFIG = {
  model_id: "scribe_v2",
  language_code: "eng",
  temperature: "0",
};

export function normalizeKeyterm(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 3 || t.length > STT_KEYTERM_MAXLEN) return null;
  if (!/[a-z]/i.test(t)) return null;
  if (/^[0-9a-f]{6,}$/i.test(t)) return null;
  if (t.includes("_") || t.includes(".")) return null;
  return t;
}

export function buildSTTKeytermsFromData(areas, states) {
  const terms = [];
  const seen = new Set();
  const push = (raw) => {
    const t = normalizeKeyterm(raw);
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    terms.push(t);
  };
  for (const t of STT_FIXED_KEYTERMS) push(t);
  try {
    if (Array.isArray(areas)) for (const a of areas) push(a && a.name);
  } catch {}
  try {
    if (Array.isArray(states)) {
      for (const s of states) {
        const id = s && s.entity_id;
        if (typeof id !== "string") continue;
        const domain = id.split(".")[0];
        if (!STT_KEYTERM_DOMAINS.has(domain)) continue;
        push(s.attributes && s.attributes.friendly_name);
      }
    }
  } catch {}
  return terms.slice(0, STT_KEYTERM_MAX);
}

export async function buildSTTKeyterms({ getAreas, getStates }) {
  let areas = null, states = null;
  try { areas = await getAreas(); } catch {}
  try { states = await getStates(); } catch {}
  return buildSTTKeytermsFromData(areas, states);
}

export async function refreshSTTKeyterms(env, deps) {
  const terms = await buildSTTKeyterms(deps);
  if (terms.length > 0) await deps.cacheSet(STT_CACHE_KEY, terms, STT_CACHE_TTL);
  return terms;
}

export async function handleTranscribe(request, env, ctx, deps) {
  const audioBlob = await request.blob();
  if (audioBlob.size === 0) {
    return new Response(JSON.stringify({ error: "Empty audio body" }), {
      status: 400, headers: { "Content-Type": "application/json" }
    });
  }
  const ct = (request.headers.get("Content-Type") || "audio/webm").toLowerCase();
  let filename = "audio.webm";
  if (ct.includes("mp4") || ct.includes("aac") || ct.includes("m4a")) filename = "audio.m4a";
  else if (ct.includes("mpeg")) filename = "audio.mp3";
  else if (ct.includes("wav")) filename = "audio.wav";
  else if (ct.includes("ogg")) filename = "audio.ogg";

  // Read-only from KV so a cold cache costs nothing on the voice critical path
  let keyterms = null;
  try { keyterms = await deps.cacheGet(STT_CACHE_KEY); } catch {}
  if (!Array.isArray(keyterms) || keyterms.length === 0) {
    keyterms = null;
    ctx.waitUntil(refreshSTTKeyterms(env, deps).catch(() => {}));
  }

  const buildForm = (withKeyterms) => {
    const form = new FormData();
    form.append("file", audioBlob, filename);
    form.append("model_id", STT_CONFIG.model_id);
    form.append("no_verbatim", "true");
    form.append("tag_audio_events", "false");
    form.append("language_code", STT_CONFIG.language_code);
    form.append("temperature", STT_CONFIG.temperature);
    if (withKeyterms && keyterms) form.append("keyterms", JSON.stringify(keyterms));
    return form;
  };

  const callScribe = (withKeyterms) => fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: buildForm(withKeyterms)
  });

  const sttStart = Date.now();
  let usedKeyterms = !!keyterms;
  let elevResp = await callScribe(usedKeyterms);
  let respText = await elevResp.text();
  if (!elevResp.ok && usedKeyterms && elevResp.status >= 400 && elevResp.status < 500) {
    console.warn("transcribe: keyterms rejected (" + elevResp.status + "), retrying without");
    usedKeyterms = false;
    elevResp = await callScribe(false);
    respText = await elevResp.text();
  }
  const sttMs = Date.now() - sttStart;

  if (!elevResp.ok) {
    return new Response(JSON.stringify({
      error: "ElevenLabs error",
      status: elevResp.status,
      body: respText.slice(0, 500),
      stt_ms: sttMs
    }), {
      status: 502, headers: { "Content-Type": "application/json" }
    });
  }
  let data;
  try { data = JSON.parse(respText); } catch { data = { text: respText }; }
  return new Response(JSON.stringify({
    text: data.text || "",
    language_code: data.language_code,
    stt_ms: sttMs,
    keyterms: usedKeyterms ? keyterms.length : 0
  }), {
    headers: {
      "Content-Type": "application/json",
      "Server-Timing": "elevenlabs;dur=" + sttMs
    }
  });
}
