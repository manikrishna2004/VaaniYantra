import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reselling minutes means every month has two numbers, and nothing in the
// product had ever subtracted them. These tests hold the subtraction:
//
//   • revenue for a CLOSED month is the charge we raised — including the
//     prepaid minutes it drew down, at the price they were sold at. Counting
//     only the invoiced tail reports a loss on every client whose balance
//     covered the month.
//   • the add-on fee is not voice revenue and must not flatter voice margin.
//   • a supplier invoice that disagrees with our own summed cost is the only
//     signal that the per-call cost we freeze at ingest is wrong.

const store = vi.hoisted(() => ({
  orgs: [] as any[],
  charges: [] as any[],
  /** SUM(UsageEvent.costInr) per org for the month. */
  supplierCost: {} as Record<string, number>,
  /** SUM(Call.llmCostInr) per org for the month. */
  llmCost: {} as Record<string, number>,
  /** Call seconds per org for the month. */
  seconds: {} as Record<string, number>,
  invoice: null as any,
}));

const db = vi.hoisted(() => {
  const d: any = {
    organization: {
      findMany: vi.fn(async () => store.orgs),
      findUnique: vi.fn(async ({ where }: any) => store.orgs.find((o) => o.id === where.id) ?? null),
    },
    overageCharge: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { orgId, month } = where.orgId_month;
        return store.charges.find((c) => c.orgId === orgId && c.month === month) ?? null;
      }),
    },
    // Two different reads land here: the ledger minutes (quantity) and the
    // supplier cost (costInr), per org and platform-wide.
    usageEvent: {
      aggregate: vi.fn(async ({ where, _sum }: any) => {
        if (_sum.quantity) return { _sum: { quantity: 0 } };
        if (!where.orgId) {
          const all = Object.values(store.supplierCost).reduce((t, n) => t + n, 0);
          return { _sum: { costInr: all } };
        }
        return { _sum: { costInr: store.supplierCost[where.orgId] ?? 0 } };
      }),
    },
    // And two here: the month's call seconds, and the month's model cost.
    call: {
      aggregate: vi.fn(async ({ where, _sum }: any) => {
        const orgId = where.workspace.orgId;
        if (_sum.llmCostInr) return { _sum: { llmCostInr: store.llmCost[orgId] ?? 0 } };
        return { _sum: { durationSec: store.seconds[orgId] ?? 0 } };
      }),
    },
    rateCard: { findFirst: vi.fn(async () => null) },
    planChange: { findFirst: vi.fn(async () => null) },
    supplierInvoice: { findUnique: vi.fn(async () => store.invoice) },
  };
  return d;
});
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/platform', () => ({
  getPlanOverrides: vi.fn(async () => ({})),
}));

import { marginForMonth, marginPctOf, revenueFromCharge } from '@/lib/billing/margin';

const org = (id: string, name: string, plan = 'standard') => ({
  id,
  name,
  plan,
  usageSource: 'calls',
  usageSourceSince: null,
});

const charge = (orgId: string, over: Partial<Record<string, unknown>> = {}) => ({
  orgId,
  month: '2026-08',
  minutes: 0,
  amountInr: 0,
  addonInr: 0,
  prepaidMinutes: 0,
  prepaidRateInr: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  store.orgs = [];
  store.charges = [];
  store.supplierCost = {};
  store.llmCost = {};
  store.seconds = {};
  store.invoice = null;
});

describe('the arithmetic, on its own', () => {
  it('reports margin as a percentage of revenue, and answers the zero case', () => {
    expect(marginPctOf(1000, 250)).toBe(25);
    expect(marginPctOf(1000, -250)).toBe(-25);
    expect(marginPctOf(0, -400)).toBe(0);
  });

  it('counts prepaid minutes as revenue at the price they were sold at', () => {
    // ₹4,200 invoiced, plus 600 minutes drawn from a balance bought at ₹5.
    expect(
      revenueFromCharge({ amountInr: 4200, addonInr: 0, prepaidMinutes: 600, prepaidRateInr: 5 }),
    ).toBe(7200);
  });

  it('leaves the flat add-on fee out of voice revenue', () => {
    // ₹4,200 of minutes plus a ₹999 WhatsApp add-on: the add-on has no minute
    // behind it, so counting it would flatter the margin on the minutes.
    expect(
      revenueFromCharge({ amountInr: 5199, addonInr: 999, prepaidMinutes: 0, prepaidRateInr: null }),
    ).toBe(4200);
  });

  it('does not invent revenue from an old row that predates prepaidRateInr', () => {
    expect(
      revenueFromCharge({ amountInr: 0, addonInr: 0, prepaidMinutes: 600, prepaidRateInr: null }),
    ).toBe(0);
  });
});

