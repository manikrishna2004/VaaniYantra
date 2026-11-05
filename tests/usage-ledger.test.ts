import { describe, it, expect, vi, beforeEach } from 'vitest';

// The usage ledger is what will decide what a customer is charged once minutes
// stop being ones we ran ourselves. It is written in shadow today, so a bug in
// it is invisible until the day it becomes authoritative — which is exactly the
// kind of bug this file exists to catch early.
//
// Four properties, all of which the billing code around it already assumes:
//
//   1. Recording the same unit of usage twice records it once. P2002 is the
//      SUCCESS case, not an error, exactly as in creditMinutes/consumePrepaid.
//   2. A correction appends the DIFFERENCE at the next seq. It never rewrites,
//      and it writes nothing when the total already matches.
//   3. A row for a month that has already been settled rolls FORWARD to the
//      first open month. Reopening a settled month would contradict an
//      OverageCharge that an immutable Invoice was built from.
//   4. Billing reads one metric and one source per org per month, and a past
//      month is measured the way it was measured then.

type Row = {
  id: string;
  orgId: string;
  workspaceId: string | null;
  metric: string;
  source: string;
  externalId: string;
  seq: number;
  quantity: number;
  occurredAt: Date;
  billingMonth: string;
  originMonth: string;
  costInr: number | null;
  callId: string | null;
};

const store = vi.hoisted(() => ({
  events: [] as any[],
  /** Months settled per org: `${orgId}:${month}`. */
  closed: new Set<string>(),
  calls: [] as any[],
  orgs: [] as any[],
  nextId: 1,
  lockedKeys: [] as string[],
}));

const db = vi.hoisted(() => {
  const client: any = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      store.lockedKeys.push(String(vals[0]));
      return 1;
    }),
    $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(client)),
    usageEvent: {
      create: vi.fn(async ({ data }: { data: any }) => {
        const clash = store.events.find(
          (e) => e.source === data.source && e.externalId === data.externalId && e.seq === data.seq,
        );
        if (clash) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `ue_${store.nextId++}`, ...data };
        store.events.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        let rows = store.events.filter(
          (e) => e.source === where.source && e.externalId === where.externalId,
        );
        if (orderBy?.seq === 'desc') rows = [...rows].sort((a, b) => b.seq - a.seq);
        return rows;
      }),
      aggregate: vi.fn(async ({ where }: any) => {
        const rows = store.events.filter(
          (e) =>
            e.orgId === where.orgId &&
            e.billingMonth === where.billingMonth &&
            e.metric === where.metric,
        );
        return { _sum: { quantity: rows.reduce((s, r) => s + r.quantity, 0) } };
      }),
    },
    overageCharge: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { orgId, month } = where.orgId_month;
        return store.closed.has(`${orgId}:${month}`) ? { id: 'oc_1' } : null;
      }),
    },
    call: {
      findUnique: vi.fn(async ({ where }: any) => store.calls.find((c) => c.id === where.id) ?? null),
      aggregate: vi.fn(async ({ where }: any) => {
        const rows = store.calls.filter(
          (c) =>
            c.workspace?.orgId === where.workspace.orgId &&
            c.createdAt >= where.createdAt.gte &&
            c.createdAt < where.createdAt.lt,
        );
        return { _sum: { durationSec: rows.reduce((s, r) => s + r.durationSec, 0) } };
      }),
    },
    organization: {
      findUnique: vi.fn(async ({ where }: any) => store.orgs.find((o) => o.id === where.id) ?? null),
      findMany: vi.fn(async () => store.orgs),
    },
  };
  return client;
});

vi.mock('@/lib/db', () => ({ prisma: db }));

import { recordUsage, reconcileUsage, syncCallUsage } from '@/lib/usage/ledger';
import { assignBillingMonth, monthKey, nextMonthKey, billingLockKey } from '@/lib/usage/period';
import {
  billableMinutes,
  ledgerMinutesInPeriod,
  callMinutesInPeriod,
  sourceForPeriod,
  periodFor,
  usageDrift,
} from '@/lib/usage/minutes';

const THIS_MONTH = monthKey(new Date());
const NOW = new Date();
/** A date safely inside the current month, so nothing rolls forward by accident. */
const IN_MONTH = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 15, 12));

const base = {
  orgId: 'org_1',
  metric: 'voice.minutes' as const,
  source: 'vaani_voice' as const,
  occurredAt: IN_MONTH,
};

