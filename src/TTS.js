// tts.js - all ElevenLabs TTS in one place. Edit here, not worker.js.

export const TTS_CONFIG = {
  defaultVoiceId: "21m00Tcm4TlvDq8ikWAM", // Rachel - change me once
  model_id: "eleven_multilingual_v2",
  output_format: "mp3_44100_128",
  maxChars: 900,
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

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
  t = t.replace(/\b&\b/g, " and ");
  t = t.replace(/\+/g, " plus ");

  t = t.replace(/[#>*`_~|]/g, " ");
  t = t.replace(/[⚡✓✗▶▼▲•]/g, " ");
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

  // opts.voice or body.voice lets you audition: POST /tts { text, voice: "XYZ" }
  const voiceId = opts.voice || body.voice ||
    env.ELEVENLABS_VOICE_ID || TTS_CONFIG.defaultVoiceId;

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
          use_speaker_boost: TTS_CONFIG.use_speaker_boost
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
