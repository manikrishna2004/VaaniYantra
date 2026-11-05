import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { bearerFrom, secretMatches } from '@/lib/cron-auth';
import { runVoicePlatformReconcile, refreshSubAccountFacts } from '@/lib/usage/omni-reconcile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Pull billable minutes back from the reseller voice platform into the usage
// ledger. Two callers, the same shape as /api/admin/overage:
//
//   - the VM cron (scripts/omni-reconcile.sh) with
//     `Authorization: Bearer $RECONCILE_CRON_SECRET`, every 15 minutes;
//   - the founder, from the admin dashboard.
//
// Body (all optional): { "accountIds": ["..."], "fullMonth": "YYYY-MM" }
//
// `fullMonth` re-reads the whole listing rather than stopping at the cursor. It
// is the ONLY way a correction to an older call is ever found — their API has
// no updated-at field and no date filter — so the cron runs it on the 1st and
// 2nd of each month, before the overage sweep closes anything.
//
// Idempotent either way: the ledger is keyed on (source, externalId, seq), so a
// replayed run converges on the same rows.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const viaCron = secretMatches(bearerFrom(req), process.env.RECONCILE_CRON_SECRET);

  let ctx = null;
  if (!viaCron) {
    const { ctx: sessionCtx, error } = await apiContext();
    if (error) return error;
    if (!isSuperAdmin(sessionCtx.user.email)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    ctx = sessionCtx;
  }

  const body = (await req.json().catch(() => ({}))) as {
    accountIds?: string[];
    fullMonth?: string;
  };
  const fullMonth = body.fullMonth?.trim() || null;
  if (fullMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(fullMonth)) {
    return NextResponse.json({ error: 'fullMonth must be YYYY-MM' }, { status: 400 });
  }

  // Refreshed first, and on every run: `timezone` is what places an ambiguous
  // call timestamp in a month, so reading it stale would misfile minutes.
  // `org_balance` and `cost_per_min` back the credit ceiling and the margin
  // report. Never fatal — a facts refresh that fails must not stop the pull.
  const facts = await refreshSubAccountFacts().catch((err) => {
    console.error('[omni-reconcile] could not refresh sub-account facts', err);
    return { updated: 0 };
  });

  const results = await runVoicePlatformReconcile({ accountIds: body.accountIds, fullMonth });
  const failed = results.filter((r) => r.error);
  const inexact = results.filter((r) => !r.exact && !r.error);

  if (ctx) {
    await audit(ctx, 'platform.usage_reconciled', {
      targetType: 'Platform',
      metadata: { accounts: results.length, fullMonth, failed: failed.length },
      req,
    });
  } else {
    console.log(
      `[omni-reconcile] cron run${fullMonth ? ` (full ${fullMonth})` : ''}: ` +
        `${results.length} account(s), ${failed.length} failed`,
      results,
    );
  }

  return NextResponse.json({
    fullMonth,
    factsUpdated: facts.updated,
    accounts: results.length,
    failedAccounts: failed.length,
    // Their call timestamps are ambiguous local strings; a run carrying any
    // inexact one must not be trusted to settle a month.
    inexactAccounts: inexact.length,
    ok: failed.length === 0,
    results,
  });
}
