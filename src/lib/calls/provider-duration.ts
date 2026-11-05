import { prisma } from '@/lib/db';
import { syncCallUsage } from '@/lib/usage/ledger';

// Who decides how long a call was — because two sources disagree and the answer
// is billed.
//
// `finalizeCallRecord` writes the media socket's elapsed time. The carrier's
// status webhook (Twilio, Exotel, Plivo) independently reports its own figure,
// which counts ringing as well as talking. Both used to write `durationSec`
// unconditionally, so the number a customer was billed for depended on which
// arrived last: a call that rang 25s and talked 40s billed as 40 or 65 for the
// same call.
//
// The voice pipeline wins, deliberately. We sell agent conversation, not carrier
// connect time, and the pipeline's figure is the one the transcript supports.
// The carrier's figure is still worth having for calls the pipeline never saw —
// a NO_ANSWER, a call that never reached the media socket — so it is written
// only where the pipeline left nothing.
//
// The `endedReason` exclusion is the other half. A call that connected but where
// nobody ever spoke is recorded with a zero duration on purpose; without this, a
// late carrier callback would overwrite that with a billable number for a call
// that produced no conversation at all.

/** Reasons that mean "the pipeline saw this call and there was nothing to bill". */
export const SILENT_CALL_REASONS = ['no_conversation', 'stale_no_conversation'];

/**
 * Record the carrier's duration, but only for a call the voice pipeline never
 * timed. Never overwrites a duration that is already set.
 */
export async function fillProviderDuration(
  callId: string,
  durationSec: number | null | undefined,
): Promise<void> {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) return;
  try {
    const res = await prisma.call.updateMany({
      where: {
        id: callId,
        // The whole point: only fill a gap, never correct the pipeline.
        durationSec: 0,
        OR: [{ endedReason: null }, { endedReason: { notIn: SILENT_CALL_REASONS } }],
      },
      data: { durationSec },
    });
    // Only when this write actually landed. `count === 0` means the pipeline had
    // already timed the call and this carrier figure was correctly ignored — so
    // there is nothing new for the ledger either, and syncing anyway would just
    // re-read a row the pipeline has already mirrored.
    if (res.count === 1) await syncCallUsage(callId);
  } catch (err) {
    // Under-billing one call is worth far less than failing the webhook, which
    // some carriers retry and some silently drop.
    console.error('[call-duration] could not record provider duration for', callId, err);
  }
}