const total = (externalId: string) =>
  store.events.filter((e) => e.externalId === externalId).reduce((s, e) => s + e.quantity, 0);

beforeEach(() => {
  vi.clearAllMocks();
  store.events = [];
  store.closed = new Set();
  store.calls = [];
  store.orgs = [{ id: 'org_1', name: 'Acme', usageSource: 'calls', usageSourceSince: null }];
  store.nextId = 1;
  store.lockedKeys = [];
});

describe('recordUsage — exactly once', () => {
  it('records the first report', async () => {
    const res = await recordUsage({ ...base, externalId: 'call_1', quantity: 90 });

    expect(res.recorded).toBe(true);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ seq: 0, quantity: 90, billingMonth: THIS_MONTH });
  });

  it('is a no-op the second time, and does not throw', async () => {
    await recordUsage({ ...base, externalId: 'call_1', quantity: 90 });
    const again = await recordUsage({ ...base, externalId: 'call_1', quantity: 90 });

    // The unique violation is the outcome we wanted: somebody already recorded
    // exactly this. Surfacing it as an error would fail a webhook retry.
    expect(again.recorded).toBe(false);
    expect(store.events).toHaveLength(1);
  });

  it('does not let a replay change the recorded quantity', async () => {
    await recordUsage({ ...base, externalId: 'call_1', quantity: 90 });
    await recordUsage({ ...base, externalId: 'call_1', quantity: 5000 });

    expect(total('call_1')).toBe(90);
  });

  it('records a zero-quantity call rather than skipping it', async () => {
    // "This call produced nothing billable" is a fact the drift report needs.
    // Skipping it looks identical to a call the ledger missed entirely.
    const res = await recordUsage({ ...base, externalId: 'call_silent', quantity: 0 });

    expect(res.recorded).toBe(true);
    expect(store.events).toHaveLength(1);
  });

  it('holds the org billing lock while it decides the month', async () => {
    await recordUsage({ ...base, externalId: 'call_1', quantity: 90 });

    expect(store.lockedKeys).toContain(billingLockKey('org_1'));
  });

  it('rethrows anything that is not a unique violation', async () => {
    db.usageEvent.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(recordUsage({ ...base, externalId: 'call_x', quantity: 10 })).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('reconcileUsage — corrections are deltas', () => {
  it('writes seq 0 when there is nothing yet', async () => {
    const res = await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 120 });

    expect(res).toEqual({ deltaApplied: 120, seq: 0 });
    expect(total('call_1')).toBe(120);
  });

  it('appends only the difference when the total is revised up', async () => {
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 120 });
    const res = await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 200 });

    expect(res).toEqual({ deltaApplied: 80, seq: 1 });
    expect(store.events).toHaveLength(2);
    expect(store.events[1].quantity).toBe(80);
    expect(total('call_1')).toBe(200);
  });

  it('appends a negative delta when the total is revised down', async () => {
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 300 });
    const res = await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 260 });

    expect(res.deltaApplied).toBe(-40);
    expect(store.events[1].quantity).toBe(-40);
    expect(total('call_1')).toBe(260);
  });

  it('never rewrites or removes an earlier row', async () => {
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 300 });
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 260 });

    // The original report survives verbatim: an audit has to be able to show
    // what was reported first, not only what the total ended up as.
    expect(store.events[0]).toMatchObject({ seq: 0, quantity: 300 });
  });

  it('writes nothing when the total already matches', async () => {
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 120 });
    const res = await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 120 });

    expect(res).toEqual({ deltaApplied: 0, seq: null });
    expect(store.events).toHaveLength(1);
  });

  it('serialises the read-then-append per record', async () => {
    // The unique constraint alone does NOT make this safe: two callers can both
    // read "300", both compute -40, and land at seq 1 and seq 2 without
    // violating anything — leaving the account 40 short.
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 300 });
    store.lockedKeys = [];
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 260 });

    expect(store.lockedKeys).toContain('usage:vaani_voice:call_1');
  });

  it('takes no per-record lock on the common first-report path', async () => {
    await reconcileUsage({ ...base, externalId: 'call_1', totalQuantity: 120 });

    // Corrections are rare; the hot path must not pay for them.
    expect(store.lockedKeys).not.toContain('usage:vaani_voice:call_1');
  });
});

