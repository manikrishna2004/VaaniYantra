import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pulling billable minutes back from a reseller platform, where the provider's
// API gives us far less than we would like:
//
//   • /calls/logs has NO date filter and a call record has NO updated-at, so
//     the cursor is a high-water mark on a numeric id and a correction to an
//     older call can only be found by reading it again;
//   • timestamps are ambiguous local strings ("05/04/2026 14:46:15"), and that
//     string decides which MONTH a minute is billed in.
//
// The properties that follow from that, and that this file exists to hold:
//
//   1. Re-reading is free and always safe — the ledger converges.
//   2. A failed run never advances the cursor.
//   3. A month is never closed against an incomplete or failed pull.
//   4. An ambiguous timestamp is reported as such rather than guessed at.

const store = vi.hoisted(() => ({
  accounts: [] as any[],
  events: [] as any[],
  closed: new Set<string>(),
  nextId: 1,
}));

const db = vi.hoisted(() => {
  const d: any = {
    $executeRaw: vi.fn(async () => 1),
    usageEvent: {
      create: vi.fn(async ({ data }: any) => {
        const clash = store.events.find(
          (e) => e.source === data.source && e.externalId === data.externalId && e.seq === data.seq,
        );
        if (clash) {
          const err: any = new Error('unique');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `ue_${store.nextId++}`, ...data };
        store.events.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let rows = store.events.filter((e) => e.source === where.source && e.externalId === where.externalId);
        if (orderBy?.seq === 'desc') rows = [...rows].sort((a, b) => b.seq - a.seq);
        return rows;
      }),
      aggregate: vi.fn(async () => ({ _sum: { quantity: 0 } })),
    },
    overageCharge: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { orgId, month } = where.orgId_month;
        return store.closed.has(`${orgId}:${month}`) ? { id: 'oc' } : null;
      }),
    },
    voicePlatformAccount: {
      findUnique: vi.fn(async ({ where }: any) => store.accounts.find((a) => a.id === where.id) ?? null),
      findMany: vi.fn(async () => store.accounts.filter((a) => a.status === 'ACTIVE')),
      update: vi.fn(async ({ where, data }: any) => {
        const a = store.accounts.find((x) => x.id === where.id);
        for (const [k, v] of Object.entries<any>(data)) {
          a[k] = v && typeof v === 'object' && 'increment' in v ? (a[k] ?? 0) + v.increment : v;
        }
        return a;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});

vi.mock('@/lib/db', () => ({ prisma: db }));
vi.mock('@/lib/crypto', () => ({ decryptSecret: vi.fn((s: string) => `plain:${s}`) }));
vi.mock('@/lib/platform', () => ({ getPlatformConfig: vi.fn(async () => null) }));

import { reconcileAccount, readyToCloseMonth } from '@/lib/usage/omni-reconcile';
import { MockVoicePlatform } from '@/lib/adapters/voice-platform/mock';
import { parseTimeOfCall } from '@/lib/adapters/voice-platform/omnidimension';
import type { VoicePlatformCallRecord } from '@/lib/adapters/voice-platform/types';

const NOW = new Date();
const IN_MONTH = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 15, 12));

const account = (over: Record<string, unknown> = {}) => ({
  id: 'vpa_1',
  orgId: 'org_1',
  workspaceId: 'ws_1',
  subAccountId: '4821',
  label: 'Sunrise Realty',
  apiKeyEnc: null,
  timezone: 'Asia/Kolkata',
  cursorLogId: null,
  status: 'ACTIVE',
  consecutiveFailures: 0,
  lastPolledAt: null,
  org: { name: 'Sunrise Realty' },
  ...over,
});

const call = (id: number, seconds: number, over: Partial<VoicePlatformCallRecord> = {}): VoicePlatformCallRecord => ({
  externalId: String(id),
  sortKey: id,
  subAccountId: '4821',
  occurredAt: IN_MONTH,
  occurredAtExact: true,
  billableSeconds: seconds,
  status: 'completed',
  direction: 'INBOUND',
  supplierCost: seconds * (3.2 / 60),
  raw: { id },
  ...over,
});

