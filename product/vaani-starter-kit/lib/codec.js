/**
 * Audio plumbing between a phone line and the model.
 *
 * Phone networks are old and narrow. Twilio hands you 8kHz G.711 µ-law — one
 * byte per sample, logarithmically compressed. Gemini Live wants 16kHz signed
 * 16-bit PCM going in, and hands you 24kHz PCM coming back. Nothing lines up,
 * so every frame gets converted twice per call.
 *
 * These are the two conversions and the loudness meter that make barge-in work.
 */

/** G.711 µ-law byte -> signed 16-bit sample. */
export function mulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** Signed 16-bit sample -> G.711 µ-law byte. */
export function linearToMulaw(sample) {
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

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/**
 * Caller -> model. µ-law 8kHz to PCM16 16kHz.
 *
 * Doubling the rate needs a sample invented between every real pair. We use the
 * midpoint of the previous and current sample, which is cheap and good enough
 * at telephone bandwidth — there is nothing above 4kHz in the signal anyway.
 */
export function mulaw8kToPcm16k(mulaw) {
  const out = Buffer.alloc(mulaw.length * 4);
  let prev = 0;
  let o = 0;
  for (let i = 0; i < mulaw.length; i++) {
    const s = mulawToLinear(mulaw[i]);
    out.writeInt16LE(clamp16((prev + s) >> 1), o);
    o += 2;
    out.writeInt16LE(clamp16(s), o);
    o += 2;
    prev = s;
  }
  return out;
}

/**
 * Model -> caller. PCM16 24kHz to µ-law 8kHz.
 *
 * Exactly 3:1, so we average each group of three samples rather than dropping
 * two of them. Dropping is faster and sounds noticeably worse — it aliases
 * high-frequency content down into the voice band as a faint metallic buzz.
 */
export function pcm24kToMulaw8k(pcm) {
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

/**
 * How loud is this frame, 0..1.
 *
 * Used to notice the caller has started talking over the agent. Comparing
 * against a threshold is far cheaper than running speech detection, and at
 * 20ms per frame it is responsive enough to cut the agent off mid-word.
 */
export function mulawEnergy(frame) {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const sample = mulawToLinear(frame[i]) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
}

// ── Exotel's wire format ────────────────────────────────────────────────────
//
// Exotel does not use µ-law. It sends and expects raw signed 16-bit PCM at
// 8kHz, little-endian — twice the bytes for the same audio, and no logarithmic
// compression to undo. Same two jobs as above, different arithmetic.

/** Caller -> model. PCM16 8kHz to PCM16 16kHz. */
export function pcm8kToPcm16k(pcm) {
  const inSamples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(inSamples * 4);
  let prev = 0;
  let o = 0;
  for (let i = 0; i < inSamples; i++) {
    const s = pcm.readInt16LE(i * 2);
    out.writeInt16LE(clamp16((prev + s) >> 1), o);
    o += 2;
    out.writeInt16LE(clamp16(s), o);
    o += 2;
    prev = s;
  }
  return out;
}

/** Model -> caller. PCM16 24kHz to PCM16 8kHz, averaging each group of three. */
export function pcm24kToPcm8k(pcm) {
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

/** Loudness of a PCM16 frame, 0..1. The barge-in meter for Exotel. */
export function pcm16Energy(frame) {
  const samples = Math.floor(frame.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = frame.readInt16LE(i * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}
