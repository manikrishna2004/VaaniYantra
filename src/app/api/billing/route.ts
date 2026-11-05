import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { recordPlanChange } from '@/lib/plan-history';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { getEffectivePlans, getUsage, isPlanKey, overageForRate } from '@/lib/billing/catalogue';
import { rateFor } from '@/lib/billing/rate-card';
import { getCashfreeConfig, isCashfreeConfigured, checkoutMode } from '@/lib/cashfree';
import { getWhatsappChatAddonPrice } from '@/lib/platform';
import { getPrepaidState, MIN_TOPUP_MINUTES } from '@/lib/billing/prepaid';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Current plan, the plan catalogue, and metered usage for the org.
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;

  // Plan, usage, GSTIN, billing address and invoices are the practice's
  // finances. The write verbs on these routes always checked; the reads never
  // did, so a VIEWER or a DOCTOR could read all of it.
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const org = await prisma.organization.findUnique({
    where: { id: ctx.org.id },
    select: { plan: true, subscriptionStatus: true, whatsappChatAddon: true, paidUntil: true, billingPhone: true },
  });
  // Priced from the org's rate card when it has one, so the page quotes the
  // number the monthly sweep will actually charge. Reading the plan here while
  // the sweep read a card would be a billing page contradicting an invoice.
  // `rate.plan` is `getEffectivePlan(org.plan)` — the same object as before —
  // and still supplies the limits, the name and the catalogue.
  const rate = await rateFor(ctx.org.id, new Date(), { planKey: org?.plan ?? null });
  const plan = rate.plan;
  const [usage, plans, cashfreeCfg, chatAddonPrice, prepaid] = await Promise.all([
    getUsage(ctx.org.id),
    getEffectivePlans(),
    getCashfreeConfig(),
    getWhatsappChatAddonPrice(),
    getPrepaidState(ctx.org.id),
  ]);

  return NextResponse.json({
    plan: plan.key,
    planName: plan.name,
    limits: plan.limits,
    // Pay-as-you-go rather than an allowance with an overage tail. The billing
    // page needs to know which of the two it is showing: on a usage plan
    // `overage.minutes` is every minute of the month and `amountInr` is the
    // whole bill, not the part past a bundle.
    usageBased: rate.usageBased ?? false,
    ratePerMinute: rate.pricePerMinute ?? null,
    usage,
    overage: { ...overageForRate(rate, usage.callMinutes), ratePerMinute: rate.overagePerMinute ?? null },
    // Prepaid minutes: the balance, what this month has drawn against it, and
    // what is left to invoice. Sent on every plan — an org moved off the
    // per-minute rate can still be holding minutes it paid for, and hiding the
    // balance would look like we had taken them.
    prepaid: { ...prepaid, minTopUpMinutes: MIN_TOPUP_MINUTES },
    canManage: ctx.role === 'OWNER',
    plans,
    paymentsConfigured: isCashfreeConfigured(cashfreeCfg),
    // 'subscription' = a mandate Cashfree auto-debits (cancellable).
    // 'order' = one paid month at a time, so the owner renews from this page.
    checkoutMode: checkoutMode(cashfreeCfg),
    // Whether a card issued outside India can be charged at all. Off = checkout
    // shows a "coming soon" gate rather than a guaranteed decline.
    internationalPayments: cashfreeCfg.internationalEnabled,
    subscribed: org?.subscriptionStatus === 'ACTIVE',
    paidUntil: org?.paidUntil?.toISOString() ?? null,
    billingPhone: org?.billingPhone ?? '',
    addons: {
      whatsappChat: {
        // Feature-flagged off: the add-on is hidden unless the org still has it
        // on (so they can turn it off) — and it's never billed while disabled.
        enabled: Boolean(org?.whatsappChatAddon),
        priceInr: whatsappEnabled() ? chatAddonPrice : 0, // 0 = not available
      },
    },
  });
}

// Change the org's plan without payment — the self-service switch used while
// Cashfree isn't configured yet, and the way anyone drops back to Free.
//
// Once payments ARE configured this can only move an org DOWN to Free: paid
// plans have to go through checkout, or an owner could hand themselves a paid
// plan by calling this endpoint directly. Cancelling a live mandate also has to
// happen through /api/billing/cancel so billing and plan can't diverge.
// OWNER only.
export async function PATCH(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { plan?: string };
  if (!isPlanKey(body.plan)) {
    return NextResponse.json({ error: 'Unknown plan' }, { status: 400 });
  }

  const [org, cfg] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: ctx.org.id },
      select: { subscriptionStatus: true },
    }),
    getCashfreeConfig(),
  ]);
  if (org?.subscriptionStatus === 'ACTIVE') {
    return NextResponse.json(
      { error: 'You have an active subscription. Cancel it first, then switch plans.' },
      { status: 409 },
    );
  }
  // Enterprise used to be exempt here, which made PATCH a second door around
  // checkout: it carries Infinity on every limit and no overagePerMinute, so
  // the sweep skips it too. checkoutPlanError already refuses to sell it
  // self-serve; this is the same rule on the other entry point.
  if (isCashfreeConfigured(cfg) && body.plan !== 'free') {
    return NextResponse.json({ error: 'Paid plans must be started from checkout.' }, { status: 402 });
  }

  await prisma.organization.update({ where: { id: ctx.org.id }, data: { plan: body.plan } });
  await recordPlanChange(ctx.org.id, body.plan, 'self_serve');
  await audit(ctx, 'billing.plan_changed', {
    targetType: 'Organization',
    targetId: ctx.org.id,
    metadata: { plan: body.plan },
    req,
  });

  return NextResponse.json({ ok: true, plan: body.plan });
}
