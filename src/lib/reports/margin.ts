import { prisma } from '@/lib/db';
import { BILLABLE_METRIC } from '@/lib/usage/ledger';

// ── Reseller margin ─────────────────────────────────────────────────────────
//
// The whole point of reselling is the difference between what a client pays us
// and what the platform charges us, and until now nothing in this codebase
// could see both numbers at once. `UsageEvent` carries them side by side —
// revenue is derived from the org's rate, `costInr` is what the provider said
// the call cost — so a margin is a subtraction rather than a spreadsheet.
//
// Two failure modes this exists to catch, both silent:
//
//   1. A client sold at a rate BELOW what we pay. Easy to do when a rate is
//      agreed once, in a conversation, and the supplier raises its price a
//      quarter later. Nothing else in the system would ever mention it.
//   2. Our per-call cost estimate drifting from the supplier's actual invoice.
//      `SupplierInvoice` is the document; `costInr` is our running guess. A gap
//      between them means the assumed rate is wrong, and every margin figure
//      that quarter is wrong with it.

export type OrgMargin = {
  orgId: string;
  orgName: string;
  minutes: number;
  /** What we bill the client, from its own rate. */
  revenueInr: number;
  /** What the platform charges us, summed from the call records. */
  supplierInr: number;
  /** Our own model spend for calls we ran ourselves. */
  llmInr: number;
  marginInr: number;
  /** Null when there is no revenue to take a percentage of. */
  marginPct: number | null;
  ratePerMinute: number;
};

export type MarginReport = {
  month: string;
  orgs: OrgMargin[];
  totals: { minutes: number; revenueInr: number; supplierInr: number; llmInr: number; marginInr: number };
  /** The supplier's own bill for the month, when it has been entered. */
  supplierInvoice: { amount: number; currency: string; seconds: number | null } | null;
  /**
   * supplierInvoice − our summed estimate. A non-trivial gap means the rate we
   * assume per call is not the rate we are actually charged.
   */
  costVarianceInr: number | null;
  /** Orgs being served at a loss. The alert worth having. */
  negativeMarginOrgs: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Margin for one month, per org.
 *
 * Revenue is computed from the org's effective per-minute rate rather than read
 * from OverageCharge, so this works for a month that has not been swept yet —
 * which is exactly when a bad rate is still worth catching.
 */
export async function marginForMonth(month: string): Promise<MarginReport> {
  const [grouped, orgs, invoice] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ['orgId'],
      where: { billingMonth: month, metric: BILLABLE_METRIC },
      _sum: { quantity: true, costInr: true },
    }),
    prisma.organization.findMany({ select: { id: true, name: true, plan: true } }),
    prisma.supplierInvoice.findUnique({ where: { provider_month: { provider: 'omnidimension', month } } }),
  ]);

  const nameOf = new Map(orgs.map((o) => [o.id, o.name]));
  const planOf = new Map(orgs.map((o) => [o.id, o.plan]));

  // Imported lazily to keep this module out of the billing import cycle:
  // billing.ts already pulls in the usage modules.
  const { getEffectivePlan } = await import('@/lib/billing/catalogue');

  const rows: OrgMargin[] = [];
  for (const g of grouped) {
    const minutes = Math.round((g._sum.quantity ?? 0) / 60);
    if (minutes === 0) continue;

    const plan = await getEffectivePlan(planOf.get(g.orgId));
    const ratePerMinute = plan.pricePerMinute ?? 0;
    const revenueInr = round2(minutes * ratePerMinute);
    // Prisma returns Decimal; Number() is safe here because this is a report,
    // not a charge — nothing downstream is billed from it.
    const supplierInr = round2(Number(g._sum.costInr ?? 0));

    // Our own model spend, for calls we ran rather than resold. Part of COGS
    // even though it never appears on a supplier invoice.
    const llmAgg = await prisma.call.aggregate({
      where: {
        workspace: { orgId: g.orgId },
        createdAt: { gte: new Date(`${month}-01T00:00:00Z`) },
        endedAt: { not: null },
      },
      _sum: { llmCostInr: true },
    });
    const llmInr = round2(llmAgg._sum.llmCostInr ?? 0);

    const marginInr = round2(revenueInr - supplierInr - llmInr);
    rows.push({
      orgId: g.orgId,
      orgName: nameOf.get(g.orgId) ?? g.orgId,
      minutes,
      revenueInr,
      supplierInr,
      llmInr,
      marginInr,
      marginPct: revenueInr > 0 ? Math.round((marginInr / revenueInr) * 1000) / 10 : null,
      ratePerMinute,
    });
  }

  rows.sort((a, b) => a.marginInr - b.marginInr);

  const totals = rows.reduce(
    (t, r) => ({
      minutes: t.minutes + r.minutes,
      revenueInr: round2(t.revenueInr + r.revenueInr),
      supplierInr: round2(t.supplierInr + r.supplierInr),
      llmInr: round2(t.llmInr + r.llmInr),
      marginInr: round2(t.marginInr + r.marginInr),
    }),
    { minutes: 0, revenueInr: 0, supplierInr: 0, llmInr: 0, marginInr: 0 },
  );

  const invoiceAmount = invoice ? Number(invoice.amount) * (invoice.fxRateToInr ?? 1) : null;

  return {
    month,
    orgs: rows,
    totals,
    supplierInvoice: invoice
      ? { amount: round2(invoiceAmount ?? 0), currency: invoice.currency, seconds: invoice.seconds }
      : null,
    costVarianceInr: invoiceAmount === null ? null : round2(invoiceAmount - totals.supplierInr),
    negativeMarginOrgs: rows.filter((r) => r.marginInr < 0).map((r) => r.orgName),
  };
}
