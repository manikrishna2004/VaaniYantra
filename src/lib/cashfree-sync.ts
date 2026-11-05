import { prisma } from '@/lib/db';
import { recordPlanChange } from '@/lib/plan-history';
import { isPlanKey } from '@/lib/billing/catalogue';
import { redeemPromo } from '@/lib/billing/promo';
import { creditMinutes } from '@/lib/billing/prepaid';
import { issueInvoice } from '@/lib/billing/invoice';
import { addMonths } from '@/lib/dates';

// Re-exported so existing callers (and tests) keep importing it from here.
export { addMonths };

/**
 * A Prisma unique-constraint failure (P2002), matched on the error code rather
 * than the class so a mocked or wrapped client is recognised too.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

// Applying a Cashfree payment to an org. Shared by the webhook and the
// return-URL handler because either can arrive first: Cashfree's webhook often
// beats the browser redirect, but not always, and neither is guaranteed. Both
// paths are idempotent, so whichever lands second is a no-op.

/**
 * A one-time order settled (Payment Gateway mode): the org has bought exactly
 * one month. `PAID` rather than `ACTIVE` — there is no mandate behind it, so
 * there is nothing to cancel and the billing page shows a renew prompt as
 * paidUntil approaches.
 *
 * Extends from the existing paidUntil when it's still in the future, so paying
 * early stacks the month instead of throwing away the remainder.
 */
export async function applyPaidOrder(args: {
  orgId: string;
  orderId: string;
  plan?: string | null;
  amountInr?: number | null;
  promoCode?: string | null;
  /** Pre-tax value quoted at checkout; falls back to the charged amount. */
  taxableInr?: number | null;
  paymentMethod?: string | null;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  const org = await prisma.organization.findUnique({
    where: { id: args.orgId },
    select: { id: true },
  });
  if (!org) return;

  // Already applied this exact order — nothing to do. This is only the fast
  // path; the unique constraint claimed below is what actually guarantees it.
  const seen = await prisma.paymentApplication.findUnique({
    where: { orderId: args.orderId },
    select: { id: true },
  });
  if (seen) return;

  // Claim the order and extend the period together.
  //
  // The webhook and the return handler both call this for the same order and
  // can interleave; the return handler can also be replayed by hand, because it
  // is unauthenticated and the customer knows their own order_id. Inserting a
  // PaymentApplication row makes both cases the same problem: the first caller
  // to insert wins, everyone else loses to the unique constraint on orderId.
  //
  // paidUntil is re-read inside the transaction rather than reused from above,
  // so a concurrent apply of a *different* order cannot be computed from a
  // stale base and silently swallow a month the customer paid for.
  let applied = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.paymentApplication.create({
        data: {
          orgId: args.orgId,
          orderId: args.orderId,
          plan: isPlanKey(args.plan) ? args.plan : null,
          amountInr: args.amountInr ?? null,
        },
      });

      const fresh = await tx.organization.findUnique({
        where: { id: args.orgId },
        select: { paidUntil: true },
      });
      const from = fresh?.paidUntil && fresh.paidUntil > now ? fresh.paidUntil : now;

      await tx.organization.update({
        where: { id: args.orgId },
        data: {
          cashfreeOrderId: args.orderId,
          subscriptionStatus: 'PAID',
          paidUntil: addMonths(from, 1),
          ...(isPlanKey(args.plan) ? { plan: args.plan } : {}),
          ...(args.amountInr && args.amountInr > 0 ? { subscriptionAmountInr: args.amountInr } : {}),
        },
      });
    });
    applied = true;
  } catch (err) {
    // Losing the claim means a concurrent call applied this same order, which
    // is the outcome we wanted. Anything else is a real failure and must
    // surface: the transaction rolled the claim back, so a retry can still
    // apply the payment rather than being locked out by its own dead claim.
    if (!isUniqueViolation(err)) throw err;
  }

  // Only count the promo redemption if this call is the one that applied the
  // payment — otherwise the webhook and the return handler would each burn one.
  if (applied) await redeemPromo(args.promoCode);

  // Same reasoning for the plan history: record it once, and only if this call
  // is the one that actually moved the plan. The sweep prices a month off this,
  // so a duplicate row would be harmless but a missing one is not.
  if (applied && isPlanKey(args.plan)) await recordPlanChange(args.orgId, args.plan, 'checkout');

  // The invoice is issued regardless of who won the race above: it is keyed on
  // the gateway order, so the loser is a no-op rather than a duplicate. Never
  // let an invoicing failure bubble up — the customer has paid and their plan
  // is already applied; a missing invoice is a back-office problem.
  try {
    const taxable = args.taxableInr ?? args.amountInr ?? null;
    if (taxable && taxable > 0) {
      // Fall back to whatever the org is actually on rather than a hardcoded
      // plan name: a literal would stamp every invoice for a new plan with the
      // wrong product, and an invoice is a statutory record we never rewrite.
      const fallbackPlan =
        (await prisma.organization
          .findUnique({ where: { id: args.orgId }, select: { plan: true } })
          .then((o) => o?.plan)
          .catch(() => null)) ?? 'free';

      await issueInvoice({
        orgId: args.orgId,
        plan: isPlanKey(args.plan) ? args.plan : fallbackPlan,
        subtotalInr: taxable,
        taxableInr: taxable,
        promoCode: args.promoCode,
        gatewayOrderId: args.orderId,
        paymentMethod: args.paymentMethod,
        at: now,
      });
    }
  } catch (err) {
    console.error('[invoice] failed to issue for order', args.orderId, err);
  }
}

