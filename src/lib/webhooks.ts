import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { assertPublicUrl } from '@/lib/net/ssrf';

// Phase 6 — Outbound webhooks. Workspaces register endpoints that receive a
// signed JSON POST when a subscribed event fires (e.g. a call completes). This
// is the foundation other integrations (Slack, CRM, Zapier/Make) build on.

export const WEBHOOK_EVENTS = [
  'call.completed',
  'call.failed',
  // Write-back events. The most common integration request is not "let us read
  // your data" but "when your AI books someone, put it in our system" — these
  // answer it on the delivery path that already exists (signed, retried,
  // failure-tracked) rather than a bespoke one per client.
  'appointment.created',
  'appointment.cancelled',
  'appointment.rescheduled',
  'visit.recorded',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_META: Record<WebhookEvent, string> = {
  'call.completed': 'A call finished successfully (includes summary, sentiment, collected data).',
  'call.failed': 'A call ended without connecting (failed, busy, or no answer).',
  'appointment.created': 'An appointment was booked — by an agent on a call, or by a patient in the chatbot.',
  'appointment.cancelled': 'A booked appointment was cancelled.',
  'appointment.rescheduled': 'A booked appointment moved to a new time.',
  'visit.recorded': 'A consultation record was filed against a patient.',
};

export function isWebhookEvent(v: string): v is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

export function generateWebhookSecret(): string {
  return 'whsec_' + crypto.randomBytes(24).toString('hex');
}

// HMAC-SHA256 of the raw body, hex — sent as `X-VaaniYantra-Signature: sha256=…`.
export function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export const WEBHOOK_TYPES = ['generic', 'slack'] as const;
export type WebhookType = (typeof WEBHOOK_TYPES)[number];

const TIMEOUT_MS = 6000;

// Last four digits only, for the Slack card.
//
// A Slack Incoming Webhook is authenticated by the secrecy of its URL and
// nothing else: Slack will never verify our HMAC, so signing this payload the
// way the generic webhook is signed would be decoration, not protection. What
// can actually be done is send less. Whoever holds the URL — a leaked config, a
// former employee's export, anyone in the channel — no longer gets a list of
// patient phone numbers, and the card still tells a clinic what it needs to
// know. Generic webhooks are unchanged: those go to an endpoint the customer
// controls, under a signature they can verify.
function maskNumber(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/\D/g, '') : '';
  return s.length >= 4 ? `•••• ${s.slice(-4)}` : '—';
}

// Format a call event as a Slack Incoming Webhook message (Block Kit).
export function formatSlackMessage(payload: any): { text: string; blocks: unknown[] } {
  const d = payload?.data ?? {};
  const failed = payload?.event === 'call.failed';
  const emoji = failed
    ? '🔴'
    : d.sentiment === 'POSITIVE'
      ? '🟢'
      : d.sentiment === 'NEGATIVE'
        ? '🔴'
        : '⚪';
  const title = failed ? '📵 Call failed' : '📞 Call completed';
  const dir = d.direction === 'INBOUND' ? '↓ Inbound' : '↑ Outbound';
  const number = d.direction === 'INBOUND' ? d.fromNumber : d.toNumber;

  const fields: { type: string; text: string }[] = [
    { type: 'mrkdwn', text: `*Agent:*\n${d.agent?.name ?? '—'}` },
    { type: 'mrkdwn', text: `*Direction:*\n${dir}` },
    { type: 'mrkdwn', text: `*Number:*\n${maskNumber(number)}` },
    { type: 'mrkdwn', text: `*Duration:*\n${d.durationSec ?? 0}s` },
  ];
  if (!failed) {
    fields.push({ type: 'mrkdwn', text: `*Sentiment:*\n${emoji} ${d.sentiment ?? 'NEUTRAL'}` });
    if (d.status) fields.push({ type: 'mrkdwn', text: `*Status:*\n${d.status}` });
  }

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
    { type: 'section', fields },
  ];
  // The summary and the collected fields DO go to Slack, unmasked, and that is
  // deliberate: a card that says only "a call happened" is not worth connecting.
  // The distinction from the number above is purpose — a clinic opts into
  // sending call content to their Slack workspace, and gets exactly what they
  // asked for; nobody opts into shipping a patient phone directory alongside it.
  // This is a disclosure ("what a connected Slack channel receives"), not a
  // defect, and is recorded as such in COMPLIANCE_GAPS.md.
  if (!failed && d.summary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Summary:*\n${d.summary}` } });
  }
  const collected = d.collectedData && typeof d.collectedData === 'object' ? d.collectedData : null;
  if (collected) {
    const lines = Object.entries(collected)
      .map(([k, v]) => `• *${k.replace(/_/g, ' ')}:* ${v == null || v === '' ? '—' : v}`)
      .join('\n');
    if (lines) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Collected:*\n${lines}` } });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `VaaniYantra • ${payload?.timestamp ?? new Date().toISOString()}` }],
  });

  return { text: `${title} — ${d.agent?.name ?? 'agent'}`, blocks };
}

// Build the JSON payload for a call event from the finalized Call row.
async function buildCallPayload(callId: string, event: WebhookEvent) {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: { agent: { select: { id: true, name: true } } },
  });
  if (!call) return null;
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  return {
    event,
    timestamp: new Date().toISOString(),
    data: {
      id: call.id,
      direction: call.direction,
      status: call.status,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      durationSec: call.durationSec,
      language: call.language,
      agent: call.agent ? { id: call.agent.id, name: call.agent.name } : null,
      summary: call.summary,
      sentiment: call.sentiment,
      sentimentScore: call.sentimentScore,
      topics: call.topics ?? [],
      collectedData: call.collectedData ?? null,
      recordingUrl: call.recordingUrl && base ? `${base}${call.recordingUrl}` : call.recordingUrl,
      createdAt: call.createdAt.toISOString(),
      endedAt: call.endedAt?.toISOString() ?? null,
    },
  };
}

