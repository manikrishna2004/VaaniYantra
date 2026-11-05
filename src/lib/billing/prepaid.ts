import { prisma } from '@/lib/db';
import { rateFor } from '@/lib/billing/rate-card';
import { allowanceMinutes, toleranceMinutes, creditsRequired, isPrepaidWallet } from '@/lib/billing/credits';
import { billableMinutes, periodFor } from '@/lib/usage/minutes';
import type { Db } from '@/lib/usage/period';

// ── Prepaid minutes ─────────────────────────────────────────────────────────
//
// The arrangement, in one paragraph: the clinic estimates the minutes it
// expects to use, pays for them before it uses them, and those minutes sit as a
// balance on the organisation. Usage draws the balance down at the end of each
// month. If they guessed low, the minutes past the balance are invoiced then —
// they are NOT blocked, because a phone that stops answering because someone
// under-estimated in January is worse than an invoice.
//
// Two properties this is built around:
//
//   1. **The balance carries forward.** Whatever is left after a month's sweep
//      stays. It is money already paid; expiring it at a month boundary would
//      be charging for the same minutes twice.
//   2. **Drawdown happens once, in the sweep.** Not on every call. The sweep
//      already has exactly-once semantics per org per month (the unique on
//      OverageCharge), so putting the decrement there means a replayed sweep,
//      a double-clicked admin button and a cron overlap all leave the balance
//      alone. Deducting per call would need its own idempotency story on the
//      hottest path in the product.

/** Sold in whole minutes, and never fewer than this — a ₹35 order costs more to process than it earns. */
export const MIN_TOPUP_MINUTES = 100;
/** A guard against a typo turning 2,000 into 200,000, not a policy about how much anyone may buy. */
export const MAX_TOPUP_MINUTES = 200_000;

export type TopUpQuote = { minutes: number; ratePerMinute: number; amountInr: number };

/**
 * What N minutes cost this org, pre-tax.
 *
 * The rate comes from the org's own RATE — its client rate card if it has one,
 * otherwise its plan — rather than from the constant. So an org moved to the
 * volume rate tops up at the volume rate, an org on an agreed card tops up at
 * the agreed price, and a rate overridden in /admin is honoured too.
 *
 * Gated on the RATE being per-minute, not on the plan being usage-based. That
 * inference locked a legacy-plan org out of buying the minutes it had just been
 * sold a card for: the card prices every minute, and the top-up page told the
 * client its account was on a monthly plan.
 *
 * `usageBased` is still half the test, and has to be: the legacy monthly plans
 * carry a `pricePerMinute` too — it is what their included allowance was
 * derived from, not a price anyone can buy minutes at. A card sets usageBased
 * by construction, so a carded org passes either way.
 */
export async function quoteTopUp(orgId: string, minutes: number): Promise<TopUpQuote | { error: string }> {
  const whole = Math.floor(minutes);
  if (!Number.isFinite(whole) || whole < MIN_TOPUP_MINUTES) {
    return { error: `Buy at least ${MIN_TOPUP_MINUTES} minutes.` };
  }
  if (whole > MAX_TOPUP_MINUTES) {
    return { error: `That is more than ${MAX_TOPUP_MINUTES.toLocaleString('en-IN')} minutes — email us and we will arrange it directly.` };
  }

  const rate = await rateFor(orgId);
  const perMinute = rate.pricePerMinute ?? 0;
  if (!rate.usageBased || perMinute <= 0) {
    return { error: 'Prepaid minutes apply to the per-minute rate. Your account is on a monthly plan.' };
  }

  return { minutes: whole, ratePerMinute: perMinute, amountInr: Math.round(whole * perMinute * 100) / 100 };
}

export type PrepaidState = {
  /** Minutes bought and not yet drawn down. */
  balanceMinutes: number;
  /** Call minutes so far in the current calendar month. */
  usedThisMonth: number;
  /** Of those, how many the balance already covers. */
  coveredThisMonth: number;
  /** The rest — what will be invoiced after the month ends. */
  uncoveredThisMonth: number;
  ratePerMinute: number;
  /** ₹ that would be invoiced if the month ended now (pre-tax). */
  dueInr: number;
  /** What the balance would be after this month's usage is drawn down. */
  balanceAfterMinutes: number;
  /** Credits still unspent. 0 means this month is running on the tolerance. */
  remainingMinutes: number;
  /** The 10% of the balance that may be spoken past zero before calls stop. */
  toleranceMinutes: number;
  /** Balance + tolerance: everything that can be spoken this month. */
  allowanceMinutes: number;
  /** Whether running out actually stops calls for this org, or only invoices them. */
  creditsEnforced: boolean;
};