const total = (externalId: string) =>
  store.events.filter((e) => e.externalId === externalId).reduce((s, e) => s + e.quantity, 0);

let platform: MockVoicePlatform;

beforeEach(() => {
  vi.clearAllMocks();
  store.accounts = [account()];
  store.events = [];
  store.closed = new Set();
  store.nextId = 1;
  platform = new MockVoicePlatform([
    { subAccountId: '4821', name: 'Sunrise Realty', costPerMin: 3.2, balanceMinutes: 2140, timezone: 'Asia/Kolkata' },
  ]);
});

describe('pulling minutes into the ledger', () => {
  it('records every call it pulls', async () => {
    platform.seedCall(call(101, 120));
    platform.seedCall(call(102, 180));

    const res = await reconcileAccount('vpa_1', { provider: platform });

    expect(res).toMatchObject({ pulled: 2, inserted: 2, corrected: 0, exact: true });
    expect(total('101')).toBe(120);
    expect(total('102')).toBe(180);
  });

  it('is a no-op when run again over the same records', async () => {
    platform.seedCall(call(101, 120));

    await reconcileAccount('vpa_1', { provider: platform });
    const again = await reconcileAccount('vpa_1', { provider: platform });

    // Re-reading has to be free, because every ambiguous case in this design
    // resolves towards reading more.
    expect(again.inserted).toBe(0);
    expect(again.corrected).toBe(0);
    expect(store.events).toHaveLength(1);
  });

  it('applies a revised duration as a correction, not a second charge', async () => {
    platform.seedCall(call(101, 120));
    await reconcileAccount('vpa_1', { provider: platform });

    platform.seedCall(call(101, 200)); // the provider revised it
    const res = await reconcileAccount('vpa_1', { provider: platform, fullMonth: null });

    expect(res.corrected).toBe(1);
    expect(res.correctedSeconds).toBe(80);
    expect(total('101')).toBe(200);
  });

  it('carries the supplier cost onto the row, for margin', async () => {
    platform.seedCall(call(101, 60));

    await reconcileAccount('vpa_1', { provider: platform });

    // Without this a resold minute has revenue and no cost, and every margin
    // figure is the revenue.
    expect(store.events[0].costInr).toBeCloseTo(3.2, 5);
  });

  it('advances the cursor to the highest id it saw', async () => {
    platform.seedCall(call(101, 60));
    platform.seedCall(call(207, 60));

    await reconcileAccount('vpa_1', { provider: platform });

    expect(store.accounts[0].cursorLogId).toBe(207);
  });
});

describe('failure never loses a minute', () => {
  it('does not advance the cursor when the pull throws', async () => {
    store.accounts[0].cursorLogId = 50;
    const failing = new MockVoicePlatform();
    failing.listCalls = vi.fn(async () => {
      throw new Error('provider 503');
    });

    const res = await reconcileAccount('vpa_1', { provider: failing as never });

    expect(res.error).toContain('503');
    // The cursor is the promise that nothing between it and now has been
    // skipped. Advancing past unread data would break that permanently.
    expect(store.accounts[0].cursorLogId).toBe(50);
    expect(store.accounts[0].consecutiveFailures).toBe(1);
    expect(store.accounts[0].lastError).toContain('503');
  });

  it('clears the failure count after a clean run', async () => {
    store.accounts[0].consecutiveFailures = 3;
    platform.seedCall(call(101, 60));

    await reconcileAccount('vpa_1', { provider: platform });

    expect(store.accounts[0].consecutiveFailures).toBe(0);
    expect(store.accounts[0].lastError).toBeNull();
  });

  it('does not advance the cursor on a scoped full-month re-pull', async () => {
    // A month-scoped re-read deliberately does not look at the newest records,
    // so treating it as "caught up" would skip everything since.
    store.accounts[0].cursorLogId = 100;
    platform.seedCall(call(101, 60));

    const month = `${IN_MONTH.getUTCFullYear()}-${String(IN_MONTH.getUTCMonth() + 1).padStart(2, '0')}`;
    await reconcileAccount('vpa_1', { provider: platform, fullMonth: month });

    expect(store.accounts[0].cursorLogId).toBe(100);
  });

  it('reports an account that does not exist rather than throwing', async () => {
    const res = await reconcileAccount('nope', { provider: platform });

    expect(res.error).toBe('no such account');
  });
});