describe('marginForMonth', () => {
  it('subtracts the supplier and the model from what was billed', async () => {
    store.orgs = [org('org_1', 'Acme Interiors')];
    store.seconds = { org_1: 60 * 1000 };
    store.charges = [charge('org_1', { minutes: 1000, amountInr: 5000 })];
    store.supplierCost = { org_1: 2800 };
    store.llmCost = { org_1: 200 };

    const report = await marginForMonth('2026-08');
    expect(report.orgs).toHaveLength(1);
    expect(report.orgs[0]).toMatchObject({
      orgName: 'Acme Interiors',
      minutes: 1000,
      revenueInr: 5000,
      supplierInr: 2800,
      llmInr: 200,
      marginInr: 2000,
      marginPct: 40,
      projected: false,
    });
    expect(report.totals.marginInr).toBe(2000);
  });

  it('flags an org billed below what its minutes cost us', async () => {
    store.orgs = [org('org_1', 'Underwater Ltd')];
    store.seconds = { org_1: 60 * 1000 };
    store.charges = [charge('org_1', { minutes: 1000, amountInr: 3000 })];
    store.supplierCost = { org_1: 3500 };

    const report = await marginForMonth('2026-08');
    expect(report.negative.map((r) => r.orgName)).toEqual(['Underwater Ltd']);
    expect(report.orgs[0].marginInr).toBe(-500);
  });

  it('projects an unswept month from the rate rather than reporting nothing', async () => {
    store.orgs = [org('org_1', 'Acme Interiors')];
    store.seconds = { org_1: 60 * 400 };
    store.supplierCost = { org_1: 800 };

    const report = await marginForMonth('2026-08');
    // 400 minutes at the catalogue ₹5, because no charge has been raised yet.
    expect(report.orgs[0]).toMatchObject({ revenueInr: 2000, projected: true, marginInr: 1200 });
  });

  it('skips an org that did nothing, and keeps the one that did', async () => {
    store.orgs = [org('org_1', 'Dormant Clinic'), org('org_2', 'Acme Interiors')];
    store.seconds = { org_2: 60 * 100 };

    const report = await marginForMonth('2026-08');
    expect(report.orgs.map((r) => r.orgName)).toEqual(['Acme Interiors']);
  });

  it('checks our summed cost against the supplier invoice, at the frozen rate', async () => {
    store.orgs = [org('org_1', 'Acme Interiors')];
    store.seconds = { org_1: 60 * 1000 };
    store.supplierCost = { org_1: 2800 };
    // A USD invoice, converted at the rate frozen when it was entered.
    store.invoice = { provider: 'omnidimension', month: '2026-08', currency: 'USD', amount: 40, fxRateToInr: 85 };

    const report = await marginForMonth('2026-08');
    expect(report.supplier.ledgerCostInr).toBe(2800);
    expect(report.supplier.invoicedInr).toBe(3400);
    // ₹600 of minutes we were charged for and never priced at ingest.
    expect(report.supplier.gapInr).toBe(600);
  });

  it('reports no gap rather than a false one when no invoice has been entered', async () => {
    store.orgs = [org('org_1', 'Acme Interiors')];
    store.seconds = { org_1: 60 * 100 };
    store.supplierCost = { org_1: 280 };

    const report = await marginForMonth('2026-08');
    expect(report.supplier.invoicedInr).toBeNull();
    expect(report.supplier.gapInr).toBeNull();
  });
});
