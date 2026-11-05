import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { resolveSweepMonth, cronSecretMatches, runOverageSweep } from '@/lib/billing/overage-sweep';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Monthly overage sweep. Two callers:
//  - the founder, from the admin dashboard (super-admin session), or
//  - the VM cron (scripts/overage-sweep.sh) with
//    `Authorization: Bearer $OVERAGE_CRON_SECRET`.
// Idempotent either way — one OverageCharge per org per month.
//
// Body (optional): { month: "YYYY-MM" } — defaults to the previous UTC month.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const viaCron = cronSecretMatches(bearer);

  let ctx = null;
  if (!viaCron) {
    const { ctx: sessionCtx, error } = await apiContext();
    if (error) return error;
    if (!isSuperAdmin(sessionCtx.user.email)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    ctx = sessionCtx;
  }

  const body = (await req.json().catch(() => ({}))) as { month?: string };
  const resolved = resolveSweepMonth(body.month);
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const results = await runOverageSweep(resolved.month, resolved.from, resolved.to);

  if (ctx) {
    await audit(ctx, 'platform.overage_sweep', {
      targetType: 'Platform',
      metadata: { month: resolved.month, charges: results.length },
      req,
    });
  } else {
    console.log(`[overage-sweep] cron run for ${resolved.month}: ${results.length} charge(s)`, results);
  }
  return NextResponse.json({ month: resolved.month, results });
}
