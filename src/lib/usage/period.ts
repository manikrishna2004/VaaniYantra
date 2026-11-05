import { prisma } from '@/lib/db';

// Billing periods for the usage ledger, and the one piece of locking that makes
// a month safe to close.

/** A Prisma transaction client, or the client itself. */
export type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** "YYYY-MM" for a date, in UTC. Sorts lexicographically = chronologically. */
export function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First instant of a "YYYY-MM", UTC. */
export function monthStartOf(key: string): Date {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

/** First instant of the month AFTER a "YYYY-MM", UTC. */
export function monthEndOf(key: string): Date {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1));
}

/** The next "YYYY-MM" after this one. */
export function nextMonthKey(key: string): string {
  return monthKey(monthEndOf(key));
}

/**
 * The advisory-lock key that serialises everything touching one org's billing
 * period boundaries.
 *
 * Taken by BOTH the ledger writer (while it decides which month a row belongs
 * to) and the monthly sweep (across its read of the month's total AND its write
 * of the OverageCharge that closes it). Anything less lets this happen:
 *
 *   writer  reads "March is open"
 *   sweep   sums March
 *   sweep   writes OverageCharge(org, March)   ← March is now closed
 *   writer  inserts a March row                ← billed in a closed month,
 *                                                never collected
 *
 * Both sides must use this same key, or the lock protects nothing.
 */
export function billingLockKey(orgId: string): string {
  return `billing:${orgId}`;
}

/** Take the per-org billing lock for the rest of the transaction. */
export async function lockBillingPeriod(tx: Db, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${billingLockKey(orgId)}))`;
}

/**
 * Has this org's month already been settled?
 *
 * A month is closed exactly when an OverageCharge row exists for it. That is
 * not a new piece of state invented for the ledger — it is the same row, with
 * the same `@@unique([orgId, month])`, that already makes the monthly drawdown
 * exactly-once. Reusing it means there is one answer to "is March done?" rather
 * than two that can disagree.
 *
 * Note what is NOT closed: the sweep skips orgs on a non-billable plan, and
 * skips a zero-total month with no prepaid minutes to draw down, writing no row
 * in either case. Those months stay open forever, which is the safe direction —
 * a late row for one of them is simply billed in the month it happened.
 */
export async function isMonthClosed(tx: Db, orgId: string, month: string): Promise<boolean> {
  const row = await tx.overageCharge.findUnique({
    where: { orgId_month: { orgId, month } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Which month a piece of usage should be BILLED in, given when it happened.
 *
 * Normally the month it happened in. If that month is already settled, it rolls
 * forward to the earliest month that is still open — it is charged now, as a
 * prior-period adjustment, rather than reopening a settled month. Reopening is
 * not an option: an OverageCharge is what an Invoice was built from, and this
 * codebase treats an issued invoice as immutable (a correction is a new
 * document, never an edit).
 *
 * ⚠ The caller MUST hold the org's billing lock (lockBillingPeriod) and must
 * still hold it when the row is inserted. Deciding "March is open" and then
 * inserting outside the lock is exactly the race the lock exists to close.
 */
export async function assignBillingMonth(
  tx: Db,
  orgId: string,
  occurredAt: Date,
): Promise<{ billingMonth: string; originMonth: string }> {
  const originMonth = monthKey(occurredAt);
  const current = monthKey(new Date());

  let billingMonth = originMonth;
  // Walk forward until an open month, stopping at the current one: the current
  // month cannot be closed (its sweep has not run), so this always terminates
  // and never rolls a row into the future.
  while (billingMonth < current && (await isMonthClosed(tx, orgId, billingMonth))) {
    billingMonth = nextMonthKey(billingMonth);
  }
  return { billingMonth, originMonth };
}
