import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 3 makes the usage ledger authoritative — per organisation, from a date.
// Three things have to hold, and all three are the kind that only fail once,
// expensively:
//
//   1. The month total is read and the month is CLOSED under the same per-org
//      lock. A usage row landing between those two is billed into a month that
//      is already settled and is never collected.
//   2. A flip only ever takes effect from a FUTURE month. Half a month counted
//      each way is billed once, into a row that is unique per (org, month) and
//      therefore cannot be corrected in place.
//   3. Moving back to `calls` clears the effective date, or a later re-flip
//      silently applies from the old one.

const store = vi.hoisted(() => ({
  orgs: [] as any[],
  charges: [] as any[],
  events: [] as any[],
  calls: [] as any[],
  /** Every advisory-lock key taken, in order. */
  locks: [] as string[],
  /** Ordered trace of the operations that must not interleave. */
  trace: [] as string[],
}));

const db = vi.hoisted(() => {
  const d: any = {
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, ...vals: unknown[]) => {
      store.locks.push(String(vals[0]));
      store.trace.push(`lock:${String(vals[0])}`);
      return 1;
    }),
    organization: {
      findMany: vi.fn(async () => store.orgs),
      findUnique: vi.fn(async ({ where }: any) => store.orgs.find((o) => o.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const org = store.orgs.find((o) => o.id === where.id);
        if (data.prepaidMinutes?.decrement !== undefined) {
          org.prepaidMinutes -= data.prepaidMinutes.decrement;
        }
        Object.assign(org, Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'prepaidMinutes')));
        return org;
      }),
    },
    overageCharge: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { orgId, month } = where.orgId_month;
        store.trace.push(`read-close:${orgId}:${month}`);
        return store.charges.find((c) => c.orgId === orgId && c.month === month) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        store.trace.push(`close:${data.orgId}:${data.month}`);
        const row = { id: `oc_${store.charges.length + 1}`, ...data };
        store.charges.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
      // Everything earlier months drew down, for pricing this month's prepaid
      // minutes at what they were sold for.
      aggregate: vi.fn(async () => ({ _sum: { prepaidMinutes: 0 } })),
    },
    minuteTopUp: { findMany: vi.fn(async () => [] as unknown[]) },
    // No client rate cards: these orgs are priced from the plan catalogue.
    rateCard: { findFirst: vi.fn(async () => null) },
    call: {
      aggregate: vi.fn(async ({ where }: any) => {
        store.trace.push(`sum-calls:${where.workspace.orgId}`);
        const rows = store.calls.filter((c) => c.orgId === where.workspace.orgId);
        return { _sum: { durationSec: rows.reduce((s, r) => s + r.durationSec, 0) } };
      }),
    },
    usageEvent: {
      aggregate: vi.fn(async ({ where }: any) => {
        store.trace.push(`sum-ledger:${where.orgId}:${where.billingMonth}`);
        const rows = store.events.filter(
          (e) => e.orgId === where.orgId && e.billingMonth === where.billingMonth && e.metric === where.metric,
        );
        return { _sum: { quantity: rows.reduce((s, r) => s + r.quantity, 0) } };
      }),
    },
    planChange: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    // The sweep now refuses to close a month for an org whose minutes are
    // spoken on a reseller platform until that platform has been fully read.
    // Empty here: these orgs are served by our own pipeline, so there is
    // nothing upstream to reconcile and the month is closeable.
    voicePlatformAccount: { findMany: vi.fn(async () => [] as unknown[]) },
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/platform', () => ({
  isSuperAdmin: vi.fn(() => true),
  getWhatsappChatAddonPrice: vi.fn(async () => 0),
  getPlanOverrides: vi.fn(async () => ({})),
}));
vi.mock('@/lib/cashfree', () => ({
  getCashfreeConfig: vi.fn(async () => ({})),
  isCashfreeConfigured: vi.fn(() => false),
  checkoutMode: vi.fn(() => 'order'),
  chargeSubscription: vi.fn(),
}));
vi.mock('@/lib/auth/api', () => ({
  apiContext: vi.fn(async () => ({ ctx: { user: { email: 'founder@vaaniyantra.com' }, org: { id: 'org_1' } } })),
}));

import { runOverageSweep } from '@/lib/billing/overage-sweep';
import { billingLockKey, monthKey, nextMonthKey } from '@/lib/usage/period';
import { POST as flip, GET as listSources } from '@/app/api/admin/usage-source/route';

