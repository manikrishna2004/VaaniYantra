import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCashfreeConfig, verifyWebhook, orgIdFromReference, isTopUpReference } from '@/lib/cashfree';
import { applyPaidOrder, applyPaidTopUp, applyActiveSubscription, endSubscription } from '@/lib/cashfree-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cashfree webhook — the authoritative source for what an org has actually
// paid. Public (no session); authenticity is the HMAC signature over the RAW
// body, which is why this reads req.text() and never req.json().
//
// Handles both products:
//   * PAYMENT_SUCCESS_WEBHOOK          — a one-time order settled (PG mode)
//   * SUBSCRIPTION_STATUS_CHANGED      — a mandate went live / ended
//   * SUBSCRIPTION_PAYMENT_SUCCESS|FAILED — a cycle or overage charge settled
//
// Configure it at Cashfree → Developers → Webhooks, pointing at
// {PUBLIC_BASE_URL}/api/billing/cashfree/webhook.

/** Resolve the org from a `van_<orgId>_<ts>` reference, falling back to a lookup. */
async function resolveOrg(
  reference: string | null | undefined,
  column: 'cashfreeOrderId' | 'cashfreeSubscriptionId',
): Promise<string | null> {
  const parsed = orgIdFromReference(reference);
  if (parsed) {
    const org = await prisma.organization.findUnique({ where: { id: parsed }, select: { id: true } });
    if (org) return org.id;
  }
  if (reference) {
    const org = await prisma.organization.findFirst({ where: { [column]: reference }, select: { id: true } });
    return org?.id ?? null;
  }
  return null;
}

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
    console.error('[cashfree] webhook failed signature verification');
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  try {
    const type: string = event.type ?? '';

    // Starter Kit sales share this merchant account but nothing else. They
    // carry a `vkt_` order id, have their own handler at /api/kit/webhook, and
    // resolve to no organization — so without this they would fall through to
    // the "unresolved order" branch below and be answered with a 500, making
    // Cashfree retry a payment that was in fact handled correctly elsewhere.
    const incomingOrderId: string | undefined =
      event.data?.order?.order_id ?? event.data?.subscription?.subscription_id;
    if (typeof incomingOrderId === 'string' && incomingOrderId.startsWith('vkt_')) {
      return NextResponse.json({ ignored: 'starter-kit order' });
    }

    if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
      // One-time plan order. order_tags carries the plan we sold.
      const order = event.data?.order ?? {};
      const orderId: string | undefined = order.order_id;
      const orgId = await resolveOrg(orderId, 'cashfreeOrderId');
      if (!orgId || !orderId) {
        // The customer has paid. If we cannot map the order to an org, the plan
        // is never applied — and answering 200 here told Cashfree the money was
        // handled, so it never retried and the payment was lost in silence.
        console.error('[cashfree] PAID but unresolved — order', orderId, 'maps to no org');
        return NextResponse.json({ error: 'unresolved order' }, { status: 500 });
      }
      // Which of the two one-time purchases this was is read off the order id,
      // not off a tag — see makeReference. Minutes bought must never be applied
      // as a month of plan.
      if (isTopUpReference(orderId)) {
        await applyPaidTopUp({
          orgId,
          orderId,
          minutes: Number(order.order_tags?.minutes) || 0,
          amountInr: Number(order.order_amount) || null,
          taxableInr: Number(order.order_tags?.taxable) || null,
          paymentMethod: event.data?.payment?.payment_group ?? null,
        });
      } else {
        await applyPaidOrder({
          orgId,
          orderId,
          plan: order.order_tags?.plan,
          amountInr: Number(order.order_amount) || null,
          promoCode: order.order_tags?.promo,
          taxableInr: Number(order.order_tags?.taxable) || null,
          paymentMethod: event.data?.payment?.payment_group ?? null,
        });
      }
    } else if (type === 'SUBSCRIPTION_STATUS_CHANGED') {
      const details = event.data?.subscription_details ?? event.data ?? {};
      const subscriptionId: string | undefined = details.subscription_id;
      const status: string | undefined = details.subscription_status;
      const orgId = await resolveOrg(subscriptionId, 'cashfreeSubscriptionId');
      if (!orgId || !subscriptionId || !status) {
        console.error(
          '[cashfree] subscription event unresolved — subscription', subscriptionId, 'status', status,
        );
        return NextResponse.json({ error: 'unresolved subscription' }, { status: 500 });
      }
      {
        if (status === 'ACTIVE') {
          await applyActiveSubscription({
            orgId,
            subscriptionId,
            plan: details.subscription_tags?.plan ?? event.data?.subscription_tags?.plan,
          });
        } else if (status === 'CANCELLED' || status === 'COMPLETED') {
          await endSubscription(orgId, status);
        } else {
          // ON_HOLD, BANK_APPROVAL_PENDING, … — record it, keep the plan.
          await prisma.organization.update({ where: { id: orgId }, data: { subscriptionStatus: status } });
        }
      }
    } else if (type === 'SUBSCRIPTION_PAYMENT_SUCCESS' || type === 'SUBSCRIPTION_PAYMENT_FAILED') {
      // Overage charges are raised with payment_id `ovg_<OverageCharge id>`;
      // anything else is a normal monthly cycle and needs no bookkeeping.
      const paymentId: string | undefined =
        event.data?.payment_id ?? event.data?.subscription_payment_details?.payment_id;
      if (paymentId?.startsWith('ovg_')) {
        await prisma.overageCharge.updateMany({
          where: { gatewayPaymentId: paymentId },
          data: { status: type === 'SUBSCRIPTION_PAYMENT_SUCCESS' ? 'paid' : 'failed' },
        });
      }
    }
  } catch (err) {
    // 500, not 200. This used to answer 200 so a transient blip would not make
    // Cashfree hammer retries — but the event carries a payment we have just
    // failed to record, and "do not retry" turns a blip into a permanently
    // lost payment. Retries are what backoff is for. applyPaidOrder is
    // idempotent on the gateway order id, so a repeat is a no-op.
    console.error('[cashfree] webhook handler failed — asking for a retry', err);
    return NextResponse.json({ error: 'handler failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
