import { GoogleGenAI } from '@google/genai';
import { getSpeechProvider } from '@/lib/adapters/speech';
import type { OrgCredentials } from '@/lib/integrations';
import { mulaw8kToPcm8k, type WireEncoding } from '@/lib/voice/codec';

// Telephony TTS: returns RAW mulaw/8kHz audio (what Twilio Media Streams want).
//
// The provider is chosen per-AGENT (agent.voiceProvider), falling back to the
// TTS_PROVIDER env var, then to auto:
//   "google"   — Google Cloud TTS (built-in; all configured languages, ~300ms).
//   "deepgram" — Deepgram Aura (integration; English voices, ~200-400ms).
//   "gemini"   — Gemini expressive voices (integration; HIGH QUALITY but
//                ~5-6s PER SENTENCE — not ideal for real-time calls).
//   "elevenlabs" — ElevenLabs (integration; premium multilingual).
//   "auto"     — Deepgram for English when a key is configured, else Google.
//
// Integrations only work when their API key is configured; if a selected
// integration fails or is missing, we fall back to the built-in Google voice so
// the call never goes silent. All paths return mulaw/8kHz.

export async function synthesizeTelephony(
  text: string,
  languageCode: string,
  voiceId: string,
  voiceProvider?: string,
  creds?: OrgCredentials,
  encoding: WireEncoding = 'mulaw',
): Promise<Buffer> {
  const mulaw = await synthesizeMulaw(text, languageCode, voiceId, voiceProvider, creds);
  // Every provider path emits mulaw/8k (Twilio's format). For Exotel we adapt to
  // raw PCM16/8k here so callers get the wire format their transport expects.
  return encoding === 'linear16' ? mulaw8kToPcm8k(mulaw) : mulaw;
}

async function synthesizeMulaw(
  text: string,
  languageCode: string,
  voiceId: string,
  voiceProvider?: string,
  creds?: OrgCredentials,
): Promise<Buffer> {
  const provider = resolveProvider(languageCode, voiceProvider);
  try {
    if (provider === 'deepgram') return await deepgramTts(text, creds?.deepgram);
    if (provider === 'gemini') return await geminiTts(text, creds?.gemini);
    if (provider === 'elevenlabs') return await elevenLabsTts(text, voiceId, creds?.elevenlabs);
  } catch (err) {
    console.error(`[tts] ${provider} failed, falling back to Google Cloud TTS:`, err);
  }
  // Google Cloud TTS (or mock) — already mulaw/8kHz. Always available.
  const sp = getSpeechProvider();
  const r = await sp.synthesize({ text, languageCode, voiceId });
  return r.audio;
}

function resolveProvider(
  languageCode: string,
  agentProvider?: string,
): 'deepgram' | 'gemini' | 'google' | 'elevenlabs' {
  // Per-agent choice wins (Google is the built-in default).
  if (
    agentProvider === 'google' ||
    agentProvider === 'deepgram' ||
    agentProvider === 'gemini' ||
    agentProvider === 'elevenlabs'
  ) {
    return agentProvider;
  }
  const explicit = process.env.TTS_PROVIDER;
  if (
    explicit === 'deepgram' ||
    explicit === 'gemini' ||
    explicit === 'google' ||
    explicit === 'elevenlabs'
  ) {
    return explicit;
  }
  // auto: Deepgram Aura is English-only; use it for English, Google otherwise.
  const isEnglish = languageCode.toLowerCase().startsWith('en');
  if (isEnglish && process.env.DEEPGRAM_API_KEY) return 'deepgram';
  return 'google';
}

// ── Deepgram Aura (low latency, natural; English voices) ──────────────────
async function deepgramTts(text: string, key?: string): Promise<Buffer> {
  const apiKey = key || process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY required for Deepgram TTS');
  const model = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-thalia-en';
  const url = `https://api.deepgram.com/v1/speak?model=${model}&encoding=mulaw&sample_rate=8000`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Deepgram TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return Buffer.from(await res.arrayBuffer()); // raw mulaw/8kHz
}

// ── ElevenLabs (integration, premium multilingual) ────────────────────────
// Requests mulaw/8kHz directly so it drops straight into Twilio Media Streams.
async function elevenLabsTts(text: string, voiceId: string, key?: string): Promise<Buffer> {
  const apiKey = key || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY required for ElevenLabs TTS');
  // A Google voice id (e.g. "en-IN-Neural2-A") isn't an ElevenLabs voice; only
  // use voiceId when it looks like an ElevenLabs id, else the configured default.
  const voice =
    voiceId && /^[A-Za-z0-9]{20,}$/.test(voiceId)
      ? voiceId
      : process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const model = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=ulaw_8000`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return Buffer.from(await res.arrayBuffer()); // raw mulaw/8kHz
}

// ── Gemini expressive TTS (e.g. Callirrhoe) — high quality, high latency ──
let genai: GoogleGenAI | null = null;
function genaiClient(): GoogleGenAI {
  if (!genai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY required for Gemini TTS');
    genai = new GoogleGenAI({ apiKey });
  }
  return genai;
}

async function geminiTts(text: string, key?: string): Promise<Buffer> {
  const model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
  const voice = process.env.GEMINI_TTS_VOICE || 'Callirrhoe';
  const style =
    process.env.GEMINI_TTS_STYLE ||
    'Say this in a warm, friendly, natural conversational tone:';

  const client = key ? new GoogleGenAI({ apiKey: key }) : genaiClient();
  const res = await client.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: `${style} ${text}` }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const data = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!data) throw new Error('Gemini TTS returned no audio');
  return pcm24ToMulaw8k(Buffer.from(data, 'base64')); // L16 24kHz -> mulaw 8kHz
}

// Downsample 24kHz PCM16 -> 8kHz (average each group of 3) and encode to mulaw.
function pcm24ToMulaw8k(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const outLen = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const base = i * 3;
    const s =
      (pcm.readInt16LE(base * 2) +
        pcm.readInt16LE((base + 1) * 2) +
        pcm.readInt16LE((base + 2) * 2)) /
      3;
    out[i] = linearToMulaw(s | 0);
  }
  return out;
}

function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
