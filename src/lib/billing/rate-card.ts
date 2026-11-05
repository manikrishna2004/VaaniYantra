import { prisma } from '@/lib/db';
import { planAt } from '@/lib/plan-history';
import { getEffectivePlan, type BillableRate, type Plan } from '@/lib/billing/catalogue';
import type { Db } from '@/lib/usage/period';

// ── What one client actually pays ───────────────────────────────────────────
//
// One function answers it — `rateFor(orgId, at)` — and everything that prices a
// minute goes through it. Precedence, highest first:
//
//   1. the RateCard in force for that org at that moment,
//   2. the founder's plan overrides from /admin (PlatformConfig),
//   3. the PLANS catalogue.
//
// (2) and (3) are `getEffectivePlan()`, unchanged and still doing its own job.
// This module adds (1) on top of it, which is why an org with no card resolves
// to precisely the numbers it resolved to before this file existed. That is the
// whole safety property of the phase: it ships with zero rows, so it ships as a
// behavioural no-op, and the first row is written deliberately for one client.
//
// TIME IS AN ARGUMENT, NOT `now()`. The sweep runs on the 2nd and prices the
// month that just ended, so "the rate" is always "the rate on that date" — the
// same discipline `planAt()` enforces for plans. A card agreed in April cannot
// be allowed to reprice March, because March's charge is unique per (org,
// month) and an invoice has already been built from it.

/** A rate card as the rest of the codebase reads it: plain numbers, no Decimal. */
export type EffectiveRate = BillableRate & {
  /** Where the numbers came from. `plan` means this org has no card. */
  source: 'card' | 'plan';
  /** The card that priced it, for audit trails and admin screens. */
  cardId: string | null;
  /** The plan key the org held at `at` — still stamped onto every charge. */
  planKey: string;
  /** The effective plan, kept for limits, names and the billing page. */
  plan: Plan;
  currency: string;
  /** What the minute costs us upstream. Never charged; used by the margin report. */
  costPerMinute: number | null;
  /** Flat monthly fee for the automation work. 0 when there is no card. */
  retainerInr: number;
  /** Monthly floor on the usage charge. 0 = no commitment. */
  minimumInr: number;
  /** Runaway-usage stop. `Infinity` when neither card nor plan sets one. */
  monthlyMinuteCap: number;
  /** Prices for non-voice metrics, keyed by `UsageEvent.metric`. */
  metricRates: Record<string, number>;
};

/**
 * Prisma hands Decimal columns back as Decimal objects; tests and JSON hand
 * them back as numbers. Both have to work, and a NaN here would price a call.
 */
function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    const n = (v as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function rates(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = num(raw);
    if (n !== null) out[k] = n;
  }
  return out;
}

/**
 * The card in force for an org at a moment, or null.
 *
 * Ordered by `effectiveFrom` descending so that a card inserted to supersede
 * another wins on the day they overlap — `effectiveTo` is set on the old one,
 * but a clock skew of a second must not leave a client briefly unpriced.
 */
