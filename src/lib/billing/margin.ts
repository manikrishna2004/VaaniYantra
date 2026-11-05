import { prisma } from '@/lib/db';
import { overageForRate } from '@/lib/billing/catalogue';
import { rateFor } from '@/lib/billing/rate-card';
import { BILLABLE_METRIC } from '@/lib/usage/ledger';
import { monthStartOf, monthEndOf } from '@/lib/usage/period';
import { billableMinutes } from '@/lib/usage/minutes';

// ── Margin, per org, per month ──────────────────────────────────────────────
//
// Reselling somebody else's minutes turns billing into two numbers instead of
// one: what the client pays, and what the minute cost us. Neither is new — the
// first is the charge we raise, the second is `UsageEvent.costInr` frozen at
// ingest — but nothing had ever subtracted them, so a deal quoted below cost
// would have looked exactly like a deal quoted above it until the supplier's
// invoice arrived at the end of the year.
//
// Three costs, deliberately kept apart rather than summed into one "cost":
//
//   supplierInr — what the reseller charged us, per call, at ingest.
//   llmInr      — what OUR pipeline spent on the model for the same month.
//                 Zero for an org served entirely by the reseller, which is the
//                 point: the two are alternatives, not layers.
//   revenueInr  — what we billed, which for a closed month is the charge we
//                 actually raised, not a re-derivation of it.
//
// REVENUE INCLUDES PREPAID. Minutes covered by the balance produced no rupees
// this month — they were paid for earlier — but they are revenue recognised in
// the month they were spoken, at the price they were SOLD at
// (OverageCharge.prepaidRateInr). Counting only the invoiced tail would report
// a negative margin for every client whose balance covered the month.

export type OrgMargin = {
  orgId: string;
  orgName: string;
  planKey: string;
  /** `card` when a client rate card priced the month. */
  rateSource: 'card' | 'plan';
  minutes: number;
  revenueInr: number;
  supplierInr: number;
  llmInr: number;
  marginInr: number;
  /** Margin as a percentage of revenue. 0 when there was no revenue. */
  marginPct: number;
  /**
   * True when the month has not been swept, so revenue is what the rate says it
   * WOULD be rather than what was charged. An open month is always projected.
   */
  projected: boolean;
};

export type MarginReport = {
  month: string;
  orgs: OrgMargin[];
  totals: {
    minutes: number;
    revenueInr: number;
    supplierInr: number;
    llmInr: number;
    marginInr: number;
    marginPct: number;
  };
  /**
   * Our own sum of what the supplier charged, against the invoice they sent.
   * A gap means the per-call cost we froze at ingest is wrong — which is a
   * silent margin bug, and the only place it ever surfaces.
   */
  supplier: {
    provider: string;
    /** Their invoice, converted at the rate frozen when it was entered. */
    invoicedInr: number | null;
    /** SUM(UsageEvent.costInr) for the month, across every org. */
    ledgerCostInr: number;
    /** invoiced − ledger. Null when no invoice has been entered yet. */
    gapInr: number | null;
  };
  /** Orgs billed at or below cost. The whole reason this report exists. */
  negative: OrgMargin[];
};

