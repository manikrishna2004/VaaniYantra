/**
 * The whole phone line, on one port.
 *
 *   Twilio ──https──▶ POST /voice ──TwiML──▶ wss://…/media
 *   Exotel ─────────── Voicebot applet ─────▶ wss://…/exotel
 *                          caller audio ──▶ Gemini Live ──▶ caller
 *
 * Both providers' websockets, the answer webhook and the setup screen are all
 * served here, so there is one public URL to configure and one process to run.
 *
 *   node server.js        then open http://localhost:8080/setup
 */

import 'dotenv/config';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { applyToEnv, missingRequired } from './lib/config.js';
import { handleSetupApi } from './lib/setup-api.js';
import { providerFor, PROVIDERS, frameAudio } from './lib/providers.js';
import { LiveSession } from './lib/live.js';
import { calendarConfigured } from './connectors/calendar.js';
import { whatsappConfigured } from './connectors/whatsapp.js';
import { startCall, addTurn, endCall, recentCalls } from './connectors/store.js';

// Settings saved by the setup screen become environment variables before
// anything else reads them. A real environment variable still wins, so a
// deployed host's dashboard overrides the file.
applyToEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const publicUrl = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const activeProvider = () => providerFor(process.env.TELEPHONY_PROVIDER || 'twilio');

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * Did this request really come from the machine running the server?
 *
 * The obvious check — is the remote address 127.0.0.1 — is WRONG on its own,
 * and dangerously so. A tunnel like ngrok runs on this same machine and
 * forwards to localhost, so every request that arrives through it, from
 * anywhere on the internet, has a loopback remote address. Trusting that alone
 * publishes the setup screen and the call log to whoever has the tunnel URL.
 *
 * So three things must all hold:
 *
 *   1. The socket really is loopback.
 *   2. No proxy announced itself. Tunnels and reverse proxies add a forwarding
 *      header; a browser on this machine does not.
 *   3. The Host header is localhost. Through a tunnel this is the tunnel's own
 *      domain, which the visitor cannot change.
 *
 * Any one of those failing means "not local", because the cost of a false
 * "yes" is someone else's API keys and someone else's callers' phone numbers.
 */
function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;

  const proxyHeaders = [
    'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
    'forwarded', 'via', 'cf-connecting-ip', 'true-client-ip',
    'x-original-forwarded-for', 'ngrok-trace-id',
  ];
  if (proxyHeaders.some((h) => req.headers[h] !== undefined)) return false;

  const host = String(req.headers.host || '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  const isLocal = isLocalRequest(req);

  if (url.pathname === '/setup' || url.pathname.startsWith('/setup/')) {
    if (!isLocal) {
      res.writeHead(403, { 'content-type': 'text/plain' })
        .end('The setup screen is only available on the machine running the server.');
      return;
    }
    if (url.pathname === '/setup' || url.pathname === '/setup/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(readFileSync(join(HERE, 'setup', 'index.html')));
      return;
    }
    if (await handleSetupApi(req, res, url)) return;
    res.writeHead(404).end('not found');
    return;
  }

  // Twilio asks what to do when a call arrives. Exotel never does.
  if (req.method === 'POST' && url.pathname === '/voice') {
    const provider = activeProvider();
    if (!publicUrl()) {
      console.error('[http] PUBLIC_URL is not set — there is nowhere to stream to.');
      res.writeHead(500).end('PUBLIC_URL not configured');
      return;
    }
    const doc = provider.answerDocument(publicUrl());
    if (!doc) {
      res.writeHead(400).end(provider.label + ' does not use an answer webhook.');
      return;
    }
    res.writeHead(200, { 'content-type': doc.contentType }).end(doc.body);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/status') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/calls') {
    if (!isLocal) {
      // Call transcripts hold callers' names and numbers. Not for the internet.
      res.writeHead(403).end('local only');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(recentCalls(20), null, 2));
    return;
  }

  if (url.pathname === '/health') {
    const missing = missingRequired();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ok: true,
      kit: 'voice-agent-starter-kit',
      provider: activeProvider().key,
      model: process.env.GEMINI_LIVE_MODEL || null,
      calendar: calendarConfigured(),
      whatsapp: whatsappConfigured(),
      ready: missing.length === 0,
      missing,
    }));
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(302, { location: '/setup' }).end();
    return;
  }

  res.writeHead(404).end('not found');
});

// ── The audio bridge ────────────────────────────────────────────────────────
//
// One websocket endpoint per provider, because the path decides which dialect
// the messages are in. Both listen all the time, so switching provider in the
// setup screen takes effect on the next call with no restart.
//
// These are created with `noServer` and routed by hand. Handing two
// WebSocketServers the same http server with different `path` options does not
// work: each one installs its own upgrade listener, and the first to run
// rejects every path but its own with a 400 — so whichever provider was
// registered second could never connect at all.