describe('a month is not closed against an incomplete pull', () => {
  const monthEnd = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1));

  it('allows an org with no reseller account', async () => {
    store.accounts = [];

    // Served by our own pipeline: the calls table is complete by construction.
    await expect(readyToCloseMonth('org_1', monthEnd)).resolves.toEqual({ ready: true });
  });

  it('blocks while a poll is failing', async () => {
    store.accounts = [account({ consecutiveFailures: 2, lastPolledAt: new Date() })];

    const res = await readyToCloseMonth('org_1', monthEnd);

    // Billing half a month is worse than billing it late: OverageCharge is
    // unique per (org, month), so the shortfall would be permanent.
    expect(res.ready).toBe(false);
    expect(res.reason).toContain('failed poll');
  });

  it('blocks when the account has never been polled', async () => {
    store.accounts = [account({ lastPolledAt: null })];

    await expect(readyToCloseMonth('org_1', monthEnd)).resolves.toMatchObject({ ready: false });
  });

  it('blocks when the last poll predates the end of the month', async () => {
    store.accounts = [account({ lastPolledAt: new Date(monthEnd.getTime() - 86_400_000) })];

    const res = await readyToCloseMonth('org_1', monthEnd);

    expect(res.ready).toBe(false);
    expect(res.reason).toContain('before the month ended');
  });

  it('allows once every account has been polled cleanly past the month end', async () => {
    store.accounts = [account({ lastPolledAt: new Date(monthEnd.getTime() + 3_600_000) })];

    await expect(readyToCloseMonth('org_1', monthEnd)).resolves.toEqual({ ready: true });
  });
});

describe('their ambiguous call timestamps', () => {
  it('is sure when the day is above 12', () => {
    const r = parseTimeOfCall('25/04/2026 14:46:15', 'Asia/Kolkata');

    expect(r?.exact).toBe(true);
    expect(r?.at.getUTCMonth()).toBe(3); // April
    expect(r?.at.getUTCDate()).toBe(25);
  });

  it('is NOT sure when both readings are possible', () => {
    // 05/04 is 5 April or 4 May depending on the convention, and those are
    // different MONTHS — which is what a minute is billed against.
    const r = parseTimeOfCall('05/04/2026 14:46:15', 'Asia/Kolkata');

    expect(r?.exact).toBe(false);
  });

  it('is not sure without the child organisation timezone', () => {
    // A call just before midnight lands on the wrong day without one, and once
    // a month on the wrong month.
    expect(parseTimeOfCall('25/04/2026 23:50:00', null)?.exact).toBe(false);
  });

  it('returns null for a value it cannot read at all', () => {
    expect(parseTimeOfCall('', 'Asia/Kolkata')).toBeNull();
    expect(parseTimeOfCall(null, 'Asia/Kolkata')).toBeNull();
  });

  it('flags a run containing an ambiguous timestamp', async () => {
    platform.seedCall(call(101, 60, { occurredAtExact: false }));

    const res = await reconcileAccount('vpa_1', { provider: platform });

    // The minute is still recorded — dropping it would lose revenue. But the
    // run is marked inexact so it cannot be trusted to settle a month.
    expect(res.inserted).toBe(1);
    expect(res.exact).toBe(false);
  });
});

describe('the spend cap', () => {
  it('moves a child balance through the provider', async () => {
    const res = await platform.setSpendCap({ subAccountId: '4821', minutes: 500 });

    // This is the only prepaid ceiling that survives a client-cloud install:
    // it is enforced upstream, where the client has no root.
    expect(res.balanceMinutes).toBe(2640);
    expect(platform.capCalls).toEqual([{ subAccountId: '4821', minutes: 500 }]);
  });

  it('claws credit back with a negative delta', async () => {
    await platform.setSpendCap({ subAccountId: '4821', minutes: -140 });

    expect((await platform.listSubAccounts())[0].balanceMinutes).toBe(2000);
  });
});