/** The billing page's whole picture: balance, this month's usage, and what is owed. */
export async function getPrepaidState(orgId: string): Promise<PrepaidState> {
  // Metered through billableMinutes rather than by summing Call.durationSec
  // here: an org served by a reseller, or by a deployment in its own cloud, has
  // minutes this table never saw. Orgs still on `calls` get the identical
  // number they always did — see src/lib/usage/minutes.ts.
  const [org, usedThisMonth] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { plan: true, prepaidMinutes: true, billingModel: true },
    }),
    billableMinutes(orgId, periodFor()),
  ]);
  // Priced from the org's rate card when it has one. Passing the plan key we
  // already read saves this page a second trip through the plan history.
  const rate = await rateFor(orgId, new Date(), { planKey: org?.plan ?? null });
  const balanceMinutes = Math.max(0, org?.prepaidMinutes ?? 0);
  const { covered, billable } = splitAgainstBalance(balanceMinutes, usedThisMonth);
  const ratePerMinute = rate.pricePerMinute ?? 0;

  return {
    balanceMinutes,
    usedThisMonth,
    coveredThisMonth: covered,
    uncoveredThisMonth: billable,
    ratePerMinute,
    dueInr: Math.round(billable * ratePerMinute * 100) / 100,
    balanceAfterMinutes: Math.max(0, balanceMinutes - covered),
    remainingMinutes: Math.max(0, balanceMinutes - usedThisMonth),
    toleranceMinutes: toleranceMinutes(balanceMinutes),
    allowanceMinutes: allowanceMinutes(balanceMinutes),
    // Read per-org rather than assumed: an org on a legacy monthly plan is
    // never stopped for credits, so telling it the line will cut out would be
    // a lie about its own account. Same rule the gate itself applies, from the
    // same function — two copies of it would eventually disagree, and the
    // disagreement would be a billing page contradicting the phone.
    creditsEnforced: isPrepaidWallet(org, rate.usageBased ?? false) && (await creditsRequired()),
  };
}

/**
 * How a month's usage divides against a balance.
 *
 * Pure, and separated from both callers on purpose: it is the one piece of
 * arithmetic that decides what a customer is charged, and it is the same
 * arithmetic whether it is being previewed on the billing page or committed by
 * the sweep. Two implementations of it would eventually disagree, and the
 * disagreement would be a customer told one number and billed another.
 */
export function splitAgainstBalance(
  balanceMinutes: number,
  usedMinutes: number,
): { covered: number; billable: number } {
  const used = Math.max(0, usedMinutes);
  const covered = Math.min(used, Math.max(0, balanceMinutes));
  return { covered, billable: used - covered };
}

/**
 * Credit paid-for minutes to an org, once.
 *
 * Idempotent on the gateway order: MinuteTopUp.gatewayOrderId is unique, and
 * the row is created in the same transaction that moves the balance, so a
 * webhook and a return-URL handler racing over the same payment credit the
 * minutes exactly once between them.
 */
export async function creditMinutes(args: {
  orgId: string;
  minutes: number;
  ratePerMinute: number;
  amountInr: number;
  gatewayOrderId: string;
}): Promise<{ credited: boolean }> {
  const minutes = Math.floor(args.minutes);
  if (!(minutes > 0)) return { credited: false };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.minuteTopUp.create({
        data: {
          orgId: args.orgId,
          minutes,
          ratePerMinute: args.ratePerMinute,
          amountInr: args.amountInr,
          gatewayOrderId: args.gatewayOrderId,
        },
      });
      await tx.organization.update({
        where: { id: args.orgId },
        data: { prepaidMinutes: { increment: minutes } },
      });
    });
    return { credited: true };
  } catch (err) {
    // A unique violation means this order was already credited — the outcome we
    // wanted. Anything else is real: the transaction rolled back, so nothing was
    // half-applied and a retry can still credit the minutes.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return { credited: false };
    }
    throw err;
  }
}

/**
 * Draw a month's usage off the balance when there is nothing left to bill.
 *
 * The sweep's normal path writes the charge and moves the balance in one
 * transaction, so the unique on (orgId, month) makes the drawdown exactly-once.
 * A month the balance covered entirely produces no charge, and without this it
 * would produce no drawdown either — the minutes would be spent and still be
 * sitting on the balance next month, free a second time.
 *
 * So the month still gets a row: a zero-rupee OverageCharge with status
 * `prepaid`. It is the receipt for the month, and it is what makes a re-run of
 * the sweep — or the admin button clicked twice — deduct the minutes once.
 */
export type PrepaidSettlement = {
  orgId: string;
  month: string;
  minutes: number;
  plan?: string | null;
  /** ₹/min those minutes were sold at. See `weightedTopUpRate`. */
  rateInr?: number | null;
};

