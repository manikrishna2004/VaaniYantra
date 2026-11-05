import crypto from 'crypto';
import { getPlatformConfig } from '@/lib/platform';
import { fetchWithTimeout } from '@/lib/net/fetch';

// Cashfree — the billing gateway. Replaces PayU, which replaced Razorpay, which
// replaced Cashfree (the first attempt died in merchant KYC). This time the
// merchant account is approved and live, so this is the one that ships.
//
// The account has TWO products with different states, which is why this module
// has two checkout paths behind one interface:
//
//   * Payment Gateway — ACTIVE today. One-time orders only. No mandate, so a
//     "subscription" is really one paid month at a time and the customer comes
//     back to renew. This is what runs until Subscriptions is switched on.
//   * Subscriptions — NOT activated yet (it's a separate request in the
//     Cashfree dashboard). UPI Autopay / eNACH / card mandates that Cashfree
//     auto-debits monthly, handling the RBI pre-debit notice itself. The moment
//     the founder ticks "Subscriptions activated" in /admin, checkout switches
//     to this path with no code change.
//
// Unlike PayU, we do NOT own a recurring cycle: there is no pre-debit notice to
// send and no daily debit cron. Cashfree drives the schedule and tells us what
// happened over the webhook.
//
// Plans are created INLINE on each subscription (plan_details accepts the full
// plan spec, not just a plan_id), so pricing stays in our own catalogue
// (src/lib/billing/catalogue.ts) and there is nothing to keep in sync in the Cashfree
// dashboard.

const API_VERSION = '2025-01-01';

export const CASHFREE_KEYS = {
  appId: 'cashfree_app_id',
  secretKey: 'cashfree_secret_key',
  environment: 'cashfree_environment', // 'sandbox' | 'production'
  subscriptions: 'cashfree_subscriptions', // '1' once the Subscriptions product is live
  international: 'cashfree_international', // '1' once international cards are live
} as const;

export type CashfreeConfig = {
  appId: string | null;
  secretKey: string | null;
  environment: 'sandbox' | 'production';
  subscriptionsEnabled: boolean;
  /**
   * Whether the account can charge a card issued outside India.
   *
   * Off today: the dashboard refuses it with "as per regulations, individual
   * merchants cannot accept payments via international cards", and the API
   * rejects every non-INR currency. A foreign customer would reach Cashfree's
   * page only to be declined, so checkout gates on this instead.
   */
  internationalEnabled: boolean;
};

/** Which checkout the org gets. Driven purely by config, not by the plan. */
export type CheckoutMode = 'subscription' | 'order';

/**
 * Mandate ceiling, as a multiple of the monthly price. Overage is capped at 2×
 * the included allowance (see overageFor in src/lib/billing/catalogue.ts) and bills at
 * roughly the plan rate, so plan + worst-case overage ≈ 3× the monthly price.
 * A mandate cannot be amended after authorization, so this has to cover the
 * worst month or the overage debit is refused.
 */
const MANDATE_HEADROOM = 3;

/**
 * How far out to schedule a mandate's first charge.
 *
 * Cashfree rejects anything earlier than the next calendar day
 * ("First charge date cannot be before : <tomorrow>"), so this cannot be a few
 * minutes out. 36h is used rather than 24h because Cashfree evaluates the date
 * in IST while we compute in UTC — at 23:00 IST a +24h stamp still lands on
 * "today" by their reckoning and is refused. 36h clears the boundary from any
 * hour of the day; being a few hours later than strictly necessary costs
 * nothing, whereas being early fails the whole registration.
 */
const FIRST_CHARGE_DELAY_MS = 36 * 60 * 60 * 1000;

export async function getCashfreeConfig(): Promise<CashfreeConfig> {
  const [appId, secretKey, environment, subscriptions, international] = await Promise.all([
    getPlatformConfig(CASHFREE_KEYS.appId),
    getPlatformConfig(CASHFREE_KEYS.secretKey),
    getPlatformConfig(CASHFREE_KEYS.environment),
    getPlatformConfig(CASHFREE_KEYS.subscriptions),
    getPlatformConfig(CASHFREE_KEYS.international),
  ]);
  return {
    appId,
    secretKey,
    environment: environment === 'production' ? 'production' : 'sandbox',
    subscriptionsEnabled: subscriptions === '1',
    internationalEnabled: international === '1',
  };
}

export function isCashfreeConfigured(cfg: CashfreeConfig): boolean {
  return Boolean(cfg.appId && cfg.secretKey);
}

export function isLiveMode(cfg: CashfreeConfig): boolean {
  return cfg.environment === 'production';
}

export function checkoutMode(cfg: CashfreeConfig): CheckoutMode {
  return cfg.subscriptionsEnabled ? 'subscription' : 'order';
}

export function baseUrl(cfg: CashfreeConfig): string {
  return cfg.environment === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}

