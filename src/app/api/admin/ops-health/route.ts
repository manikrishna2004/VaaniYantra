import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { isSuperAdmin } from '@/lib/platform';
import { bearerFrom, secretMatches } from '@/lib/cron-auth';
import { lastReminderTickAt } from '@/lib/reminder-dispatcher';
import { lastStaleSweepAt } from '@/lib/calls/stale';
import { usageDrift } from '@/lib/usage/minutes';
import { voicePlatformHealth } from '@/lib/usage/reseller-health';
import { monthKey } from '@/lib/usage/period';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Outcome-based operational health, for scripts/check-ops-health.sh.
//
// Why this exists: on 2026-08-27 the Gemini credits ran out and every call
// failed for hours. The system recorded it perfectly — each call landed as
// `FAILED / endedReason: 'no_conversation'` — and told nobody. That column was
// written by five call sites and read by zero. A customer reported the outage.
//
// So this reports the things that are *true when the product is broken*, rather
// than whether some process is running:
//
//   - the share of recent calls that failed before anyone spoke (a dead model
//     provider, a revoked key, a depleted quota — all look like this),
//   - whether the two in-process background jobs have actually completed a pass
//     recently, since both survive their own errors and keep ticking uselessly,
//   - webhook endpoints that have been failing long enough to be abandoned.
//
// Read-only and cheap: three counts and two config reads.

const WINDOW_MS = 60 * 60 * 1000; // 1h
// Below this, one bad call is a large percentage and the rate is noise.
const MIN_CALLS_FOR_RATE = 5;
const WEBHOOK_FAILURE_LIMIT = 10;

/** The month the drift check looks at: the current one, still accumulating. */
function currentMonth(): string {
  return monthKey(new Date());
}

function opsCronSecretMatches(provided: string | null): boolean {
  return secretMatches(provided, process.env.OPS_CRON_SECRET);
}

async function authorize(req: Request) {
  if (opsCronSecretMatches(bearerFrom(req))) return { ok: true } as const;

  const { ctx, error } = await apiContext();
  if (error) return { ok: false, error } as const;
  if (!isSuperAdmin(ctx.user.email)) {
    return { ok: false, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) } as const;
  }
  return { ok: true } as const;
}

const ageHours = (iso: string | null) =>
  iso === null ? null : Math.round(((Date.now() - new Date(iso).getTime()) / 3_600_000) * 10) / 10;

export async function GET(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await authorize(req);
  if (!auth.ok) return auth.error;

  const since = new Date(Date.now() - WINDOW_MS);

  const [totalCalls, noConversation, reminderTick, staleSweep, failingWebhooks, drift, resell] =
    await Promise.all([
    prisma.call.count({ where: { createdAt: { gte: since } } }),
    prisma.call.count({ where: { createdAt: { gte: since }, endedReason: 'no_conversation' } }),
    lastReminderTickAt(),
    lastStaleSweepAt(),
    prisma.webhook.count({ where: { enabled: true, failureCount: { gt: WEBHOOK_FAILURE_LIMIT } } }),
    // While the usage ledger runs in shadow it is written on every call and
    // read by nothing, which is exactly the shape of the bug this endpoint was
    // built after: a column five call sites wrote and zero read, silently wrong
    // for hours. Checking it here means a dual write that stops working shows
    // up in the 15-minute cron instead of at the moment an org is flipped onto
    // it and starts being billed from a table that is missing calls.
    usageDrift(currentMonth()).catch((err) => {
      console.error('[ops-health] usage drift check failed', err);
      return null;
    }),
    // The reseller pull is the billing source of truth for any org served by
    // OmniDimension. A poller that quietly stops does not look like anything
    // until a month cannot be closed — which is the same shape as the incident
    // this endpoint was built after.
    voicePlatformHealth().catch((err) => {
      console.error('[ops-health] voice platform health check failed', err);
      return null;
    }),
  ]);

  // Null rather than 0 on a quiet hour: "no calls" and "no failures" are very
  // different, and an alert that cannot tell them apart cries wolf every night.
  const noConversationPct =
    totalCalls >= MIN_CALLS_FOR_RATE ? Math.round((noConversation / totalCalls) * 1000) / 10 : null;

  return NextResponse.json({
    windowMinutes: WINDOW_MS / 60000,
    calls: {
      total: totalCalls,
      noConversation,
      noConversationPct,
      rated: totalCalls >= MIN_CALLS_FOR_RATE,
    },
    reminders: { lastTickAt: reminderTick, ageHours: ageHours(reminderTick) },
    staleCalls: { lastSweepAt: staleSweep, ageHours: ageHours(staleSweep) },
    webhooks: { failing: failingWebhooks, failureLimit: WEBHOOK_FAILURE_LIMIT },
    // `null` when the check itself failed — distinct from "checked, all agree",
    // for the same reason noConversationPct is null on a quiet hour.
    usageLedger:
      drift === null
        ? { checked: false, month: currentMonth(), activeOrgs: null, driftingOrgs: null, worstDeltaMinutes: null }
        : {
            checked: true,
            month: currentMonth(),
            activeOrgs: drift.length,
            driftingOrgs: drift.filter((d) => d.deltaMinutes !== 0).length,
            worstDeltaMinutes: drift.reduce(
              (worst, d) => (Math.abs(d.deltaMinutes) > Math.abs(worst) ? d.deltaMinutes : worst),
              0,
            ),
            // The signed value above is for a human reading the JSON. The cron
            // script scrapes numbers with a [0-9]+ regex and would silently miss
            // a negative one, so give it a field it can actually read.
            worstDeltaAbsMinutes: drift.reduce((worst, d) => Math.max(worst, Math.abs(d.deltaMinutes)), 0),
          },
    voicePlatform:
      resell === null
        ? { checked: false, accounts: null, stalePolls: null, failingAccounts: null, volumeCollapseAccounts: null }
        : {
            checked: true,
            accounts: resell.accounts.length,
            // Polls older than the threshold: the pull has effectively stopped.
            stalePolls: resell.accounts.filter((a) => a.stale).length,
            failingAccounts: resell.accounts.filter((a) => a.consecutiveFailures > 0).length,
            // The revenue-leakage signal: an ACTIVE account whose recent volume
            // has collapsed against its own trailing median is the signature of
            // a client repointing agents at their OWN reseller account.
            volumeCollapseAccounts: resell.accounts.filter((a) => a.volumeCollapse).length,
            oldestPollAgeHours: resell.oldestPollAgeHours,
            detail: resell.accounts.filter((a) => a.stale || a.consecutiveFailures > 0 || a.volumeCollapse),
          },
  });
}
