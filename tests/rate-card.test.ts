import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 5 — per-client rate cards over the plan catalogue, and the wallet that
// goes with them. Four things have to hold, and each of them is silent when it
// breaks:
//
//   1. With no card, every number is the number the catalogue gave before this
//      existed. That is what makes the deploy a no-op.
//   2. A card prices EVERY minute. Leaving the plan's included allowance in
//      place would bill the first N minutes of an agreed rate at nothing.
//   3. An org holding a legacy plan key AND a card must be swept. The old
//      catalogue allowlist skipped exactly that org — silently, every month.
//   4. Prepaid minutes are recognised at the price they were SOLD at, which
//      stops being the current rate the moment a client is moved onto a card.

const store = vi.hoisted(() => ({
  card: null as any,
  topUps: [] as any[],
  priorPrepaid: 0,
}));

const db = vi.hoisted(() => {
  const d: any = {
    organization: {
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(async () => ({ plan: 'free', prepaidMinutes: 0 }) as unknown),
      update: vi.fn(async () => ({})),
    },
    overageCharge: {
      findUnique: vi.fn(async () => null as unknown),
      create: vi.fn(async ({ data }: any) => ({ id: 'oc_1', ...data })),
      update: vi.fn(async () => ({})),
      aggregate: vi.fn(async () => ({ _sum: { prepaidMinutes: store.priorPrepaid } })),
    },
    minuteTopUp: { findMany: vi.fn(async () => store.topUps) },
    rateCard: { findFirst: vi.fn(async () => store.card) },
    call: { aggregate: vi.fn(async () => ({ _sum: { durationSec: 0 } })) },
    usageEvent: { aggregate: vi.fn(async () => ({ _sum: { quantity: 0 } })) },
    planChange: { findFirst: vi.fn(async () => null as unknown), create: vi.fn(async () => ({})) },
    voicePlatformAccount: { findMany: vi.fn(async () => [] as unknown[]) },
  };
  d.$executeRaw = vi.fn(async () => 1);
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/platform', () => ({
  isSuperAdmin: vi.fn(() => false),
  getWhatsappChatAddonPrice: vi.fn(async () => 0),
  // No admin overrides: the catalogue is the fallback under test.
  getPlanOverrides: vi.fn(async () => ({})),
}));
vi.mock('@/lib/cashfree', () => ({
  getCashfreeConfig: vi.fn(async () => ({})),
  isCashfreeConfigured: vi.fn(() => false),
  checkoutMode: vi.fn(() => 'order'),
  chargeSubscription: vi.fn(),
}));

import { rateFor, isBillableRate } from '@/lib/billing/rate-card';
import { overageFor, overageForRate, rateFromPlan, PLANS, RATE_PER_MINUTE_INR } from '@/lib/billing/catalogue';
import { weightedTopUpRate, quoteTopUp } from '@/lib/billing/prepaid';
import { runOverageSweep } from '@/lib/billing/overage-sweep';

/** First argument of the nth call to a mock, untyped on purpose. */
const argOf = (fn: unknown, n = 0): any => (fn as { mock: { calls: any[][] } }).mock.calls.at(n)![0];

/** A Decimal column as Prisma actually hands it back. */
const dec = (n: number) => ({ toNumber: () => n });

