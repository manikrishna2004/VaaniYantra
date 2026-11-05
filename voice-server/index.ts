/**
 * VaaniYantra — realtime voice/media server (single public endpoint).
 *
 * Serves BOTH on one port (8080):
 *   • HTTP  POST /api/telephony/twilio/voice   → returns TwiML that bridges the
 *                                                call to the media WebSocket
 *           POST /api/telephony/twilio/status  → call lifecycle updates
 *   • WS    /twilio                            → Twilio Media Stream (audio)
 *
 *   Twilio ──https──▶ /api/telephony/twilio/voice ──TwiML──▶ wss /twilio
 *                         caller audio ─▶ STT ─▶ Gemini ─▶ TTS ─▶ caller
 *
 * Because everything Twilio needs lives on this one port, you only need a
 * single public tunnel (ngrok → 8080). The Next.js dashboard runs locally and
 * doesn't need to be exposed.
 *
 * Run with: `npm run voice-server`.
 */
import 'dotenv/config';
// The @google/genai SDK prefers a GOOGLE_API_KEY env var over the key we pass
// explicitly. A stray system-level GOOGLE_API_KEY would silently override our
// configured key — force it to the .env GEMINI_API_KEY so we always use the
// intended project.
if (process.env.GEMINI_API_KEY) process.env.GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
import http from 'http';
import { parse as parseQuery } from 'querystring';
import { WebSocketServer, WebSocket } from 'ws';
import { prisma } from '@/lib/db';
import { getSpeechProvider } from '@/lib/adapters/speech';
import { getTelephonyProvider } from '@/lib/adapters/telephony';
import {
  generateAgentTurnStreaming,
  recordTurn,
  summarizeCall,
} from '@/lib/voice/conversation';
import { synthesizeTelephony } from '@/lib/voice/tts';
import { openDeepgram, type DeepgramLive } from '@/lib/voice/deepgram';
import { LiveCallSession } from '@/lib/voice/live';
import { codecForProvider, buildMediaMessage, buildClearMessage, frameEnergy, type TelephonyCodec } from '@/lib/voice/codec';
import { resolveInboundCall, refuseInboundOverLimit } from '@/lib/voice/inbound';
import { fillProviderDuration } from '@/lib/calls/provider-duration';
import { orgStatusForWorkspace, canUseService } from '@/lib/org-status';
import { detectRedFlag, emergencySpokenReply, raiseVoiceEmergency } from '@/lib/voice/emergency';
import { candidatePlivoTokens, verifyPlivoSignature } from '@/lib/plivo-signature';
import { verifyCallbackToken } from '@/lib/webhook-token';
import { reportConfig } from '@/lib/config/env';
import { languageForCaller } from '@/lib/constants';
import {
  isWithinBusinessHours,
  applyVariables,
  matchesTransferTrigger,
  voiceForStage,
  isClosingSentence,
  type VoiceStage,
} from '@/lib/agent-behavior';
import { getOrgCredentials, type OrgCredentials } from '@/lib/integrations';
import {
  candidateTwilioTokens,
  publicUrlFromHeaders,
  verifyTwilioSignature,
} from '@/lib/telephony-signature';
import { finalizeCallRecord } from '@/lib/voice/finalize';
import { startReminderDispatcher } from '@/lib/reminder-dispatcher';
import { startRetentionSweeper } from '@/lib/retention';
import { startStaleCallSweeper } from '@/lib/calls/stale';
import { dispatchCallEvent } from '@/lib/webhooks';
import { pushCallToCrm } from '@/lib/crm';
import type { ChatMessage } from '@/lib/adapters/llm';
import type { Agent } from '@prisma/client';

const PORT = parseInt(process.env.VOICE_WS_PORT || '8080', 10);

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error('[voice-server] http error', err);
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
  });
});

const wss = new WebSocketServer({ noServer: true });

// Upgrade the /twilio (Twilio Media Streams), /exotel (Exotel Voicebot) and
// /plivo (Plivo AudioStream) paths to a media WebSocket.
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '', 'http://localhost');
  console.log('[voice-server] WS upgrade request:', req.url, 'host:', req.headers.host);
  if (pathname.endsWith('/twilio') || pathname.endsWith('/exotel') || pathname.endsWith('/plivo')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    console.log('[voice-server] rejecting upgrade for path', pathname);
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  // callId arrives in the provider "start" event (Twilio custom parameter, or
  // Exotel start metadata), not the URL. We accept the connection and resolve it
  // there. The query is kept only as a fallback for non-provider clients/tests.
  const url = new URL(req.url ?? '', 'http://localhost');
  const queryCallId = url.searchParams.get('callId');
  const provider: 'twilio' | 'exotel' | 'plivo' = url.pathname.endsWith('/exotel')
    ? 'exotel'
    : url.pathname.endsWith('/plivo')
      ? 'plivo'
      : 'twilio';
  console.log('[voice-server] WS CONNECTED, provider:', provider, '(callId resolved on start)');
  ws.on('error', (e) => console.error('[voice-server] ws error:', e.message));
  // Liveness. A carrier leg that dies without a FIN — routine behind mobile NAT
  // — leaves this socket half-open: 'close' never fires, so the call is never
  // finalized and its Gemini session is never shut, which means it keeps
  // billing. The heartbeat below terminates a peer that stops answering, and
  // terminate() does fire 'close'.
  (ws as any).isAlive = true;
  ws.on('pong', () => {
    (ws as any).isAlive = true;
  });
  ws.on('close', (code, reason) =>
    console.log('[voice-server] ws closed:', code, reason.toString()),
  );
  // USE_GEMINI_LIVE=true → realtime speech-to-speech pipeline (one Gemini Live
  // session). Otherwise the cascade pipeline (Deepgram STT → Gemini → TTS).
  if (process.env.USE_GEMINI_LIVE === 'true') {
    console.log('[voice-server] using Gemini Live realtime pipeline');
    void new LiveCallSession(ws, queryCallId, provider).run();
  } else {
    void new CallSession(ws, queryCallId, provider).run();
  }
});

