import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prepaid minutes: a clinic pays for the minutes it expects to use, and the
// monthly sweep draws them down. The two things these tests exist to hold:
// minutes are never spent twice, and they are never spent for free.

const db = vi.hoisted(() => {
  const d: any = {
    organization: {
      findMany: vi.fn(async () => [] as unknown[]),
      findUnique: vi.fn(async () => null as unknown),
      update: vi.fn(async () => ({})),
    },
    overageCharge: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(async () => ({})),
      // How many prepaid minutes earlier months already drew down, which is what
      // positions this month in the FIFO queue of top-ups.
      aggregate: vi.fn(async () => ({ _sum: { prepaidMinutes: 0 } })),
    },
    minuteTopUp: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => [] as unknown[]) },
    // No client rate cards: these orgs are priced from the plan catalogue, which
    // is what every org on the platform is priced from today.
    rateCard: { findFirst: vi.fn(async () => null) },
    call: { aggregate: vi.fn(async () => ({ _sum: { durationSec: 0 } })) },
    planChange: { findFirst: vi.fn(async () => null as unknown), create: vi.fn(async () => ({})) },
    // The sweep now reads the month total and closes the month inside ONE
    // transaction, under a per-org advisory lock, so that a usage row cannot
    // land between the two. The lock is a real query and the mock has to answer
    // it; the ledger is only summed for an org actually flipped onto it.
    usageEvent: { aggregate: vi.fn(async () => ({ _sum: { quantity: 0 } })) },
    // The sweep now refuses to close a month for an org whose minutes are
    // spoken on a reseller platform until that platform has been fully read.
    // Empty here: these orgs are served by our own pipeline, so there is
    // nothing upstream to reconcile and the month is closeable.
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
  getPlanOverrides: vi.fn(async () => ({})),
}));
vi.mock('@/lib/cashfree', () => ({
  getCashfreeConfig: vi.fn(async () => ({})),
  isCashfreeConfigured: vi.fn(() => false),
  checkoutMode: vi.fn(() => 'order'),
  chargeSubscription: vi.fn(),
}));

import {
  splitAgainstBalance,
  consumePrepaid,
  creditMinutes,
  quoteTopUp,
  getPrepaidState,
  MIN_TOPUP_MINUTES,
  MAX_TOPUP_MINUTES,
} from '@/lib/billing/prepaid';
import { runOverageSweep } from '@/lib/billing/overage-sweep';
import { RATE_PER_MINUTE_INR } from '@/lib/billing/catalogue';

/** First argument of the nth call to a mock, untyped on purpose. */
const argOf = (fn: unknown, n = 0): any => (fn as { mock: { calls: any[][] } }).mock.calls.at(n)![0];

beforeEach(() => {
  vi.clearAllMocks();
  db.overageCharge.findUnique.mockResolvedValue(null);
  db.overageCharge.create.mockImplementation(async (a: { data: unknown }) => ({ id: 'c1', ...(a.data as object) }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
});

describe('splitAgainstBalance', () => {
  it('covers everything it can and bills the rest', () => {
    expect(splitAgainstBalance(500, 300)).toEqual({ covered: 300, billable: 0 });
    expect(splitAgainstBalance(100, 300)).toEqual({ covered: 100, billable: 200 });
    expect(splitAgainstBalance(0, 300)).toEqual({ covered: 0, billable: 300 });
  });

  it('never invents minutes out of an empty or negative balance', () => {
    expect(splitAgainstBalance(-50, 300)).toEqual({ covered: 0, billable: 300 });
    expect(splitAgainstBalance(500, 0)).toEqual({ covered: 0, billable: 0 });
    expect(splitAgainstBalance(500, -10)).toEqual({ covered: 0, billable: 0 });
  });
});

describe('quoteTopUp', () => {
  beforeEach(() => {
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 0 });
  });

  it('prices at the org own per-minute rate', async () => {
    const q = await quoteTopUp('o1', 2000);
    expect(q).toEqual({ minutes: 2000, ratePerMinute: RATE_PER_MINUTE_INR, amountInr: 2000 * RATE_PER_MINUTE_INR });
  });

  it('refuses an order below the minimum or above the sanity cap', async () => {
    expect(await quoteTopUp('o1', MIN_TOPUP_MINUTES - 1)).toHaveProperty('error');
    expect(await quoteTopUp('o1', MAX_TOPUP_MINUTES + 1)).toHaveProperty('error');
  });

  it('refuses an org on a monthly plan, which has an allowance instead', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'voice_starter', prepaidMinutes: 0 });
    expect(await quoteTopUp('o1', 2000)).toHaveProperty('error');
  });
});

describe('creditMinutes', () => {
  it('writes the receipt and moves the balance in one transaction', async () => {
    const res = await creditMinutes({
      orgId: 'o1',
      minutes: 2000,
      ratePerMinute: RATE_PER_MINUTE_INR,
      amountInr: 10000,
      gatewayOrderId: 'ord_1',
    });
    expect(res.credited).toBe(true);
    expect(argOf(db.minuteTopUp.create).data).toMatchObject({ minutes: 2000, gatewayOrderId: 'ord_1' });
    expect(argOf(db.organization.update).data.prepaidMinutes).toEqual({ increment: 2000 });
  });

  it('credits a replayed gateway order exactly once', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2002' });
    const res = await creditMinutes({
      orgId: 'o1',
      minutes: 2000,
      ratePerMinute: RATE_PER_MINUTE_INR,
      amountInr: 10000,
      gatewayOrderId: 'ord_1',
    });
    expect(res.credited).toBe(false);
  });

  it('lets a real failure through, having changed nothing', async () => {
    db.$transaction.mockRejectedValue(new Error('connection lost'));
    await expect(
      creditMinutes({ orgId: 'o1', minutes: 2000, ratePerMinute: RATE_PER_MINUTE_INR, amountInr: 10000, gatewayOrderId: 'ord_1' }),
    ).rejects.toThrow('connection lost');
  });
});