const sockets = Object.fromEntries(
  Object.values(PROVIDERS).map((provider) => {
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (ws) => bridge(ws, provider));
    return [provider.wsPath, wss];
  }),
);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const wss = sockets[pathname];
  if (!wss) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function bridge(ws, provider) {
  let streamSid = null;
  let live = null;
  let ctx = { callSid: null, from: null };
  let speaking = false;
  let closing = false;

  // The model emits audio in whatever size it likes; the provider wants a
  // specific frame size. Hold the remainder between chunks rather than padding
  // every one, which would inject a click at each boundary.
  let outbox = Buffer.alloc(0);

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const sendToCaller = (pcm24k) => {
    speaking = true;
    outbox = Buffer.concat([outbox, provider.encodeFromPcm24k(pcm24k)]);
    while (outbox.length >= provider.frameBytes) {
      const frame = outbox.subarray(0, provider.frameBytes);
      outbox = outbox.subarray(provider.frameBytes);
      send(provider.mediaMessage(streamSid, frame.toString('base64')));
    }
  };

  /** Flush whatever the agent said that has not reached the caller's ear yet. */
  const stopSpeaking = () => {
    outbox = Buffer.alloc(0);
    speaking = false;
    if (streamSid) send(provider.clearMessage(streamSid));
  };

  const hangUp = () => {
    if (closing) return;
    closing = true;
    // Let the goodbye drain out of the provider's buffer first, or the caller
    // hears the agent vanish mid-word.
    const tail = frameAudio(provider, outbox);
    for (const frame of tail) send(provider.mediaMessage(streamSid, frame.toString('base64')));
    setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
    }, 1200);
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // both providers speak JSON; anything else is not for us
    }

    if (msg.event === 'connected') return; // Twilio's handshake, no payload

    if (msg.event === 'start') {
      const start = provider.readStart(msg);
      streamSid = start.streamSid;
      ctx = { callSid: start.callSid || streamSid, from: start.from };
      console.log('[call]', provider.label, 'call started', ctx.callSid, 'from', ctx.from || 'unknown');
      startCall({ callSid: ctx.callSid, from: ctx.from, to: start.to });

      live = new LiveSession({
        ctx,
        onAudio: sendToCaller,
        onInterrupt: stopSpeaking,
        onTranscript: (who, text) => {
          console.log('[' + who + ']', text);
          addTurn(ctx.callSid, who, text);
        },
        onHangUp: hangUp,
      });

      try {
        await live.connect();
      } catch (err) {
        console.error('[call] could not reach the model:', err.message);
        hangUp();
      }
      return;
    }

    if (msg.event === 'media' && live) {
      const wire = Buffer.from(msg.media.payload, 'base64');

      // Belt and braces over the model's own interruption detection: if the
      // caller is clearly talking while the agent is mid-sentence, cut the
      // agent now rather than waiting for the model to notice.
      if (speaking && provider.energy(wire) > Number(process.env.BARGE_THRESHOLD || 0.06)) {
        stopSpeaking();
      }

      live.sendAudio(provider.decodeToPcm16k(wire));
      return;
    }

    if (msg.event === 'stop') {
      console.log('[call] caller hung up', ctx.callSid);
      live?.close();
      if (ctx.callSid) endCall(ctx.callSid);
    }
  });

  ws.on('close', () => {
    live?.close();
    if (ctx.callSid) endCall(ctx.callSid);
  });

  ws.on('error', (err) => console.error('[ws]', err.message));
}

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const provider = activeProvider();
  const missing = missingRequired();
  const url = publicUrl();

  console.log('');
  console.log('  ' + (process.env.BUSINESS_NAME || 'Your business') + ' — voice agent');
  console.log('');
  console.log('  Set it up     http://localhost:' + PORT + '/setup');
  console.log('  Call log      http://localhost:' + PORT + '/calls');
  console.log('');

  if (missing.length) {
    console.log('  Not ready yet — ' + missing.length + ' setting(s) still needed.');
    console.log('  Open the setup page above and fill them in.');
  } else if (provider.usesAnswerWebhook) {
    console.log('  Point your ' + provider.label + ' number at:');
    console.log('    ' + url + '/voice');
  } else {
    console.log('  Point your ' + provider.label + ' Voicebot applet at:');
    console.log('    ' + url.replace(/^http/, 'ws') + provider.wsPath);
  }

  console.log('');
  console.log('  telephony  ' + provider.label);
  console.log('  calendar   ' + (calendarConfigured() ? 'connected' : 'off — the agent will take messages instead'));
  console.log('  whatsapp   ' + (whatsappConfigured() ? 'connected' : 'off — no confirmations will be sent'));
  console.log('');
});
