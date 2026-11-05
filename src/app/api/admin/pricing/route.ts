import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin, setPlanOverrides, type PlanOverride } from '@/lib/platform';
import { PLAN_ORDER } from '@/lib/billing/catalogue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PLAN_KEYS: readonly string[] = PLAN_ORDER;
const LIMIT_KEYS = ['agents', 'workspaces', 'callMinutesPerMonth', 'knowledgeDocs', 'chatbots', 'chatConversationsPerMonth'];

// Save founder-set plan price/limit overrides. Super-admin only.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { overrides?: Record<string, any> };
  const input = body.overrides ?? {};
  const clean: Record<string, PlanOverride> = {};

  for (const planKey of PLAN_KEYS) {
    const o = input[planKey];
    if (!o || typeof o !== 'object') continue;
    const entry: PlanOverride = {};
    if (o.priceMonthly !== undefined && o.priceMonthly !== null && Number.isFinite(Number(o.priceMonthly))) {
      entry.priceMonthly = Math.max(0, Math.round(Number(o.priceMonthly)));
    }
    // Per-minute rates keep one decimal (₹6.3/min style).
    if (o.pricePerMinute !== undefined && o.pricePerMinute !== null && Number.isFinite(Number(o.pricePerMinute))) {
      entry.pricePerMinute = Math.max(0, Math.round(Number(o.pricePerMinute) * 10) / 10);
    }
    if (o.overagePerMinute !== undefined && o.overagePerMinute !== null && Number.isFinite(Number(o.overagePerMinute))) {
      entry.overagePerMinute = Math.max(0, Math.round(Number(o.overagePerMinute) * 10) / 10);
    }
    if (o.limits && typeof o.limits === 'object') {
      const limits: Record<string, number> = {};
      for (const lk of LIMIT_KEYS) {
        const v = o.limits[lk];
        if (v !== undefined && v !== null && Number.isFinite(Number(v))) limits[lk] = Math.max(0, Math.round(Number(v)));
      }
      if (Object.keys(limits).length) entry.limits = limits as PlanOverride['limits'];
    }
    if (entry.priceMonthly !== undefined || entry.pricePerMinute !== undefined || entry.overagePerMinute !== undefined || entry.limits)
      clean[planKey] = entry;
  }

  await setPlanOverrides(clean);
  await audit(ctx, 'platform.pricing_updated', { targetType: 'Platform', req });
  return NextResponse.json({ ok: true, overrides: clean });
}