const CARD = {
  id: 'rc_1',
  orgId: 'org_1',
  currency: 'INR',
  pricePerMinute: dec(4.2),
  costPerMinute: dec(2.8),
  retainerInr: null,
  minimumInr: null,
  monthlyMinuteCap: null,
  metricRates: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  store.card = null;
  store.topUps = [];
  store.priorPrepaid = 0;
  db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 0 });
  db.overageCharge.findUnique.mockResolvedValue(null);
  db.overageCharge.create.mockImplementation(async ({ data }: any) => ({ id: 'oc_1', ...data }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('rateFor — no card is the catalogue, unchanged', () => {
  it('returns the plan numbers verbatim for an org with no card', async () => {
    const rate = await rateFor('org_1', new Date('2026-09-15T00:00:00Z'), { planKey: 'standard' });
    expect(rate.source).toBe('plan');
    expect(rate.cardId).toBeNull();
    expect(rate.pricePerMinute).toBe(RATE_PER_MINUTE_INR);
    expect(rate.overagePerMinute).toBe(PLANS.standard.overagePerMinute);
    expect(rate.includedMinutes).toBe(PLANS.standard.limits.callMinutesPerMonth);
    expect(rate.usageBased).toBe(true);
    expect(rate.retainerInr).toBe(0);
    expect(rate.minimumInr).toBe(0);
    expect(rate.costPerMinute).toBeNull();
  });

  it('keeps a legacy monthly plan monthly — an allowance, not a per-minute rate', async () => {
    const rate = await rateFor('org_1', new Date(), { planKey: 'voice_starter' });
    expect(rate.usageBased).toBe(false);
    expect(rate.includedMinutes).toBe(PLANS.voice_starter.limits.callMinutesPerMonth);
    expect(rate.overagePerMinute).toBe(PLANS.voice_starter.overagePerMinute);
  });

  it('prices from the card in force AT THE MOMENT ASKED, not the latest one', async () => {
    const at = new Date('2026-08-31T23:59:59Z');
    await rateFor('org_1', at, { planKey: 'standard' });
    const where = argOf(db.rateCard.findFirst).where;
    expect(where.orgId).toBe('org_1');
    expect(where.effectiveFrom).toEqual({ lte: at });
    expect(where.OR).toEqual([{ effectiveTo: null }, { effectiveTo: { gt: at } }]);
    expect(argOf(db.rateCard.findFirst).orderBy).toEqual({ effectiveFrom: 'desc' });
  });

  it('resolves the plan from history when the caller has not already', async () => {
    db.planChange.findFirst.mockResolvedValueOnce({ plan: 'voice_growth' });
    const rate = await rateFor('org_1', new Date('2026-07-31T23:59:59Z'));
    expect(rate.planKey).toBe('voice_growth');
  });
});

describe('rateFor — a card overrides the price and nothing else', () => {
  it('reads Decimal columns and overrides BOTH per-minute numbers', async () => {
    store.card = CARD;
    const rate = await rateFor('org_1', new Date(), { planKey: 'free' });
    expect(rate.source).toBe('card');
    expect(rate.cardId).toBe('rc_1');
    expect(rate.pricePerMinute).toBe(4.2);
    // The plan's overage rate must not survive next to an agreed price.
    expect(rate.overagePerMinute).toBe(4.2);
    expect(rate.costPerMinute).toBe(2.8);
  });

  it('bills every minute: a card has no included allowance to run past', async () => {
    store.card = CARD;
    const rate = await rateFor('org_1', new Date(), { planKey: 'voice_starter' });
    expect(rate.usageBased).toBe(true);
    expect(rate.includedMinutes).toBe(Infinity);
    // 1,000 minutes on a card is 1,000 × the card rate, not "the tail past
    // voice_starter's allowance".
    expect(overageForRate(rate, 1000)).toEqual({ minutes: 1000, amountInr: 4200 });
  });

  it('keeps the plan key on the charge — the card prices it, the plan labels it', async () => {
    store.card = CARD;
    const rate = await rateFor('org_1', new Date(), { planKey: 'free' });
    expect(rate.planKey).toBe('free');
    expect(rate.plan.key).toBe('free');
  });

  it('takes the client cap when it sets one, and the plan cap when it does not', async () => {
    store.card = { ...CARD, monthlyMinuteCap: 8000 };
    expect((await rateFor('org_1', new Date(), { planKey: 'standard' })).monthlyMinuteCap).toBe(8000);
    store.card = CARD;
    expect((await rateFor('org_1', new Date(), { planKey: 'standard' })).monthlyMinuteCap).toBe(
      PLANS.standard.limits.callMinutesPerMonth,
    );
  });
});

describe('isBillableRate', () => {
  const base = { retainerInr: 0, minimumInr: 0 } as any;
  it('is true for a per-minute price, a retainer, or a commitment', () => {
    expect(isBillableRate({ ...base, pricePerMinute: 4.2 })).toBe(true);
    expect(isBillableRate({ ...base, pricePerMinute: 0, retainerInr: 25000 })).toBe(true);
    expect(isBillableRate({ ...base, pricePerMinute: 0, minimumInr: 5000 })).toBe(true);
  });

  it('is false for a card that charges nothing at all', () => {
    expect(isBillableRate({ ...base, pricePerMinute: 0 })).toBe(false);
  });
});

describe('overageForRate is overageFor, moved', () => {
  // The arithmetic that decides what every live org is charged. It was carried
  // across rather than rewritten, and this is what says so.
  const cases: [string, number][] = [
    ['standard', 0],
    ['standard', 1234],
    ['voice_starter', 100],
    ['voice_starter', 5000],
    ['free', 900],
    ['chat_starter', 50],
    ['enterprise', 10_000],
    ['scale', 40_000],
  ];
  for (const [key, minutes] of cases) {
    it(`agrees with the plan path for ${key} at ${minutes} minutes`, () => {
      const plan = PLANS[key as keyof typeof PLANS];
      expect(overageForRate(rateFromPlan(plan), minutes)).toEqual(overageFor(plan, minutes));
    });
  }
});

describe('the sweep bills a carded org whatever plan key it holds', () => {
  const from = new Date(Date.UTC(2026, 7, 1));
  const to = new Date(Date.UTC(2026, 8, 1));

  function orgOn(plan: string, extra: Record<string, unknown> = {}) {
    db.organization.findMany.mockResolvedValue([
      {
        id: 'org_1',
        name: 'Acme Interiors',
        plan,
        prepaidMinutes: 0,
        cashfreeSubscriptionId: null,
        subscriptionStatus: null,
        whatsappChatAddon: false,
        ...extra,
      },
    ]);
    db.organization.findUnique.mockResolvedValue({ plan, prepaidMinutes: 0, usageSource: 'calls' });
  }

  it('bills a legacy free-key org that has been sold a card', async () => {
    // The landmine: `free` is not in the catalogue's billable allowlist, so
    // before rateFor this org was skipped and never invoiced — while its client
    // was on an agreed ₹4.20/min.
    orgOn('free');
    store.card = CARD;
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 60 * 1000 } });

    const results = await runOverageSweep('2026-08', from, to);

    expect(db.overageCharge.create).toHaveBeenCalledTimes(1);
    expect(argOf(db.overageCharge.create).data).toMatchObject({
      orgId: 'org_1',
      month: '2026-08',
      minutes: 1000,
      amountInr: 4200,
      // Still stamped with the plan key it holds: Cashfree tags and issued
      // invoices carry that key and it can never become a card id.
      plan: 'free',
    });
    expect(results[0]).toMatchObject({ amountInr: 4200, rateCardId: 'rc_1' });
  });

  it('still skips a free-key org with no card', async () => {
    orgOn('free');
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 60 * 1000 } });

    expect(await runOverageSweep('2026-08', from, to)).toEqual([]);
    expect(db.overageCharge.create).not.toHaveBeenCalled();
  });

  it('bills the retainer in a month with no minutes at all', async () => {
    orgOn('free');
    store.card = { ...CARD, retainerInr: dec(25000) };
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 0 } });

    await runOverageSweep('2026-08', from, to);
    expect(argOf(db.overageCharge.create).data).toMatchObject({ minutes: 0, amountInr: 25000 });
  });

  it('treats a monthly commitment as a floor, not an addition', async () => {
    orgOn('free');
    store.card = { ...CARD, minimumInr: dec(20000) };
    // 1,000 minutes at ₹4.20 is ₹4,200 — under the commitment.
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 60 * 1000 } });

    await runOverageSweep('2026-08', from, to);
    expect(argOf(db.overageCharge.create).data.amountInr).toBe(20000);

    // Past the commitment, the minutes win.
    vi.clearAllMocks();
    db.overageCharge.create.mockImplementation(async ({ data }: any) => ({ id: 'oc_2', ...data }));
    orgOn('free');
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 60 * 10_000 } });
    await runOverageSweep('2026-08', from, to);
    expect(argOf(db.overageCharge.create).data.amountInr).toBe(42000);
  });
});

