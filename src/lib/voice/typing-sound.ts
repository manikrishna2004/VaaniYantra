// Keyboard-typing ambience as 8kHz mulaw (Twilio's audio format), streamed
// during the brief pause after the caller finishes and before the agent replies
// — making the agent sound like a person at a desk. Gated default-off (admin).
//
// Primary source is a real recording at `assets/typing.ulaw` (8kHz mono mulaw,
// pre-converted from assets/typing.mp3); if that file is missing we fall back to
// a synthesized loop. The live pipeline loops it in 20ms (160-byte) frames.

import fs from 'fs';
import path from 'path';

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

function clampI16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
}

function generate(): Buffer {
  const RATE = 8000;
  const total = RATE * 4; // 4 seconds, looped
  const pcm = new Int16Array(total); // silence between clicks

  let pos = Math.floor(RATE * 0.04);
  while (pos < total - 200) {
    // One keystroke: a short, fast-decaying noise burst at low (background) level.
    const clickLen = 50 + Math.floor(Math.random() * 70); // ~6-15ms
    const peak = 1500 + Math.random() * 1800; // subtle (~5-10% of full scale)
    const tau = clickLen * (0.16 + Math.random() * 0.12);
    for (let i = 0; i < clickLen && pos + i < total; i++) {
      const env = Math.exp(-i / tau);
      const noise = Math.random() * 2 - 1;
      pcm[pos + i] = clampI16(pcm[pos + i] + noise * peak * env);
    }
    // Irregular gap to the next key (60-210ms) — occasionally a longer pause.
    const gap = 0.06 + Math.random() * 0.15 + (Math.random() < 0.15 ? 0.2 : 0);
    pos += clickLen + Math.floor(RATE * gap);
  }

  const out = Buffer.alloc(total);
  for (let i = 0; i < total; i++) out[i] = linearToMulaw(pcm[i]);
  return out;
}

// Load the real recording if present (cwd is the project root for the
// voice-server), else synthesize. Cached for the process lifetime.
function load(): Buffer {
  const file = process.env.TYPING_SOUND_FILE || path.join(process.cwd(), 'assets', 'typing.ulaw');
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 160) {
      console.log(`[typing] loaded ${buf.length} bytes (${(buf.length / 8000).toFixed(1)}s) from ${file}`);
      return buf;
    }
  } catch {
    /* fall back to synthesized */
  }
  console.log('[typing] using synthesized fallback (no assets/typing.ulaw)');
  return generate();
}

// The looped mulaw buffer (cached for the process lifetime).
export const TYPING_MULAW_8K: Buffer = load();
export const TYPING_FRAME_BYTES = 160; // 20ms at 8kHz mulaw
