import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { checkoutPlanError, getEffectivePlan, isPlanKey } from '@/lib/billing/catalogue';
import { checkRateLimit } from '@/lib/rate-limit';
import { applyPromo } from '@/lib/billing/promo';
import { getTaxConfig, computeTax, stateCodeFromGstin, SAC_CODE } from '@/lib/billing/tax';
import { DEFAULT_COUNTRY } from '@/lib/billing-address';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Shares the promo limiter's job: this endpoint also validates codes. */
const QUOTE_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 };

// Price a plan for this org — subtotal, discount, GST split, total — so the
// billing page can show a real order summary before anyone is sent to Cashfree.
//
// Display only. Checkout recomputes all of it server-side from the same
// functions, so a tampered quote changes nothing about what is charged.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const rl = checkRateLimit(`quote:${ctx.org.id}`, QUOTE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { plan?: string; promoCode?: string };
  const planError = await checkoutPlanError(body.plan);
  if (planError || !isPlanKey(body.plan)) {
    return NextResponse.json({ error: planError ?? 'That plan does not exist.' }, { status: 400 });
  }

  const plan = await getEffectivePlan(body.plan);
  if (!plan.priceMonthly || plan.priceMonthly <= 0) {
    return NextResponse.json({ error: `The ${body.plan} plan has no price set.` }, { status: 400 });
  }

  const [taxCfg, org] = await Promise.all([
    getTaxConfig(),
    prisma.organization.findUnique({
      where: { id: ctx.org.id },
      select: { gstin: true, gstStateCode: true, billingCountry: true },
    }),
  ]);

  let taxable = plan.priceMonthly;
  let promo: { code: string; label: string } | null = null;
  let promoError: string | null = null;
  if (body.promoCode?.trim()) {
    const r = await applyPromo({ code: body.promoCode, plan: body.plan, priceInr: plan.priceMonthly });
    if (r.ok) {
      taxable = r.amountInr;
      promo = { code: r.code, label: r.label };
    } else {
      // Surface the reason but still return a valid undiscounted quote, so the
      // summary doesn't blank out while someone is mid-typing a code.
      promoError = r.error;
    }
  }

  const buyerState = stateCodeFromGstin(org?.gstin) ?? org?.gstStateCode ?? null;
  const tax = computeTax(taxCfg, taxable, buyerState, org?.billingCountry ?? DEFAULT_COUNTRY);

  return NextResponse.json({
    plan: plan.key,
    planName: plan.name,
    subtotalInr: plan.priceMonthly,
    discountInr: Math.max(0, Math.round((plan.priceMonthly - taxable) * 100) / 100),
    taxableInr: tax.taxableInr,
    cgstInr: tax.cgstInr,
    sgstInr: tax.sgstInr,
    igstInr: tax.igstInr,
    totalTaxInr: tax.totalTaxInr,
    totalInr: tax.totalInr,
    taxRate: tax.rate,
    taxKind: tax.kind,
    sacCode: SAC_CODE,
    promo,
    promoError,
  });
}
