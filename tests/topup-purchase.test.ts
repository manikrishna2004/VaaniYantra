import { describe, it, expect, vi, beforeEach } from 'vitest';

// Buying prepaid minutes settles through the same gateway plumbing as a plan
// payment, and the whole risk lives in telling the two apart. A minutes
// purchase misread as a plan payment is a free month of service; a plan payment
// misread as minutes is a month the customer paid for and did not get.
//
// The order id is what decides it — `vtm_` for minutes, `van_` for a plan —
// because the id is the gateway's own primary key and comes back on every
// event, where an order tag can go missing.

const state = vi.hoisted(() => ({
  org: null as any,
  topUps: new Map<string, any>(),
}));

const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const db = vi.hoisted(() => {
  const d: any = {
    organization: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === state.org.id ? { ...state.org } : null)),
      update: vi.fn(async ({ where, data }: any) => {
        if (where.id !== state.org.id) throw new Error('no such org');
        for (const [k, v] of Object.entries<any>(data)) {
          if (v && typeof v === 'object' && 'increment' in v) state.org[k] = (state.org[k] ?? 0) + v.increment;
          else if (v && typeof v === 'object' && 'decrement' in v) state.org[k] = (state.org[k] ?? 0) - v.decrement;
          else state.org[k] = v;
        }
        return { ...state.org };
      }),
    },
    minuteTopUp: {
      create: vi.fn(async ({ data }: any) => {
        if (state.topUps.has(data.gatewayOrderId)) throw uniqueViolation();
        state.topUps.set(data.gatewayOrderId, { ...data });
        return { ...data };
      }),
    },
  };
  // A real rollback, so a duplicate cannot leave a half-applied credit behind.
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => {
    const before = { org: { ...state.org }, topUps: new Map(state.topUps) };
    try {
      return await fn(d);
    } catch (err) {
      state.org = before.org;
      state.topUps = before.topUps;
      throw err;
    }
  });
  return d;
});

const invoices = vi.hoisted(() => ({
  issue: vi.fn(async (..._args: any[]): Promise<any> => ({ number: 'INV-1' })),
}));

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/billing/invoice', () => ({ issueInvoice: invoices.issue }));
vi.mock('@/lib/billing/promo', () => ({ redeemPromo: vi.fn(async () => {}) }));
vi.mock('@/lib/plan-history', () => ({ recordPlanChange: vi.fn(async () => {}), planAt: vi.fn(), seedPlanHistory: vi.fn() }));
vi.mock('@/lib/platform', () => ({ getPlanOverrides: vi.fn(async () => ({})), isSuperAdmin: vi.fn(() => false) }));

import { makeReference, orgIdFromReference, isTopUpReference } from '@/lib/cashfree';
import { applyPaidTopUp } from '@/lib/cashfree-sync';

beforeEach(() => {
  vi.clearAllMocks();
  state.org = { id: 'o1', plan: 'standard', prepaidMinutes: 0, paidUntil: null, subscriptionStatus: null };
  state.topUps = new Map();
  invoices.issue.mockResolvedValue({ number: 'INV-1' });
});

describe('telling the two purchases apart', () => {
  it('mints an id that says which it is, and still names the org', () => {
    const topUp = makeReference('org123', 'topup');
    const plan = makeReference('org123');
    expect(topUp.startsWith('vtm_')).toBe(true);
    expect(plan.startsWith('van_')).toBe(true);
    expect(orgIdFromReference(topUp)).toBe('org123');
    expect(orgIdFromReference(plan)).toBe('org123');
  });

  it('recognises a top-up and refuses to mistake a plan order for one', () => {
    expect(isTopUpReference(makeReference('org123', 'topup'))).toBe(true);
    expect(isTopUpReference(makeReference('org123'))).toBe(false);
    expect(isTopUpReference('vtm_')).toBe(false);
    expect(isTopUpReference(null)).toBe(false);
    expect(isTopUpReference('nonsense')).toBe(false);
  });

  it('defaults to a plan reference, so nothing becomes a top-up by omission', () => {
    expect(isTopUpReference(makeReference('org123'))).toBe(false);
  });
});

describe('a settled top-up', () => {
  const ORDER = 'vtm_o1_1756000000000';

  it('credits the minutes and records what they were sold at', async () => {
    await applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 2000, taxableInr: 7000, amountInr: 8260 });

    expect(state.org.prepaidMinutes).toBe(2000);
    const receipt = state.topUps.get(ORDER);
    // 7000 pre-tax over 2000 minutes is the ₹3.5 rate the quote was made at —
    // derived from what was actually paid rather than a tag that could drift.
    expect(receipt).toMatchObject({ minutes: 2000, ratePerMinute: 3.5, amountInr: 7000 });
  });

  // The whole point of a separate settle path.
  it('does not hand out a month of plan', async () => {
    await applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 2000, taxableInr: 7000 });
    expect(state.org.paidUntil).toBeNull();
    expect(state.org.subscriptionStatus).toBeNull();
    expect(state.org.plan).toBe('standard');
  });

  it('invoices the minutes as minutes, not as a month of subscription', async () => {
    await applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 2000, taxableInr: 7000 });
    const arg = invoices.issue.mock.calls[0][0] as any;
    expect(arg.description).toMatch(/2,000 prepaid call minutes/);
    expect(arg.taxableInr).toBe(7000);
    // Minutes never expire, so the invoice must not claim to bill a period.
    expect(arg.periodEnd).toEqual(arg.at);
  });

  it('credits one payment exactly once, however many handlers see it', async () => {
    await applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 2000, taxableInr: 7000 });
    await applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 2000, taxableInr: 7000 });
    expect(state.org.prepaidMinutes).toBe(2000);
    expect(state.topUps.size).toBe(1);
  });

  it('adds to a balance that is already there rather than replacing it', async () => {
    state.org.prepaidMinutes = 500;
    await applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 2000, taxableInr: 7000 });
    expect(state.org.prepaidMinutes).toBe(2500);
  });

  // Loud, not quiet: someone has paid and we cannot tell what for. Throwing
  // makes the webhook answer 500 so Cashfree retries and it is visible.
  it('refuses to guess when the minutes are missing', async () => {
    await expect(
      applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 0, taxableInr: 7000 }),
    ).rejects.toThrow(/no minutes/i);
    expect(state.org.prepaidMinutes).toBe(0);
  });

  it('keeps the minutes when the invoice cannot be written', async () => {
    invoices.issue.mockRejectedValue(new Error('numbering series locked'));
    await applyPaidTopUp({ orgId: 'o1', orderId: ORDER, minutes: 2000, taxableInr: 7000 });
    expect(state.org.prepaidMinutes).toBe(2000);
  });
});
