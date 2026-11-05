// ── Lean standalone voice bridge (latency test rig) ─────────────────────────
//
// The MINIMUM possible code path: Twilio Media Streams <-> Gemini Live native
// speech-to-speech. No database, no Next.js, no campaigns, no RAG — just the
// audio bridge, so we can measure the latency floor on a dedicated VM with
// nothing else competing for CPU.
//
// Hardcoded to HYBRID TELUGU (English + తెలుగు code-switch).
//
// Run:  GEMINI_API_KEY=... node server.mjs
// Env (all optional):
//   PORT                     default 8080
//   GEMINI_LIVE_MODEL        default gemini-2.5-flash-native-audio-latest
//   GEMINI_LIVE_VOICE        default Aoede
//   GEMINI_LIVE_SILENCE_MS   default 300

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';

const PORT = parseInt(process.env.PORT || '8080', 10);
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest';
const VOICE = process.env.GEMINI_LIVE_VOICE || 'Aoede';
const SILENCE_MS = Number(process.env.GEMINI_LIVE_SILENCE_MS || 300);
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!API_KEY) {
  console.error('Set GEMINI_API_KEY');
  process.exit(1);
}

// Hardcoded persona + hybrid-Telugu language instruction (mirrors the platform's
// languageStyleInstruction('hybrid','te-IN')).
const SYSTEM_INSTRUCTION =
  `You are a warm, friendly voice assistant for a business, talking on a live phone call. ` +
  `Keep replies short and natural — one or two spoken sentences, then let the caller respond.\n\n` +
  `Language: speak in a natural, conversational mix of English and Telugu (తెలుగు) — code-switch ` +
  `the way bilingual Telugu speakers actually talk on the phone. Keep common English words in ` +
  `English; do not translate everything. Never announce that you are mixing languages.\n\n` +
  `Begin the call by greeting the caller warmly in this hybrid style and asking how you can help.`;

const ai = new GoogleGenAI({ apiKey: API_KEY });

// Wall-clock timestamp (HH:MM:SS.mmm) so we can read real gaps in the log.
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(stamp(), ...a);

// Event-loop lag monitor. If the e2-micro's CPU can't keep up with real-time
// audio transcoding, the loop drifts and THIS is the smoking gun for "lag".
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const drift = now - lastTick - 1000;
  if (drift > 120) log(`[loop] ⚠ event-loop lag ${drift}ms (CPU can't keep up)`);
  lastTick = now;
}, 1000);

