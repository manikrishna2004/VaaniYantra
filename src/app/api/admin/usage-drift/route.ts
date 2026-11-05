import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { isSuperAdmin } from '@/lib/platform';
import { bearerFrom, secretMatches } from '@/lib/cron-auth';
import { usageDrift } from '@/lib/usage/minutes';
import { monthKey } from '@/lib/usage/period';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The gate on moving an org onto the usage ledger.
//
// While the ledger runs in shadow, every billable minute is written twice: once
// as Call.durationSec (which billing still reads) and once as a UsageEvent
// (which nothing reads). The only evidence that the second write is COMPLETE is
// that both produce the same number, for every org, over a whole closed month.
//
// Two callers, same shape as /api/admin/overage: the founder from the admin
// dashboard, or the VM cron with `Authorization: Bearer $OPS_CRON_SECRET`.
// Read-only — it computes nothing and writes nothing.
//
//   GET /api/admin/usage-drift             → the last closed month
//   GET /api/admin/usage-drift?month=2026-08

function lastClosedMonth(): string {
  const now = new Date();
  return monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

export async function GET(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  // The ops cron secret rather than a new one: this is the same class of
  // read-only health check as /api/admin/ops-health, run by the same script on
  // the same box, and a secret per endpoint is a secret nobody rotates.
  if (!secretMatches(bearerFrom(req), process.env.OPS_CRON_SECRET)) {
    const { ctx, error } = await apiContext();
    if (error) return error;
    if (!isSuperAdmin(ctx.user.email)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const month = new URL(req.url).searchParams.get('month') ?? lastClosedMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
  }

  const rows = await usageDrift(month);
  const drifting = rows.filter((r) => r.deltaMinutes !== 0);

  return NextResponse.json({
    month,
    activeOrgs: rows.length,
    driftingOrgs: drifting.length,
    // The number check-ops-health.sh alarms on. Zero is the only value that
    // clears an org to be flipped.
    ok: drifting.length === 0,
    drift: drifting,
  });
}