/** Prisma returns Decimal objects; tests and JSON return numbers. Both count. */
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    const n = (v as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Margin percentage, with the divide-by-zero answered rather than propagated. */
export function marginPctOf(revenueInr: number, marginInr: number): number {
  if (!(revenueInr > 0)) return 0;
  return Math.round((marginInr / revenueInr) * 1000) / 10;
}

/**
 * What we billed an org for a month.
 *
 * A closed month is read from the charge we RAISED — the row an invoice was
 * built from — rather than re-priced from the rate. Re-deriving it would make
 * this report disagree with the customer's invoice the moment a rate changed,
 * and the invoice is the one that is true.
 */
export function revenueFromCharge(charge: {
  amountInr: number;
  addonInr: number;
  prepaidMinutes: number;
  prepaidRateInr: number | null;
}): number {
  // The add-on is a flat WhatsApp fee with no per-minute cost behind it.
  // Leaving it in would flatter the margin on voice, which is what this
  // measures.
  const billed = charge.amountInr - charge.addonInr;
  const prepaid = Math.max(0, charge.prepaidMinutes) * Math.max(0, charge.prepaidRateInr ?? 0);
  return round2(billed + prepaid);
}

export async function marginForMonth(
  month: string,
  provider = 'omnidimension',
): Promise<MarginReport> {
  const period = { key: month, from: monthStartOf(month), to: monthEndOf(month) };

  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true, plan: true },
    orderBy: { createdAt: 'asc' },
  });

  const rows: OrgMargin[] = [];
  for (const org of orgs) {
    const [minutes, charge, supplierAgg, llmAgg] = await Promise.all([
      billableMinutes(org.id, period),
      prisma.overageCharge.findUnique({ where: { orgId_month: { orgId: org.id, month } } }),
      prisma.usageEvent.aggregate({
        where: { orgId: org.id, billingMonth: month, metric: BILLABLE_METRIC },
        _sum: { costInr: true },
      }),
      prisma.call.aggregate({
        where: { workspace: { orgId: org.id }, createdAt: { gte: period.from, lt: period.to } },
        _sum: { llmCostInr: true },
      }),
    ]);

    const supplierInr = round2(num(supplierAgg._sum.costInr));
    const llmInr = round2(num(llmAgg._sum.llmCostInr));

    // Priced as at the end of the month, exactly as the sweep prices it.
    const rate = await rateFor(org.id, new Date(period.to.getTime() - 1), { planKey: org.plan });

    let revenueInr: number;
    let projected: boolean;
    if (charge) {
      revenueInr = revenueFromCharge({
        amountInr: charge.amountInr,
        addonInr: charge.addonInr,
        prepaidMinutes: charge.prepaidMinutes,
        prepaidRateInr: charge.prepaidRateInr ?? null,
      });
      projected = false;
    } else {
      const usage = overageForRate(rate, minutes);
      revenueInr = round2(Math.max(usage.amountInr, rate.minimumInr) + rate.retainerInr);
      projected = true;
    }

    // A dormant org with no minutes, no cost and no charge is noise.
    if (minutes === 0 && revenueInr === 0 && supplierInr === 0 && llmInr === 0) continue;

    const marginInr = round2(revenueInr - supplierInr - llmInr);
    rows.push({
      orgId: org.id,
      orgName: org.name,
      planKey: rate.planKey,
      rateSource: rate.source,
      minutes,
      revenueInr,
      supplierInr,
      llmInr,
      marginInr,
      marginPct: marginPctOf(revenueInr, marginInr),
      projected,
    });
  }

  const sum = (pick: (r: OrgMargin) => number) => round2(rows.reduce((t, r) => t + pick(r), 0));
  const revenueInr = sum((r) => r.revenueInr);
  const supplierInr = sum((r) => r.supplierInr);
  const llmInr = sum((r) => r.llmInr);
  const marginInr = round2(revenueInr - supplierInr - llmInr);

  // Summed across the platform in one query rather than added up from the rows
  // above: this is the figure a supplier invoice is checked against, and it
  // should be a second read of the fact rather than an echo of the first.
  const ledgerAgg = await prisma.usageEvent.aggregate({
    where: { billingMonth: month, metric: BILLABLE_METRIC },
    _sum: { costInr: true },
  });
  const ledgerCostInr = round2(num(ledgerAgg._sum.costInr));

  const invoice = await prisma.supplierInvoice.findUnique({
    where: { provider_month: { provider, month } },
  });
  // Converted at the rate frozen when the invoice was entered, never at
  // today's: a USD bill reconciled at the live rate silently restates every
  // past month's margin as the rupee moves.
  const invoicedInr = invoice
    ? round2(
        invoice.currency === 'INR'
          ? num(invoice.amount)
          : num(invoice.amount) * (invoice.fxRateToInr ?? 0),
      )
    : null;

  return {
    month,
    orgs: rows,
    totals: {
      minutes: rows.reduce((t, r) => t + r.minutes, 0),
      revenueInr,
      supplierInr,
      llmInr,
      marginInr,
      marginPct: marginPctOf(revenueInr, marginInr),
    },
    supplier: {
      provider,
      invoicedInr,
      ledgerCostInr,
      gapInr: invoicedInr === null ? null : round2(invoicedInr - ledgerCostInr),
    },
    negative: rows.filter((r) => r.marginInr < 0),
  };
}
