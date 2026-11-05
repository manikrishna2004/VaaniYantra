import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// P2-6: the monthly overage sweep can run from cron via a bearer secret, so a
// forgotten admin-dashboard click no longer loses revenue.

const db = vi.hoisted(() => {
  const d: any = {
    organization: {
      findMany: vi.fn(async () => [] as unknown[]),
      // Read by billableMinutes to decide which source meters this org. Null
      // falls back to the calls table, which is what every org is on today.
      findUnique: vi.fn(async () => null as unknown),
      update: vi.fn(async () => ({})),
    },
    overageCharge: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(async () => ({ _sum: { prepaidMinutes: 0 } })),
    },
    minuteTopUp: { findMany: vi.fn(async () => [] as unknown[]) },
    // No client rate cards, so every org here is priced from the catalogue.
    rateCard: { findFirst: vi.fn(async () => null) },
    call: { aggregate: vi.fn() },
    planChange: { findFirst: vi.fn(async () => null as unknown), create: vi.fn(async () => ({})) },
    usageEvent: { aggregate: vi.fn(async () => ({ _sum: { quantity: 0 } })) },
    // The sweep now refuses to close a month for an org whose minutes are
    // spoken on a reseller platform until that platform has been fully read.
    // Empty here: these orgs are served by our own pipeline, so there is
    // nothing upstream to reconcile and the month is closeable.
    voicePlatformAccount: { findMany: vi.fn(async () => [] as unknown[]) },
  };
  // The per-org billing lock the sweep now holds across its read AND its write.
  d.$executeRaw = vi.fn(async () => 1);
  // The sweep writes the charge and the prepaid drawdown together; the callback
  // gets the same mock, so both writes land where the assertions can see them.
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/api', () => ({
  apiContext: vi.fn(async () => ({
    error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  })),
}));
vi.mock('@/lib/platform', () => ({
  isSuperAdmin: vi.fn(() => false),
  getWhatsappChatAddonPrice: vi.fn(async () => 0),
  // No admin overrides: the sweep should price off the catalogue.
  getPlanOverrides: vi.fn(async () => ({})),
}));
vi.mock('@/lib/cashfree', () => ({
  getCashfreeConfig: vi.fn(async () => ({})),
  isCashfreeConfigured: vi.fn(() => false),
  checkoutMode: vi.fn(() => 'order'),
  chargeSubscription: vi.fn(),
}));

import { resolveSweepMonth, cronSecretMatches, runOverageSweep } from '@/lib/billing/overage-sweep';

/** First argument of the nth call to a mock, untyped on purpose. */
const argOf = (fn: unknown, n = 0): any => (fn as { mock: { calls: any[][] } }).mock.calls.at(n)![0];
import { POST } from '@/app/api/admin/overage/route';

