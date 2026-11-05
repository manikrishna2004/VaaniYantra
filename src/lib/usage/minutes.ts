import { prisma } from '@/lib/db';
import { BILLABLE_METRIC } from '@/lib/usage/ledger';
import { monthKey, monthStartOf, monthEndOf, type Db } from '@/lib/usage/period';

// ── The one place a billable minute is counted ──────────────────────────────
//
// Every billing read goes through `billableMinutes`, and it resolves which
// source is authoritative the same way `planAt()` resolves which plan applied:
// by comparing the period against the date the change took effect, so a PAST
// month is measured the way it was measured then.
//
// ⚠ In shadow mode nothing in the billing path calls this yet. getUsage(),
// checkCallMinutesAllowed(), getPrepaidState() and runOverageSweep() still read
// Call.durationSec directly. They are re-pointed here only once the drift
// report has been clean for two closed months — see scripts/usage-drift.ts.

export type Period = { key: string; from: Date; to: Date };

/** The calendar month a date falls in, as a period. */
export function periodFor(at: Date = new Date()): Period {
  const key = monthKey(at);
  return { key, from: monthStartOf(key), to: monthEndOf(key) };
}

/**
 * Minutes billed to an org from the CALLS table — today's behaviour, byte for
 * byte.
 *
 * The rounding is deliberately identical to billing.ts, prepaid.ts and
 * overage-sweep.ts: one Math.round over the summed SECONDS. Rounding anywhere
 * else, or per row, changes what live orgs are charged.
 */
export async function callMinutesInPeriod(orgId: string, period: Period, db: Db = prisma): Promise<number> {
  const agg = await db.call.aggregate({
    where: { workspace: { orgId }, createdAt: { gte: period.from, lt: period.to } },
    _sum: { durationSec: true },
  });
  return Math.round((agg._sum.durationSec ?? 0) / 60);
}

/**
 * Minutes billed to an org from the LEDGER.
 *
 * Filtered on `billingMonth`, not on occurredAt: a correction that arrived
 * after its own month closed is billed in the month it landed in, and this is
 * the read that has to agree with that. Only `voice.minutes` is summed —
 * `voice.minutes.reported` is what an untrusted deployment says about itself
 * and is never charged for.
 *
 * One index-only scan on (orgId, billingMonth, metric), which is cheaper than
 * the calls path: that one joins through workspace on what is also the hot
 * call-admission check.
 */
export async function ledgerMinutesInPeriod(orgId: string, period: Period, db: Db = prisma): Promise<number> {
  const agg = await db.usageEvent.aggregate({
    where: { orgId, billingMonth: period.key, metric: BILLABLE_METRIC },
    _sum: { quantity: true },
  });
  return Math.round((agg._sum.quantity ?? 0) / 60);
}

/**
 * Which source was authoritative for this org in this period.
 *
 * `usageSourceSince` is the "YYYY-MM" the flip took effect, and "YYYY-MM" sorts
 * lexicographically in chronological order — so a month before the flip is
 * still measured from calls, which is what makes a re-run of an old month
 * produce the number it produced the first time.
 */
export function sourceForPeriod(
  org: { usageSource: string; usageSourceSince: string | null },
  period: Period,
): 'calls' | 'ledger' {
  if (org.usageSource !== 'ledger') return 'calls';
  if (!org.usageSourceSince) return 'ledger';
  return period.key >= org.usageSourceSince ? 'ledger' : 'calls';
}

/**
 * Billable minutes for one org in one period, from whichever source is
 * authoritative for it.
 *
 * This is the function the whole billing path will call. Until then it backs
 * the drift report only.
 */
export async function billableMinutes(orgId: string, period: Period, db: Db = prisma): Promise<number> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { usageSource: true, usageSourceSince: true },
  });
  // An org we cannot read is measured the way every org has always been
  // measured. Failing open to the ledger would bill from a table that may be
  // empty for this account.
  if (!org) return callMinutesInPeriod(orgId, period, db);

  return sourceForPeriod(org, period) === 'ledger'
    ? ledgerMinutesInPeriod(orgId, period, db)
    : callMinutesInPeriod(orgId, period, db);
}

export type Drift = {
  orgId: string;
  orgName: string;
  month: string;
  callMinutes: number;
  ledgerMinutes: number;
  /** ledger − calls. Zero is the only acceptable value before a flip. */
  deltaMinutes: number;
  source: 'calls' | 'ledger';
};

/**
 * Compare both sources for every org in a month.
 *
 * This is the gate on Phase 3. An org is only moved onto the ledger after two
 * consecutive CLOSED months where this reports a zero delta for it — anything
 * else means the dual-write is missing calls, and flipping would silently
 * under- or over-bill a real customer.
 */
export async function usageDrift(month: string): Promise<Drift[]> {
  const period: Period = { key: month, from: monthStartOf(month), to: monthEndOf(month) };
  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, usageSource: true, usageSourceSince: true },
    orderBy: { createdAt: 'asc' },
  });

  const out: Drift[] = [];
  for (const org of orgs) {
    const [callMinutes, ledgerMinutes] = await Promise.all([
      callMinutesInPeriod(org.id, period),
      ledgerMinutesInPeriod(org.id, period),
    ]);
    // An org with no activity either way is not interesting, and listing every
    // dormant account buries the ones that matter.
    if (callMinutes === 0 && ledgerMinutes === 0) continue;
    out.push({
      orgId: org.id,
      orgName: org.name,
      month,
      callMinutes,
      ledgerMinutes,
      deltaMinutes: ledgerMinutes - callMinutes,
      source: sourceForPeriod(org, period),
    });
  }
  return out;
}