// ── HTTP: health + Twilio voice webhook ─────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (url.pathname === '/api/telephony/twilio/voice' || url.pathname === '/voice') {
    // Twilio strips query params from <Stream url>, and Media Streams need wss.
    const host = req.headers.host ?? `localhost:${PORT}`;
    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<Response><Connect><Stream url="wss://${host}/twilio" /></Connect></Response>`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml);
  }
  res.writeHead(404).end('not found');
});

// ── WebSocket: Twilio media <-> Gemini Live ─────────────────────────────────
const wss = new WebSocketServer({ server, path: '/twilio' });

wss.on('connection', (ws) => {
  console.log('[ws] twilio connected');
  let streamSid = '';
  let session = null;
  let startedAt = Date.now();
  // Latency: timestamp of the caller's most recent inbound audio packet, and a
  // flag so we log the response gap once per turn.
  let mediaIn = 0;
  let mediaDropped = 0;
  // True turn-latency tracking.
  let lastInTranscriptMs = 0; // when the caller last produced transcription
  let awaitingResponse = false; // caller spoke; waiting for the agent's audio
  let respChunks = 0; // audio chunks in the current agent response
  let respFirstMs = 0; // when the current agent response's first audio arrived

  const ms = () => Date.now() - startedAt;

  const sendClear = () => {
    if (streamSid) ws.send(JSON.stringify({ event: 'clear', streamSid }));
  };

  const sendAudioToTwilio = (pcm24) => {
    const mulaw = pcm24kToMulaw8k(pcm24);
    for (let i = 0; i < mulaw.length; i += 160) {
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: mulaw.subarray(i, i + 160).toString('base64') },
        }),
      );
    }
  };

  const openLive = async () => {
    startedAt = Date.now();
    console.log('[live] connecting:', MODEL, 'voice:', VOICE, 'silenceMs:', SILENCE_MS);
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 50,
            silenceDurationMs: SILENCE_MS,
          },
        },
      },
      callbacks: {
        onopen: () => console.log('[live] gemini session open'),
        onmessage: (m) => onLiveMessage(m),
        onerror: (e) => console.error('[live] gemini error:', e?.message ?? e),
        onclose: () => console.log('[live] gemini session closed'),
      },
    });
    // Make the model greet first.
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: 'The call has connected. Greet the caller now.' }] }],
      turnComplete: true,
    });
  };

  const onLiveMessage = (m) => {
    if (m.setupComplete) console.log('[live] setupComplete');
    const sc = m.serverContent;
    if (!sc) {
      // Log any non-serverContent signals (toolCall, goAway, etc.) to diagnose.
      const keys = Object.keys(m).filter((k) => k !== 'serverContent');
      if (keys.length) console.log('[live] msg keys:', keys.join(','));
      return;
    }
    if (sc.interrupted) {
      log('[live] interrupted (barge-in)');
      sendClear();
    }

    // Caller speech transcription → mark that we're now awaiting a response.
    if (sc.inputTranscription?.text) {
      lastInTranscriptMs = Date.now();
      awaitingResponse = true;
    }

    const parts = sc.modelTurn?.parts ?? [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data) {
        if (awaitingResponse) {
          // TRUE turn latency: caller's last transcribed word → agent's first audio.
          log(`[latency] ⏱ agent audio started ${Date.now() - lastInTranscriptMs}ms after caller's last word`);
          awaitingResponse = false;
          respChunks = 0;
          respFirstMs = Date.now();
        }
        respChunks++;
        sendAudioToTwilio(Buffer.from(data, 'base64'));
      }
    }

    if (sc.generationComplete) log('[live] generationComplete');
    if (sc.turnComplete) {
      if (respChunks > 0) log(`[live] turnComplete — agent sent ${respChunks} chunks over ${Date.now() - respFirstMs}ms`);
      respChunks = 0;
    }
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case 'start':
        streamSid = msg.start?.streamSid ?? msg.streamSid ?? '';
        console.log('[ws] stream started', streamSid);
        void openLive();
        break;
      case 'media': {
        const payload = msg.media?.payload;
        if (payload && session) {
          mediaIn++;
          if (mediaIn % 250 === 0) log(`[ws] media in: ${mediaIn} packets (~${Math.round(mediaIn / 50)}s)`);
          try {
            const pcm16 = mulaw8kToPcm16k(Buffer.from(payload, 'base64'));
            session.sendRealtimeInput({
              media: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
            });
          } catch (err) {
            console.error('[ws] sendRealtimeInput failed:', err?.message ?? err);
          }
        } else if (payload && !session) {
          mediaDropped++;
          if (mediaDropped % 50 === 0) console.log(`[ws] media DROPPED (no session yet): ${mediaDropped}`);
        }
        break;
      }
      case 'stop':
        console.log('[ws] stream stopped');
        break;
    }
  });

  ws.on('close', () => {
    console.log('[ws] twilio closed, call duration', Math.round(ms() / 1000), 's');
    try {
      session?.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`[voice-test] http + ws listening on :${PORT}`);
  console.log(`[voice-test] Twilio voice webhook: /api/telephony/twilio/voice`);
  console.log(`[voice-test] hybrid Telugu · model ${MODEL} · voice ${VOICE} · silence ${SILENCE_MS}ms`);
});

// ── Audio conversion (mulaw 8k <-> PCM16 16k/24k) ───────────────────────────
function mulaw8kToPcm16k(mulaw) {
  const n = mulaw.length;
  const out = Buffer.alloc(n * 2 * 2);
  let prev = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const s = mulawToLinear(mulaw[i]);
    out.writeInt16LE(clamp16((prev + s) >> 1), o);
    o += 2;
    out.writeInt16LE(clamp16(s), o);
    o += 2;
    prev = s;
  }
  return out;
}

function pcm24kToMulaw8k(pcm) {
  const inSamples = Math.floor(pcm.length / 2);
  const outLen = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const b = i * 3;
    const s = (pcm.readInt16LE(b * 2) + pcm.readInt16LE((b + 1) * 2) + pcm.readInt16LE((b + 2) * 2)) / 3;
    out[i] = linearToMulaw(s | 0);
  }
  return out;
}

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

function mulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function linearToMulaw(sample) {
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
