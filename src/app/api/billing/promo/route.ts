import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { checkoutPlanError, getEffectivePlan, isPlanKey } from '@/lib/billing/catalogue';
import { checkRateLimit } from '@/lib/rate-limit';
import { applyPromo } from '@/lib/billing/promo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Codes are short and guessable, so an unthrottled preview endpoint is a free
 * oracle for brute-forcing them. Tight enough to make enumeration pointless,
 * loose enough that a customer mistyping a code a few times is fine.
 */
const PROMO_LIMIT = { limit: 12, windowMs: 10 * 60 * 1000 };

// Check a promo code and return what it would cost, so the billing page can
// show the discount before sending anyone to Cashfree. This is a preview only —
// checkout re-validates and recomputes the amount server-side, so nothing here
// is load-bearing for what actually gets charged. OWNER only.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const rl = checkRateLimit(`promo:${ctx.org.id}`, PROMO_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { plan?: string; code?: string };
  const planError = await checkoutPlanError(body.plan);
  if (planError || !isPlanKey(body.plan)) {
    return NextResponse.json({ error: planError ?? 'That plan does not exist.' }, { status: 400 });
  }

  const plan = await getEffectivePlan(body.plan);
  if (!plan.priceMonthly || plan.priceMonthly <= 0) {
    return NextResponse.json({ error: `The ${body.plan} plan has no price set.` }, { status: 400 });
  }

  const result = await applyPromo({ code: body.code ?? '', plan: body.plan, priceInr: plan.priceMonthly });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({
    ok: true,
    code: result.code,
    label: result.label,
    amountInr: result.amountInr,
    originalInr: result.originalInr,
  });
}
