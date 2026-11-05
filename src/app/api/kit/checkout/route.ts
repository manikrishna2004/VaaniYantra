import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { getCashfreeConfig, isCashfreeConfigured, isLiveMode, baseUrl, money } from '@/lib/cashfree';
import {
  KIT_PRICE_INR,
  KIT_PRODUCT_NAME,
  kitPriceFor,
  createPendingOrder,
  isValidEmail,
  makeKitOrderId,
  normalizeEmail,
} from '@/lib/kit/purchase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Start a Starter Kit purchase.
 *
 * Public — there is no sign-in. The buyer gives an email, we record a pending
 * order and mint one at Cashfree, and the browser is handed the session id to
 * open hosted checkout with.
 *
 * This does NOT go through src/app/api/billing/checkout, which is org-scoped
 * and sells plans. The two must stay apart: that route decides what a paying
 * tenant is entitled to, and this one sells a file to a stranger.
 */

// Every call mints a real order at the gateway, so an impatient buyer clicking
// twice is fine and a script hammering it is not.
const LIMIT = { limit: 8, windowMs: 10 * 60 * 1000 };

/** Where Cashfree sends the browser back, and where it posts the webhook. */
function siteUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  // Fall back to the request's own origin so a preview deployment works
  // without extra configuration.
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  return host ? `${proto}://${host}` : '';
}

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const gate = checkRateLimit(`kit-checkout:${ip}`, LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  let body: { email?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const email = normalizeEmail(body.email ?? '');
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  const name = (body.name ?? '').trim().slice(0, 100);
  if (!name) {
    return NextResponse.json({ error: 'Enter your name.' }, { status: 400 });
  }

  const cfg = await getCashfreeConfig();
  // isCashfreeConfigured proves both credentials are present; the local
  // constants below carry that through to the fetch, which wants strings.
  if (!isCashfreeConfigured(cfg) || !cfg.appId || !cfg.secretKey) {
    console.error('[kit] checkout attempted while Cashfree is not configured');
    return NextResponse.json(
      { error: 'Payments are not available right now. Please try again later.' },
      { status: 503 },
    );
  }

  const site = siteUrl(req);
  if (!site) {
    console.error('[kit] cannot determine the site URL for the Cashfree return address');
    return NextResponse.json({ error: 'Checkout is misconfigured.' }, { status: 500 });
  }

  const orderId = makeKitOrderId();
  const amountInr = kitPriceFor(email);

  try {
    await createPendingOrder({ email, name, orderId, amountInr });

    // Posted directly rather than through createOrder() in src/lib/cashfree.ts:
    // that function takes an orgId, stamps a `van_`/`vtm_` prefix and tags the
    // order with a plan. None of those exist here, and borrowing it would put
    // kit sales inside the code path that grants platform access.
    const res = await fetch(`${baseUrl(cfg)}/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': cfg.appId,
        'x-client-secret': cfg.secretKey,
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: money(amountInr),
        order_currency: 'INR',
        customer_details: {
          // The gateway wants a stable customer id; the order id serves, since
          // a kit buyer has no account with us.
          customer_id: orderId,
          customer_name: name,
          customer_email: email,
          // Cashfree requires a phone. We do not collect one — asking for a
          // phone number to buy a file costs conversions — so a documented
          // placeholder goes in. It is never used to contact anyone.
          customer_phone: '9999999999',
        },
        order_meta: {
          return_url: `${site}/kit/thanks?order_id={order_id}`,
          // Per-order webhook, so kit payments never land on the billing
          // webhook even if the dashboard has a global one configured.
          notify_url: `${site}/api/kit/webhook`,
        },
        order_note: `${KIT_PRODUCT_NAME} — one-off download${amountInr === KIT_PRICE_INR ? '' : ' (test price)'}`,
        order_tags: { product: 'starter_kit' },
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.payment_session_id) {
      console.error('[kit] Cashfree rejected the order', res.status, JSON.stringify(data).slice(0, 300));
      return NextResponse.json(
        { error: 'Could not start the payment. Please try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      orderId,
      paymentSessionId: data.payment_session_id,
      environment: isLiveMode(cfg) ? 'production' : 'sandbox',
    });
  } catch (err) {
    console.error('[kit] checkout failed', err);
    return NextResponse.json({ error: 'Could not start the payment. Please try again.' }, { status: 500 });
  }
}