/** Cashfree takes amounts as a number with up to 2dp. */
export const money = (inr: number) => Math.round(inr * 100) / 100;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function cfFetch(cfg: CashfreeConfig, path: string, body?: unknown): Promise<any> {
  const res = await fetchWithTimeout(`${baseUrl(cfg)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'x-api-version': API_VERSION,
      'x-client-id': cfg.appId ?? '',
      'x-client-secret': cfg.secretKey ?? '',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    timeoutMs: 20_000,
    retries: 1,
  });

  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cashfree ${path}: unparseable response`);
  }
  if (!res.ok) throw new Error(json?.message || `Cashfree ${path} failed (HTTP ${res.status})`);
  return json;
}

// ---------------------------------------------------------------------------
// Identifiers
//
// Both flows mint IDs we can parse back to an org, because the webhook arrives
// with no session. `van_<orgId>_<timestamp>`; orgId is a cuid (alphanumeric),
// which keeps us inside Cashfree's charset rules for both fields.
// ---------------------------------------------------------------------------

// Two kinds of one-time payment, told apart by the prefix: `van_` buys a month
// of a plan, `vtm_` buys prepaid call minutes.
//
// The prefix — not an order tag — is what decides how a settling payment is
// applied. The order id is the gateway's own primary key: it comes back on
// every webhook and on the return URL, and it cannot be dropped or rewritten
// the way a tag can. A lost `kind` tag would otherwise hand someone a free
// month of plan in exchange for a minutes purchase, in silence.
const ID_RE = /^v(?:an|tm)_(.+)_\d+$/;
const PREFIX: Record<OrderKind, string> = { plan: 'van_', topup: 'vtm_' };

export type OrderKind = 'plan' | 'topup';

export function makeReference(orgId: string, kind: OrderKind = 'plan'): string {
  return `${PREFIX[kind]}${orgId}_${Date.now()}`;
}

export function orgIdFromReference(reference: string | null | undefined): string | null {
  const m = ID_RE.exec(reference ?? '');
  return m ? m[1] : null;
}

/** True when this reference is a prepaid-minutes purchase rather than a plan payment. */
export function isTopUpReference(reference: string | null | undefined): boolean {
  return (reference ?? '').startsWith(PREFIX.topup) && orgIdFromReference(reference) !== null;
}

// ---------------------------------------------------------------------------
// Payment Gateway — one-time orders (live today)
// ---------------------------------------------------------------------------

/**
 * Create a one-time order for a single month of a plan. Returns the session ID
 * the Cashfree JS SDK needs to open hosted checkout.
 *
 * The org's plan is only applied once the order is confirmed PAID — by the
 * webhook, or by the return-URL handler re-reading the order (the webhook can
 * lose the race with the browser redirect).
 */
export async function createOrder(args: {
  cfg: CashfreeConfig;
  orgId: string;
  plan: string;
  amountInr: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  returnUrl: string;
  notifyUrl?: string;
  /** Rides along in order_tags so the payment handler can count the redemption. */
  promoCode?: string | null;
  /**
   * Pre-tax value, when `amountInr` includes GST. Carried in order_tags so the
   * invoice records the taxable value that was actually quoted, rather than
   * re-deriving it from a rate that may have changed by the time it settles.
   */
  taxableInr?: number | null;
  /**
   * What is being bought. 'topup' buys prepaid call minutes rather than a month
   * of a plan, which changes the order id's prefix — and that prefix is what
   * routes the payment when it settles.
   */
  kind?: OrderKind;
  /** Minutes bought, on a top-up. Carried in order_tags so the settle path can credit them. */
  minutes?: number | null;
}): Promise<{ orderId: string; paymentSessionId: string }> {
  const kind = args.kind ?? 'plan';
  const orderId = makeReference(args.orgId, kind);
  const res = await cfFetch(args.cfg, '/orders', {
    order_id: orderId,
    order_amount: money(args.amountInr),
    order_currency: 'INR',
    customer_details: {
      customer_id: args.orgId,
      customer_name: args.customerName,
      customer_email: args.customerEmail,
      customer_phone: args.customerPhone,
    },
    order_meta: {
      return_url: args.returnUrl,
      ...(args.notifyUrl ? { notify_url: args.notifyUrl } : {}),
    },
    order_note:
      kind === 'topup'
        ? `VaaniYantra — ${args.minutes} prepaid call minutes`
        : `VaaniYantra ${args.plan} plan — 1 month`,
    // order_tags is the ONLY carrier of the plan identity through the gateway —
    // the webhook and the return handler both read `plan` back out of it to
    // decide what the org just bought. The value must round-trip byte for byte,
    // so it is never sanitised or prettified here.
    //
    // ⚠ Plan keys now contain underscores (bundle_practice, chat_starter). If
    // Cashfree ever rejects or mangles them, checkout fails for every new plan
    // while the legacy keys keep working — put one real ₹1 order through a new
    // plan and confirm the key comes back intact before trusting this.
    order_tags: {
      orgId: args.orgId,
      plan: args.plan,
      ...(kind === 'topup' ? { kind, minutes: String(args.minutes ?? 0) } : {}),
      ...(args.promoCode ? { promo: args.promoCode } : {}),
      ...(args.taxableInr != null ? { taxable: String(args.taxableInr) } : {}),
    },
  });
  if (!res?.payment_session_id) throw new Error('Cashfree did not return a payment session');
  return { orderId, paymentSessionId: res.payment_session_id };
}