const NOW = new Date();
const CURRENT = monthKey(NOW);
const NEXT = nextMonthKey(CURRENT);
const SWEPT = monthKey(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1)));
const FROM = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1));
const TO = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));

const org = (over: Record<string, unknown> = {}) => ({
  id: 'org_1',
  name: 'Acme',
  plan: 'standard',
  prepaidMinutes: 0,
  cashfreeSubscriptionId: null,
  subscriptionStatus: null,
  whatsappChatAddon: false,
  usageSource: 'calls',
  usageSourceSince: null,
  ...over,
});

const post = (body: unknown) =>
  flip(new Request('http://test/api/admin/usage-source', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets call history but NOT an implementation installed with
  // mockImplementation, so the race test below would leak its stub into every
  // test after it. Reinstate the default explicitly.
  db.overageCharge.findUnique.mockImplementation(async ({ where }: any) => {
    const { orgId, month } = where.orgId_month;
    store.trace.push(`read-close:${orgId}:${month}`);
    return store.charges.find((c) => c.orgId === orgId && c.month === month) ?? null;
  });
  store.orgs = [org()];
  store.charges = [];
  store.events = [];
  store.calls = [];
  store.locks = [];
  store.trace = [];
});

describe('the sweep closes a month under the same lock it reads it', () => {
  it('takes the org billing lock before summing the month', async () => {
    store.calls.push({ orgId: 'org_1', durationSec: 6000 });

    await runOverageSweep(SWEPT, FROM, TO);

    const lockAt = store.trace.indexOf(`lock:${billingLockKey('org_1')}`);
    const sumAt = store.trace.findIndex((t) => t.startsWith('sum-calls:'));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(sumAt).toBeGreaterThan(lockAt);
  });

  it('still holds it when the month is closed', async () => {
    store.calls.push({ orgId: 'org_1', durationSec: 6000 });

    await runOverageSweep(SWEPT, FROM, TO);

    // read → close must both sit after the lock, with nothing releasing it in
    // between. This ordering is the whole protection: a usage row that checks
    // "is this month open?" cannot slip between the sum and the close.
    const lockAt = store.trace.indexOf(`lock:${billingLockKey('org_1')}`);
    const sumAt = store.trace.findIndex((t) => t.startsWith('sum-'));
    const closeAt = store.trace.findIndex((t) => t.startsWith('close:'));
    expect(lockAt).toBeLessThan(sumAt);
    expect(sumAt).toBeLessThan(closeAt);
  });

  it('re-checks for a settled month inside the lock', async () => {
    // The cron fires twice a month for reboot tolerance, so two runs really do
    // race. The pre-check outside the transaction can be stale by the time the
    // lock is held.
    store.calls.push({ orgId: 'org_1', durationSec: 6000 });
    let firstCall = true;
    db.overageCharge.findUnique.mockImplementation(async ({ where }: any) => {
      if (firstCall) {
        firstCall = false;
        return null; // the cheap pre-check sees an open month
      }
      return { id: 'oc_race', minutes: 100, amountInr: 500, status: 'charged', ...where.orgId_month };
    });

    const results = await runOverageSweep(SWEPT, FROM, TO);

    expect(results[0].status).toBe('already charged');
    expect(db.overageCharge.create).not.toHaveBeenCalled();
  });

  it('bills a flipped org from the ledger, not from the calls table', async () => {
    store.orgs = [org({ usageSource: 'ledger', usageSourceSince: SWEPT })];
    // Deliberately contradictory: the calls table is nearly empty for this org
    // because its minutes were spoken on a platform we do not run.
    store.calls.push({ orgId: 'org_1', durationSec: 60 });
    store.events.push({ orgId: 'org_1', billingMonth: SWEPT, metric: 'voice.minutes', quantity: 6000 });

    const results = await runOverageSweep(SWEPT, FROM, TO);

    expect(results[0].minutes).toBe(100);
    expect(db.usageEvent.aggregate).toHaveBeenCalled();
  });

  it('bills a month from BEFORE the flip out of the calls table', async () => {
    // The flip takes effect next month, so the month being swept predates it.
    store.orgs = [org({ usageSource: 'ledger', usageSourceSince: NEXT })];
    store.calls.push({ orgId: 'org_1', durationSec: 6000 });
    store.events.push({ orgId: 'org_1', billingMonth: SWEPT, metric: 'voice.minutes', quantity: 999999 });

    const results = await runOverageSweep(SWEPT, FROM, TO);

    // Re-running an old month has to produce the number the customer was
    // actually invoiced, not a number from a source that took over later.
    expect(results[0].minutes).toBe(100);
  });

  it('draws the balance down inside the same transaction for a covered month', async () => {
    store.orgs = [org({ prepaidMinutes: 500 })];
    store.calls.push({ orgId: 'org_1', durationSec: 6000 }); // 100 min, fully covered

    const results = await runOverageSweep(SWEPT, FROM, TO);

    expect(results[0]).toMatchObject({ status: 'covered by prepaid', prepaidMinutes: 100 });
    expect(store.orgs[0].prepaidMinutes).toBe(400);
    // The zero-rupee marker row is what makes the drawdown exactly-once.
    expect(store.charges[0]).toMatchObject({ month: SWEPT, status: 'prepaid', prepaidMinutes: 100 });
  });
});

