import { prisma } from '@/lib/db';

// Promo codes for checkout.
//
// Everything here runs server-side against the plan price from our own
// catalogue. The client sends only a code string — never an amount — so a
// tampered request can't buy a plan for ₹1.

/** Cashfree rejects orders under ₹1, so no discount may take the total below it. */
export const MIN_CHARGE_INR = 1;

export type PromoResult =
  | { ok: true; code: string; amountInr: number; originalInr: number; label: string }
  | { ok: false; error: string };

export const normalizeCode = (raw: string) => raw.trim().toUpperCase();

/** Round to 2dp — the precision Cashfree accepts for an order amount. */
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * Resolve a code against a plan and its price. Returns the amount actually to
 * charge, or a reason the code doesn't apply. Read-only: redemption is only
 * recorded once the payment settles (see redeemPromo).
 */
export async function applyPromo(args: {
  code: string;
  plan: string;
  priceInr: number;
  now?: Date;
}): Promise<PromoResult> {
  const now = args.now ?? new Date();
  const code = normalizeCode(args.code);
  if (!code) return { ok: false, error: 'Enter a promo code.' };

  const promo = await prisma.promoCode.findUnique({ where: { code } });
  // Same message whether the code is unknown or disabled — no probing for
  // which codes exist.
  if (!promo || !promo.active) return { ok: false, error: 'That promo code isn’t valid.' };

  if (promo.expiresAt && promo.expiresAt <= now) {
    return { ok: false, error: 'That promo code has expired.' };
  }
  if (promo.maxRedemptions != null && promo.timesRedeemed >= promo.maxRedemptions) {
    return { ok: false, error: 'That promo code has already been used.' };
  }
  if (promo.plans) {
    const allowed = promo.plans.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(args.plan.toLowerCase())) {
      return { ok: false, error: `That code doesn’t apply to the ${args.plan} plan.` };
    }
  }

  let amount: number;
  let label: string;
  if (promo.fixedPriceInr != null) {
    amount = money(promo.fixedPriceInr);
    label = `${promo.code} — fixed price ₹${amount.toLocaleString('en-IN')}`;
  } else if (promo.percentOff != null) {
    const pct = Math.min(100, Math.max(1, promo.percentOff));
    amount = money(args.priceInr * (1 - pct / 100));
    label = `${promo.code} — ${pct}% off`;
  } else {
    // Neither discount field set: a malformed row, not the customer's problem.
    return { ok: false, error: 'That promo code isn’t valid.' };
  }

  if (!Number.isFinite(amount) || amount < MIN_CHARGE_INR) {
    amount = MIN_CHARGE_INR;
  }
  if (amount >= args.priceInr) {
    return { ok: false, error: 'That code doesn’t reduce this plan’s price.' };
  }

  return { ok: true, code: promo.code, amountInr: amount, originalInr: args.priceInr, label };
}

/**
 * Count a redemption, once the payment has actually settled — an abandoned
 * checkout shouldn't burn a single-use code.
 *
 * Conditional on the redemption count still being under the cap, so concurrent
 * payments can't push a limited code past its limit.
 */
export async function redeemPromo(code: string | null | undefined): Promise<void> {
  if (!code) return;
  const normalized = normalizeCode(code);
  const promo = await prisma.promoCode.findUnique({ where: { code: normalized } });
  if (!promo) return;

  // `increment` is atomic, so the count itself is safe under concurrency; the
  // only thing needing a guard is the cap. Matching on `timesRedeemed < max`
  // means a simultaneous payment can't push a single-use code to 2.
  await prisma.promoCode.updateMany({
    where: {
      code: normalized,
      ...(promo.maxRedemptions != null ? { timesRedeemed: { lt: promo.maxRedemptions } } : {}),
    },
    data: { timesRedeemed: { increment: 1 } },
  });
}
