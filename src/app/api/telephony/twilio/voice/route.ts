import { prisma } from '@/lib/db';
import { getTelephonyProvider } from '@/lib/adapters/telephony';
import { verifyTwilioRequest } from '@/lib/telephony-signature';

export const dynamic = 'force-dynamic';

// Twilio answer webhook. Hit when:
//  - an inbound call arrives at a provisioned number (Twilio is configured to
//    POST here), or
//  - an outbound call we placed is answered (we set this as the Url).
// Responds with TwiML that bridges the call audio to the voice-server.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const form = await req.formData().catch(() => null);
  if (!(await verifyTwilioRequest(req, form))) return new Response('forbidden', { status: 403 });

  const callSid = (form?.get('CallSid') as string) || undefined;
  const from = (form?.get('From') as string) || 'unknown';
  const to = (form?.get('To') as string) || 'unknown';

  let callId = searchParams.get('callId') || undefined;

  // Inbound: no pre-created Call row. Find the number -> its agent, create one.
  if (!callId) {
    const number = await prisma.phoneNumber.findUnique({
      where: { e164: to },
      include: { agent: true },
    });
    // A number without an agent is rejected — never another tenant's agent.
    if (!number?.agentId) {
      const doc =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response><Say>Sorry, this number is not set up to take calls yet. Goodbye.</Say><Hangup/></Response>';
      return new Response(doc, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    const call = await prisma.call.create({
      data: {
        workspaceId: number.workspaceId,
        userId: number.userId ?? null,
        agentId: number.agentId ?? null,
        phoneNumberId: number?.id ?? null,
        direction: 'INBOUND',
        status: 'IN_PROGRESS',
        fromNumber: from,
        toNumber: to,
        providerSid: callSid,
        language: number?.agent?.language ?? 'en-IN',
        startedAt: new Date(),
      },
    });
    callId = call.id;
  } else if (callSid) {
    await prisma.call.update({
      where: { id: callId },
      data: { status: 'IN_PROGRESS', providerSid: callSid, startedAt: new Date() },
    });
  }

  const voiceWs = process.env.VOICE_WS_URL || 'ws://localhost:8080';
  const provider = getTelephonyProvider();
  const doc = provider.buildAnswerDocument({ voiceWsUrl: voiceWs, callId: callId! });

  return new Response(doc.body, {
    status: 200,
    headers: { 'Content-Type': doc.contentType },
  });
}
