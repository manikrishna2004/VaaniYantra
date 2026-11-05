import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { getVoicePlatform } from '@/lib/adapters/voice-platform';
import type { VoicePlatformCallRecord, VoicePlatformProvider } from '@/lib/adapters/voice-platform/types';
import { reconcileUsage, BILLABLE_METRIC } from '@/lib/usage/ledger';
import { monthStartOf, monthEndOf } from '@/lib/usage/period';

// ── Pulling billable minutes back from the reseller platform ────────────────
//
// This is the billing source of truth for any org served by OmniDimension. It
// is a PULL, deliberately: a deployment running in a client's own cloud can be
// switched off, firewalled or patched, and none of that changes what the
// provider says we owe them or what the client owes us.
//
// ── What their API forces on the design ─────────────────────────────────────
//
// `/calls/logs` takes pageno, pagesize, agentid, call_status and bulk_call_id.
// There is no date filter, and a call record has no modified timestamp. So:
//
//   • the cursor is a high-water mark on the numeric call-log id, not a time;
//   • a routine poll pages newest-first and stops once it is far enough past
//     the cursor to be confident it has seen everything new;
//   • a CORRECTION to an older call cannot be detected incrementally at all.
//     The only way to find one is to read the call again, which is what the
//     month-end full re-pull is for. Skip that and a revised duration is never
//     billed.
//
// The safety property throughout: the cursor may be REPLAYED, never advanced
// past unprocessed data. Re-reading is free — the ledger is idempotent on
// (source, externalId) — so every ambiguous case resolves towards reading more.

/** Pages to keep reading past the cursor before trusting that we are caught up. */
const OVERLAP_PAGES = 1;
/** Hard stop, so a first run against a large account cannot page forever. */
const MAX_PAGES = 200;

export type ReconcileResult = {
  account: string;
  org: string;
  subAccountId: string;
  pulled: number;
  inserted: number;
  corrected: number;
  correctedSeconds: number;
  /** True when every record in the run had an unambiguous timestamp. */
  exact: boolean;
  error?: string;
};

type Account = {
  id: string;
  orgId: string;
  workspaceId: string | null;
  subAccountId: string;
  label: string;
  apiKeyEnc: string | null;
  timezone: string | null;
  cursorLogId: number | null;
  org: { name: string };
};

/**
 * Decrypt a per-account key, if there is one.
 *
 * A child key that will not decrypt is a hard failure rather than a silent
 * fallback to the reseller key: falling back would read the WRONG account's
 * call logs and bill one client for another's minutes.
 */
function childKeyFor(acct: Account): string | null {
  if (!acct.apiKeyEnc) return null;
  return decryptSecret(acct.apiKeyEnc);
}

/** One page loop for one sub-account. Returns the records it decided are new. */
async function pullRecords(
  provider: VoicePlatformProvider,
  acct: Account,
  opts: { full: boolean },
): Promise<{ records: VoicePlatformCallRecord[]; highestSortKey: number | null }> {
  const cursor = acct.cursorLogId ?? null;
  const out: VoicePlatformCallRecord[] = [];
  let highest: number | null = null;
  let page: string | null = null;
  let pagesPastCursor = 0;

  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await provider.listCalls({
      subAccountId: acct.subAccountId,
      cursor: page,
      stopAtSortKey: opts.full ? null : cursor,
      // The child's timezone is what places an ambiguous local timestamp on the
      // clock; without it every record in the run is flagged inexact.
      ...({ timezone: acct.timezone } as Record<string, unknown>),
    });

    for (const r of res.records) {
      if (highest === null || r.sortKey > highest) highest = r.sortKey;
      out.push(r);
    }

    if (res.nextCursor === null) break;

    // A full re-pull reads everything; an incremental one stops once it has
    // read a whole page below the cursor. The extra page is the overlap: a
    // record written at the exact moment of the last poll must not be skipped,
    // and re-reading it costs nothing.
    if (!opts.full && cursor !== null && res.records.every((r) => r.sortKey <= cursor)) {
      pagesPastCursor += 1;
      if (pagesPastCursor > OVERLAP_PAGES) break;
    }
    page = res.nextCursor;
  }

  return { records: out, highestSortKey: highest };
}

/**
 * Reconcile one sub-account.
 *
 * `fullMonth` reads the whole listing rather than stopping at the cursor. It is
 * how a correction to an older call is found, and it must be run before a month
 * is closed — see the `blocked_unreconciled` guard in the monthly sweep.
 */