export async function cardFor(orgId: string, at: Date, db: Db = prisma) {
  return db.rateCard.findFirst({
    where: {
      orgId,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

/**
 * What this org pays, at this moment.
 *
 * `planKey` may be passed by a caller that has already resolved it — the sweep
 * has it from `planAt()`, and the call-admission path has it from the org row —
 * so the hot path does not pay for a second history lookup.
 */
export async function rateFor(
  orgId: string,
  at: Date = new Date(),
  opts: { planKey?: string | null; db?: Db } = {},
): Promise<EffectiveRate> {
  const db = opts.db ?? prisma;
  const [card, planKey] = await Promise.all([
    cardFor(orgId, at, db),
    opts.planKey !== undefined ? Promise.resolve(opts.planKey) : planAt(orgId, at),
  ]);
  const plan = await getEffectivePlan(planKey);

  // No card: the catalogue answer, byte for byte. Every field below is the one
  // the old code read off the plan, which is what makes this a no-op today.
  if (!card) {
    return {
      source: 'plan',
      cardId: null,
      planKey: planKey ?? plan.key,
      plan,
      currency: 'INR',
      usageBased: plan.usageBased ?? false,
      pricePerMinute: plan.pricePerMinute,
      overagePerMinute: plan.overagePerMinute,
      includedMinutes: plan.limits.callMinutesPerMonth,
      costPerMinute: null,
      retainerInr: 0,
      minimumInr: 0,
      monthlyMinuteCap: plan.limits.callMinutesPerMonth,
      metricRates: {},
    };
  }

  const pricePerMinute = num(card.pricePerMinute) ?? 0;
  const cap = card.monthlyMinuteCap ?? null;
  return {
    source: 'card',
    cardId: card.id,
    planKey: planKey ?? plan.key,
    plan,
    currency: card.currency ?? 'INR',
    // A card is a per-minute price by definition: there is no included bundle
    // to run past, so every minute is billable from the first one. Saying so
    // explicitly is what makes `overageForRate` bill the whole month rather
    // than the tail of it.
    usageBased: true,
    pricePerMinute,
    // The card's price overrides BOTH plan numbers. Leaving overagePerMinute on
    // the plan's value would bill minutes past a bundle at the catalogue rate
    // while billing the rest at the agreed one.
    overagePerMinute: pricePerMinute,
    includedMinutes: Infinity,
    costPerMinute: num(card.costPerMinute),
    retainerInr: num(card.retainerInr) ?? 0,
    minimumInr: num(card.minimumInr) ?? 0,
    monthlyMinuteCap: cap ?? plan.limits.callMinutesPerMonth,
    metricRates: rates(card.metricRates),
  };
}

/**
 * Is there anything to bill this org for at all?
 *
 * Replaces the sweep's old catalogue allowlist for carded orgs. A retainer or a
 * minimum is billable on its own: an agency client can owe money in a month
 * nobody picked up the phone, which is exactly the case a per-minute allowlist
 * gets wrong.
 */
export function isBillableRate(rate: EffectiveRate): boolean {
  return (rate.pricePerMinute ?? 0) > 0 || rate.retainerInr > 0 || rate.minimumInr > 0;
}

/**
 * Agree a new rate for a client, from `effectiveFrom` onwards.
 *
 * Append-only: the standing card is CLOSED rather than edited, in the same
 * transaction, so there is never a moment with two live cards and never a past
 * month whose price silently changed. Re-running it for the same date is not
 * idempotent by design — a rate change is a decision someone made, not a
 * message that might be replayed.
 *
 * ⚠ This is the one-way door in this phase. The first card for a client is the
 * price they were quoted.
 */
export async function setRateCard(args: {
  orgId: string;
  effectiveFrom: Date;
  pricePerMinute: number;
  currency?: string;
  costPerMinute?: number | null;
  retainerInr?: number | null;
  minimumInr?: number | null;
  monthlyMinuteCap?: number | null;
  metricRates?: Record<string, number> | null;
  note?: string | null;
  createdById?: string | null;
}): Promise<{ id: string }> {
  if (!(args.pricePerMinute >= 0)) throw new Error('pricePerMinute must be a number >= 0');

  return prisma.$transaction(async (tx) => {
    // Close whatever is standing at that date. `updateMany` rather than a
    // findFirst-then-update: two admins agreeing a card at once must not leave
    // one of the old rows open.
    await tx.rateCard.updateMany({
      where: {
        orgId: args.orgId,
        effectiveTo: null,
        effectiveFrom: { lte: args.effectiveFrom },
      },
      data: { effectiveTo: args.effectiveFrom },
    });
    const created = await tx.rateCard.create({
      data: {
        orgId: args.orgId,
        effectiveFrom: args.effectiveFrom,
        currency: args.currency ?? 'INR',
        pricePerMinute: args.pricePerMinute,
        costPerMinute: args.costPerMinute ?? null,
        retainerInr: args.retainerInr ?? null,
        minimumInr: args.minimumInr ?? null,
        monthlyMinuteCap: args.monthlyMinuteCap ?? null,
        metricRates: args.metricRates ?? undefined,
        note: args.note ?? null,
        createdById: args.createdById ?? null,
      },
      select: { id: true },
    });
    return created;
  });
}
