import { NextResponse } from 'next/server';
import { getCashfreeConfig, verifyWebhook } from '@/lib/cashfree';
import { isKitOrderId, markFailed, markPaid, downloadUrl } from '@/lib/kit/purchase';
import { sendKitDownloadEmail } from '@/lib/kit/email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Cashfree webhook for Starter Kit orders.
 *
 * Separate from the billing webhook on purpose. That one decides what an
 * organization is entitled to; this one unlocks a file. Kit orders reach here
 * because their `notify_url` is set per order, and this handler refuses
 * anything without a `vkt_` id so a stray plan payment can never be processed
 * as a kit sale.
 *
 * Public, as every webhook must be. Authenticity is the HMAC over the RAW
 * body, which is why this reads req.text() and never req.json().
 */
export async function POST(req: Request) {
  const cfg = await getCashfreeConfig();
  if (!cfg.secretKey) return NextResponse.json({ error: 'not configured' }, { status: 400 });

  const payload = await req.text();
  const event = verifyWebhook(
    payload,
    req.headers.get('x-webhook-signature'),
    req.headers.get('x-webhook-timestamp'),
    cfg.secretKey,
  );
  if (!event) {
    console.error('[kit] webhook failed signature verification');
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  const type: string = event.type ?? '';
  const orderId: string | undefined = event.data?.order?.order_id;

  // Not ours. Answer 200 so Cashfree stops retrying — the billing webhook owns
  // these, and it has its own delivery.
  if (!orderId || !isKitOrderId(orderId)) {
    return NextResponse.json({ ignored: true });
  }

  try {
    if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
      const paymentId = event.data?.payment?.cf_payment_id ?? null;
      const order = await markPaid(orderId, paymentId ? String(paymentId) : null);

      if (!order) {
        // Money has been taken for an order we have no record of. Never answer
        // 200 to that: a non-2xx makes Cashfree retry, which is the only way
        // this recovers if the row was written late or the database blipped.
        console.error('[kit] PAID but no matching order row —', orderId);
        return NextResponse.json({ error: 'unknown order' }, { status: 500 });
      }

      // The email is a convenience, not the delivery mechanism: the buyer is
      // already being redirected to the download page. A mail failure must not
      // make Cashfree retry a payment we have fully processed.
      if (order.downloadToken) {
        const site = (process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
        if (site) {
          sendKitDownloadEmail({
            to: order.email,
            name: order.name,
            link: downloadUrl(site, order.downloadToken),
            orderId: order.orderId,
            amountInr: order.amountInr,
          }).catch((err) => console.error('[kit] download email failed', err));
        }
      }

      return NextResponse.json({ received: true });
    }

    if (type === 'PAYMENT_FAILED_WEBHOOK' || type === 'PAYMENT_USER_DROPPED_WEBHOOK') {
      await markFailed(orderId);
      return NextResponse.json({ received: true });
    }

    return NextResponse.json({ ignored: true });
  } catch (err) {
    console.error('[kit] webhook handler failed', err);
    return NextResponse.json({ error: 'handler failed' }, { status: 500 });
  }
}
