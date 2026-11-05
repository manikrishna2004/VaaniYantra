import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { assignBillingMonth, lockBillingPeriod, type Db } from '@/lib/usage/period';

// ── Writing to the usage ledger ─────────────────────────────────────────────
//
// Two entry points, and the difference between them matters:
//
//   recordUsage    — "this happened". Writes the original report at seq 0.
//                    A duplicate loses to the unique constraint and is a no-op.
//   reconcileUsage — "the authoritative total for this record is now N".
//                    Appends the DIFFERENCE at the next seq, or nothing when
//                    the total already matches.
//
// Everything here follows the exactly-once pattern this codebase already uses
// in creditMinutes() and consumePrepaid(): the insert is the claim, the unique
// constraint is the arbiter, and a Prisma P2002 is the SUCCESS case — it means
// somebody else already recorded exactly this, which is the outcome we wanted.

export type UsageSource = 'vaani_voice' | 'omnidimension' | 'client_cloud' | 'manual';
export type UsageMetric = 'voice.minutes' | 'voice.minutes.reported' | 'automation.run';

/** The metric billing reads. Nothing else is ever summed into a charge. */
export const BILLABLE_METRIC: UsageMetric = 'voice.minutes';

export type RecordUsageArgs = {
  orgId: string;
  workspaceId?: string | null;
  metric: UsageMetric;
  source: UsageSource;
  externalId: string;
  /** Canonical units. SECONDS for voice.minutes — never pre-rounded to minutes. */
  quantity: number;
  occurredAt: Date;
  costInr?: number | null;
  callId?: string | null;
  deploymentId?: string | null;
  raw?: Prisma.InputJsonValue;
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/**
 * Record the original report for a unit of usage.
 *
 * Idempotent on (source, externalId): a second call for the same record loses
 * to the unique constraint and returns `{ recorded: false }`. That is not an
 * error — a replayed poll, an overlapping cron and a manual re-sync are all
 * expected, and all three must converge on one row.
 *
 * A zero quantity still writes a row. It is a real fact ("this call produced no
 * billable time") and it is what stops a later correction from being mistaken
 * for a first report.
 */
export async function recordUsage(
  args: RecordUsageArgs,
): Promise<{ recorded: boolean; billingMonth: string | null }> {
  const quantity = Math.round(args.quantity);
  if (!Number.isFinite(quantity)) return { recorded: false, billingMonth: null };

  try {
    return await prisma.$transaction(async (tx) => {
      // Held for the rest of the transaction, so the month cannot be closed
      // between deciding which one this belongs to and inserting into it.
      await lockBillingPeriod(tx, args.orgId);
      const { billingMonth, originMonth } = await assignBillingMonth(tx, args.orgId, args.occurredAt);

      await tx.usageEvent.create({
        data: {
          orgId: args.orgId,
          workspaceId: args.workspaceId ?? null,
          metric: args.metric,
          source: args.source,
          externalId: args.externalId,
          seq: 0,
          quantity,
          occurredAt: args.occurredAt,
          billingMonth,
          originMonth,
          costInr: args.costInr ?? null,
          callId: args.callId ?? null,
          deploymentId: args.deploymentId ?? null,
          raw: args.raw,
        },
      });
      return { recorded: true, billingMonth };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { recorded: false, billingMonth: null };
    throw err;
  }
}

/**
 * Set the authoritative total for a record, appending only the difference.
 *
 * Use this whenever a source can REVISE what it previously reported — a
 * provider that corrects a duration days later, or our own pipeline overwriting
 * a figure the carrier filled in first. Writes nothing when the total already
 * matches, so it is safe to call on every sync.
 *
 * ⚠ The unique constraint does NOT make this safe on its own. Two callers can
 * both read "current total 300", both compute a delta of -40, and land at seq 1
 * and seq 2 — the constraint is satisfied and the account is short 40. So the
 * read-sum-then-append is serialised per external record with an advisory lock,
 * the same idiom nextInvoiceNumber() uses for the invoice series. Corrections
 * are rare, so this costs nothing on the common path.
 */
export async function reconcileUsage(
  args: Omit<RecordUsageArgs, 'quantity'> & { totalQuantity: number },
): Promise<{ deltaApplied: number; seq: number | null }> {
  const total = Math.round(args.totalQuantity);
  if (!Number.isFinite(total)) return { deltaApplied: 0, seq: null };

  // Fast path: the first report for a record is the overwhelmingly common case
  // and needs no lock of its own — the unique constraint settles a race between
  // two first-writers, and the loser falls through to the locked path below.
  const first = await recordUsage({ ...args, quantity: total });
  if (first.recorded) return { deltaApplied: total, seq: 0 };

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`usage:${args.source}:${args.externalId}`}))`;

    const rows = await tx.usageEvent.findMany({
      where: { source: args.source, externalId: args.externalId },
      select: { seq: true, quantity: true },
      orderBy: { seq: 'desc' },
    });
    if (rows.length === 0) {
      // The seq-0 row was deleted between the fast path and here. Vanishingly
      // unlikely (the table is append-only), but recording nothing would lose
      // the usage silently, so treat it as a first report.
      const retry = await recordUsage({ ...args, quantity: total });
      return { deltaApplied: retry.recorded ? total : 0, seq: retry.recorded ? 0 : null };
    }

    const current = rows.reduce((sum, r) => sum + r.quantity, 0);
    const delta = total - current;
    if (delta === 0) return { deltaApplied: 0, seq: null };

    const seq = rows[0].seq + 1;
    // The correction is billed in whatever month is open NOW, not in the month
    // the call happened in — that month may be settled, and its OverageCharge
    // is what an immutable invoice was built from.
    await lockBillingPeriod(tx, args.orgId);
    const { billingMonth, originMonth } = await assignBillingMonth(tx, args.orgId, args.occurredAt);

    await tx.usageEvent.create({
      data: {
        orgId: args.orgId,
        workspaceId: args.workspaceId ?? null,
        metric: args.metric,
        source: args.source,
        externalId: args.externalId,
        seq,
        quantity: delta,
        occurredAt: args.occurredAt,
        billingMonth,
        originMonth,
        costInr: args.costInr ?? null,
        callId: args.callId ?? null,
        deploymentId: args.deploymentId ?? null,
        raw: args.raw,
      },
    });
    return { deltaApplied: delta, seq };
  });
}

/**
 * Mirror a Call's current billable duration into the ledger.
 *
 * The single hook the voice pipeline, the carrier gap-filler and the stale-call
 * reaper all use. It re-reads the Call row rather than taking a duration as an
 * argument, which means:
 *
 *   • whichever of the three wrote last, the ledger converges on the same
 *     number the billing path reads today — which is exactly the invariant the
 *     drift report checks while the ledger runs in shadow;
 *   • the "pipeline beats carrier" rule in fillProviderDuration needs no
 *     restating here. It is already settled in the Call row by the time we look.
 *
 * NEVER throws. A ledger nobody reads yet must not be able to fail a call, a
 * webhook a carrier will retry, or the reaper. It logs and moves on — the
 * backfill script can always reconstruct a row it missed.
 */
export async function syncCallUsage(callId: string): Promise<void> {
  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        id: true,
        workspaceId: true,
        durationSec: true,
        createdAt: true,
        startedAt: true,
        llmCostInr: true,
        workspace: { select: { orgId: true } },
      },
    });
    // No workspace means no organisation to bill. Inbound calls can land before
    // routing resolves one; there is nothing to record against.
    if (!call?.workspace?.orgId) return;

    await reconcileUsage({
      orgId: call.workspace.orgId,
      workspaceId: call.workspaceId,
      metric: BILLABLE_METRIC,
      source: 'vaani_voice',
      externalId: call.id,
      totalQuantity: call.durationSec,
      // The call's own clock, not now(): a reaped call is billed in the month it
      // happened in, not the month the reaper noticed.
      occurredAt: call.startedAt ?? call.createdAt,
      callId: call.id,
    });
  } catch (err) {
    console.error('[usage] could not sync call to the ledger:', callId, err);
  }
}
