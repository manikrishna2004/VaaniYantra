import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { recordPlanChange } from '@/lib/plan-history';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { getCashfreeConfig, isCashfreeConfigured, cancelSubscription } from '@/lib/cashfree';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cancel the org's Cashfree mandate and drop to the Free plan. Only meaningful
// in Subscriptions mode — a one-time order (PG mode) has nothing to cancel; it
// simply isn't renewed, so the billing page doesn't offer this. OWNER only.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const org = await prisma.organization.findUnique({
    where: { id: ctx.org.id },
    select: { cashfreeSubscriptionId: true, subscriptionStatus: true },
  });
  if (org?.subscriptionStatus !== 'ACTIVE' || !org.cashfreeSubscriptionId) {
    return NextResponse.json({ error: 'No active subscription to cancel.' }, { status: 409 });
  }

  const cfg = await getCashfreeConfig();
  if (!isCashfreeConfigured(cfg)) {
    return NextResponse.json({ error: 'Payments not configured.' }, { status: 400 });
  }

  try {
    await cancelSubscription(cfg, org.cashfreeSubscriptionId);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not cancel the subscription' }, { status: 502 });
  }

  // Cashfree also sends SUBSCRIPTION_STATUS_CHANGED for this; applying it now
  // means the owner sees the result immediately instead of waiting on a hook.
  await prisma.organization.update({
    where: { id: ctx.org.id },
    data: { subscriptionStatus: 'CANCELLED', plan: 'free', paidUntil: null },
  });
  await recordPlanChange(ctx.org.id, 'free', 'cancel');
  await audit(ctx, 'billing.subscription_cancelled', {
    targetType: 'Organization',
    targetId: ctx.org.id,
    req,
  });

  return NextResponse.json({ ok: true });
}