describe('consumePrepaid', () => {
  it('records a zero-rupee month and decrements by what it covered', async () => {
    const res = await consumePrepaid({ orgId: 'o1', month: '2026-07', minutes: 300, plan: 'standard' });
    expect(res.consumed).toBe(true);
    expect(argOf(db.overageCharge.create).data).toMatchObject({
      month: '2026-07',
      minutes: 0,
      amountInr: 0,
      prepaidMinutes: 300,
      plan: 'standard',
      status: 'prepaid',
    });
    expect(argOf(db.organization.update).data.prepaidMinutes).toEqual({ decrement: 300 });
  });

  it('does nothing at all when a concurrent sweep already settled the month', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2002' });
    expect(await consumePrepaid({ orgId: 'o1', month: '2026-07', minutes: 300 })).toEqual({ consumed: false });
  });

  it('is a no-op for a month the balance covered nothing of', async () => {
    expect(await consumePrepaid({ orgId: 'o1', month: '2026-07', minutes: 0 })).toEqual({ consumed: false });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('getPrepaidState', () => {
  it('shows what is left, what this month used, and what it would cost', async () => {
    db.organization.findUnique.mockResolvedValue({ plan: 'standard', prepaidMinutes: 500 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 800 * 60 } });

    const s = await getPrepaidState('o1');
    expect(s).toMatchObject({
      balanceMinutes: 500,
      usedThisMonth: 800,
      coveredThisMonth: 500,
      uncoveredThisMonth: 300,
      balanceAfterMinutes: 0,
    });
    expect(s.dueInr).toBe(Math.round(300 * RATE_PER_MINUTE_INR * 100) / 100);
  });
});

// The sweep is the only place the balance is spent, so this is where "spent
// twice" or "spent for free" would actually happen.
describe('the sweep draws the balance down', () => {
  const JULY = { month: '2026-07', from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };

  function org(overrides: Record<string, unknown> = {}) {
    db.organization.findMany.mockResolvedValue([
      {
        id: 'o1',
        name: 'Smilecare',
        plan: 'standard',
        prepaidMinutes: 0,
        cashfreeSubscriptionId: null,
        subscriptionStatus: null,
        whatsappChatAddon: false,
        ...overrides,
      },
    ]);
  }

  const sweep = () => runOverageSweep(JULY.month, JULY.from, JULY.to);

  it('bills only the minutes the balance did not cover', async () => {
    org({ prepaidMinutes: 100 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 300 * 60 } });

    const res = await sweep();
    expect(res[0]).toMatchObject({ minutes: 200, amountInr: 200 * RATE_PER_MINUTE_INR, prepaidMinutes: 100 });
    expect(argOf(db.overageCharge.create).data).toMatchObject({ minutes: 200, prepaidMinutes: 100 });
    expect(argOf(db.organization.update).data.prepaidMinutes).toEqual({ decrement: 100 });
  });

  // The bug this whole path was written for: a month covered entirely by
  // prepayment used to return early, leaving the minutes spent AND still on the
  // balance — free again next month.
  it('still spends the minutes on a month it bills nothing for', async () => {
    org({ prepaidMinutes: 500 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 300 * 60 } });

    const res = await sweep();
    expect(res[0]).toMatchObject({ amountInr: 0, status: 'covered by prepaid', prepaidMinutes: 300 });
    expect(argOf(db.organization.update).data.prepaidMinutes).toEqual({ decrement: 300 });
    expect(argOf(db.overageCharge.create).data).toMatchObject({ amountInr: 0, status: 'prepaid' });
  });

  it('carries the remainder forward instead of expiring it', async () => {
    org({ prepaidMinutes: 500 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 300 * 60 } });
    await sweep();
    // 300 of 500 spent — a decrement, not a reset to zero.
    expect(argOf(db.organization.update).data.prepaidMinutes).toEqual({ decrement: 300 });
  });

  it('touches nothing for a month with no calls', async () => {
    org({ prepaidMinutes: 500 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 0 } });

    expect(await sweep()).toHaveLength(0);
    expect(db.organization.update).not.toHaveBeenCalled();
    expect(db.overageCharge.create).not.toHaveBeenCalled();
  });

  it('re-running the sweep does not spend the same minutes again', async () => {
    org({ prepaidMinutes: 500 });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 300 * 60 } });
    db.overageCharge.findUnique.mockResolvedValue({ minutes: 0, amountInr: 0, status: 'prepaid' });

    const res = await sweep();
    expect(res[0].status).toBe('already prepaid');
    expect(db.organization.update).not.toHaveBeenCalled();
  });

  // A legacy monthly plan sold an included allowance, which overageFor already
  // subtracts. Applying a balance on top would discount the same minutes twice.
  it('leaves a monthly plan balance alone', async () => {
    org({ plan: 'voice_starter', prepaidMinutes: 500 });
    db.planChange.findFirst.mockResolvedValue({ plan: 'voice_starter' });
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 280 * 60 } });

    const res = await sweep();
    expect(res[0].minutes).toBe(280 - 143);
    expect(res[0].prepaidMinutes).toBeUndefined();
    expect(db.organization.update).not.toHaveBeenCalled();
  });
});