describe('resolveSweepMonth', () => {
  const now = new Date(Date.UTC(2026, 6, 18)); // 2026-07-18

  it('defaults to the previous UTC month', () => {
    const r = resolveSweepMonth(undefined, now);
    expect(r).toMatchObject({ month: '2026-06' });
  });

  it('accepts an explicit ended month', () => {
    const r = resolveSweepMonth('2026-03', now);
    if ('error' in r) throw new Error(r.error);
    expect(r.month).toBe('2026-03');
    expect(r.from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rejects the current (unfinished) month', () => {
    expect(resolveSweepMonth('2026-07', now).error).toMatch(/not ended/);
  });

  it('ignores malformed input and falls back to the previous month', () => {
    expect(resolveSweepMonth('garbage', now)).toMatchObject({ month: '2026-06' });
    expect(resolveSweepMonth('2026-13', now)).toMatchObject({ month: '2026-06' });
  });

  it('handles the January → December year rollover', () => {
    const jan = new Date(Date.UTC(2027, 0, 3));
    expect(resolveSweepMonth(undefined, jan)).toMatchObject({ month: '2026-12' });
  });
});

describe('cronSecretMatches', () => {
  afterEach(() => {
    delete process.env.OVERAGE_CRON_SECRET;
  });

  it('is false when the secret is not configured', () => {
    expect(cronSecretMatches('anything')).toBe(false);
  });

  it('is false for a missing or wrong token', () => {
    process.env.OVERAGE_CRON_SECRET = 's3cret';
    expect(cronSecretMatches(null)).toBe(false);
    expect(cronSecretMatches('wrong')).toBe(false);
    expect(cronSecretMatches('s3cret-longer')).toBe(false);
  });

  it('is true for the exact token', () => {
    process.env.OVERAGE_CRON_SECRET = 's3cret';
    expect(cronSecretMatches('s3cret')).toBe(true);
  });
});

describe('POST /api/admin/overage (cron auth)', () => {
  beforeEach(() => {
    process.env.OVERAGE_CRON_SECRET = 'cron-secret';
  });
  afterEach(() => {
    delete process.env.OVERAGE_CRON_SECRET;
  });

  function post(headers: Record<string, string> = {}) {
    return POST(
      new Request('http://test/api/admin/overage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({}),
      }),
    );
  }

  it('runs the sweep with a valid bearer secret and no session', async () => {
    const res = await post({ Authorization: 'Bearer cron-secret' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(body.results).toEqual([]);
  });

  it('falls through to session auth (401) on a wrong bearer secret', async () => {
    const res = await post({ Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('falls through to session auth (401) with no auth at all', async () => {
    const res = await post();
    expect(res.status).toBe(401);
  });
});

// The downgrade hole. An org on voice_starter (143 min included, ₹8/min over)
// burns 280 minutes in July, then switches to free on 1 August. The 2 August
// sweep used to select orgs by their CURRENT plan, so this org was not in the
// result set at all and the month's overage was written off in silence.
describe('runOverageSweep prices the month it is billing', () => {
  const JULY = { month: '2026-07', from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') };

  beforeEach(() => {
    db.organization.findMany.mockResolvedValue([
      {
        id: 'o1',
        name: 'Smilecare',
        plan: 'free', // what they downgraded to on 1 August
        cashfreeSubscriptionId: null,
        subscriptionStatus: null,
        whatsappChatAddon: false,
      },
    ]);
    db.overageCharge.findUnique.mockResolvedValue(null);
    db.overageCharge.create.mockImplementation(async (a: { data: unknown }) => ({ id: 'c1', ...(a.data as object) }));
    db.overageCharge.update.mockResolvedValue({});
    db.call.aggregate.mockResolvedValue({ _sum: { durationSec: 280 * 60 } });
    db.planChange.findFirst.mockResolvedValue({ plan: 'voice_starter' }); // what they were in July
  });

  it('still bills a month the org has since downgraded away from', async () => {
    const res = await runOverageSweep(JULY.month, JULY.from, JULY.to);
    expect(res).toHaveLength(1);
    expect(res[0].minutes).toBe(280 - 143);
    expect(res[0].amountInr).toBeGreaterThan(0);
  });

  it('records the plan it priced with, so the charge can be explained later', async () => {
    await runOverageSweep(JULY.month, JULY.from, JULY.to);
    expect(argOf(db.overageCharge.create).data.plan).toBe('voice_starter');
  });

  it('asks for the plan held at the end of the swept month, not today', async () => {
    await runOverageSweep(JULY.month, JULY.from, JULY.to);
    const at = argOf(db.planChange.findFirst, -1).where.changedAt.lte as Date;
    expect(at.getTime()).toBeLessThan(JULY.to.getTime());
    expect(at.getTime()).toBeGreaterThan(JULY.from.getTime());
  });

  // The other direction: genuinely on free all July means nothing to bill.
  it('bills nothing for an org that really was on free', async () => {
    db.planChange.findFirst.mockResolvedValue({ plan: 'free' });
    expect(await runOverageSweep(JULY.month, JULY.from, JULY.to)).toHaveLength(0);
  });
});
