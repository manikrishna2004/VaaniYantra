import { prisma } from '@/lib/db';
import { BILLABLE_METRIC } from '@/lib/usage/ledger';

// Health of the reseller pull, for /api/admin/ops-health.
//
// Three signals, and the important structural point is that BILLING depends on
// none of the ones a client controls:
//
//   A (authoritative)  the pull itself. A client-cloud install that goes silent
//                      still bills, because we never asked it anything.
//   B (ops only)       a stale or failing poll. Alerts; never a billing event.
//   C (revenue)        volume collapse — the one people forget. An ACTIVE
//                      account whose recent minutes have fallen off a cliff
//                      against its own trailing median is the signature of a
//                      client quietly repointing agents at their own reseller
//                      account. Nothing technical prevents that; the only
//                      defence is noticing.

/** A poll older than this means the pull has effectively stopped. */
const STALE_POLL_HOURS = 2;
/** Recent window compared against the trailing median. */
const RECENT_DAYS = 7;
const BASELINE_DAYS = 28;
/** Below this share of the baseline, recent volume counts as collapsed. */
const COLLAPSE_RATIO = 0.2;
/** Under this many baseline minutes the ratio is noise, not a signal. */
const MIN_BASELINE_MINUTES = 200;

export type AccountHealth = {
  accountId: string;
  label: string;
  org: string;
  lastPolledAt: string | null;
  pollAgeHours: number | null;
  stale: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  balanceMinutes: number | null;
  recentMinutes: number;
  baselineMinutesPerWeek: number;
  volumeCollapse: boolean;
};

export type VoicePlatformHealth = {
  accounts: AccountHealth[];
  oldestPollAgeHours: number | null;
};

const hoursSince = (d: Date | null) =>
  d === null ? null : Math.round(((Date.now() - d.getTime()) / 3_600_000) * 10) / 10;

export async function voicePlatformHealth(): Promise<VoicePlatformHealth> {
  const accounts = await prisma.voicePlatformAccount.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      label: true,
      orgId: true,
      lastPolledAt: true,
      consecutiveFailures: true,
      lastError: true,
      balanceMinutes: true,
      org: { select: { name: true } },
    },
  });

  const now = Date.now();
  const recentFrom = new Date(now - RECENT_DAYS * 86_400_000);
  const baselineFrom = new Date(now - BASELINE_DAYS * 86_400_000);

  const out: AccountHealth[] = [];
  for (const a of accounts) {
    const [recent, baseline] = await Promise.all([
      prisma.usageEvent.aggregate({
        where: {
          orgId: a.orgId,
          source: 'omnidimension',
          metric: BILLABLE_METRIC,
          occurredAt: { gte: recentFrom },
        },
        _sum: { quantity: true },
      }),
      prisma.usageEvent.aggregate({
        where: {
          orgId: a.orgId,
          source: 'omnidimension',
          metric: BILLABLE_METRIC,
          occurredAt: { gte: baselineFrom, lt: recentFrom },
        },
        _sum: { quantity: true },
      }),
    ]);

    const recentMinutes = Math.round((recent._sum.quantity ?? 0) / 60);
    // The baseline covers three weeks; normalise it to one so the two windows
    // are comparable.
    const baselineMinutesPerWeek = Math.round(
      (baseline._sum.quantity ?? 0) / 60 / ((BASELINE_DAYS - RECENT_DAYS) / RECENT_DAYS),
    );

    const pollAgeHours = hoursSince(a.lastPolledAt);
    out.push({
      accountId: a.id,
      label: a.label,
      org: a.org.name,
      lastPolledAt: a.lastPolledAt?.toISOString() ?? null,
      pollAgeHours,
      // Never polled counts as stale: an account that has never been read is
      // not a healthy one, it is one nobody finished setting up.
      stale: pollAgeHours === null || pollAgeHours > STALE_POLL_HOURS,
      consecutiveFailures: a.consecutiveFailures,
      lastError: a.lastError,
      balanceMinutes: a.balanceMinutes,
      recentMinutes,
      baselineMinutesPerWeek,
      // A new account has no baseline, so it can never "collapse" — otherwise
      // every account would alarm on its first week.
      volumeCollapse:
        baselineMinutesPerWeek >= MIN_BASELINE_MINUTES &&
        recentMinutes < baselineMinutesPerWeek * COLLAPSE_RATIO,
    });
  }

  const ages = out.map((a) => a.pollAgeHours).filter((v): v is number => v !== null);
  return { accounts: out, oldestPollAgeHours: ages.length ? Math.max(...ages) : null };
}