export async function getOrder(cfg: CashfreeConfig, orderId: string): Promise<any> {
  return cfFetch(cfg, `/orders/${encodeURIComponent(orderId)}`);
}

// ---------------------------------------------------------------------------
// Subscriptions — recurring mandates (once the product is activated)
// ---------------------------------------------------------------------------

/**
 * Create a monthly mandate with the plan defined inline, so no Plan IDs have to
 * exist in the Cashfree dashboard. Returns the session ID for the SDK's
 * subscriptionsCheckout.
 *
 * The org's plan is only applied once the webhook reports the subscription
 * ACTIVE.
 */
export async function createSubscription(args: {
  cfg: CashfreeConfig;
  orgId: string;
  plan: string;
  amountInr: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  returnUrl: string;
  now?: Date;
}): Promise<{ subscriptionId: string; sessionId: string }> {
  const now = args.now ?? new Date();
  const subscriptionId = makeReference(args.orgId);
  const amount = money(args.amountInr);

  const res = await cfFetch(args.cfg, '/subscriptions', {
    subscription_id: subscriptionId,
    customer_details: {
      customer_name: args.customerName,
      customer_email: args.customerEmail,
      customer_phone: args.customerPhone,
    },
    plan_details: {
      // plan_name is capped at 40 chars by Cashfree. Longest key today is
      // "bundle_practice" → "VaaniYantra bundle_practice" (27), well inside it,
      // but the slice stays as the guard for whatever gets added next.
      plan_name: `VaaniYantra ${args.plan}`.slice(0, 40),
      plan_type: 'PERIODIC',
      plan_currency: 'INR',
      plan_amount: amount,
      plan_max_amount: money(amount * MANDATE_HEADROOM),
      plan_intervals: 1,
      plan_interval_type: 'MONTH',
    },
    subscription_meta: { return_url: args.returnUrl },
    // Collect the first month right away rather than after a free cycle.
    subscription_first_charge_time: new Date(now.getTime() + FIRST_CHARGE_DELAY_MS).toISOString(),
    subscription_tags: { orgId: args.orgId, plan: args.plan },
  });

  if (!res?.subscription_session_id) throw new Error('Cashfree did not return a subscription session');
  return { subscriptionId, sessionId: res.subscription_session_id };
}

export async function getSubscription(cfg: CashfreeConfig, subscriptionId: string): Promise<any> {
  return cfFetch(cfg, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function cancelSubscription(cfg: CashfreeConfig, subscriptionId: string): Promise<any> {
  return cfFetch(cfg, `/subscriptions/${encodeURIComponent(subscriptionId)}/manage`, {
    subscription_id: subscriptionId,
    action: 'CANCEL',
  });
}

/**
 * Raise a one-off charge on an existing mandate — used for monthly overage.
 * Cashfree requires a schedule date (it sends the pre-debit notice itself), so
 * this is scheduled a day out rather than debited on the spot. `paymentId` must
 * be unique; the sweep uses `ovg_<OverageCharge id>` so the webhook can settle
 * the row.
 */
export async function chargeSubscription(args: {
  cfg: CashfreeConfig;
  subscriptionId: string;
  paymentId: string;
  amountInr: number;
  remarks: string;
  scheduleAt?: Date;
}): Promise<{ status: string }> {
  const at = args.scheduleAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const res = await cfFetch(args.cfg, '/subscriptions/pay', {
    subscription_id: args.subscriptionId,
    payment_id: args.paymentId,
    payment_type: 'CHARGE',
    payment_amount: money(args.amountInr),
    payment_schedule_date: at.toISOString(),
    payment_remarks: args.remarks.slice(0, 100),
  });
  return { status: String(res?.payment_status ?? 'PENDING') };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Verify a Cashfree webhook and return the parsed event, or null if it can't be
 * trusted. Signature is Base64(HMAC-SHA256(timestamp + rawBody, secretKey)) in
 * `x-webhook-signature` — computed over the RAW body, so callers must pass
 * req.text() rather than a re-serialized object. Stale timestamps are rejected
 * so a captured webhook can't be replayed.
 *
 * There is no separate webhook secret on Cashfree: it signs with the merchant
 * secret key.
 */
export function verifyWebhook(
  payload: string,
  signature: string | null,
  timestamp: string | null,
  secret: string,
): any | null {
  if (!signature || !timestamp) return null;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}${payload}`).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // The header may be epoch seconds or milliseconds; normalize to seconds.
  const ts = Number(timestamp);
  const tsSec = ts > 1e12 ? ts / 1000 : ts;
  if (!Number.isFinite(tsSec) || Math.abs(Date.now() / 1000 - tsSec) > 300) return null;

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
