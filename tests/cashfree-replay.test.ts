import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cashfree return-URL replay.
//
// GET /api/billing/cashfree/return is unauthenticated by necessity (it is a
// cross-site redirect back from the gateway) and takes order_id from the query
// string. The route argues that re-reading the order from Cashfree makes this
// safe — "it grants nothing that the order status doesn't already prove".
//
// But a paid order proves payment ONCE, and nothing enforced once. Idempotency
// compared the incoming order against a single column holding the *most recent*
// order, so:
//
//   1. pay order A            -> cashfreeOrderId = A, paidUntil = +1 month
//   2. begin a new checkout   -> cashfreeOrderId = B (status INITIALIZED)
//   3. re-hit .../return?order_id=A  -> Cashfree still says A is PAID, the
//      guard compares A against B, misses, and another month is granted
//   4. repeat 2-3 forever
//
// The customer already holds their own order_id — it was in their URL bar.
//
// The fix is a per-order ledger whose unique constraint IS the idempotency
// check, so a replay cannot be applied no matter how the org row has moved on.

const MONTH_MS = 31 * 24 * 3600 * 1000;

type Org = {
  id: string;
  plan: string;
  paidUntil: Date | null;
  cashfreeOrderId: string | null;
  subscriptionStatus: string | null;
  subscriptionAmountInr: number | null;
};

const state = vi.hoisted(() => ({
  org: null as any,
  ledger: new Map<string, any>(),
}));

const uniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const prismaMock = vi.hoisted(() => ({
  organization: {
    findUnique: vi.fn(async ({ where }: any) => (where.id === state.org.id ? { ...state.org } : null)),
    update: vi.fn(async ({ where, data }: any) => {
      if (where.id !== state.org.id) throw new Error('no such org');
      Object.assign(state.org, data);
      return { ...state.org };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      // Mirrors Prisma: only rows matching every key in `where` are written.
      const hit =
        where.id === state.org.id &&
        (where.cashfreeOrderId === undefined || where.cashfreeOrderId === state.org.cashfreeOrderId);
      if (!hit) return { count: 0 };
      Object.assign(state.org, data);
      return { count: 1 };
    }),
  },
  paymentApplication: {
    findUnique: vi.fn(async ({ where }: any) => state.ledger.get(where.orderId) ?? null),
    create: vi.fn(async ({ data }: any) => {
      if (state.ledger.has(data.orderId)) throw uniqueViolation();
      state.ledger.set(data.orderId, { ...data });
      return { ...data };
    }),
  },
  // Interactive transactions with real rollback, so a mid-transaction unique
  // violation cannot leave a half-applied payment behind.
  $transaction: vi.fn(async (fn: any) => {
    const snapshot = { org: { ...state.org }, ledger: new Map(state.ledger) };
    try {
      return await fn(prismaMock);
    } catch (err) {
      state.org = snapshot.org;
      state.ledger = snapshot.ledger;
      throw err;
    }
  }),
}));

const redeemPromo = vi.hoisted(() => vi.fn(async () => {}));
const issueInvoice = vi.hoisted(() => vi.fn(async () => ({ number: 'VY/2026-27/0001' })));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/billing/promo', () => ({ redeemPromo }));
vi.mock('@/lib/billing/invoice', () => ({ issueInvoice }));

import { applyPaidOrder } from '@/lib/cashfree-sync';

const START = new Date('2026-08-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  state.ledger = new Map();
  state.org = {
    id: 'o1',
    plan: 'free',
    paidUntil: null,
    cashfreeOrderId: null,
    subscriptionStatus: null,
    subscriptionAmountInr: null,
  } satisfies Org;
});

const pay = (orderId: string, at: Date, extra: Record<string, unknown> = {}) =>
  applyPaidOrder({
    orgId: 'o1',
    orderId,
    plan: 'growth',
    amountInr: 4999,
    taxableInr: 4237,
    now: at,
    ...extra,
  });

