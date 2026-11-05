import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';

/**
 * Selling the Starter Kit: order ids, download tokens, and the one transition
 * that matters — PENDING to PAID.
 *
 * Kept entirely separate from src/lib/cashfree-sync.ts, which applies plan and
 * minutes payments to organizations. These two paths share a merchant account
 * and nothing else. A defect here must never be able to grant someone a month
 * of the platform, and the `vkt_` prefix below is what guarantees that: the
 * billing webhook's reference parser only recognises `van_` and `vtm_`.
 */

/** The only price. One product, one amount, quoted inclusive of tax. */
export const KIT_PRICE_INR = 299;

export const KIT_PRODUCT_NAME = 'Voice Agent Starter Kit';

const ORDER_PREFIX = 'vkt_';

/**
 * What this buyer is charged.
 *
 * KIT_PRICE_INR for everyone, except addresses listed in KIT_TEST_EMAILS
 * (comma-separated), who pay KIT_TEST_PRICE_INR (default ₹10). That exists so
 * the live Cashfree path — real money, real webhook, real email — can be walked
 * end to end without paying full price, and without lowering the price for
 * anyone else while it happens. Unset KIT_TEST_EMAILS and restart to turn it off.
 */
export function kitPriceFor(email: string): number {
  const testers = (process.env.KIT_TEST_EMAILS || '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean);
  if (!testers.includes(normalizeEmail(email))) return KIT_PRICE_INR;
  const price = Number(process.env.KIT_TEST_PRICE_INR || 10);
  // Cashfree's floor is ₹1; anything unparseable falls back to the real price.
  return Number.isFinite(price) && price >= 1 ? price : KIT_PRICE_INR;
}

/** `vkt_<random>_<timestamp>` — Cashfree allows alphanumerics and underscores. */
export function makeKitOrderId(): string {
  return ORDER_PREFIX + randomBytes(9).toString('hex') + '_' + Date.now();
}

export function isKitOrderId(orderId: string | null | undefined): boolean {
  return typeof orderId === 'string' && orderId.startsWith(ORDER_PREFIX);
}

/**
 * How long a download link lives, and how the link is shaped.
 *
 * Seven days is long enough that a buyer who pays on a phone can download on a
 * laptop at the weekend, and short enough that a link pasted into a public
 * channel stops working. Running out is not a dead end — the buyer asks and we
 * re-issue against the same paid order.
 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mintToken(): string {
  // 32 bytes of randomness, base64url. This is a bearer credential for a paid
  // file: it must not be guessable and must not encode anything about the
  // buyer.
  return randomBytes(32).toString('base64url');
}

export function normalizeEmail(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

/**
 * Good enough to catch a typo, deliberately not an RFC 5322 implementation.
 * The real validation is that the receipt has to arrive.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export async function createPendingOrder(args: {
  email: string;
  name?: string | null;
  orderId: string;
  amountInr: number;
}) {
  return prisma.kitOrder.create({
    data: {
      email: normalizeEmail(args.email),
      name: args.name?.trim() || null,
      orderId: args.orderId,
      amountInr: args.amountInr,
      status: 'PENDING',
    },
  });
}

/**
 * Mark an order paid and issue its download token.
 *
 * Idempotent on purpose. Two things race to call this — Cashfree's webhook and
 * the buyer's browser landing on the return URL — and whichever arrives second
 * must not mint a second token, because the first one may already be in the
 * buyer's inbox.
 */
export async function markPaid(orderId: string, cfPaymentId?: string | null) {
  const existing = await prisma.kitOrder.findUnique({ where: { orderId } });
  if (!existing) return null;

  if (existing.status === 'PAID' && existing.downloadToken) {
    // Already settled. Hand back what we issued the first time — but keep the
    // payment id if this caller is the first to know it. The return page
    // settles without one, so a webhook arriving second still has to record it.
    if (cfPaymentId && !existing.cfPaymentId) {
      return prisma.kitOrder.update({ where: { orderId }, data: { cfPaymentId } });
    }
    return existing;
  }

  return prisma.kitOrder.update({
    where: { orderId },
    data: {
      status: 'PAID',
      paidAt: existing.paidAt ?? new Date(),
      cfPaymentId: cfPaymentId ?? existing.cfPaymentId,
      downloadToken: existing.downloadToken ?? mintToken(),
      tokenExpiresAt: existing.tokenExpiresAt ?? new Date(Date.now() + TOKEN_TTL_MS),
    },
  });
}

export async function markFailed(orderId: string) {
  const existing = await prisma.kitOrder.findUnique({ where: { orderId } });
  // Never overwrite a settled payment with a failure — Cashfree can report a
  // failed attempt after a successful retry on the same order.
  if (!existing || existing.status === 'PAID') return existing;
  return prisma.kitOrder.update({ where: { orderId }, data: { status: 'FAILED' } });
}

export type TokenCheck =
  | { ok: true; order: NonNullable<Awaited<ReturnType<typeof markPaid>>> }
  | { ok: false; reason: 'unknown' | 'unpaid' | 'expired' | 'exhausted' };

/**
 * Is this token allowed to download right now?
 *
 * Compared in constant time. The token is looked up by an indexed equality
 * match, so a timing difference here would be small — but this is the single
 * gate on a paid artefact, and constant-time comparison costs nothing.
 */
export async function checkDownloadToken(token: string | null | undefined): Promise<TokenCheck> {
  if (!token) return { ok: false, reason: 'unknown' };

  const order = await prisma.kitOrder.findUnique({ where: { downloadToken: token } });
  if (!order || !order.downloadToken) return { ok: false, reason: 'unknown' };

  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(order.downloadToken).digest();
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'unknown' };

  if (order.status !== 'PAID') return { ok: false, reason: 'unpaid' };
  if (order.tokenExpiresAt && order.tokenExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (order.downloadCount >= order.maxDownloads) return { ok: false, reason: 'exhausted' };

  return { ok: true, order };
}

export async function recordDownload(orderId: string) {
  await prisma.kitOrder.update({
    where: { orderId },
    data: { downloadCount: { increment: 1 } },
  });
}

/** The page a buyer is sent to once the payment is done. */
export function downloadUrl(baseUrl: string, token: string): string {
  return baseUrl.replace(/\/+$/, '') + '/kit/download?token=' + encodeURIComponent(token);
}