// One ping cycle for every media socket. A peer that misses a whole cycle is
// gone, whatever its socket claims — terminate() then fires 'close', which is
// what runs finalize() and shuts the model session.
const HEARTBEAT_MS = Number(process.env.VOICE_WS_HEARTBEAT_MS) || 15_000;
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if ((client as any).isAlive === false) {
      console.warn('[voice-server] media socket missed a heartbeat — terminating');
      client.terminate();
      continue;
    }
    (client as any).isAlive = false;
    try {
      client.ping();
    } catch {
      /* socket already going away */
    }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

// ── Process-level crash guard ─────────────────────────────────────────────
// This is a single process serving every concurrent call for every org, so
// Node's default behaviour for an unhandled rejection — exit(1) — takes all of
// them down at once. pm2 restarts us, which historically left a restart count
// as the only evidence. Log loudly and stay up; a voided promise somewhere in a
// call's fan-out must never be able to hang up on everyone else.
process.on('unhandledRejection', (reason) => {
  console.error('[voice-server] UNHANDLED REJECTION — staying up:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[voice-server] UNCAUGHT EXCEPTION — staying up:', err);
});

// Set once the background jobs below are running. /health reports it, so a
// half-alive server — answering HTTP but no longer sending reminders — reads as
// unhealthy instead of green.
let dispatchersStarted = false;

// GET /health — the deploy gate (scripts/deploy.sh) and any uptime monitor poll
// this. It used to return a literal "ok" without checking anything, so it
// stayed green through an outage in which no call could be answered. It now
// costs a DB round-trip and means something.
async function healthProbe(res: http.ServerResponse) {
  const send = (code: number, payload: Record<string, unknown>) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(payload));
  };
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db health check timed out')), 3000)),
    ]);
  } catch {
    return send(503, { ok: false, db: 'down' });
  }
  if (!dispatchersStarted) return send(503, { ok: false, db: 'up', dispatchers: 'not started' });
  return send(200, {
    ok: true,
    db: 'up',
    dispatchers: 'running',
    uptimeSec: Math.round(process.uptime()),
  });
}

server.listen(PORT, () => {
  console.log(`[voice-server] http + ws listening on :${PORT}`);
  console.log(`[voice-server] Twilio webhook path: /api/telephony/twilio/voice`);
  // Validate configuration loudly at boot (F-1.1/F-4.6). In production an
  // error-level problem (e.g. missing PUBLIC_BASE_URL → webhooks misrouted) is
  // logged; we don't hard-exit so an already-answered call isn't dropped, but
  // the operator sees it immediately in pm2 logs.
  if (!reportConfig()) {
    console.error('[voice-server] configuration has error-level problems — see [config] lines above');
  }
  // Send appointment reminders (24h + 1h before).
  startReminderDispatcher();
  // Purge call content past each org's data-retention window.
  startRetentionSweeper();
  // Close out calls whose end signal was lost (this process dying mid-call is
  // the usual cause, so the boot sweep cleans up after the crash that just
  // happened). Without it they showed as live forever.
  startStaleCallSweeper();
  dispatchersStarted = true;
});

// ── HTTP (Twilio webhooks) ────────────────────────────────────────────────

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '', 'http://localhost');
  switch (url.pathname) {
    case '/health':
      return healthProbe(res);
    case '/api/telephony/twilio/voice':
      return voiceWebhook(req, res, url);
    case '/api/telephony/twilio/status':
      return statusWebhook(req, res, url);
    case '/api/telephony/plivo/voice':
      return plivoVoiceWebhook(req, res, url);
    case '/api/telephony/plivo/status':
      return plivoStatusWebhook(req, res, url);
    case '/api/telephony/plivo/transfer':
      return plivoTransferDocument(req, res, url);
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
  }
}

function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(parseQuery(data) as Record<string, string>));
    req.on('error', () => resolve({}));
  });
}

// Reject Twilio webhooks that don't carry a valid X-Twilio-Signature (signed
// with the platform token or the BYO account owning the number/call).
async function rejectUnlessSigned(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  form: Record<string, string>,
): Promise<boolean> {
  const tokens = await candidateTwilioTokens({ to: form.To, callId: url.searchParams.get('callId') });
  const publicUrl = publicUrlFromHeaders(
    { host: req.headers.host, forwardedProto: req.headers['x-forwarded-proto'] },
    req.url ?? '',
  );
  const ok = verifyTwilioSignature({
    authTokens: tokens,
    url: publicUrl,
    params: form,
    signature: req.headers['x-twilio-signature'] as string | undefined,
  });
  if (!ok) {
    console.error('[voice-server] rejected Twilio webhook with missing/invalid signature:', publicUrl);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return true;
  }
  return false;
}

