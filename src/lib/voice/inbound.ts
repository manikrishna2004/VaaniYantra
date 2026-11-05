import { prisma } from '@/lib/db';
import { isWithinBusinessHours } from '@/lib/agent-behavior';
import { orgStatusForWorkspace, canUseService } from '@/lib/org-status';
import { checkCallMinutesAllowed } from '@/lib/billing/catalogue';

// Resolve an inbound call to a callId, creating the Call row.
//
// Twilio does this in its HTTP /voice webhook (before the WS opens) and passes
// the callId as a Stream <Parameter>. Exotel has no pre-WS webhook — the call's
// metadata (To/From/CallSid) only arrives in the WS `start` event — so the
// /exotel media session calls this on start to get a callId.
//
// Returns { callId } to proceed into the voice engine, or { terminal } when the
// call should not be bridged (inbound disabled / after-hours). The caller closes
// the socket on a terminal outcome.
export type InboundResolution =
  | { callId: string; terminal?: undefined }
  | {
      callId: null;
      terminal:
        | 'inbound_disabled'
        | 'after_hours'
        | 'no_agent'
        | 'account_suspended'
        | 'over_limit';
    };

export async function resolveInboundCall(input: {
  from: string;
  to: string;
  callSid?: string;
}): Promise<InboundResolution> {
  const { from, to, callSid } = input;
  const number = await prisma.phoneNumber.findUnique({
    where: { e164: to },
    include: { agent: true },
  });
  const agent = number?.agent ?? null;
  const language = agent?.language ?? 'en-IN';

  // A paused or deactivated org does not answer its phone. Checked before
  // inboundEnabled and business hours, because the account being stopped
  // outranks anything the clinic itself configured.
  const orgState = await orgStatusForWorkspace(number?.workspaceId);
  if (orgState && !canUseService(orgState.status)) {
    await prisma.call.create({
      data: {
        workspaceId: number?.workspaceId ?? null,
        userId: number?.userId ?? null,
        agentId: agent?.id ?? null,
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
    });
    return { callId: null, terminal: 'account_suspended' };
  }

  // Does this org have the minutes? Outbound has always asked
  // (place-outbound.ts); inbound never did, which made the plan's minute
  // allowance unenforceable in the direction that carries almost all the
  // traffic. A clinic on chat_starter — sold explicitly as "no phone calls",
  // callMinutesPerMonth: 0 — could point a number at an agent and answer calls
  // forever, billed nothing. On paid plans the overage cap that exists to stop
  // an uncollectable bill was never reached either, because nothing checked it.
  if (
    orgState &&
    (await refuseInboundOverLimit({
      orgId: orgState.orgId,
      workspaceId: number?.workspaceId ?? null,
      userId: number?.userId ?? null,
      agentId: agent?.id ?? null,
      phoneNumberId: number?.id ?? null,
      from,
      to,
      providerSid: callSid,
      language,
    }))
  ) {
    return { callId: null, terminal: 'over_limit' };
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
        providerSid: callSid,
        startedAt: new Date(),
        endedAt: new Date(),
        endedReason: 'inbound_disabled',
      },
    });
    return { callId: null, terminal: 'inbound_disabled' };
  }

  if (agent && !isWithinBusinessHours(agent.businessHours)) {
    await prisma.call.create({
      data: {
        workspaceId: number?.workspaceId ?? null,
        userId: number?.userId ?? null,
        agentId: agent.id,
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
    return { callId: null, terminal: 'after_hours' };
  }

  const call = await prisma.call.create({
    data: {
      workspaceId: number?.workspaceId ?? null,
      userId: number?.userId ?? null,
      agentId: agent?.id ?? null,
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
  return { callId: call.id };
}

/**
 * Refuse an inbound call when the org has no plan minutes left, recording it the
 * way the other refusals are recorded. Returns whether the call was refused.
 *
 * Lives here, and is exported, because the three inbound entry points do NOT
 * share a path: Twilio and Plivo resolve the number in their own webhooks and
 * never call resolveInboundCall. The org-status gate above had to be repeated in
 * all three for exactly that reason, and a second copy of a billing rule is a
 * worse thing to maintain than a second call to one function.
 */
export async function refuseInboundOverLimit(opts: {
  orgId: string;
  workspaceId: string | null;
  userId: string | null;
  agentId: string | null;
  phoneNumberId: string | null;
  from: string;
  to: string;
  providerSid?: string;
  language: string;
}): Promise<boolean> {
  const minutes = await checkCallMinutesAllowed(opts.orgId);
  if (minutes.allowed) return false;

  await prisma.call
    .create({
      data: {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        agentId: opts.agentId,
        phoneNumberId: opts.phoneNumberId,
        direction: 'INBOUND',
        status: 'COMPLETED',
        fromNumber: opts.from,
        toNumber: opts.to,
        providerSid: opts.providerSid,
        language: opts.language,
        startedAt: new Date(),
        endedAt: new Date(),
        endedReason: 'over_limit',
      },
    })
    .catch((e) => console.error('[inbound] over-limit call log failed', e));

  console.error(
    '[inbound] refused call to', opts.to, '— org', opts.orgId,
    minutes.credits.allowed
      ? `has used ${minutes.used} of ${minutes.limit} plan minutes`
      : `has used ${minutes.used} minutes against ${minutes.credits.allowanceMinutes} prepaid (balance ${minutes.credits.balanceMinutes} + ${minutes.credits.toleranceMinutes} tolerance)`,
  );
  return true;
}
