// tts.js - all ElevenLabs TTS in one place. Edit here, not worker.js.

export const TTS_CONFIG = {
  defaultVoiceId: "21m00Tcm4TlvDq8ikWAM", // Rachel - change me once
  model_id: "eleven_flash_v2_5",
  output_format: "mp3_22050_32",
  maxChars: 900,
  speed: 1.0, // 1.0 = natural pace; < 1.0 slower, > 1.0 faster (ElevenLabs)
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

// ElevenLabs working range for eleven_flash_v2_5: 0.7 = 30% slower,
// 1.2 = 20% faster. Values outside it are rejected by the API.
export const TTS_SPEED_MIN = 0.7;
export const TTS_SPEED_MAX = 1.2;

// Resolution order: per-request body.speed → env.ELEVENLABS_VOICE_SPEED →
// TTS_CONFIG.speed. Out-of-range values clamp and unparseable values fall
// back so a bad secret can never 4xx a spoken reply.
export function resolveVoiceSpeed(body = {}, env = {}) {
  const raw = body.speed !== undefined ? body.speed : env.ELEVENLABS_VOICE_SPEED;
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return TTS_CONFIG.speed;
  return Math.round(Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, n)) * 100) / 100;
}

export function cleanForSpeech(s) {
  if (!s) return "";
  let t = " " + String(s) + " ";
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1");           // **bold** -> bold
  t = t.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");  // [label](url) -> label
  t = t.replace(/https?:\/\/\S+/g, " ");           // urls -> silence

  // spoken expansions - BEFORE symbol stripping
  t = t.replace(/°\s*F\b/gi, " degrees Fahrenheit ");
  t = t.replace(/°\s*C\b/gi, " degrees Celsius ");
  t = t.replace(/°/g, " degrees ");
  t = t.replace(/(\d)\s*%/g, "$1 percent ");
  t = t.replace(/\s*&\s*/g, " and ");
  t = t.replace(/\+/g, " plus ");
  // expansions above can strand a space before sentence punctuation
  t = t.replace(/\s+([.,!?;:])/g, "$1");

  t = t.replace(/[#>*`_~|]/g, " ");
  t = t.replace(/[⚡✓✗▶▼▲•]/g, " ");
  // emoji, pictographs, arrows, box-drawing - silence, not "emoji face"
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2500}-\u{25FF}\u{FE0F}\u{200D}]/gu, " ");
  // entity ids read terribly aloud - say object name instead
  t = t.replace(/\b[a-z_]{3,}\.[a-z0-9_]{3,}\b/g, (m) => m.split(".")[1].replace(/_/g, " "));
  t = t.replace(/\n\s*[-0-9]+\.?\s*/g, ". ");
  t = t.replace(/\n+/g, ". ");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > TTS_CONFIG.maxChars) {
    const cut = t.slice(0, TTS_CONFIG.maxChars);
    const dot = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = dot > 200 ? cut.slice(0, dot + 1) : cut;
  }
  return t;
}

export async function handleTTS(request, env, opts = {}) {
  let body;
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  let text = cleanForSpeech(body.text || "").slice(0, 1000);
  if (!text) return new Response('empty', { status: 400 });

  const voiceId = opts.voice || body.voice ||
    env.ELEVENLABS_VOICE_ID || TTS_CONFIG.defaultVoiceId;
  const speed = resolveVoiceSpeed(body, env);

  const elevResp = await fetch(
    "https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId) + "?output_format=" + TTS_CONFIG.output_format,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text: text,
        model_id: TTS_CONFIG.model_id,
        voice_settings: {
          stability: TTS_CONFIG.stability,
          similarity_boost: TTS_CONFIG.similarity_boost,
          style: TTS_CONFIG.style,
          use_speaker_boost: TTS_CONFIG.use_speaker_boost,
          speed
        }
      })
    }
  );

  if (!elevResp.ok || !elevResp.body) {
    const detail = await elevResp.text().catch(() => "");
    return new Response(JSON.stringify({
      error: "ElevenLabs TTS error",
      detail: detail.slice(0, 500)
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const audioBuf = await elevResp.arrayBuffer();
  return new Response(audioBuf, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" }
  });
}