// Answer webhook: hit when an inbound call arrives or an outbound call we placed
// is answered. Returns TwiML that connects the audio to this server's /twilio WS.
async function voiceWebhook(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const form = await readForm(req);
  if (await rejectUnlessSigned(req, res, url, form)) return;
  const callSid = form.CallSid;
  const from = form.From || 'unknown';
  const to = form.To || 'unknown';

  let callId = url.searchParams.get('callId') || undefined;

  if (!callId) {
    // Inbound: resolve the dialed number -> its agent. A number without an
    // agent is politely rejected — never routed to another tenant's agent.
    const number = await prisma.phoneNumber.findUnique({
      where: { e164: to },
      include: { agent: true },
    });
    const agent = number?.agent ?? null;
    const agentId = number?.agentId ?? null;
    const language = number?.agent?.language ?? 'en-IN';

    if (!agentId) {
      await prisma.call.create({
        data: {
          workspaceId: number?.workspaceId ?? null,
          userId: number?.userId ?? null,
          phoneNumberId: number?.id ?? null,
          direction: 'INBOUND',
          status: 'COMPLETED',
          fromNumber: from,
          toNumber: to,
          providerSid: callSid,
          startedAt: new Date(),
          endedAt: new Date(),
          endedReason: 'no_agent',
        },
      }).catch((e) => console.error('[voice-server] no-agent call log failed', e));
      console.error('[voice-server] inbound call to', to, 'has no assigned agent — rejecting');
      const twiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say>Sorry, this number is not set up to take calls yet. Goodbye.</Say><Hangup/></Response>';
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml);
    }

    // A paused or deactivated org does not answer its phone. This webhook
    // resolves the number itself instead of going through resolveInboundCall,
    // so the gate has to be repeated here or pausing an org would stop Exotel
    // inbound and quietly leave Twilio inbound running.
    const orgState = await orgStatusForWorkspace(number?.workspaceId);
    if (orgState && !canUseService(orgState.status)) {
      await prisma.call.create({
        data: {
          workspaceId: number?.workspaceId ?? null,
          userId: number?.userId ?? null,
          agentId,
          phoneNumberId: number?.id ?? null,
          direction: 'INBOUND',
          status: 'COMPLETED',
          fromNumber: from,
          toNumber: to,
          providerSid: callSid,
          language,
          startedAt: new Date(),
          endedAt: new Date(),
          endedReason: `account_${orgState.status.toLowerCase()}`,
        },
      }).catch((e) => console.error('[voice-server] suspended-account call log failed', e));
      console.error('[voice-server] inbound call to', to, '— account', orgState.status);
      const twiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say>Sorry, this number is not accepting calls right now. Goodbye.</Say><Hangup/></Response>';
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml);
    }

    // Out of plan minutes. Same gate as the Exotel path in resolveInboundCall,
    // repeated here for the same reason the account gate above is: this webhook
    // never goes through it.
    if (
      orgState &&
      (await refuseInboundOverLimit({
        orgId: orgState.orgId,
        workspaceId: number?.workspaceId ?? null,
        userId: number?.userId ?? null,
        agentId,
        phoneNumberId: number?.id ?? null,
        from,
        to,
        providerSid: callSid,
        language,
      }))
    ) {
      const overTwiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say>Sorry, this number is not accepting calls right now. Goodbye.</Say><Hangup/></Response>';
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(overTwiml);
    }

    // Inbound routing rules (only for numbers we manage in the DB).
    if (number && !number.inboundEnabled) {
      await prisma.call.create({
        data: {
          workspaceId: number.workspaceId,
          userId: number.userId,
          phoneNumberId: number.id,
          direction: 'INBOUND',
          status: 'COMPLETED',
          fromNumber: from,
          toNumber: to,
          providerSid: callSid,
          startedAt: new Date(),
          endedAt: new Date(),
          endedReason: 'inbound_disabled',
        },
      });
      const twiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say>Sorry, this number is not accepting calls right now. Goodbye.</Say><Hangup/></Response>';
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml);
    }

    // Call forwarding: hand the inbound call straight to another number (a human
    // / call center) instead of the AI agent. Takes precedence over the agent.
    if (number?.forwardTo) {
      await prisma.call.create({
        data: {
          workspaceId: number.workspaceId,
          userId: number.userId,
          agentId,
          phoneNumberId: number.id,
          direction: 'INBOUND',
          status: 'COMPLETED',
          fromNumber: from,
          toNumber: to,
          providerSid: callSid,
          language,
          startedAt: new Date(),
          endedAt: new Date(),
          endedReason: 'forwarded',
          summary: `Forwarded to ${number.forwardTo}`,
        },
      });
      const twiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<Response><Dial>${escapeXml(number.forwardTo)}</Dial></Response>`;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml);
    }

    // Business hours: if this agent is closed right now, greet with the
    // after-hours message and hang up instead of bridging to the voice engine.
    if (agent && !isWithinBusinessHours(agent.businessHours)) {
      const msg =
        applyVariables(agent.afterHoursMessage?.trim() || '', agent.variables) ||
        "Sorry, you've reached us outside our business hours. Please call back during working hours. Goodbye.";
      await prisma.call.create({
        data: {
          workspaceId: number?.workspaceId ?? null,
          userId: number?.userId ?? null,
          agentId,
          phoneNumberId: number?.id ?? null,
          direction: 'INBOUND',
          status: 'COMPLETED',
          fromNumber: from,
          toNumber: to,
          providerSid: callSid,
          language,
          startedAt: new Date(),
          endedAt: new Date(),
          endedReason: 'after_hours',
        },
      });
      const twiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<Response><Say>${escapeXml(msg)}</Say><Hangup/></Response>`;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(twiml);
    }

    const call = await prisma.call.create({
      data: {
        workspaceId: number?.workspaceId ?? null,
        userId: number?.userId ?? null,
        agentId,
        phoneNumberId: number?.id ?? null,
        direction: 'INBOUND',
        status: 'IN_PROGRESS',
        fromNumber: from,
        toNumber: to,
        providerSid: callSid,
        language,
        startedAt: new Date(),
      },
    });
    callId = call.id;
  } else if (callSid) {
    await prisma.call
      .update({
        where: { id: callId },
        data: { status: 'IN_PROGRESS', providerSid: callSid, startedAt: new Date() },
      })
      .catch(() => {});
  }

  // Build the media-stream URL from the public host Twilio reached us on, so it
  // automatically matches the ngrok domain. Twilio Media Streams require wss.
  // NOTE: Twilio strips query params from the Stream URL, so the callId is
  // passed as a <Parameter> — it arrives in the WS "start" event's
  // start.customParameters.callId.
  const host = req.headers.host ?? `localhost:${PORT}`;
  const streamUrl = `wss://${host}/twilio`;
  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Connect>' +
    `<Stream url="${streamUrl}">` +
    `<Parameter name="callId" value="${callId}" />` +
    '</Stream>' +
    '</Connect></Response>';

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml);
}