describe('a settled month is never reopened', () => {
  const LAST = monthKey(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1)));
  const IN_LAST = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15, 12));

  it('bills into the month it happened in while that month is open', async () => {
    await recordUsage({ ...base, externalId: 'late_1', quantity: 60, occurredAt: IN_LAST });

    expect(store.events[0]).toMatchObject({ billingMonth: LAST, originMonth: LAST });
  });

  it('rolls forward when that month has been settled', async () => {
    store.closed.add(`org_1:${LAST}`);

    await recordUsage({ ...base, externalId: 'late_1', quantity: 60, occurredAt: IN_LAST });

    // Billed now, as a prior-period adjustment. The OverageCharge for LAST is
    // what an immutable invoice was built from, so it cannot be reopened.
    expect(store.events[0].billingMonth).toBe(nextMonthKey(LAST));
    // …and originMonth still says where it really came from, so it can be
    // explained to a customer rather than looking like a call nobody made.
    expect(store.events[0].originMonth).toBe(LAST);
  });

  it('walks past several settled months to the first open one', async () => {
    const TWO_AGO = monthKey(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 2, 1)));
    const IN_TWO_AGO = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 2, 10, 12));
    store.closed.add(`org_1:${TWO_AGO}`);
    store.closed.add(`org_1:${LAST}`);

    await recordUsage({ ...base, externalId: 'old_1', quantity: 60, occurredAt: IN_TWO_AGO });

    expect(store.events[0].billingMonth).toBe(THIS_MONTH);
  });

  it('never rolls a row into the future, even if the current month looks closed', async () => {
    // The current month cannot really be settled — its sweep has not run — but
    // the loop must terminate at it regardless, or a row lands in a month that
    // does not exist yet and is never billed.
    store.closed.add(`org_1:${THIS_MONTH}`);

    const { billingMonth } = await assignBillingMonth(db, 'org_1', IN_MONTH);

    expect(billingMonth).toBe(THIS_MONTH);
  });

  it('is decided per org — one org settling a month does not move another', async () => {
    store.closed.add(`org_2:${LAST}`);

    await recordUsage({ ...base, externalId: 'late_1', quantity: 60, occurredAt: IN_LAST });

    expect(store.events[0].billingMonth).toBe(LAST);
  });
});

describe('syncCallUsage — the dual-write hook', () => {
  const call = {
    id: 'call_9',
    workspaceId: 'ws_1',
    durationSec: 42,
    createdAt: IN_MONTH,
    startedAt: IN_MONTH,
    llmCostInr: 1.5,
    workspace: { orgId: 'org_1' },
  };

  it('mirrors the call’s current duration', async () => {
    store.calls.push(call);

    await syncCallUsage('call_9');

    expect(total('call_9')).toBe(42);
    expect(store.events[0]).toMatchObject({ source: 'vaani_voice', callId: 'call_9', seq: 0 });
  });

  it('converges when a second writer corrects the duration', async () => {
    // The carrier fills a gap first, then the pipeline writes the real figure.
    // Whichever order they land in, the ledger must end up agreeing with the
    // calls table — that is the invariant the drift report checks.
    store.calls.push({ ...call, durationSec: 30 });
    await syncCallUsage('call_9');
    store.calls[0].durationSec = 45;
    await syncCallUsage('call_9');

    expect(total('call_9')).toBe(45);
    expect(store.events).toHaveLength(2);
  });

  it('is idempotent when called repeatedly with no change', async () => {
    store.calls.push(call);

    await syncCallUsage('call_9');
    await syncCallUsage('call_9');
    await syncCallUsage('call_9');

    expect(store.events).toHaveLength(1);
  });

  it('records nothing for a call with no workspace', async () => {
    // An inbound call can land before routing resolves one, and there is no
    // organisation to bill.
    store.calls.push({ ...call, workspaceId: null, workspace: null });

    await syncCallUsage('call_9');

    expect(store.events).toHaveLength(0);
  });

  it('never throws, so it cannot fail a call or a carrier webhook', async () => {
    db.call.findUnique.mockRejectedValueOnce(new Error('db down'));

    await expect(syncCallUsage('call_9')).resolves.toBeUndefined();
  });

  it('bills a reaped call in the month it happened, not the month it was noticed', async () => {
    const LAST_M = monthKey(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 1)));
    const then = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 20, 9));
    store.calls.push({ ...call, startedAt: then, createdAt: then });

    await syncCallUsage('call_9');

    expect(store.events[0].originMonth).toBe(LAST_M);
  });
});

