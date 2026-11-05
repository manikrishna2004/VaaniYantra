// Telephony audio codecs. Each provider streams a different wire format, so the
// realtime pipeline (Gemini Live in live.ts and the Deepgram→TTS cascade in the
// voice-server) is parameterised by a TelephonyCodec instead of hard-coding mulaw.
//
//   Twilio : mulaw / 8 kHz, 20 ms (160-byte) frames, camelCase `streamSid`.
//   Exotel : raw PCM16 / 8 kHz LE, chunks a multiple of 320 bytes (>= 3.2 KB),
//            snake_case `stream_sid`.
//   Plivo  : mulaw / 8 kHz (same audio as Twilio), but a different WS dialect —
//            inbound `start.streamId`, outbound `playAudio`/`clearAudio` frames.
//
// The pipeline always talks PCM16 internally (16 kHz into Gemini, 24 kHz out of
// it), so a codec only has to translate the wire format at the edges.

export type WireEncoding = 'mulaw' | 'linear16';

export interface TelephonyCodec {
  readonly provider: 'twilio' | 'exotel' | 'plivo' | 'mock';
  // Outbound WS message dialect. 'twilio' = `{event:'media'|'clear', <streamSid>}`
  // (Twilio + Exotel); 'plivo' = `{event:'playAudio'|'clearAudio'}`.
  readonly outboundDialect: 'twilio' | 'plivo';
  // How Deepgram STT and TTS should be told to encode telephony audio.
  readonly deepgramEncoding: WireEncoding;
  readonly ttsEncoding: WireEncoding;
  // Outbound media chunking, in bytes of wire audio.
  readonly frameBytes: number;
  // Wire-audio playback rate (bytes per second of real time), for estimating
  // how long queued outbound audio takes to actually play to the caller.
  readonly wireBytesPerSec: number;
  // Byte value that represents silence in the wire format (for padding a final
  // partial chunk up to the required alignment).
  readonly silenceByte: number;
  // Field name carrying the stream id in this provider's WS JSON.
  readonly streamSidField: 'streamSid' | 'stream_sid';
  // Inbound wire audio -> PCM16 16 kHz (what Gemini Live consumes).
  decodeToPcm16k(buf: Buffer): Buffer;
  // Gemini Live PCM16 24 kHz -> outbound wire audio.
  encodeFromPcm24k(pcm: Buffer): Buffer;
}

// ── Twilio: mulaw 8 kHz ──────────────────────────────────────────────────────

export const MULAW_CODEC: TelephonyCodec = {
  provider: 'twilio',
  outboundDialect: 'twilio',
  deepgramEncoding: 'mulaw',
  ttsEncoding: 'mulaw',
  frameBytes: 160, // 20 ms of mulaw/8k
  wireBytesPerSec: 8000, // mulaw/8k: 1 byte per sample
  silenceByte: 0xff, // mulaw silence
  streamSidField: 'streamSid',
  decodeToPcm16k: mulaw8kToPcm16k,
  encodeFromPcm24k: pcm24kToMulaw8k,
};

// ── Plivo: mulaw 8 kHz (same audio as Twilio, different WS dialect) ───────────

export const PLIVO_CODEC: TelephonyCodec = {
  provider: 'plivo',
  outboundDialect: 'plivo',
  deepgramEncoding: 'mulaw',
  ttsEncoding: 'mulaw',
  frameBytes: 160, // 20 ms of mulaw/8k
  wireBytesPerSec: 8000,
  silenceByte: 0xff,
  streamSidField: 'streamSid', // unused for the plivo dialect (uses streamId)
  decodeToPcm16k: mulaw8kToPcm16k,
  encodeFromPcm24k: pcm24kToMulaw8k,
};

// ── Exotel: raw PCM16 8 kHz LE ───────────────────────────────────────────────

export const PCM16_CODEC: TelephonyCodec = {
  provider: 'exotel',
  outboundDialect: 'twilio',
  deepgramEncoding: 'linear16',
  ttsEncoding: 'linear16',
  // Exotel wants outbound chunks that are a multiple of 320 bytes and >= 3.2 KB.
  // 3200 bytes = 200 ms of PCM16/8k, safely inside the 3.2 KB–100 KB window.
  frameBytes: 3200,
  wireBytesPerSec: 16000, // PCM16/8k: 2 bytes per sample
  silenceByte: 0x00, // PCM16 silence
  streamSidField: 'stream_sid',
  decodeToPcm16k: pcm8kToPcm16k,
  encodeFromPcm24k: pcm24kToPcm8k,
};

export function codecForProvider(provider: string): TelephonyCodec {
  if (provider === 'exotel') return PCM16_CODEC;
  if (provider === 'plivo') return PLIVO_CODEC;
  return MULAW_CODEC;
}

