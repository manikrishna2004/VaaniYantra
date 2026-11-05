import { prisma } from '@/lib/db';
import { fillProviderDuration } from '@/lib/calls/provider-duration';
import { verifyTwilioRequest } from '@/lib/telephony-signature';

export const dynamic = 'force-dynamic';

// Twilio status-callback webhook. Maps Twilio call statuses onto our Call model
// and records duration/recording when the call completes.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const callId = searchParams.get('callId');
  const form = await req.formData().catch(() => null);
  if (!(await verifyTwilioRequest(req, form))) return new Response('forbidden', { status: 403 });
  if (!callId || !form) return new Response('ok');

  const callStatus = (form.get('CallStatus') as string) || '';
  const duration = parseInt((form.get('CallDuration') as string) || '0', 10);
  const recordingUrl = (form.get('RecordingUrl') as string) || undefined;

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
  const status = map[callStatus];
  // Unknown/new Twilio status — ignore rather than guess (guessing IN_PROGRESS
  // used to resurrect completed calls).
  if (!status) return new Response('ok');

  const terminal = ['COMPLETED', 'FAILED', 'NO_ANSWER', 'BUSY'];
  await prisma.call.updateMany({
    // Non-terminal updates must not overwrite a call that already ended.
    where: terminal.includes(status) ? { id: callId } : { id: callId, status: { notIn: terminal } },
    data: {
      status,
      ...(recordingUrl ? { recordingUrl } : {}),
      ...(terminal.includes(status) ? { endedAt: new Date(), endedReason: callStatus } : {}),
    },
  }).catch((err) => console.error('[twilio-status] update failed', { callId }, err));
  await fillProviderDuration(callId, duration);

  return new Response('ok');
}