describe('reading a billable minute', () => {
  const period = periodFor(IN_MONTH);

  it('rounds once, over the summed seconds', async () => {
    // Two 90-second calls are 3 minutes. Rounding each to 2 and summing gives
    // 4 — which is what per-row rounding would have billed.
    await recordUsage({ ...base, externalId: 'a', quantity: 90 });
    await recordUsage({ ...base, externalId: 'b', quantity: 90 });

    expect(await ledgerMinutesInPeriod('org_1', period)).toBe(3);
  });

  it('counts a correction into the month it was billed in', async () => {
    await reconcileUsage({ ...base, externalId: 'a', totalQuantity: 600 });
    await reconcileUsage({ ...base, externalId: 'a', totalQuantity: 300 });

    expect(await ledgerMinutesInPeriod('org_1', period)).toBe(5);
  });

  it('never sums self-reported minutes into a charge', async () => {
    await recordUsage({ ...base, externalId: 'a', quantity: 600 });
    await recordUsage({
      ...base,
      externalId: 'a-reported',
      quantity: 99_999,
      metric: 'voice.minutes.reported',
      source: 'client_cloud',
    });

    // A deployment the client has root on writes into a namespace the biller
    // does not read. That is what makes "upstream is the source of truth"
    // structural rather than a convention.
    expect(await ledgerMinutesInPeriod('org_1', period)).toBe(10);
  });

  it('reads the calls table for an org that has not been flipped', async () => {
    store.calls.push({ id: 'c1', durationSec: 120, createdAt: IN_MONTH, workspace: { orgId: 'org_1' } });
    await recordUsage({ ...base, externalId: 'a', quantity: 999 });

    // Shadow mode: the ledger is written and deliberately not read.
    expect(await billableMinutes('org_1', period)).toBe(2);
  });

  it('reads the ledger once the org is flipped', async () => {
    store.orgs[0] = { ...store.orgs[0], usageSource: 'ledger', usageSourceSince: THIS_MONTH };
    store.calls.push({ id: 'c1', durationSec: 120, createdAt: IN_MONTH, workspace: { orgId: 'org_1' } });
    await recordUsage({ ...base, externalId: 'a', quantity: 600 });

    expect(await billableMinutes('org_1', period)).toBe(10);
  });

  it('measures a month from before the flip the way it was measured then', () => {
    const org = { usageSource: 'ledger', usageSourceSince: '2026-09' };

    // Otherwise re-running an old month produces a different number from the
    // one the customer was invoiced — the same trap PlanChange exists to avoid.
    expect(sourceForPeriod(org, { key: '2026-08' } as any)).toBe('calls');
    expect(sourceForPeriod(org, { key: '2026-09' } as any)).toBe('ledger');
    expect(sourceForPeriod(org, { key: '2026-10' } as any)).toBe('ledger');
  });

  it('falls back to the calls table for an org it cannot read', async () => {
    store.orgs = [];
    store.calls.push({ id: 'c1', durationSec: 60, createdAt: IN_MONTH, workspace: { orgId: 'org_1' } });

    // Failing open to the ledger would bill from a table that may be empty.
    expect(await billableMinutes('org_1', period)).toBe(1);
  });
});

describe('the drift report — the gate on flipping an org', () => {
  it('reports a zero delta when both sources agree', async () => {
    store.calls.push({ id: 'c1', durationSec: 120, createdAt: IN_MONTH, workspace: { orgId: 'org_1' } });
    await recordUsage({ ...base, externalId: 'c1', quantity: 120 });

    const [row] = await usageDrift(THIS_MONTH);

    expect(row).toMatchObject({ callMinutes: 2, ledgerMinutes: 2, deltaMinutes: 0 });
  });

  it('surfaces a call the dual write missed', async () => {
    store.calls.push({ id: 'c1', durationSec: 120, createdAt: IN_MONTH, workspace: { orgId: 'org_1' } });
    store.calls.push({ id: 'c2', durationSec: 180, createdAt: IN_MONTH, workspace: { orgId: 'org_1' } });
    await recordUsage({ ...base, externalId: 'c1', quantity: 120 });

    const [row] = await usageDrift(THIS_MONTH);

    expect(row.deltaMinutes).toBe(-3);
  });

  it('ignores orgs with no activity either way', async () => {
    store.orgs.push({ id: 'org_2', name: 'Dormant', usageSource: 'calls', usageSourceSince: null });

    // Listing every dormant account buries the ones that matter.
    expect(await usageDrift(THIS_MONTH)).toHaveLength(0);
  });
});