describe('applyPaidOrder — a settled order may only ever be applied once', () => {
  it('grants a month for a genuine first payment', async () => {
    await pay('order-A', START);

    expect(state.org.subscriptionStatus).toBe('PAID');
    expect(state.org.plan).toBe('growth');
    expect(state.org.paidUntil).toBeTruthy();
    expect(state.org.paidUntil!.getTime()).toBeGreaterThan(START.getTime());
  });

  it('is a no-op when the same order arrives twice (webhook + return race)', async () => {
    await pay('order-A', START);
    const after = state.org.paidUntil!.getTime();

    await pay('order-A', START);

    expect(state.org.paidUntil!.getTime()).toBe(after);
    expect(redeemPromo).toHaveBeenCalledTimes(1);
  });

  it('REPLAY: a stale-but-PAID order cannot buy a second month once a newer checkout has started', async () => {
    await pay('order-A', START, { promoCode: 'LAUNCH50' });
    const afterFirstPayment = state.org.paidUntil!.getTime();

    // The customer opens a new checkout and abandons it. This is the step that
    // moves cashfreeOrderId off order-A and defeated the old guard.
    state.org.cashfreeOrderId = 'order-B';
    state.org.subscriptionStatus = 'INITIALIZED';

    // Re-hitting the bookmarked return URL for the original, genuinely paid order.
    await pay('order-A', START, { promoCode: 'LAUNCH50' });

    expect(state.org.paidUntil!.getTime()).toBe(afterFirstPayment);
    // And the promo must not be burned a second time either.
    expect(redeemPromo).toHaveBeenCalledTimes(1);
  });

  it('REPLAY: cannot be farmed by repeating the abandon-checkout cycle', async () => {
    await pay('order-A', START);
    const afterFirstPayment = state.org.paidUntil!.getTime();

    for (let i = 0; i < 12; i++) {
      state.org.cashfreeOrderId = `order-decoy-${i}`;
      state.org.subscriptionStatus = 'INITIALIZED';
      await pay('order-A', START);
    }

    expect(state.org.paidUntil!.getTime()).toBe(afterFirstPayment);
  });

  it('still lets a genuinely new order stack a further month', async () => {
    await pay('order-A', START);
    const afterFirst = state.org.paidUntil!.getTime();

    await pay('order-B', START);

    // Paying again early must extend from the existing expiry, not from today,
    // so the customer never loses the remainder they already bought.
    expect(state.org.paidUntil!.getTime()).toBeGreaterThan(afterFirst);
    expect(state.org.paidUntil!.getTime()).toBeGreaterThanOrEqual(afterFirst + MONTH_MS - 3 * 24 * 3600 * 1000);
  });

  it('extends from today when the previous period has already lapsed', async () => {
    await pay('order-A', START);
    const muchLater = new Date(START.getTime() + 200 * 24 * 3600 * 1000);

    await pay('order-B', muchLater);

    expect(state.org.paidUntil!.getTime()).toBeGreaterThan(muchLater.getTime());
  });

  it('leaves no ledger claim behind when the org write fails', async () => {
    // A claimed-but-unapplied order would be worse than the bug being fixed:
    // the customer has paid, and every retry would then no-op forever.
    prismaMock.organization.update.mockRejectedValueOnce(new Error('db down'));

    await expect(pay('order-A', START)).rejects.toThrow();
    expect(state.ledger.has('order-A')).toBe(false);

    // The retry must still be able to apply it.
    await pay('order-A', START);
    expect(state.org.subscriptionStatus).toBe('PAID');
  });

  it('does nothing for an unknown org', async () => {
    await applyPaidOrder({ orgId: 'nope', orderId: 'order-X', now: START });

    expect(state.org.subscriptionStatus).toBeNull();
    expect(state.ledger.size).toBe(0);
  });

  it('does not let an invoicing failure undo the payment', async () => {
    issueInvoice.mockRejectedValueOnce(new Error('invoice service down'));

    await pay('order-A', START);

    expect(state.org.subscriptionStatus).toBe('PAID');
    expect(state.ledger.has('order-A')).toBe(true);
  });
});