async function statusWebhook(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const form = await readForm(req);
  if (await rejectUnlessSigned(req, res, url, form)) return;
  const callId = url.searchParams.get('callId');
  if (callId) {
    const map: Record<string, string> = {
      queued: 'QUEUED',
      ringing: 'RINGING',
      'in-progress': 'IN_PROGRESS',
      completed: 'COMPLETED',
      busy: 'BUSY',
      'no-answer': 'NO_ANSWER',
      failed: 'FAILED',
      canceled: 'FAILED',
    };
    const status = map[form.CallStatus];
    const duration = parseInt(form.CallDuration || '0', 10);
    if (!status) {
      // Unknown/new Twilio status — never guess (guessing IN_PROGRESS used to
      // resurrect completed calls).
      console.warn('[voice-server] ignoring unknown Twilio CallStatus:', form.CallStatus);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    const terminal = ['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'];
    // A non-terminal update must never overwrite a call that already ended
    // (status callbacks can arrive out of order) — hence updateMany with a
    // status filter for the non-terminal case.
    await prisma.call
      .updateMany({
        where: terminal.includes(status)
          ? { id: callId }
          : { id: callId, status: { notIn: terminal } },
        data: {
          status,
          ...(terminal.includes(status)
            ? { endedAt: new Date(), endedReason: form.CallStatus }
            : {}),
        },
      })
      // Twilio does not retry status callbacks, so a swallowed failure here
      // silently loses the call's end state and its billable duration.
      .catch((err) => console.error('[twilio-status] update failed', { callId }, err));
    await fillProviderDuration(callId, duration);
    // A call that ended without connecting fires call.failed (call.completed is
    // dispatched from the media-session finalize once a conversation happened).
    if (['FAILED', 'NO_ANSWER', 'BUSY'].includes(status)) {
      void dispatchCallEvent(callId, 'call.failed');
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}

// ── Plivo webhooks (answer / status / transfer) ───────────────────────────

// Normalise a Plivo webhook number (often digits-only) to +E.164.
function plivoE164(n: string | undefined): string {
  if (!n || n === 'unknown') return n || 'unknown';
  return n.startsWith('+') ? n : '+' + n.replace(/\D/g, '');
}

// Reject Plivo webhooks that fail signature validation (default-off — see
// plivo-signature.ts). Returns true when the request was rejected.
async function rejectUnlessPlivoSigned(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  form: Record<string, string>,
): Promise<boolean> {
  const tokens = await candidatePlivoTokens({ to: form.To, callId: url.searchParams.get('callId') });
  const publicUrl = publicUrlFromHeaders(
    { host: req.headers.host, forwardedProto: req.headers['x-forwarded-proto'] },
    req.url ?? '',
  );
  const ok = verifyPlivoSignature({
    authTokens: tokens,
    url: publicUrl,
    nonce: req.headers['x-plivo-signature-v3-nonce'] as string | undefined,
    signature: req.headers['x-plivo-signature-v3'] as string | undefined,
  });
  if (!ok) {
    console.error('[voice-server] rejected Plivo webhook with missing/invalid signature:', publicUrl);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return true;
  }
  return false;
}

// Plivo streaming XML that bridges the call leg to our /plivo media WebSocket.
function plivoStreamXml(host: string, callId: string): string {
  const streamUrl = `wss://${host}/plivo?callId=${encodeURIComponent(callId)}`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    '<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">' +
    escapeXml(streamUrl) +
    '</Stream>' +
    '</Response>'
  );
}

function plivoSpeakHangup(msg: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Speak>${escapeXml(msg)}</Speak><Hangup/></Response>`
  );
}

// Plivo answer webhook: hit for inbound calls and when an outbound call we placed
// is answered. Returns Plivo XML that connects audio to this server's /plivo WS.
async function plivoVoiceWebhook(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const form = await readForm(req);
  if (await rejectUnlessPlivoSigned(req, res, url, form)) return;
  const callUuid = form.CallUUID;
  const from = plivoE164(form.From);
  const to = plivoE164(form.To);
  const host = req.headers.host ?? `localhost:${PORT}`;
  const sendXml = (xml: string) => {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(xml);
  };

  let callId = url.searchParams.get('callId') || undefined;

  // Outbound leg answered — attach the real CallUUID (needed for transfer/hangup).
  if (callId) {
    if (callUuid) {
      await prisma.call
        .update({
          where: { id: callId },
          data: { status: 'IN_PROGRESS', providerSid: callUuid, startedAt: new Date() },
        })
        .catch(() => {});
    }
    return sendXml(plivoStreamXml(host, callId));
  }

  // Inbound: resolve the dialled number → its agent (mirrors the Twilio path).
  const number = await prisma.phoneNumber.findUnique({ where: { e164: to }, include: { agent: true } });
  const agent = number?.agent ?? null;
  const agentId = number?.agentId ?? null;
  const language = agent?.language ?? 'en-IN';

  if (!agentId) {
    await prisma.call
      .create({
        data: {
          workspaceId: number?.workspaceId ?? null,
          userId: number?.userId ?? null,
          phoneNumberId: number?.id ?? null,
          direction: 'INBOUND',
          status: 'COMPLETED',
          fromNumber: from,
          toNumber: to,
          providerSid: callUuid,
          startedAt: new Date(),
          endedAt: new Date(),
          endedReason: 'no_agent',
        },
      })
      .catch((e) => console.error('[voice-server] plivo no-agent log failed', e));
    return sendXml(plivoSpeakHangup('Sorry, this number is not set up to take calls yet. Goodbye.'));
  }

  // Same account gate as the Twilio path above — this webhook also resolves the
  // number itself rather than going through resolveInboundCall.
  const plivoOrgState = await orgStatusForWorkspace(number?.workspaceId);
  if (plivoOrgState && !canUseService(plivoOrgState.status)) {
    await prisma.call
      .create({
        data: {
          workspaceId: number?.workspaceId ?? null,
          userId: number?.userId ?? null,
          agentId,
          phoneNumberId: number?.id ?? null,
          direction: 'INBOUND',
          status: 'COMPLETED',
          fromNumber: from,
          toNumber: to,
          providerSid: callUuid,
          language,
          startedAt: new Date(),
          endedAt: new Date(),
          endedReason: `account_${plivoOrgState.status.toLowerCase()}`,
        },
      })
      .catch((e) => console.error('[voice-server] plivo suspended-account log failed', e));
    console.error('[voice-server] plivo inbound to', to, '— account', plivoOrgState.status);
    return sendXml(plivoSpeakHangup('Sorry, this number is not accepting calls right now. Goodbye.'));
  }

  // Out of plan minutes — same gate, same reason as above.
  if (
    plivoOrgState &&
    (await refuseInboundOverLimit({
      orgId: plivoOrgState.orgId,
      workspaceId: number?.workspaceId ?? null,
      userId: number?.userId ?? null,
      agentId,
      phoneNumberId: number?.id ?? null,
      from,
      to,
      providerSid: callUuid,
      language,
    }))
  ) {
    return sendXml(plivoSpeakHangup('Sorry, this number is not accepting calls right now. Goodbye.'));
  }

  if (number && !number.inboundEnabled) {
    await prisma.call.create({
      data: {
        workspaceId: number.workspaceId,
        userId: number.userId,
        phoneNumberId: number.id,
        direction: 'INBOUND',
        status: 'COMPLETED',
        fromNumber: from,
        toNumber: to,
        providerSid: callUuid,
        startedAt: new Date(),
        endedAt: new Date(),
        endedReason: 'inbound_disabled',
      },
    });
    return sendXml(plivoSpeakHangup('Sorry, this number is not accepting calls right now. Goodbye.'));
  }

  // Call forwarding: hand the inbound call to another number (a human) instead of
  // the AI agent. Plivo's <Dial> takes a <Number> child.
  if (number?.forwardTo) {
    await prisma.call.create({
      data: {
        workspaceId: number.workspaceId,
        userId: number.userId,
        agentId,
        phoneNumberId: number.id,
        direction: 'INBOUND',
        status: 'COMPLETED',
        fromNumber: from,
        toNumber: to,
        providerSid: callUuid,
        language,
        startedAt: new Date(),
        endedAt: new Date(),
        endedReason: 'forwarded',
        summary: `Forwarded to ${number.forwardTo}`,
      },
    });
    return sendXml(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<Response><Dial><Number>${escapeXml(number.forwardTo)}</Number></Dial></Response>`,
    );
  }

  if (agent && !isWithinBusinessHours(agent.businessHours)) {
    const msg =
      applyVariables(agent.afterHoursMessage?.trim() || '', agent.variables) ||
      "Sorry, you've reached us outside our business hours. Please call back during working hours. Goodbye.";
    await prisma.call.create({
      data: {
        workspaceId: number?.workspaceId ?? null,
        userId: number?.userId ?? null,
        agentId,
        phoneNumberId: number?.id ?? null,
        direction: 'INBOUND',
        status: 'COMPLETED',
        fromNumber: from,
        toNumber: to,
        providerSid: callUuid,
        language,
        startedAt: new Date(),
        endedAt: new Date(),
        endedReason: 'after_hours',
      },
    });
    return sendXml(plivoSpeakHangup(msg));
  }

  const call = await prisma.call.create({
    data: {
      workspaceId: number?.workspaceId ?? null,
      userId: number?.userId ?? null,
      agentId,
      phoneNumberId: number?.id ?? null,
      direction: 'INBOUND',
      status: 'IN_PROGRESS',
      fromNumber: from,
      toNumber: to,
      providerSid: callUuid,
      language,
      startedAt: new Date(),
    },
  });
  callId = call.id;
  return sendXml(plivoStreamXml(host, callId));
}