describe('prepaid minutes are recognised at the price they were sold at', () => {
  it('weights the consumed minutes FIFO across the top-ups that paid for them', () => {
    const topUps = [
      { minutes: 1000, ratePerMinute: 5 },
      { minutes: 1000, ratePerMinute: 4 },
    ];
    // The first month spends the first purchase.
    expect(weightedTopUpRate(topUps, 0, 1000, 0)).toBe(5);
    // The second spends the cheaper one.
    expect(weightedTopUpRate(topUps, 1000, 1000, 0)).toBe(4);
    // A month straddling both is the blend, not either rate.
    expect(weightedTopUpRate(topUps, 500, 1000, 0)).toBe(4.5);
  });

  it('prices minutes no purchase accounts for at the current rate, not at zero', () => {
    // Minutes granted by hand leave no MinuteTopUp row.
    expect(weightedTopUpRate([{ minutes: 100, ratePerMinute: 5 }], 0, 200, 3)).toBe(4);
    expect(weightedTopUpRate([], 0, 100, 4.2)).toBe(4.2);
  });

  it('is null for a month that consumed nothing', () => {
    expect(weightedTopUpRate([{ minutes: 100, ratePerMinute: 5 }], 0, 0, 5)).toBeNull();
  });

  it('writes the sold rate onto the charge, not the rate now in force', async () => {
    // Bought 1,000 minutes at ₹5 on the catalogue rate, then moved onto a
    // ₹4.20 card. August spends 600 of those minutes: they are recognised at
    // the ₹5 they were sold at.
    db.organization.findMany.mockResolvedValue([
      {
        id: 'org_1',
        name: 'Acme Interiors',
        plan: 'standard',
        prepaidMinutes: 1000,
        cashfreeSubscriptionId: null,
        subscriptionStatus: null,
        whatsappChatAddon: false,
      },
    ]);
    db.organization.findUnique.mockResolvedValue({
      plan: 'standard',
      prepaidMinutes: 1000,
      usageSource: 'calls',
    });
    store.card = CARD;
    store.topUps = [{ minutes: 1000, ratePerMinute: 5 }];
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 60 * 600 } });

    await runOverageSweep('2026-08', new Date(Date.UTC(2026, 7, 1)), new Date(Date.UTC(2026, 8, 1)));

    // Nothing to invoice — the balance covered the month — so the row is the
    // prepaid receipt, carrying what those minutes were sold for.
    expect(argOf(db.overageCharge.create).data).toMatchObject({
      prepaidMinutes: 600,
      prepaidRateInr: 5,
      status: 'prepaid',
    });
  });
});

describe('the wallet follows the rate, not the plan key', () => {
  it('lets a legacy-plan org with a card buy minutes', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'free', prepaidMinutes: 0 });
    store.card = CARD;
    expect(await quoteTopUp('org_1', 1000)).toEqual({
      minutes: 1000,
      ratePerMinute: 4.2,
      amountInr: 4200,
    });
  });

  it('still refuses an org on a monthly plan with no card', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'voice_starter', prepaidMinutes: 0 });
    expect(await quoteTopUp('org_1', 1000)).toHaveProperty('error');
  });
});