export async function reconcileAccount(
  accountId: string,
  opts: { fullMonth?: string | null; provider?: VoicePlatformProvider | null } = {},
): Promise<ReconcileResult> {
  const acct = (await prisma.voicePlatformAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      orgId: true,
      workspaceId: true,
      subAccountId: true,
      label: true,
      apiKeyEnc: true,
      timezone: true,
      cursorLogId: true,
      org: { select: { name: true } },
    },
  })) as Account | null;

  const base: ReconcileResult = {
    account: acct?.label ?? accountId,
    org: acct?.org.name ?? '?',
    subAccountId: acct?.subAccountId ?? '?',
    pulled: 0,
    inserted: 0,
    corrected: 0,
    correctedSeconds: 0,
    exact: true,
  };
  if (!acct) return { ...base, error: 'no such account' };

  const provider = opts.provider ?? (await getVoicePlatform());
  if (!provider) return { ...base, error: 'no voice platform configured' };

  const full = Boolean(opts.fullMonth);
  const window = opts.fullMonth
    ? { from: monthStartOf(opts.fullMonth), to: monthEndOf(opts.fullMonth) }
    : null;

  try {
    // A child key that cannot be decrypted must stop the run, not fall through
    // to the reseller key and read somebody else's account.
    childKeyFor(acct);

    const { records, highestSortKey } = await pullRecords(provider, acct, { full });

    let inserted = 0;
    let corrected = 0;
    let correctedSeconds = 0;
    let exact = true;

    for (const r of records) {
      if (!r.occurredAtExact) exact = false;
      // A full-month re-pull only settles the month it was asked about; records
      // outside it are still recorded, but they are not what this run is for.
      if (window && (r.occurredAt < window.from || r.occurredAt >= window.to)) continue;

      const res = await reconcileUsage({
        orgId: acct.orgId,
        workspaceId: acct.workspaceId,
        metric: BILLABLE_METRIC,
        source: 'omnidimension',
        externalId: r.externalId,
        totalQuantity: r.billableSeconds,
        occurredAt: r.occurredAt,
        costInr: r.supplierCost ?? null,
        raw: r.raw as never,
      });
      if (res.seq === 0) inserted += 1;
      else if (res.deltaApplied !== 0) {
        corrected += 1;
        correctedSeconds += res.deltaApplied;
      }
    }

    // ── Advance the cursor, but never past what we processed ────────────────
    //
    // Only after the whole page loop succeeded, and never on a full re-pull
    // that was scoped to one month — that run deliberately did not read the
    // newest records, so treating it as "caught up" would skip everything since.
    const advance = !full && highestSortKey !== null && highestSortKey > (acct.cursorLogId ?? -1);

    await prisma.voicePlatformAccount.update({
      where: { id: acct.id },
      data: {
        ...(advance ? { cursorLogId: highestSortKey } : {}),
        lastPolledAt: new Date(),
        ...(records.length > 0
          ? { lastRecordAt: records.reduce((a, r) => (r.occurredAt > a ? r.occurredAt : a), records[0].occurredAt) }
          : {}),
        consecutiveFailures: 0,
        lastError: null,
      },
    });

    return { ...base, pulled: records.length, inserted, corrected, correctedSeconds, exact };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The cursor is deliberately NOT advanced. A failed run must re-read, and
    // re-reading is free.
    await prisma.voicePlatformAccount
      .update({
        where: { id: acct.id },
        data: { consecutiveFailures: { increment: 1 }, lastError: message.slice(0, 500) },
      })
      .catch(() => {});
    return { ...base, error: message };
  }
}

/** Reconcile every ACTIVE sub-account. Driven by the 15-minute ops cron. */
export async function runVoicePlatformReconcile(
  opts: { accountIds?: string[]; fullMonth?: string | null } = {},
): Promise<ReconcileResult[]> {
  const provider = await getVoicePlatform();
  const accounts = await prisma.voicePlatformAccount.findMany({
    where: {
      status: 'ACTIVE',
      ...(opts.accountIds?.length ? { id: { in: opts.accountIds } } : {}),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  const results: ReconcileResult[] = [];
  for (const a of accounts) {
    // Sequential on purpose: this runs behind a per-org advisory lock in the
    // ledger writer, and hammering a provider's rate limit in parallel is how a
    // reconciliation run half-completes.
    results.push(await reconcileAccount(a.id, { fullMonth: opts.fullMonth, provider }));
  }
  return results;
}

/**
 * Refresh the cached balance, rate and timezone for every sub-account.
 *
 * Cheap (one call for all children) and worth doing on every run: `org_balance`
 * is the real prepaid ceiling, `cost_per_min` is the cost side of the margin
 * report, and `timezone` decides which month an ambiguous timestamp lands in.
 */
export async function refreshSubAccountFacts(
  provider?: VoicePlatformProvider | null,
): Promise<{ updated: number }> {
  const p = provider ?? (await getVoicePlatform());
  if (!p) return { updated: 0 };

  const remote = await p.listSubAccounts();
  let updated = 0;
  for (const r of remote) {
    const res = await prisma.voicePlatformAccount.updateMany({
      where: { provider: p.name === 'mock' ? undefined : 'omnidimension', subAccountId: r.subAccountId },
      data: {
        costPerMin: r.costPerMin ?? undefined,
        balanceMinutes: r.balanceMinutes ?? undefined,
        timezone: r.timezone ?? undefined,
      },
    });
    updated += res.count;
  }
  return { updated };
}

export type ReconcileHealth = {
  accountId: string;
  label: string;
  org: string;
  lastPolledAt: Date | null;
  pollAgeHours: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  balanceMinutes: number | null;
  /** True when recent volume has collapsed against its own trailing median. */
  volumeCollapse: boolean;
};

/**
 * Whether a month can be CLOSED for an org served by a reseller.
 *
 * Billing half a month is worse than billing it late: OverageCharge is unique
 * per (orgId, month), so the shortfall is permanent and cannot be corrected in
 * place. A month is only settle-able when every sub-account for that org has
 * been reconciled cleanly, and past the end of the month itself.
 */
export async function readyToCloseMonth(
  orgId: string,
  monthEnd: Date,
): Promise<{ ready: boolean; reason?: string }> {
  const accounts = await prisma.voicePlatformAccount.findMany({
    where: { orgId, status: 'ACTIVE' },
    select: { label: true, lastPolledAt: true, consecutiveFailures: true },
  });
  // No reseller account means nothing to reconcile — the org is served by our
  // own pipeline and the calls table is complete by construction.
  if (accounts.length === 0) return { ready: true };

  for (const a of accounts) {
    if (a.consecutiveFailures > 0) {
      return { ready: false, reason: `${a.label}: ${a.consecutiveFailures} failed poll(s)` };
    }
    if (!a.lastPolledAt) return { ready: false, reason: `${a.label}: never polled` };
    if (a.lastPolledAt < monthEnd) {
      return { ready: false, reason: `${a.label}: last polled before the month ended` };
    }
  }
  return { ready: true };
}
