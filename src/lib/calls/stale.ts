import { prisma } from '@/lib/db';
import { setPlatformConfig, getPlatformConfig } from '@/lib/platform';
import { syncCallUsage } from '@/lib/usage/ledger';

// Reconcile calls that are still flagged active but stopped being live.
//
// Every normal end-of-call path writes a terminal status: the media socket's
// close handler runs finalizeCallRecord(), and the provider's status webhook
// maps completed/busy/failed onto the Call row. Both signals can be lost:
//
//   - the voice-server dies mid-call (crash, OOM, deploy restart), so the ws
//     'close' handler never runs and the row stays IN_PROGRESS, or
//   - the provider never delivers a terminal status callback (misrouted URL, a
//     rejected or dropped retry), so an outbound row stays QUEUED/RINGING.
//
// Nothing else ever revisited those rows, so they stayed "active" forever and
// the Live Calls page showed day-old calls with the elapsed timer still
// counting up. This sweeper is the thing that revisits them.
//
// Liveness is judged by the last transcript turn, not by wall-clock age: turns
// are written one at a time while the call is happening (see recordTurn), so a
// call that is genuinely still talking keeps pushing its own deadline forward
// and is never reaped, however long it runs.

export const ACTIVE_STATUSES = ['QUEUED', 'RINGING', 'IN_PROGRESS'];

/** How long a call may show no activity at all before it is presumed dead. */
export const STALE_AFTER_MS = parseInt(process.env.STALE_CALL_AFTER_MS || '900000', 10); // 15m

const TICK_MS = parseInt(process.env.STALE_CALL_TICK_MS || '300000', 10); // 5m

export interface StaleSweepResult {
  /** False when a sweep was already in flight and this call was a no-op. */
  ran: boolean;
  completed: number;
  failed: number;
}

let started = false;
let ticking = false;

export async function sweepStaleCalls(now = new Date()): Promise<StaleSweepResult> {
  if (ticking) return { ran: false, completed: 0, failed: 0 };
  ticking = true;
  try {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);

    // A call created after the cutoff cannot have last-activity older than it,
    // so this bounds the scan to genuine candidates.
    const candidates = await prisma.call.findMany({
      where: { status: { in: ACTIVE_STATUSES }, createdAt: { lt: cutoff } },
      select: {
        id: true,
        createdAt: true,
        startedAt: true,
        transcript: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      },
    });

    let completed = 0;
    let failed = 0;

    for (const call of candidates) {
      const lastTurnAt = call.transcript[0]?.createdAt ?? null;
      const startedAt = call.startedAt ?? call.createdAt;
      const lastActivity = lastTurnAt ?? startedAt;
      if (lastActivity > cutoff) continue; // still talking — leave it alone

      // Duration is billed (the overage sweep reads durationSec), so a reaped
      // call is only ever charged up to the last thing that was actually said.
      // Billing to `now` would invoice days of silence.
      const data = lastTurnAt
        ? {
            // A real conversation happened; only its end signal was lost.
            status: 'COMPLETED',
            endedAt: lastTurnAt,
            durationSec: Math.max(1, Math.round((lastTurnAt.getTime() - startedAt.getTime()) / 1000)),
            endedReason: 'stale_no_end_signal',
          }
        : {
            // Nothing was ever said — it never connected, or died at the
            // greeting. Not billable, mirroring finalizeCallRecord's
            // no_conversation branch.
            status: 'FAILED',
            endedAt: startedAt,
            durationSec: 0,
            endedReason: 'stale_no_conversation',
          };

      // Re-check the status in the WHERE clause: the real end signal may have
      // landed between the read above and this write, and it wins.
      const res = await prisma.call.updateMany({
        where: { id: call.id, status: { in: ACTIVE_STATUSES } },
        data,
      });
      if (res.count === 0) continue;
      // Shadow-mode dual write. Only for a call this reaper actually claimed:
      // count === 0 means the real end signal landed first and finalizeCallRecord
      // owns the row, ledger row included.
      await syncCallUsage(call.id);
      if (data.status === 'COMPLETED') completed++;
      else failed++;
    }

    // Deliberately no finalizeCallRecord() here. Its fan-out — summary,
    // call.completed webhook, calendar appointment, CRM push — is written for a
    // call that just ended. Replaying it hours or days late would post-date a
    // webhook and book an appointment for a slot already in the past. The
    // endedReason records that these rows were reconciled, not finalized.
    if (completed || failed) {
      console.log(`[stale-calls] reconciled ${completed} completed, ${failed} failed`);
    }
    // Liveness marker. This sweeper is the only thing that closes out calls
    // whose end signal was lost, so if it stops, calls show as live forever —
    // the original bug. A stale marker says so before a customer does.
    await setPlatformConfig(LAST_SWEEP_KEY, now.toISOString()).catch((e) =>
      console.error('[stale-calls] could not stamp last-sweep marker', e),
    );

    return { ran: true, completed, failed };
  } finally {
    ticking = false;
  }
}

export const LAST_SWEEP_KEY = 'staleCalls.lastSweepAt';

/** ISO timestamp of the last completed stale-call sweep, or null if never. */
export async function lastStaleSweepAt(): Promise<string | null> {
  return getPlatformConfig(LAST_SWEEP_KEY);
}

export function startStaleCallSweeper(): void {
  if (started) return;
  started = true;
  // Run once at boot: the most common way a call is orphaned is the very
  // process restart that is happening right now.
  void sweepStaleCalls().catch((err) => console.error('[stale-calls] boot sweep error', err));
  setInterval(() => {
    sweepStaleCalls().catch((err) => console.error('[stale-calls] tick error', err));
  }, TICK_MS);
  console.log(`[stale-calls] sweeper started (tick ${TICK_MS}ms, stale after ${STALE_AFTER_MS}ms)`);
}