describe('a month is never closed against an unreconciled reseller account', () => {
  it('blocks the sweep while a sub-account is failing to reconcile', async () => {
    store.calls.push({ orgId: 'org_1', durationSec: 6000 });
    db.voicePlatformAccount.findMany.mockResolvedValueOnce([
      { label: 'Sunrise / Omni', lastPolledAt: new Date(), consecutiveFailures: 2 },
    ]);

    const results = await runOverageSweep(SWEPT, FROM, TO);

    // Billing half a month is worse than billing it late: OverageCharge is
    // unique per (org, month), so the missing minutes have no way back.
    expect(results[0].status).toMatch(/^blocked_unreconciled/);
    expect(db.overageCharge.create).not.toHaveBeenCalled();
  });

  it('bills normally once the account has been polled past the month end', async () => {
    store.calls.push({ orgId: 'org_1', durationSec: 6000 });
    db.voicePlatformAccount.findMany.mockResolvedValueOnce([
      { label: 'Sunrise / Omni', lastPolledAt: new Date(TO.getTime() + 3_600_000), consecutiveFailures: 0 },
    ]);

    const results = await runOverageSweep(SWEPT, FROM, TO);

    expect(results[0].minutes).toBe(100);
    expect(db.overageCharge.create).toHaveBeenCalled();
  });
});

describe('flipping an org between sources', () => {
  it('defaults to the first month that has not started', async () => {
    const res = await post({ orgId: 'org_1', source: 'ledger' });

    expect(res.status).toBe(200);
    expect(store.orgs[0]).toMatchObject({ usageSource: 'ledger', usageSourceSince: NEXT });
  });

  it('refuses to take effect this month', async () => {
    const res = await post({ orgId: 'org_1', source: 'ledger', effectiveMonth: CURRENT });

    // Half a month from each source is billed once, into a row that is unique
    // per (org, month) and so cannot be corrected in place.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ earliestEffectiveMonth: NEXT });
    expect(store.orgs[0].usageSource).toBe('calls');
  });

  it('refuses to take effect in a past month', async () => {
    const res = await post({ orgId: 'org_1', source: 'ledger', effectiveMonth: SWEPT });

    expect(res.status).toBe(400);
    expect(store.orgs[0].usageSource).toBe('calls');
  });

  it('clears the effective date when moving back to calls', async () => {
    store.orgs = [org({ usageSource: 'ledger', usageSourceSince: SWEPT })];

    const res = await post({ orgId: 'org_1', source: 'calls' });

    expect(res.status).toBe(200);
    // A stale date left behind would make a later re-flip silently apply from
    // the OLD month, re-pricing everything in between.
    expect(store.orgs[0]).toMatchObject({ usageSource: 'calls', usageSourceSince: null });
  });

  it('rejects an unknown source', async () => {
    const res = await post({ orgId: 'org_1', source: 'guess' });

    expect(res.status).toBe(400);
    expect(store.orgs[0].usageSource).toBe('calls');
  });

  it('404s an org that does not exist', async () => {
    const res = await post({ orgId: 'nope', source: 'ledger' });

    expect(res.status).toBe(404);
  });

  it('lists every org with the earliest month a flip could apply from', async () => {
    const res = await listSources();

    await expect(res.json()).resolves.toMatchObject({
      earliestEffectiveMonth: NEXT,
      orgs: [{ id: 'org_1', usageSource: 'calls' }],
    });
  });
});
