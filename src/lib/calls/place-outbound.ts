import { prisma } from '@/lib/db';
import { checkCallMinutesAllowed, callMinutesLimitMessage } from '@/lib/billing/catalogue';
import { isMockTelephony } from '@/lib/adapters/telephony';
import { providerForNumberId } from '@/lib/telephony-accounts';
import { runSimulatedCall } from '@/lib/voice/simulator';
import { signCallbackUrl } from '@/lib/webhook-token';
import type { Call } from '@prisma/client';
import { orgStatus, canUseService, suspendedMessage } from '@/lib/org-status';

export type PlaceOutboundResult =
  | { ok: true; call: Call; simulated?: boolean }
  | { ok: false; status: number; error: string };

// Place an outbound call: enforce plan minutes, resolve the caller-ID number,
// create the Call row, then place it via the number's provider (Twilio/Exotel/
// env) — or run the simulated pipeline in mock mode. Shared by the dashboard
// route (session auth) and the public API route (API-key auth).
//
// `workspaceId` scopes the agent when known (dashboard's active workspace);
// omit it and the agent is resolved within the org (public API).
export async function placeOutboundCall(input: {
  orgId: string;
  agentId: string;
  to: string;
  fromNumberId?: string | null;
  workspaceId?: string | null;
}): Promise<PlaceOutboundResult> {
  // A paused or deactivated org places no calls. Checked before anything else,
  // including the minute allowance: whether they have minutes left is not the
  // question when the account is stopped.
  const { status, reason } = await orgStatus(input.orgId);
  if (!canUseService(status)) {
    return { ok: false, status: 403, error: suspendedMessage(status, reason) };
  }

  const minutes = await checkCallMinutesAllowed(input.orgId);
  if (!minutes.allowed) {
    return {
      ok: false,
      status: 403,
      error: callMinutesLimitMessage(minutes.limit, minutes.used, minutes.plan, minutes.credits),
    };
  }

  const agent = await prisma.agent.findFirst({
    where: input.workspaceId
      ? { id: input.agentId, workspaceId: input.workspaceId }
      : { id: input.agentId, workspace: { orgId: input.orgId } },
  });
  if (!agent) return { ok: false, status: 404, error: 'Agent not found' };
  const workspaceId = agent.workspaceId;

  // Resolve the caller-ID number.
  let fromNumber = process.env.TWILIO_CALLER_ID || '+15550100001';
  let phoneNumberId: string | null = null;
  if (input.fromNumberId) {
    const num = await prisma.phoneNumber.findFirst({ where: { id: input.fromNumberId, workspaceId } });
    if (num) {
      fromNumber = num.e164;
      phoneNumberId = num.id;
    }
  }

  const call = await prisma.call.create({
    data: {
      workspaceId,
      agentId: agent.id,
      phoneNumberId,
      direction: 'OUTBOUND',
      status: 'QUEUED',
      fromNumber,
      toNumber: input.to,
      language: agent.language,
    },
  });

  const provider = await providerForNumberId(phoneNumberId);

  if (provider.name === 'mock-telephony' && isMockTelephony()) {
    void runSimulatedCall(call.id);
    return { ok: true, call, simulated: true };
  }

  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
  let answerWebhookUrl = `${base}/api/telephony/twilio/voice?callId=${call.id}`;
  let statusWebhookUrl: string | undefined = `${base}/api/telephony/twilio/status?callId=${call.id}`;

  // Plivo fetches a per-call answer document (Plivo XML) like Twilio, but at its
  // own path segment (its params/response differ).
  if (provider.name === 'plivo') {
    answerWebhookUrl = `${base}/api/telephony/plivo/voice?callId=${call.id}`;
    // Signed as well as Plivo-signature-checked: the token proves we minted this
    // URL for this call, so the handler stays safe even on an account whose auth
    // token can't be resolved for signature validation.
    statusWebhookUrl = signCallbackUrl(
      `${base}/api/telephony/plivo/status?callId=${call.id}`,
      call.id,
      'plivo-status',
    );
  }

  // Exotel connects to a preconfigured streaming App (exoml flow), not a per-call
  // TwiML URL, so it needs the account's appUrl.
  if (provider.name === 'exotel') {
    const acct = phoneNumberId
      ? await prisma.phoneNumber
          .findUnique({ where: { id: phoneNumberId }, select: { exotelAccount: true } })
          .then((n) => n?.exotelAccount ?? null)
      : null;
    if (!acct?.appUrl) {
      await prisma.call.update({
        where: { id: call.id },
        data: { status: 'FAILED', endedReason: 'Exotel outbound needs an App URL on the account' },
      });
      return { ok: false, status: 400, error: 'Outbound via Exotel needs a streaming App URL set on the Exotel account.' };
    }
    answerWebhookUrl = acct.appUrl;
    // Exotel never signs its callbacks, so this token is the only thing standing
    // between the endpoint and anyone who learns a call id — and that endpoint
    // writes the billable duration.
    statusWebhookUrl = signCallbackUrl(
      `${base}/api/telephony/exotel/status?callId=${call.id}`,
      call.id,
      'exotel-status',
    );
  }

  try {
    const result = await provider.placeCall({ to: input.to, from: fromNumber, answerWebhookUrl, statusWebhookUrl });
    const updated = await prisma.call.update({
      where: { id: call.id },
      data: { providerSid: result.providerSid, status: 'RINGING' },
    });
    return { ok: true, call: updated };
  } catch (err: any) {
    await prisma.call.update({
      where: { id: call.id },
      data: { status: 'FAILED', endedReason: err?.message?.slice(0, 200) },
    });
    return { ok: false, status: 502, error: err?.message ?? 'Failed to place call' };
  }
}