// POST a payload to one webhook, recording the outcome on its row. Never throws.
// Slack-type webhooks receive a Block Kit message (no HMAC); generic webhooks
// receive the signed JSON event.
export async function deliver(
  webhook: { id: string; url: string; secret: string; type?: string },
  payload: unknown,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const isSlack = webhook.type === 'slack';
  const body = isSlack ? JSON.stringify(formatSlackMessage(payload)) : JSON.stringify(payload);
  let status = 0;
  let error: string | undefined;
  try {
    const url = await assertPublicUrl(webhook.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        // Do not follow redirects: a 3xx could send the signed payload to an
        // internal address (SSRF), bypassing the assertPublicUrl check above.
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'VaaniYantra-Webhooks/1.0',
          ...(isSlack
            ? {}
            : {
                'X-VaaniYantra-Event': String((payload as any)?.event ?? ''),
                'X-VaaniYantra-Signature': signPayload(webhook.secret, body),
              }),
        },
        body,
        signal: controller.signal,
      });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    error = e?.name === 'AbortError' ? 'Timed out' : e?.message || 'Delivery failed';
  }
  const ok = status >= 200 && status < 300;
  await prisma.webhook
    .update({
      where: { id: webhook.id },
      data: {
        lastStatus: status,
        lastError: ok ? null : (error ?? null),
        lastDeliveryAt: new Date(),
        failureCount: ok ? 0 : { increment: 1 },
      },
    })
    .catch(() => {});
  return { ok, status, error };
}

// Dispatch a call event to every enabled webhook in the call's workspace that
// subscribes to it. Fire-and-forget from the voice-server finalize paths.
export async function dispatchCallEvent(callId: string, event: WebhookEvent): Promise<void> {
  try {
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { workspaceId: true } });
    if (!call?.workspaceId) return;
    const hooks = await prisma.webhook.findMany({
      where: { workspaceId: call.workspaceId, enabled: true, events: { has: event } },
    });
    if (hooks.length === 0) return;
    const payload = await buildCallPayload(callId, event);
    if (!payload) return;
    await Promise.all(hooks.map((h) => deliver(h, payload)));
  } catch (err) {
    console.error('[webhooks] dispatch failed', err);
  }
}

/**
 * Dispatch a non-call event (appointments, visit records) to a workspace's
 * subscribed webhooks.
 *
 * Deliberately takes a plain data object rather than re-reading a row: these
 * fire from inside booking and ingest paths that already hold everything worth
 * sending, and a webhook must never be able to fail the operation that
 * triggered it. Fire-and-forget — `deliver` records its own outcome.
 */
export async function dispatchPatientEvent(
  workspaceId: string | null | undefined,
  event: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    if (!workspaceId) return;
    const hooks = await prisma.webhook.findMany({
      where: { workspaceId, enabled: true, events: { has: event } },
    });
    if (hooks.length === 0) return;
    const payload = { event, timestamp: new Date().toISOString(), data };
    await Promise.all(hooks.map((h) => deliver(h, payload)));
  } catch (err) {
    console.error('[webhooks] patient event dispatch failed', event, err);
  }
}

// A sample payload used by the "Send test" button.
export function sampleCallPayload(event: WebhookEvent) {
  if (event.startsWith('appointment.')) {
    return {
      event,
      timestamp: new Date().toISOString(),
      data: {
        id: 'appt_test_123',
        externalPatientId: 'PMS-4471',
        customerName: 'Ravi Kumar',
        customerNumber: '+919876543210',
        service: 'Dental check-up',
        expertName: 'Dr. Rao',
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 88200000).toISOString(),
        timezone: 'Asia/Kolkata',
        status: event === 'appointment.cancelled' ? 'CANCELLED' : 'CONFIRMED',
        bookedBy: 'agent',
        test: true,
      },
    };
  }
  if (event === 'visit.recorded') {
    return {
      event,
      timestamp: new Date().toISOString(),
      data: {
        visitId: 'visit_test_123',
        contactId: 'contact_test_123',
        externalId: 'PMS-VISIT-88',
        visitedAt: new Date().toISOString(),
        service: 'Root canal — follow-up',
        expertName: 'Dr. Rao',
        test: true,
      },
    };
  }
  return sampleCallEventPayload(event);
}

function sampleCallEventPayload(event: WebhookEvent) {
  return {
    event,
    timestamp: new Date().toISOString(),
    data: {
      id: 'call_test_123',
      direction: 'INBOUND',
      status: event === 'call.failed' ? 'NO_ANSWER' : 'COMPLETED',
      fromNumber: '+919812345678',
      toNumber: '+919876543210',
      durationSec: 42,
      language: 'en-IN',
      agent: { id: 'agent_test', name: 'Support Assistant' },
      summary: 'Caller asked about pricing and booked a follow-up.',
      sentiment: 'POSITIVE',
      sentimentScore: 0.6,
      topics: ['pricing', 'follow-up'],
      collectedData: { name: 'Alex Doe', preferred_time: 'Tomorrow 3pm' },
      recordingUrl: null,
      createdAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      test: true,
    },
  };
}
