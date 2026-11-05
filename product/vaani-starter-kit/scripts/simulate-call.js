/**
 * `npm run simulate` — hear your agent without owning a phone number.
 *
 * Pretends to be whichever provider you configured: opens the same websocket,
 * sends the same start message, and captures what the agent says back. The
 * result is written to greeting.wav, which you can play in anything.
 *
 * This is the fastest loop there is for tuning the prompt. Edit agent/prompt.md,
 * run this, listen. No tunnel, no phone number, no phone bill.
 *
 * Run `npm start` in another terminal first.
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { applyToEnv } from '../lib/config.js';
import { providerFor } from '../lib/providers.js';
import { mulawToLinear } from '../lib/codec.js';

applyToEnv();

const PORT = Number(process.env.PORT || 8080);
const SECONDS = Number(process.argv[2] || 12);
const provider = providerFor(process.env.TELEPHONY_PROVIDER || 'twilio');

console.log('Pretending to be ' + provider.label + ' on port ' + PORT + '…');
const ws = new WebSocket('ws://localhost:' + PORT + provider.wsPath);

const chunks = [];
let frames = 0;

ws.on('open', () => {
  console.log('Connected. Listening for ' + SECONDS + ' seconds.\n');

  const streamSid = 'SIMULATED';
  const callSid = 'SIM' + Date.now();
  const from = process.env.SIMULATED_CALLER || '+15550000000';

  // Each provider names these differently, so build the start message the same
  // way the real one would — otherwise the simulator tests a code path that
  // never runs in production.
  ws.send(JSON.stringify(
    provider.key === 'exotel'
      ? { event: 'start', stream_sid: streamSid, start: { stream_sid: streamSid, call_sid: callSid, from } }
      : { event: 'start', streamSid, start: { streamSid, callSid, customParameters: { from } } },
  ));

  // Real providers send a steady stream of frames whether or not anyone is
  // talking, and the model's silence detection expects that rhythm. Send
  // nothing and it waits forever for a turn that never ends.
  const silence = Buffer.alloc(provider.frameBytes, provider.silenceByte).toString('base64');
  const everyMs = provider.key === 'exotel' ? 200 : 20;
  const tick = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(provider.mediaMessage(streamSid, silence)));
    }
  }, everyMs);

  setTimeout(() => {
    clearInterval(tick);
    ws.send(JSON.stringify({ event: 'stop' }));
    ws.close();
  }, SECONDS * 1000);
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.event === 'media') {
    frames++;
    chunks.push(Buffer.from(msg.media.payload, 'base64'));
    process.stdout.write('.');
  }
  if (msg.event === 'clear') process.stdout.write('|');
});

ws.on('close', () => {
  console.log('\n');
  if (!chunks.length) {
    console.log('The agent said nothing.');
    console.log('');
    console.log('The server terminal says why. The two usual causes are:');
    console.log('  • No Gemini key saved yet.');
    console.log('  • The key is fine, but the Google project has no credits — the Live');
    console.log('    API is billed, so the session opens and closes straight away.');
    console.log('');
    console.log('Open http://localhost:' + PORT + '/setup and press "Test the AI key";');
    console.log('it opens a real session and tells you which of the two it is.');
    process.exit(1);
  }

  const audio = Buffer.concat(chunks);
  // Twilio's bytes are µ-law and need decoding; Exotel's are already PCM16.
  const pcm = provider.key === 'exotel' ? audio : decodeMulaw(audio);
  writeFileSync('greeting.wav', toWav(pcm));

  const seconds = pcm.length / 2 / 8000;
  console.log('Captured ' + frames + ' frames (' + seconds.toFixed(1) + 's of speech).');
  console.log('Written to greeting.wav — play it.');
});

ws.on('error', (err) => {
  console.error('\nCould not connect: ' + err.message);
  console.error('Is the server running? Start it with `npm start` in another terminal.');
  process.exit(1);
});

function decodeMulaw(mulaw) {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) pcm.writeInt16LE(mulawToLinear(mulaw[i]), i * 2);
  return pcm;
}

/** Wrap PCM16 8kHz mono in the smallest WAV header anything will play. */
function toWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);      // fmt chunk size
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // mono
  header.writeUInt32LE(8000, 24);    // sample rate
  header.writeUInt32LE(16000, 28);   // byte rate
  header.writeUInt16LE(2, 32);       // block align
  header.writeUInt16LE(16, 34);      // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
