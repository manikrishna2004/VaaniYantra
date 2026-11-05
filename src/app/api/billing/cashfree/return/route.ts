import { NextResponse } from 'next/server';
import {
  getCashfreeConfig,
  isCashfreeConfigured,
  getOrder,
  orgIdFromReference,
  isTopUpReference,
} from '@/lib/cashfree';
import { applyPaidOrder, applyPaidTopUp } from '@/lib/cashfree-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Where Cashfree sends the browser back after a one-time order (PG mode).
//
// This exists so a paying customer never sees a stale plan: the webhook is the
// authority, but it can lose the race with the redirect. So rather than trust
// the query string — which the customer controls — this re-reads the order from
// Cashfree's API and applies it only if Cashfree itself says PAID.
//
// Unauthenticated by necessity (cross-site redirect, no guaranteed cookie), but
// it grants nothing that the order status doesn't already prove.
export async function GET(req: Request) {
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  const back = (state: string) => NextResponse.redirect(`${base}/settings/billing?cashfree=${state}`, 303);

  const orderId = new URL(req.url).searchParams.get('order_id');
  if (!orderId) return back('error');

  const cfg = await getCashfreeConfig();
  if (!isCashfreeConfigured(cfg)) return back('error');

  const orgId = orgIdFromReference(orderId);
  if (!orgId) return back('error');

  let order: any;
  try {
    order = await getOrder(cfg, orderId);
  } catch (err) {
    // Can't confirm — say so rather than guess. The webhook will still settle
    // it, and the billing page reflects that on the next load.
    console.error('[cashfree] could not verify returning order', orderId, err);
    return back('pending');
  }

  if (order?.order_status !== 'PAID') {
    return back(order?.order_status === 'ACTIVE' ? 'pending' : 'failed');
  }

  // A minutes purchase is not a month of plan, and the order id says which is
  // which. 'minutes' rather than 'success' so the page can say what arrived.
  if (isTopUpReference(orderId)) {
    await applyPaidTopUp({
      orgId,
      orderId,
      minutes: Number(order?.order_tags?.minutes) || 0,
      amountInr: Number(order?.order_amount) || null,
      taxableInr: Number(order?.order_tags?.taxable) || null,
    });
    return back('minutes');
  }

  await applyPaidOrder({
    orgId,
    orderId,
    plan: order?.order_tags?.plan,
    amountInr: Number(order?.order_amount) || null,
    promoCode: order?.order_tags?.promo,
    taxableInr: Number(order?.order_tags?.taxable) || null,
  });
  return back('success');
}