// Plivo status/hangup callback. Maps Plivo's CallStatus onto our Call model.
async function plivoStatusWebhook(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const form = await readForm(req);
  if (await rejectUnlessPlivoSigned(req, res, url, form)) return;
  const callId = url.searchParams.get('callId');

  // Plivo's own signature check above is default-off (PLIVO_VALIDATE_SIGNATURE),
  // so on a stock deployment it passes everything. This callback writes
  // durationSec, which overage billing is computed from, so authenticate it with
  // the token we put in the callback URL when the call was placed. Unlike the
  // signature, this needs no per-account token lookup and is always on.
  if (callId && !verifyCallbackToken(callId, 'plivo-status', url.searchParams.get('t'))) {
    console.error('[voice-server] rejected Plivo status with missing/invalid token:', callId);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden');
  }

  if (callId) {
    const map: Record<string, string> = {
      ringing: 'RINGING',
      'in-progress': 'IN_PROGRESS',
      answered: 'IN_PROGRESS',
      completed: 'COMPLETED',
      busy: 'BUSY',
      'no-answer': 'NO_ANSWER',
      failed: 'FAILED',
      timeout: 'NO_ANSWER',
      cancel: 'FAILED',
    };
    const status = map[(form.CallStatus || '').toLowerCase()];
    const duration = parseInt(form.Duration || form.BillDuration || '0', 10);
    if (status) {
      const terminal = ['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'];
      await prisma.call
        .updateMany({
          where: terminal.includes(status) ? { id: callId } : { id: callId, status: { notIn: terminal } },
          data: {
            status,
            ...(terminal.includes(status) ? { endedAt: new Date(), endedReason: form.CallStatus || form.HangupCause } : {}),
          },
        })
        .catch((err) => console.error('[plivo-status] update failed', { callId }, err));
      await fillProviderDuration(callId, duration);
      if (['FAILED', 'NO_ANSWER', 'BUSY'].includes(status)) void dispatchCallEvent(callId, 'call.failed');
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}

// Live-call transfer document: Plivo transfers an in-progress leg to this URL
// (see PlivoProvider.redirectCall), which renders <Speak>/<Dial>/<Hangup> from
// the query. No DB side effects — safe to serve unauthenticated.
function plivoTransferDocument(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const say = url.searchParams.get('say');
  const dial = url.searchParams.get('dial');
  const hangup = url.searchParams.get('hangup');
  let inner = '';
  if (say) inner += `<Speak>${escapeXml(say)}</Speak>`;
  if (dial) inner += `<Dial><Number>${escapeXml(dial)}</Number></Dial>`;
  if (hangup && !dial) inner += '<Hangup/>';
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + '</Response>');
}

// ── Media session (STT → Gemini → TTS) ────────────────────────────────────

// Endpointing: end the caller's turn after this much trailing silence. Lower =
// snappier replies, but too low clips mid-sentence pauses. ~500ms is a good
// balance for conversational latency.
const SILENCE_MS = 450;
const ENERGY_THRESHOLD = 0.015; // caller-speech detection while listening
// Interrupting the agent mid-speech needs a higher, sustained signal so the
// agent's own audio echoing back doesn't falsely trigger a barge-in.
const BARGE_THRESHOLD = 0.03;
const BARGE_FRAMES = 12; // ~240ms of sustained speech to barge in

class CallSession {
  private streamSid = '';
  private startedAt = Date.now();
  private speech = getSpeechProvider();
  private agent: Agent | null = null;
  private history: ChatMessage[] = [];
  private utterance: Buffer[] = [];
  private lastVoiceAt = 0;
  private speaking = false; // caller is currently speaking (capturing)
  private thinking = false; // STT + LLM generation in progress
  private gotMedia = false;
  private bargeFrames = 0;
  private turnId = 0; // monotonic; bumped per turn and on every barge-in
  private ttsQueue: { text: string; turn: number; stage: VoiceStage }[] = [];
  private ttsRunning = false;
  private creds: OrgCredentials = {}; // org-supplied provider keys for this call
  private dg: DeepgramLive | null = null; // streaming STT (when configured)
  // Effective language for this call. Equals agent.language unless the agent
  // uses "auto" picking, in which case it's resolved from the caller's number.
  private language = 'en-IN';
  // Provider call SID — needed to redirect the live call (human transfer).
  private providerSid: string | null = null;
  private transferring = false;
  // Emergency tripwire: fires at most once per call. orgId/callerNumber are
  // kept so the clinic's alert can be raised without another database read.
  private emergencyFired = false;
  private orgId: string | null = null;
  private callerNumber: string | null = null;
  // Wire audio codec (mulaw for Twilio, PCM16 for Exotel).
  private codec: TelephonyCodec;

  constructor(
    private ws: WebSocket,
    private callId: string | null,
    private provider: 'twilio' | 'exotel' | 'plivo' = 'twilio',
  ) {
    this.codec = codecForProvider(provider);
  }

  async run() {
    // callId is resolved from the "start" event (Twilio custom parameter), so
    // we just wire up handlers here and keep the socket open.
    this.ws.on('message', (raw) => this.onMessage(raw.toString()));
    this.ws.on('close', () => {
      void this.finalize();
    });
  }

  private async loadAgent() {
    if (!this.callId) return;
    const call = await prisma.call.findUnique({
      where: { id: this.callId },
      include: {
        agent: { include: { workspace: { select: { orgId: true } } } },
      },
    });
    this.agent = (call?.agent as Agent) ?? null;
    this.providerSid = call?.providerSid ?? null;
    this.orgId = ((call?.agent as any)?.workspace?.orgId as string | undefined) ?? null;
    this.callerNumber =
      (call?.direction === 'OUTBOUND' ? call?.toNumber : call?.fromNumber) ?? null;
    // Org-supplied integration keys (Deepgram/ElevenLabs/Gemini/…), if any.
    this.creds = await getOrgCredentials((call?.agent as any)?.workspace?.orgId).catch(() => ({}));
    // Resolve the language for this call. "auto" picks from the caller's number
    // (location); every other mode uses the agent's configured language.
    const base = this.agent?.language ?? 'en-IN';
    this.language =
      this.agent?.languageMode === 'auto'
        ? languageForCaller(call?.fromNumber, base)
        : base;
    if (this.language !== call?.language) {
      console.log('[voice-server] language resolved:', this.language, '(mode:', this.agent?.languageMode, ')');
      await prisma.call
        .update({ where: { id: this.callId }, data: { language: this.language } })
        .catch(() => {});
    }
  }

  private ms() {
    return Date.now() - this.startedAt;
  }

  private async onMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.event !== 'media') console.log('[voice-server] event:', msg.event);
    try {
      await this.handleEvent(msg);
    } catch (err) {
      console.error('[voice-server] handleEvent error:', err);
    }
  }

  private async handleEvent(msg: any) {
    switch (msg.event) {
      case 'start': {
        this.streamSid =
          msg.start?.streamSid ?? msg.start?.stream_sid ?? msg.start?.streamId ??
          msg.streamSid ?? msg.stream_sid ?? msg.streamId ?? '';
        // Twilio passes our <Parameter name="callId"> here; Exotel supplies it in
        // custom_parameters (outbound) or via call metadata (inbound).
        const paramCallId =
          msg.start?.customParameters?.callId ?? msg.start?.custom_parameters?.callId;
        this.callId = paramCallId ?? this.callId;
        if (!this.callId && this.provider === 'exotel') {
          const s = msg.start ?? {};
          const res = await resolveInboundCall({
            from: s.from ?? 'unknown',
            to: s.to ?? 'unknown',
            callSid: s.call_sid,
          });
          this.callId = res.callId;
          if (res.terminal) console.log('[voice-server] exotel inbound terminal:', res.terminal);
        }
        this.startedAt = Date.now();
        console.log('[voice-server] stream started, streamSid:', this.streamSid, 'callId:', this.callId);
        if (!this.callId) {
          console.error('[voice-server] start event had no callId — closing socket');
          this.ws.close();
          break;
        }
        await this.loadAgent();
        console.log('[voice-server] agent:', this.agent?.name ?? 'NONE');
        // Open streaming STT if a Deepgram key is configured (low latency);
        // otherwise we fall back to energy-VAD + batch Google STT.
        const dgKey = this.creds.deepgram || process.env.DEEPGRAM_API_KEY;
        if (dgKey) {
          this.dg = openDeepgram({
            apiKey: dgKey,
            languageCode: this.language,
            onUtterance: (t) => this.onDeepgramUtterance(t),
            encoding: this.codec.deepgramEncoding,
          });
        }
        if (this.agent) {
          const greeting = applyVariables(
            this.agent.greeting?.trim() || 'Hello! How can I help you today?',
            this.agent.variables,
          );
          await recordTurn(this.callId, 'AGENT', greeting, this.ms());
          this.history.push({ role: 'model', text: greeting });
          this.enqueueSpeak(greeting, this.turnId, 'greeting');
          console.log('[voice-server] greeting queued');
        }
        break;
      }
      case 'media': {
        const payload = msg.media?.payload;
        if (payload) this.onAudioFrame(Buffer.from(payload, 'base64'));
        break;
      }
      case 'stop':
        this.ws.close();
        break;
    }
  }

  private agentActive(): boolean {
    return this.thinking || this.ttsRunning || this.ttsQueue.length > 0;
  }

  // Twilio streams inbound audio continuously (a 20ms frame every 20ms, even
  // during silence). We detect end-of-turn by trailing SILENCE, and — while the
  // agent is talking — we watch for the caller barging in to interrupt.
  private onAudioFrame(frame: Buffer) {
    if (!this.gotMedia) {
      this.gotMedia = true;
      console.log('[voice-server] receiving caller media');
    }
    const energy = frameEnergy(this.codec, frame);
    const now = Date.now();

    // Barge-in: caller starts talking while the agent is thinking/speaking.
    if (this.agentActive()) {
      if (energy > BARGE_THRESHOLD) {
        this.bargeFrames++;
        if (this.bargeFrames < BARGE_FRAMES) {
          if (this.dg) this.dg.send(frame);
          return;
        }
        this.bargeIn();
      } else {
        this.bargeFrames = 0;
      }
    }

    // Deepgram path: forward every frame; Deepgram handles endpointing and
    // calls onDeepgramUtterance when the caller finishes speaking.
    if (this.dg) {
      this.dg.send(frame);
      return;
    }

    // Fallback path: energy-based capture + silence endpointing.
    if (energy > ENERGY_THRESHOLD) {
      if (!this.speaking) {
        this.speaking = true;
        this.utterance = [];
      }
      this.lastVoiceAt = now;
      this.utterance.push(frame);
    } else if (this.speaking) {
      this.utterance.push(frame);
      if (now - this.lastVoiceAt >= SILENCE_MS) void this.endUtterance();
    }
  }

  // Deepgram detected end-of-speech. Ignore transcripts that arrive while the
  // agent is speaking (echo / not a real turn) — real interrupts come through
  // the energy-based barge-in path, after which the agent is no longer active.
  private onDeepgramUtterance(text: string) {
    if (this.agentActive()) return;
    void this.processTurn(text);
  }

  // Caller interrupted — silence the agent immediately and start listening.
  private bargeIn() {
    console.log('[voice-server] barge-in — caller interrupted');
    this.turnId++; // invalidate any in-flight generation / queued speech
    this.thinking = false;
    this.ttsQueue = [];
    // Flush whatever audio the provider has buffered/playing so the agent stops now.
    this.sendClear();
    this.bargeFrames = 0;
    this.speaking = false; // the capture block re-arms it for this frame
    this.utterance = [];
  }

  // Fallback (no Deepgram): batch-transcribe the captured audio, then process.
  private async endUtterance() {
    const callId = this.callId;
    if (!callId || !this.speaking || this.utterance.length === 0) return;
    this.speaking = false;
    const audio = Buffer.concat(this.utterance);
    this.utterance = [];
    try {
      const stt = await this.speech.transcribe(audio, this.language);
      const text = stt.text.trim();
      if (text) await this.processTurn(text);
      else console.log('[voice-server] empty transcription');
    } catch (err) {
      console.error('[voice-server] stt error:', err);
    }
  }

  // Run one caller turn: log, generate (streamed), speak sentence-by-sentence.
  // turnId-gated so a barge-in mid-turn abandons it cleanly.
  private async processTurn(text: string) {
    const callId = this.callId;
    if (!callId) return;
    const myTurn = ++this.turnId;
    this.thinking = true;
    const t0 = Date.now();
    try {
      console.log('[voice-server] caller said:', text);
      await recordTurn(callId, 'CALLER', text, this.ms());

      // Emergency tripwire. A genuine PRE-EMPT on this pipeline: the utterance
      // is fully transcribed before any model call, so a caller describing
      // chest pain is answered from a fixed table and the model is never asked.
      // Ahead of the transfer check, because an ambulance beats a receptionist.
      if (this.maybeEmergency(text, myTurn)) return;

      // Human transfer: if the caller asks for a person, hand off and stop.
      if (await this.maybeTransfer(text)) return;

      this.history.push({ role: 'user', text });

      if (!this.agent) return;
      let firstSentence = true;
      const reply = await generateAgentTurnStreaming(
        { agent: this.agent, history: this.history.slice(0, -1), callerText: text, language: this.language },
        (sentence) => {
          if (myTurn !== this.turnId) return;
          if (firstSentence) {
            firstSentence = false;
            console.log(`[voice-server] ⏱ LLM first sentence at +${Date.now() - t0}ms`);
          }
          this.enqueueSpeak(sentence, myTurn);
        },
        () => myTurn !== this.turnId,
      );
      if (myTurn !== this.turnId) return; // barged during generation
      console.log(`[voice-server] ⏱ LLM full reply at +${Date.now() - t0}ms:`, reply.slice(0, 80));
      await recordTurn(callId, 'AGENT', reply, this.ms());
      this.history.push({ role: 'model', text: reply });
      await this.waitForTts(myTurn);
    } catch (err) {
      console.error('[voice-server] turn error:', err);
    } finally {
      if (myTurn === this.turnId) this.thinking = false;
    }
  }

  // If transfer is enabled and the caller asked for a human, redirect the live
  // call to <Say> + <Dial>. Returns true when a transfer was initiated.
  private async maybeTransfer(text: string): Promise<boolean> {
    const a = this.agent;
    if (this.transferring || !a?.transferEnabled || !a.transferNumber || !this.providerSid) {
      return false;
    }
    if (!matchesTransferTrigger(text, a.transferTriggers)) return false;
    this.transferring = true;
    const say = applyVariables(a.transferMessage?.trim() || 'Please hold while I connect you to a representative.', a.variables);
    try {
      await getTelephonyProvider().redirectCall(this.providerSid, { say, dial: a.transferNumber });
      console.log('[voice-server] transferring call to', a.transferNumber);
      if (this.callId) await recordTurn(this.callId, 'SYSTEM', `Transferred to ${a.transferNumber}`, this.ms());
    } catch (err) {
      console.error('[voice-server] transfer failed:', err);
      this.transferring = false;
      return false;
    }
    return true;
  }

  // Enqueue text to be spoken. Non-blocking; a worker synthesizes + streams in
  // order. Each item carries its turn (so stale/barged speech is dropped) and a
  // conversation stage (so multi-voice agents pick the right voice).
  // Emergency tripwire (cascade pipeline). Returns true when it fired and the
  // turn is finished — the caller has been answered and the model must not run.
  //
  // Fires at most once per call: the caller has been told to hang up and dial,
  // and repeating it over every later sentence talks over someone acting on it.
  private maybeEmergency(text: string, turn: number): boolean {
    if (this.emergencyFired) return false;
    const flag = detectRedFlag(text);
    if (!flag) return false;
    this.emergencyFired = true;
    console.warn(`[voice-server] emergency tripwire fired (${flag.concept}) on call ${this.callId}`);

    const clinic = this.agent?.name || 'the clinic';
    const line = emergencySpokenReply(clinic, this.language);

    // Drop anything the agent was about to say, then say this instead. Marked
    // 'closing' so it is never treated as a mid-thought fragment.
    this.ttsQueue = [];
    this.sendClear();
    this.enqueueSpeak(line, turn, 'closing');

    // The model never saw this turn, so put both halves into the history
    // ourselves — otherwise the next turn reads as a non-sequitur.
    this.history.push({ role: 'user', text }, { role: 'model', text: line });

    raiseVoiceEmergency(
      {
        callId: this.callId,
        orgId: this.orgId,
        workspaceId: this.agent?.workspaceId ?? null,
        agentId: this.agent?.id ?? null,
        clinicName: clinic,
        callerNumber: this.callerNumber,
        atMs: this.ms(),
      },
      flag,
      line,
      text,
    );
    return true;
  }

  private enqueueSpeak(text: string, turn: number, stage?: VoiceStage) {
    const t = text.trim();
    if (!t) return;
    const resolved: VoiceStage = stage ?? (isClosingSentence(t) ? 'closing' : 'main');
    this.ttsQueue.push({ text: t, turn, stage: resolved });
    void this.drainTts();
  }

  private async drainTts() {
    if (this.ttsRunning) return;
    this.ttsRunning = true;
    try {
      while (this.ttsQueue.length) {
        const item = this.ttsQueue.shift()!;
        if (item.turn !== this.turnId) continue; // stale after a barge-in
        await this.synthAndSend(item.text, item.turn, item.stage);
      }
    } finally {
      this.ttsRunning = false;
    }
  }

  private async waitForTts(turn: number) {
    while ((this.ttsRunning || this.ttsQueue.length) && turn === this.turnId) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private async synthAndSend(text: string, turn: number, stage: VoiceStage = 'main') {
    if (!this.agent) return;
    const tts0 = Date.now();
    const { voice, provider } = voiceForStage(this.agent, stage);
    const audio = await synthesizeTelephony(
      text,
      this.language,
      voice,
      provider,
      this.creds,
      this.codec.ttsEncoding,
    );
    console.log(`[voice-server] ⏱ TTS ${Date.now() - tts0}ms for`, JSON.stringify(text).slice(0, 40));
    if (turn !== this.turnId) return; // barged in during synthesis — don't play
    const frame = this.codec.frameBytes;
    for (let i = 0; i < audio.length; i += frame) {
      let chunk = audio.subarray(i, i + frame);
      if (this.provider === 'exotel' && chunk.length % 320 !== 0) {
        const padded = Buffer.alloc(Math.ceil(chunk.length / 320) * 320, this.codec.silenceByte);
        chunk.copy(padded);
        chunk = padded;
      }
      this.sendMedia(chunk.toString('base64'));
    }
    console.log('[voice-server] spoke:', JSON.stringify(text).slice(0, 50), `(${audio.length}b)`);
  }

  // Provider-correct media / clear frames (Twilio/Exotel `media`/`clear` vs
  // Plivo `playAudio`/`clearAudio`).
  private sendMedia(payloadBase64: string) {
    this.ws.send(JSON.stringify(buildMediaMessage(this.codec, this.streamSid, payloadBase64)));
  }

  private sendClear() {
    const msg = buildClearMessage(this.codec, this.streamSid);
    if (msg) this.ws.send(JSON.stringify(msg));
  }

  private async finalize() {
    this.dg?.close();
    this.dg = null;
    const callId = this.callId;
    if (!callId) return;
    try {
      await finalizeCallRecord(callId, this.ms());
    } catch (err) {
      console.error('[voice-server] finalize failed', err);
    }
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