// ── Outbound WS message framing (provider dialect) ────────────────────────────
// Both realtime pipelines (live.ts + the voice-server cascade) send audio and
// barge-in "clear" frames back to the provider. Twilio/Exotel and Plivo speak
// different dialects; these builders keep that in one place.

export function buildMediaMessage(codec: TelephonyCodec, streamSid: string, payloadBase64: string): object {
  if (codec.outboundDialect === 'plivo') {
    // Plivo plays audio into the call leg; no streamId required on playAudio.
    return {
      event: 'playAudio',
      media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: payloadBase64 },
    };
  }
  const msg: any = { event: 'media', media: { payload: payloadBase64 } };
  msg[codec.streamSidField] = streamSid;
  return msg;
}

// Drop the provider's buffered/queued outbound audio (used on barge-in). Returns
// null when there's nothing to address (no stream id yet).
export function buildClearMessage(codec: TelephonyCodec, streamSid: string): object | null {
  if (codec.outboundDialect === 'plivo') {
    return streamSid ? { event: 'clearAudio', streamId: streamSid } : { event: 'clearAudio' };
  }
  if (!streamSid) return null;
  const msg: any = { event: 'clear' };
  msg[codec.streamSidField] = streamSid;
  return msg;
}

// ── Conversions ──────────────────────────────────────────────────────────────

// mulaw 8kHz -> PCM16 16kHz (decode mulaw, then 2x linear-interpolate upsample).
export function mulaw8kToPcm16k(mulaw: Buffer): Buffer {
  const n = mulaw.length;
  const out = Buffer.alloc(n * 2 * 2); // 2x samples, 2 bytes each
  let prev = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const s = mulawToLinear(mulaw[i]);
    const mid = (prev + s) >> 1;
    out.writeInt16LE(clamp16(mid), o);
    o += 2;
    out.writeInt16LE(clamp16(s), o);
    o += 2;
    prev = s;
  }
  return out;
}

// PCM16 24kHz -> mulaw 8kHz (average groups of 3 samples, then mulaw-encode).
export function pcm24kToMulaw8k(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const outLen = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const b = i * 3;
    const s =
      (pcm.readInt16LE(b * 2) + pcm.readInt16LE((b + 1) * 2) + pcm.readInt16LE((b + 2) * 2)) / 3;
    out[i] = linearToMulaw(s | 0);
  }
  return out;
}

// PCM16 8kHz -> PCM16 16kHz (2x linear-interpolate upsample).
export function pcm8kToPcm16k(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(inSamples * 2 * 2);
  let prev = 0;
  let o = 0;
  for (let i = 0; i < inSamples; i++) {
    const s = pcm.readInt16LE(i * 2);
    const mid = (prev + s) >> 1;
    out.writeInt16LE(clamp16(mid), o);
    o += 2;
    out.writeInt16LE(clamp16(s), o);
    o += 2;
    prev = s;
  }
  return out;
}

// PCM16 24kHz -> PCM16 8kHz (average groups of 3 samples = 3x downsample).
export function pcm24kToPcm8k(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const outLen = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    const b = i * 3;
    const s =
      (pcm.readInt16LE(b * 2) + pcm.readInt16LE((b + 1) * 2) + pcm.readInt16LE((b + 2) * 2)) / 3;
    out.writeInt16LE(clamp16(s | 0), i * 2);
  }
  return out;
}

// mulaw 8kHz -> PCM16 8kHz (decode only, no resample). Used to adapt TTS output
// (which every provider path emits as mulaw/8k) to Exotel's PCM16 wire format.
export function mulaw8kToPcm8k(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    out.writeInt16LE(clamp16(mulawToLinear(mulaw[i])), i * 2);
  }
  return out;
}

export function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

export function mulawToLinear(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

export function linearToMulaw(sample: number): number {
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

// ── Frame energy ────────────────────────────────────────────────────────────
// RMS amplitude of one wire frame, on a 0..1 scale, so callers can tell speech
// from silence without decoding a whole utterance. Lives here beside the codecs
// because "how loud is this frame" depends on how the frame is encoded — the
// cascade pipeline had its own private copies of both, which is why the Live
// pipeline had no way to reach them.

export function mulawEnergy(frame: Buffer): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const sample = mulawToLinear(frame[i]);
    sum += (sample / 32768) ** 2;
  }
  return Math.sqrt(sum / frame.length);
}

/** RMS energy for raw PCM16 LE frames (Exotel), on the same 0..1 scale. */
export function pcm16Energy(frame: Buffer): number {
  const n = Math.floor(frame.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const sample = frame.readInt16LE(i * 2);
    sum += (sample / 32768) ** 2;
  }
  return Math.sqrt(sum / n);
}

/** Energy of a frame in whatever encoding this codec puts on the wire. */
export function frameEnergy(codec: TelephonyCodec, frame: Buffer): number {
  return codec.deepgramEncoding === 'linear16' ? pcm16Energy(frame) : mulawEnergy(frame);
}
