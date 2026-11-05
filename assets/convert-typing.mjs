import { MPEGDecoder } from 'mpg123-decoder';
import fs from 'fs';

function linearToMulaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const TARGET_PEAK = 0.55; // normalize so it's clearly audible but not harsh; tunable

const dec = new MPEGDecoder();
await dec.ready;
const mp3 = fs.readFileSync('assets/typing.mp3');
const { channelData, samplesDecoded, sampleRate } = dec.decode(mp3);
const ch0 = channelData[0];
const ch1 = channelData[1] || channelData[0];
const mono = new Float32Array(samplesDecoded);
for (let i = 0; i < samplesDecoded; i++) mono[i] = (ch0[i] + ch1[i]) / 2;

// Resample sampleRate -> 8000 (linear interpolation; fine for ambience).
const ratio = sampleRate / 8000;
const outLen = Math.floor(samplesDecoded / ratio);
const out8 = new Float32Array(outLen);
for (let i = 0; i < outLen; i++) {
  const src = i * ratio, i0 = Math.floor(src), frac = src - i0;
  const a = mono[i0] || 0, b = mono[i0 + 1] !== undefined ? mono[i0 + 1] : a;
  out8[i] = a + (b - a) * frac;
}

let peak = 0;
for (const v of out8) peak = Math.max(peak, Math.abs(v));
const gain = peak > 0 ? TARGET_PEAK / peak : 1;

const ulaw = Buffer.alloc(outLen);
for (let i = 0; i < outLen; i++) {
  let s = Math.round(out8[i] * gain * 32767);
  s = Math.max(-32768, Math.min(32767, s));
  ulaw[i] = linearToMulaw(s);
}
fs.writeFileSync('assets/typing.ulaw', ulaw);
console.log(`decoded ${samplesDecoded} samples @${sampleRate}Hz, peak=${peak.toFixed(3)}, gain=${gain.toFixed(2)}`);
console.log(`wrote assets/typing.ulaw: ${outLen} samples @8kHz = ${(outLen / 8000).toFixed(2)}s, ${ulaw.length} bytes`);
dec.free();
