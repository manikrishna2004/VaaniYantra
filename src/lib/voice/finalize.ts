import { prisma } from '@/lib/db';
import { summarizeCall } from '@/lib/voice/conversation';
import { dispatchCallEvent } from '@/lib/webhooks';
import { pushCallToCrm } from '@/lib/crm';
import type { LiveUsage } from '@/lib/voice/usage';
import { syncCallUsage } from '@/lib/usage/ledger';

/** What the call cost to run, where the pipeline was able to measure it. */
export type CallUsage = { usage: LiveUsage; model: string; costInr: number };

function usageColumns(u: CallUsage | undefined) {
  if (!u) return {};
  return {
    llmModel: u.model || null,
    llmTurns: u.usage.turns,
    llmPromptTokens: u.usage.promptTokens,
    llmResponseTokens: u.usage.responseTokens,
    llmAudioInTokens: u.usage.audioInTokens,
    llmAudioOutTokens: u.usage.audioOutTokens,
    llmCostInr: u.costInr,
  };
}

// Shared end-of-call bookkeeping for both voice pipelines (Gemini Live and the
// STT→LLM→TTS cascade). A call where nothing was ever said — the media socket
// dropped before or at the greeting — is recorded as FAILED with zero duration
// (not billable); a real conversation is summarized, marked COMPLETED, and
// fans out the post-call actions.
export async function finalizeCallRecord(
  callId: string,
  elapsedMs: number,
  callUsage?: CallUsage,
): Promise<'failed' | 'completed'> {
  const turns = await prisma.transcriptTurn.count({ where: { callId } });
  if (turns === 0) {
    // Usage is written here too. A call that got as far as a greeting spent
    // real tokens even though it is not billable to the customer, and that
    // spend is invisible in the invoice unless it lands on the record.
    await prisma.call.update({
      where: { id: callId },
      data: {
        status: 'FAILED',
        endedAt: new Date(),
        durationSec: 0,
        endedReason: 'no_conversation',
        ...usageColumns(callUsage),
      },
    });
    // Shadow-mode dual write. A zero-duration row is still recorded: "this call
    // produced nothing billable" is a fact the drift report needs, and its
    // absence would look identical to a call the ledger simply missed.
    await syncCallUsage(callId);
    void dispatchCallEvent(callId, 'call.failed').catch((e) => console.error('[finalize] call.failed webhook', e));
    return 'failed';
  }

  const durationSec = Math.max(1, Math.round(elapsedMs / 1000));
  const summary = await summarizeCall(callId);
  await prisma.call.update({
    where: { id: callId },
    data: {
      status: 'COMPLETED',
      endedAt: new Date(),
      durationSec,
      summary,
      recordingUrl: `/api/calls/${callId}/recording`,
      endedReason: 'completed',
      ...usageColumns(callUsage),
    },
  });
  // Shadow-mode dual write: the ledger is written on every call and read by
  // nothing but the drift report until an org is flipped to it. Awaited rather
  // than fired off, so the row exists before the webhook tells anyone the call
  // is done — but syncCallUsage never throws, so it cannot fail the call.
  await syncCallUsage(callId);
  void dispatchCallEvent(callId, 'call.completed').catch((e) => console.error('[finalize] call.completed webhook', e));
  void pushCallToCrm(callId).catch((e) => console.error('[finalize] crm push', e));
  return 'completed';
}
