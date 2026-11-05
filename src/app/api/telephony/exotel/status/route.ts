import { prisma } from '@/lib/db';
import { fillProviderDuration } from '@/lib/calls/provider-duration';
import { verifyCallbackToken, webhookTokensAvailable } from '@/lib/webhook-token';

export const dynamic = 'force-dynamic';

// Exotel call status callback. Exotel posts call lifecycle updates (Status /
// DialCallStatus, Duration) which we map onto our Call model. Accepts both form
// and query params since Exotel's passthru/StatusCallback formats vary.
//
// Exotel does not sign its webhooks, so authenticity comes from the `t` token we
// embedded in the callback URL when the call was placed (see lib/webhook-token).
// Without it this endpoint would let anyone who learns a call id rewrite that
// call's `duration` — the field overage billing is computed from.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const callId = searchParams.get('callId');
  const form = await req.formData().catch(() => null);
  if (!callId) return new Response('ok');

  if (!verifyCallbackToken(callId, 'exotel-status', searchParams.get('t'))) {
    // A deployment with no signing secret cannot verify anything; say so loudly
    // rather than fail every callback silently and lose all Exotel billing.
    console.error(
      webhookTokensAvailable()
        ? '[exotel-status] rejected callback with missing/invalid token'
        : '[exotel-status] rejected callback — no WEBHOOK_TOKEN_SECRET/SECRET_ENC_KEY set, cannot verify',
      { callId },
    );
    // 403 rather than 200: Exotel retries, which gives a genuine callback that
    // lost its token (e.g. a URL rewritten mid-flight) another chance to arrive.
    return new Response('forbidden', { status: 403 });
  }

  const get = (k: string) =>
    ((form?.get(k) as string) || searchParams.get(k) || '').toString();
  const callStatus = (get('Status') || get('CallStatus') || get('DialCallStatus')).toLowerCase();
  const duration = parseInt(get('Duration') || get('CallDuration') || '0', 10);
  const recordingUrl = get('RecordingUrl') || undefined;

  const map: Record<string, string> = {
    queued: 'QUEUED',
    ringing: 'RINGING',
    'in-progress': 'IN_PROGRESS',
    'in progress': 'IN_PROGRESS',
    connected: 'IN_PROGRESS',
    completed: 'COMPLETED',
    complete: 'COMPLETED',
    busy: 'BUSY',
    'no-answer': 'NO_ANSWER',
    'no answer': 'NO_ANSWER',
    failed: 'FAILED',
    canceled: 'FAILED',
    cancelled: 'FAILED',
  };
  const status = map[callStatus];
  // Unknown status: ignore rather than guess. This used to default to
  // IN_PROGRESS, which resurrected calls that had already completed — the same
  // bug already fixed on the Twilio path.
  if (!status) return new Response('ok');

  const TERMINAL = ['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'];
  await prisma.call
    .updateMany({
      // A late non-terminal update must not overwrite a call that already ended.
      where: TERMINAL.includes(status) ? { id: callId } : { id: callId, status: { notIn: TERMINAL } },
      data: {
        status,
        ...(recordingUrl ? { recordingUrl } : {}),
        ...(TERMINAL.includes(status)
          ? { endedAt: new Date(), endedReason: callStatus || 'completed' }
          : {}),
      },
    })
    .catch((err) => console.error('[exotel-status] update failed', { callId }, err));
  await fillProviderDuration(callId, duration);

  return new Response('ok');
}
