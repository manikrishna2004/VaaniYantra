import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { checkRateLimit } from '@/lib/rate-limit';
import { quoteTopUp } from '@/lib/billing/prepaid';
import { getTaxConfig, computeTax, stateCodeFromGstin } from '@/lib/billing/tax';
import {
  normalizePhone,
  isValidPhone,
  validateBillingAddress,
  DEFAULT_COUNTRY,
} from '@/lib/billing-address';
import { isIndia } from '@/lib/countries';
import { getCashfreeConfig, isCashfreeConfigured, createOrder } from '@/lib/cashfree';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Same reasoning as plan checkout: every call mints a real order at Cashfree. */
const TOPUP_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 };

// Buy prepaid call minutes.
//
// Always a one-time order, even on a platform configured for subscriptions: a
// mandate is for something that recurs, and a top-up is a single purchase of a
// quantity the clinic chose. Nothing is credited here — the minutes land only
// when Cashfree confirms the payment (webhook, or the return handler), the same
// rule plan checkout follows. OWNER only.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'billing:manage');
  if (denied) return denied;

  const rl = checkRateLimit(`topup:${ctx.org.id}`, TOPUP_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a minute and try again.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { minutes?: number; phone?: string };

  const cfg = await getCashfreeConfig();
  if (!isCashfreeConfigured(cfg)) {
    return NextResponse.json({ error: 'Payments are not configured yet.' }, { status: 400 });
  }

  // The quote is authoritative: it re-reads the org's own rate rather than
  // trusting anything the page sent, so the amount charged is the amount the
  // account is actually priced at.
  const quote = await quoteTopUp(ctx.org.id, Number(body.minutes));
  if ('error' in quote) {
    return NextResponse.json({ error: quote.error }, { status: 400 });
  }

  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  if (!base) {
    return NextResponse.json({ error: 'Server base URL is not configured.' }, { status: 500 });
  }

  // A tax invoice is issued the moment this settles, and it needs a real
  // billed-to address. Last check before money moves.
  const org = await prisma.organization.findUnique({
    where: { id: ctx.org.id },
    select: {
      name: true,
      plan: true,
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
      billingPhone: true,
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
  // customer to Cashfree just buys them a decline.
  if (!isIndia(country) && !cfg.internationalEnabled) {
    return NextResponse.json(
      {
        error:
          'We can’t take card payments outside India just yet. Email info@vaaniyantra.com and we’ll add your minutes directly.',
        code: 'international_unavailable',
      },
      { status: 409 },
    );
  }

  // Cashfree needs a customer phone. The billing page has usually saved one
  // already, so a top-up doesn't have to ask for it a second time.
  const phone = normalizePhone(body.phone || org?.billingPhone || '', country);
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

  // GST on top. `amountInr` stays the taxable value the invoice records — and
  // it is what the settle path divides by the minutes to recover the rate, so
  // it must be the pre-tax figure.
  const taxCfg = await getTaxConfig();
  const buyerState = stateCodeFromGstin(org?.gstin) ?? org?.gstStateCode ?? null;
  const tax = computeTax(taxCfg, quote.amountInr, buyerState, country);

  try {
    const { paymentSessionId } = await createOrder({
      cfg,
      orgId: ctx.org.id,
      kind: 'topup',
      minutes: quote.minutes,
      // The plan the minutes were sold under. Not changed by this purchase —
      // carried so the invoice names the right product line.
      plan: org?.plan ?? 'standard',
      amountInr: tax.totalInr,
      taxableInr: quote.amountInr,
      customerName:
        (org?.billingName || ctx.user.name || org?.name || 'Customer')
          .replace(/[^\p{L}\p{N} ]/gu, '')
          .trim() || 'Customer',
      customerEmail: ctx.user.email,
      customerPhone: phone,
      returnUrl: `${base}/api/billing/cashfree/return?order_id={order_id}`,
      notifyUrl: `${base}/api/billing/cashfree/webhook`,
    });

    // Deliberately no write to the org here. cashfreeOrderId and
    // subscriptionStatus describe the plan, and stamping a top-up over them
    // would make an unfinished minutes purchase look like an unfinished plan
    // payment on the billing page.
    if (body.phone && body.phone !== org?.billingPhone) {
      await prisma.organization.update({ where: { id: ctx.org.id }, data: { billingPhone: phone } });
    }

    return NextResponse.json({
      sessionId: paymentSessionId,
      environment: cfg.environment,
      minutes: quote.minutes,
      ratePerMinute: quote.ratePerMinute,
      amountInr: quote.amountInr,
      chargeInr: tax.totalInr,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not start checkout' }, { status: 502 });
  }
}
