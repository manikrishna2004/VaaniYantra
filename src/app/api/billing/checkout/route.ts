import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { checkoutPlanError, getEffectivePlan, isPlanKey } from '@/lib/billing/catalogue';
import { checkRateLimit } from '@/lib/rate-limit';
import { applyPromo } from '@/lib/billing/promo';
import { getTaxConfig, computeTax, stateCodeFromGstin } from '@/lib/billing/tax';
import {
  normalizePhone,
  isValidPhone,
  validateBillingAddress,
  DEFAULT_COUNTRY,
} from '@/lib/billing-address';
import { isIndia } from '@/lib/countries';
import {
  getCashfreeConfig,
  isCashfreeConfigured,
  checkoutMode,
  createOrder,
  createSubscription,
} from '@/lib/cashfree';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Every call here mints a real order/mandate at Cashfree, so a stuck retry loop
 * or an impatient owner clicking repeatedly would litter the merchant account.
 * Generous enough that nobody legitimately hits it — a real checkout is one
 * call, and a retry after a failure is two.
 */
const CHECKOUT_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 };

// Start a paid-plan checkout. Which product runs is a platform-level setting,
// not a per-org one (see src/lib/cashfree.ts):
//
//   * subscription — a UPI Autopay / eNACH / card mandate Cashfree auto-debits
//     every month. Used once Subscriptions is activated on the account.
//   * order — a one-time payment for a single month. All the Payment Gateway
//     can do on its own; the org renews from the billing page each cycle.
//
// Either way the response is a session ID the Cashfree JS SDK opens, and the
// org's plan does NOT change here — only a confirmed payment applies it
// (webhook, or the return handler). OWNER only.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const rl = checkRateLimit(`checkout:${ctx.org.id}`, CHECKOUT_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many checkout attempts. Please wait a minute and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { plan?: string; phone?: string; promoCode?: string };
  const planError = await checkoutPlanError(body.plan);
  if (planError || !isPlanKey(body.plan)) {
    return NextResponse.json({ error: planError ?? 'That plan does not exist.' }, { status: 400 });
  }

  const cfg = await getCashfreeConfig();
  if (!isCashfreeConfigured(cfg)) {
    return NextResponse.json({ error: 'Payments are not configured yet.' }, { status: 400 });
  }

  const plan = await getEffectivePlan(body.plan);
  if (!plan.priceMonthly || plan.priceMonthly <= 0) {
    return NextResponse.json({ error: `The ${body.plan} plan has no price set.` }, { status: 400 });
  }

  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  if (!base) {
    return NextResponse.json({ error: 'Server base URL is not configured.' }, { status: 500 });
  }

  // A tax invoice is issued the moment a payment settles, and it needs a real
  // billed-to address. The checkout page collects it, but check here too — this
  // is the last point before money moves.
  const org = await prisma.organization.findUnique({
    where: { id: ctx.org.id },
    select: {
      gstin: true,
      gstStateCode: true,
      billingName: true,
      billingLine1: true,
      billingLine2: true,
      billingCity: true,
      billingPostalCode: true,
      billingCountry: true,
      billingRegion: true,
      billingAddress: true,
    },
  });
  const country = org?.billingCountry ?? DEFAULT_COUNTRY;
  const addressErrors = validateBillingAddress(
    {
      billingName: org?.billingName ?? null,
      billingLine1: org?.billingLine1 ?? null,
      billingLine2: org?.billingLine2 ?? null,
      billingCity: org?.billingCity ?? null,
      billingPostalCode: org?.billingPostalCode ?? null,
      billingCountry: country,
      billingRegion: org?.billingRegion ?? null,
      gstStateCode: org?.gstStateCode ?? null,
      gstin: org?.gstin ?? null,
      billingAddress: org?.billingAddress ?? null,
    },
    { strict: true },
  );
  if (Object.keys(addressErrors).length > 0) {
    return NextResponse.json(
      { error: 'Add your billing address before paying.', errors: addressErrors },
      { status: 400 },
    );
  }

  // Until the merchant account can charge a foreign card, sending a non-Indian
  // customer to Cashfree just buys them a decline. Fail here with something they
  // can act on instead. Flipped from /admin the day Cashfree approves it.
  if (!isIndia(country) && !cfg.internationalEnabled) {
    return NextResponse.json(
      {
        error:
          'We can’t take card payments outside India just yet. Email info@vaaniyantra.com and we’ll set your plan up directly.',
        code: 'international_unavailable',
      },
      { status: 409 },
    );
  }

  // Cashfree needs a customer phone on both flows, and a mandate is registered
  // against it. India's rail wants exactly the 10-digit mobile; elsewhere the
  // number carries its country code.
  const phone = normalizePhone(body.phone, country);
  if (!isValidPhone(phone, country)) {
    return NextResponse.json(
      {
        error: isIndia(country)
          ? 'Enter a valid 10-digit Indian mobile number for the payment.'
          : 'Enter a valid phone number, including your country code.',
        errors: { phone: 'Enter a valid phone number for the payment.' },
      },
      { status: 400 },
    );
  }

  const customer = {
    // Cashfree rejects names with punctuation on some rails.
    customerName:
      (org?.billingName || ctx.user.name || ctx.org.name || 'Customer')
        .replace(/[^\p{L}\p{N} ]/gu, '')
        .trim() || 'Customer',
    customerEmail: ctx.user.email,
    customerPhone: phone,
  };
  const mode = checkoutMode(cfg);

  // Promo codes discount a single order. A mandate keeps its amount for life,
  // so applying one in subscription mode would discount every future month too
  // — refuse rather than silently do that.
  let amountInr = plan.priceMonthly;
  let promoCode: string | null = null;
  if (body.promoCode?.trim()) {
    if (mode === 'subscription') {
      return NextResponse.json(
        { error: 'Promo codes can’t be used with auto-renewing subscriptions.' },
        { status: 400 },
      );
    }
    const promo = await applyPromo({ code: body.promoCode, plan: body.plan, priceInr: plan.priceMonthly });
    if (!promo.ok) return NextResponse.json({ error: promo.error }, { status: 400 });
    amountInr = promo.amountInr;
    promoCode = promo.code;
  }

  // GST goes on top of the (possibly discounted) price. `amountInr` stays the
  // taxable value for the invoice; `chargeInr` is what Cashfree collects.
  const taxCfg = await getTaxConfig();
  const buyerState = stateCodeFromGstin(org?.gstin) ?? org?.gstStateCode ?? null;
  const tax = computeTax(taxCfg, amountInr, buyerState, country);
  const chargeInr = tax.totalInr;

  try {
    if (mode === 'subscription') {
      const { subscriptionId, sessionId } = await createSubscription({
        cfg,
        orgId: ctx.org.id,
        plan: body.plan,
        amountInr: plan.priceMonthly,
        ...customer,
        returnUrl: `${base}/settings/billing?cashfree=pending`,
      });
      // Remember the pending mandate so the webhook can resolve this org; the
      // plan stays put until the webhook reports ACTIVE.
      await prisma.organization.update({
        where: { id: ctx.org.id },
        data: {
          cashfreeSubscriptionId: subscriptionId,
          subscriptionStatus: 'INITIALIZED',
          subscriptionAmountInr: plan.priceMonthly,
          billingPhone: phone,
          billingEmail: ctx.user.email,
        },
      });
      return NextResponse.json({ mode, sessionId, environment: cfg.environment });
    }

    const { orderId, paymentSessionId } = await createOrder({
      cfg,
      orgId: ctx.org.id,
      plan: body.plan,
      amountInr: chargeInr,
      taxableInr: amountInr,
      promoCode,
      ...customer,
      // The browser lands here after paying; the handler confirms with Cashfree
      // before touching the plan, so it doesn't depend on the webhook winning.
      returnUrl: `${base}/api/billing/cashfree/return?order_id={order_id}`,
      notifyUrl: `${base}/api/billing/cashfree/webhook`,
    });
    await prisma.organization.update({
      where: { id: ctx.org.id },
      data: {
        cashfreeOrderId: orderId,
        subscriptionStatus: 'INITIALIZED',
        subscriptionAmountInr: plan.priceMonthly,
        billingPhone: phone,
        billingEmail: ctx.user.email,
      },
    });
    return NextResponse.json({ mode, sessionId: paymentSessionId, environment: cfg.environment });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not start checkout' }, { status: 502 });
  }
}