// ── What the consumed minutes were SOLD at ──────────────────────────────────
//
// Prepaid revenue is recognised in the month the minutes are spoken, and the
// price is the one they were bought at — frozen in MinuteTopUp.ratePerMinute —
// not whatever the rate is when they are consumed. Those were the same number
// for as long as an org's rate could only change by changing its plan; a client
// rate card makes them different, and the difference is revenue recognised at
// the wrong price with nothing in the row to show it.
//
// FIFO, because a balance is a queue: the minutes bought first are the ones
// spoken first. `skipMinutes` is everything earlier months already drew down
// (the sum of OverageCharge.prepaidMinutes), which is what positions this month
// in that queue.

/**
 * The weighted ₹/min of `takeMinutes` drawn from `topUps`, oldest first, after
 * skipping the `skipMinutes` that earlier months consumed.
 *
 * Pure, and tested on its own: it is arithmetic that decides a number on a
 * financial record, and it has to be checked against a hand-worked example
 * rather than against itself.
 *
 * A balance larger than every top-up put together is possible — minutes granted
 * by hand leave no MinuteTopUp row — so the shortfall is priced at
 * `fallbackRate`, the org's current rate, rather than silently at zero.
 */
export function weightedTopUpRate(
  topUps: { minutes: number; ratePerMinute: number }[],
  skipMinutes: number,
  takeMinutes: number,
  fallbackRate: number,
): number | null {
  if (!(takeMinutes > 0)) return null;
  let skip = Math.max(0, skipMinutes);
  let remaining = takeMinutes;
  let value = 0;

  for (const t of topUps) {
    let available = Math.max(0, t.minutes);
    if (skip > 0) {
      const skipped = Math.min(skip, available);
      skip -= skipped;
      available -= skipped;
    }
    if (available <= 0) continue;
    const taken = Math.min(available, remaining);
    value += taken * t.ratePerMinute;
    remaining -= taken;
    if (remaining <= 0) break;
  }
  if (remaining > 0) value += remaining * Math.max(0, fallbackRate);

  return Math.round((value / takeMinutes) * 10000) / 10000;
}

/**
 * `weightedTopUpRate` against the database, on the caller's transaction.
 *
 * Read under the same per-org billing lock the sweep already holds, so a top-up
 * landing mid-sweep cannot change the queue between the split and the write.
 */
export async function prepaidRateForMinutes(
  tx: Db,
  args: { orgId: string; minutes: number; fallbackRate: number },
): Promise<number | null> {
  // Checked first: a month that consumed nothing must not cost two queries, and
  // the sweep's own tests mock only the tables it reaches.
  if (!(args.minutes > 0)) return null;
  const [topUps, prior] = await Promise.all([
    tx.minuteTopUp.findMany({
      where: { orgId: args.orgId },
      orderBy: { createdAt: 'asc' },
      select: { minutes: true, ratePerMinute: true },
    }),
    tx.overageCharge.aggregate({
      where: { orgId: args.orgId },
      _sum: { prepaidMinutes: true },
    }),
  ]);
  return weightedTopUpRate(topUps, prior._sum.prepaidMinutes ?? 0, args.minutes, args.fallbackRate);
}

/**
 * The two writes that settle a fully-covered month, on a transaction the CALLER
 * owns.
 *
 * Split out so the monthly sweep can perform them inside the same transaction
 * (and under the same per-org billing lock) that it uses to close the month,
 * without a second copy of the arithmetic drifting away from this one.
 *
 * ⚠ Raises P2002 on a re-run rather than swallowing it. That is deliberate: a
 * caught error inside a Postgres transaction still aborts the transaction, so
 * the caller cannot recover from it in place. `consumePrepaid` below owns the
 * transaction and so can catch it; the sweep instead holds the org's billing
 * lock and re-checks, which makes the conflict unreachable rather than handled.
 */
export async function settlePrepaidOnly(tx: Db, args: PrepaidSettlement): Promise<void> {
  const minutes = Math.floor(args.minutes);
  await tx.overageCharge.create({
    data: {
      orgId: args.orgId,
      month: args.month,
      minutes: 0,
      amountInr: 0,
      addonInr: 0,
      prepaidMinutes: minutes,
      prepaidRateInr: args.rateInr ?? null,
      plan: args.plan ?? null,
      status: 'prepaid',
    },
  });
  await tx.organization.update({
    where: { id: args.orgId },
    data: { prepaidMinutes: { decrement: minutes } },
  });
}

export async function consumePrepaid(args: PrepaidSettlement): Promise<{ consumed: boolean }> {
  const minutes = Math.floor(args.minutes);
  if (!(minutes > 0)) return { consumed: false };

  try {
    await prisma.$transaction((tx) => settlePrepaidOnly(tx, { ...args, minutes }));
    return { consumed: true };
  } catch (err) {
    // This month was already settled by another run of the sweep — which is the
    // outcome we wanted, and its drawdown already happened. Anything else rolled
    // the transaction back, so the balance is untouched and a retry is safe.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return { consumed: false };
    }
    throw err;
  }
}