/**
 * A prepaid-minutes top-up settled.
 *
 * Pointedly NOT applyPaidOrder with a different tag on it. Buying minutes must
 * not move `plan`, must not extend `paidUntil`, and must not touch
 * subscriptionStatus: there is no month being bought here, and granting one
 * would hand out a plan period nobody paid for.
 *
 * Idempotent through creditMinutes, which claims MinuteTopUp.gatewayOrderId in
 * the same transaction that moves the balance — so the webhook and the return
 * handler racing over one payment credit it exactly once between them.
 */
export async function applyPaidTopUp(args: {
  orgId: string;
  orderId: string;
  minutes: number;
  /** Pre-tax value quoted at checkout; falls back to the amount charged. */
  taxableInr?: number | null;
  amountInr?: number | null;
  paymentMethod?: string | null;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  const minutes = Math.floor(Number(args.minutes) || 0);
  if (!(minutes > 0)) {
    // Someone has paid and we cannot tell what for. Throwing makes the webhook
    // answer 500, so Cashfree retries and the failure is loud; crediting a
    // guess, or returning quietly, would swallow a purchase.
    throw new Error(`top-up ${args.orderId} settled with no minutes on it`);
  }

  const org = await prisma.organization.findUnique({
    where: { id: args.orgId },
    select: { plan: true },
  });
  if (!org) return;

  const taxable = args.taxableInr ?? args.amountInr ?? null;
  // The rate is derived rather than carried in its own tag: the pre-tax value
  // IS minutes x rate, so this reproduces the quoted rate exactly, and it
  // cannot disagree with the amount the customer actually paid.
  const ratePerMinute = taxable && taxable > 0 ? Math.round((taxable / minutes) * 100) / 100 : 0;

  await creditMinutes({
    orgId: args.orgId,
    minutes,
    ratePerMinute,
    amountInr: taxable ?? 0,
    gatewayOrderId: args.orderId,
  });

  // Keyed on the gateway order, so whichever of the two callers arrives second
  // is a no-op rather than a duplicate. Never let an invoicing failure bubble
  // up: the minutes are already credited, and a missing invoice is a
  // back-office problem rather than a customer-facing one.
  try {
    if (taxable && taxable > 0) {
      await issueInvoice({
        orgId: args.orgId,
        plan: org.plan,
        subtotalInr: taxable,
        taxableInr: taxable,
        gatewayOrderId: args.orderId,
        paymentMethod: args.paymentMethod,
        at: now,
        description: `VaaniYantra — ${minutes.toLocaleString('en-IN')} prepaid call minutes at ₹${ratePerMinute}/min`,
        // Minutes do not expire, so there is no period to bill for. An invoice
        // claiming a month would be a false statutory record.
        periodEnd: now,
      });
    }
  } catch (err) {
    console.error('[invoice] failed to issue for top-up', args.orderId, err);
  }
}

/**
 * A mandate went live (Subscriptions mode). Cashfree debits it from here on, so
 * there is no schedule for us to keep — paidUntil is cleared to mark that this
 * org no longer renews by hand.
 */
export async function applyActiveSubscription(args: {
  orgId: string;
  subscriptionId: string;
  plan?: string | null;
}): Promise<void> {
  await prisma.organization.update({
    where: { id: args.orgId },
    data: {
      cashfreeSubscriptionId: args.subscriptionId,
      subscriptionStatus: 'ACTIVE',
      paidUntil: null,
      ...(isPlanKey(args.plan) ? { plan: args.plan } : {}),
    },
  });
}

/**
 * A mandate ended (cancelled by the customer in their UPI app, completed, or
 * dropped by the bank). The org falls back to Free — it has no way to pay.
 */
export async function endSubscription(orgId: string, status: string): Promise<void> {
  await prisma.organization.update({
    where: { id: orgId },
    data: { subscriptionStatus: status, plan: 'free', paidUntil: null },
  });
  await recordPlanChange(orgId, 'free', 'subscription');
}
