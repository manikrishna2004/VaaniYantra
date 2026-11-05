import crypto from 'crypto';
import { prisma } from '@/lib/db';

// One-time codes for patient sign-in.
//
// SECURITY MODEL — read this before changing anything here.
//
// This replaced a bearer token embedded in the chatbot link. That link was
// forwardable: passing on an appointment SMS passed on the patient's medical
// history. A patient now proves control of the phone number the clinic already
// has on file for them.
//
// The limits that matter are all in the DATABASE, not in src/lib/rate-limit.ts.
// That limiter is per-process and resets on restart, so a deploy — or simply
// hitting a different worker — would hand an attacker a fresh budget. It is
// still used in front of these endpoints as a cheap per-IP throttle, but it is
// never the thing standing between an attacker and a patient's records.
//
// Existence is never disclosed. /otp/start behaves identically for a phone
// number that belongs to a patient and one that does not: same response, same
// work, a row written either way. Only the SMS differs, and the sender cannot
// observe that.

/** How long a code stays valid. Short: it is delivered in seconds. */
export const OTP_TTL_MS = 5 * 60 * 1000;
/** Wrong guesses before the code is burned. */
export const OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between codes to one number. */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
/** Codes one number may request per hour. */
export const OTP_MAX_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

function pepper(): string {
  // Falls back to the platform encryption key so the hash is never unsalted,
  // even when the dedicated pepper hasn't been set.
  return process.env.PORTAL_OTP_PEPPER || process.env.ENCRYPTION_KEY || 'vaaniyantra-portal-otp';
}

/**
 * A 6-digit code.
 *
 * crypto.randomInt, never Math.random: Math.random is neither uniform nor
 * unpredictable, and a predictable "one-time" code is not one.
 */
export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Hash a code for storage.
 *
 * SHA-256 with a server-side pepper, deliberately not bcrypt. A 6-digit code
 * has ~10^6 possibilities, so no work factor makes offline guessing infeasible
 * — the TTL and the attempt cap are what bound the attack. What the hash
 * actually buys is that reading the database does not yield a code that can be
 * replayed while it is still live. Binding in the phone and portal means a row
 * lifted from one clinic cannot be replayed at another.
 *
 * Please do not "upgrade" this to bcrypt: it would slow every verification for
 * no security gain.
 */
export function hashCode(code: string, phone: string, portalId: string): string {
  return crypto.createHash('sha256').update(`${code}:${phone}:${portalId}:${pepper()}`).digest('hex');
}

/** Constant-time comparison, so verification leaks nothing through timing. */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export type StartResult =
  | { ok: true; code: string | null; cooldown?: never }
  | { ok: false; retryAfterSec: number };

/**
 * Create a code for (portal, phone), or refuse on cooldown / hourly cap.
 *
 * Returns the plaintext code for the caller to send. It is returned rather than
 * sent here so this module has no dependency on messaging and stays trivially
 * testable.
 */
export async function startOtp(args: {
  portalId: string;
  orgId: string;
  phone: string;
  now?: Date;
}): Promise<StartResult> {
  const now = args.now ?? new Date();

  const recent = await prisma.portalOtp.findFirst({
    where: { portalId: args.portalId, phone: args.phone },
    orderBy: { createdAt: 'desc' },
  });

  // Cooldown between sends, so the endpoint can't be used to hammer someone's
  // phone with texts.
  if (recent) {
    const since = now.getTime() - recent.lastSentAt.getTime();
    if (since < OTP_RESEND_COOLDOWN_MS) {
      return { ok: false, retryAfterSec: Math.ceil((OTP_RESEND_COOLDOWN_MS - since) / 1000) };
    }
  }

  const lastHour = await prisma.portalOtp.count({
    where: { portalId: args.portalId, phone: args.phone, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
  });
  if (lastHour >= OTP_MAX_PER_HOUR) {
    return { ok: false, retryAfterSec: 900 };
  }

  const code = generateCode();
  await prisma.portalOtp.create({
    data: {
      portalId: args.portalId,
      orgId: args.orgId,
      phone: args.phone,
      codeHash: hashCode(code, args.phone, args.portalId),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      lastSentAt: now,
    },
  });

  return { ok: true, code };
}

export type VerifyResult =
  | { ok: true; otpId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'too_many' };

/**
 * Check a code, consuming it on success.
 *
 * Every failure mode returns the same generic message to the caller — the
 * distinction here exists for logging, not for the patient, who should not be
 * told whether a code merely expired or never existed for that number.
 */
export async function verifyOtp(args: {
  portalId: string;
  phone: string;
  code: string;
  now?: Date;
}): Promise<VerifyResult> {
  const now = args.now ?? new Date();

  const row = await prisma.portalOtp.findFirst({
    where: { portalId: args.portalId, phone: args.phone, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many' };
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };

  const matches = hashesEqual(row.codeHash, hashCode(args.code, args.phone, args.portalId));
  if (!matches) {
    // Count the attempt in the database, so restarting the app doesn't reset an
    // attacker's budget.
    await prisma.portalOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: 'invalid' };
  }

  // Consume it: a code is good exactly once.
  await prisma.portalOtp.update({ where: { id: row.id }, data: { consumedAt: now } });
  // The row id comes back so the caller can hang a household-selection token on
  // it when the number turns out to belong to more than one patient.
  return { ok: true, otpId: row.id };
}

/** How long a household-selection token stays usable after the code is verified. */
export const OTP_SELECTION_TTL_MS = 2 * 60 * 1000;

/**
 * Attach a single-use selection token to the just-consumed code.
 *
 * Used when a verified phone number turns out to belong to several patients:
 * the caller has proved control of the NUMBER, and the number determines the
 * allowed set, so this token carries exactly that authority and nothing more.
 */
export async function issueSelectionToken(otpId: string, now: Date = new Date()): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.portalOtp.update({
    where: { id: otpId },
    data: {
      selectionTokenHash: hashSelectionToken(token),
      selectionExpiresAt: new Date(now.getTime() + OTP_SELECTION_TTL_MS),
    },
  });
  return token;
}

export function hashSelectionToken(token: string): string {
  return crypto.createHash('sha256').update(`${token}:${pepper()}`).digest('hex');
}

/**
 * Redeem a selection token, returning the PHONE it was issued for.
 *
 * The phone is the point: the caller sends a contactId, but it is only ever
 * checked against the set derived from this phone — never trusted on its own.
 * Single-use, so a leaked token cannot be replayed.
 */
export async function redeemSelectionToken(
  portalId: string,
  token: string,
  now: Date = new Date(),
): Promise<{ phone: string } | null> {
  const row = await prisma.portalOtp.findFirst({
    where: {
      portalId,
      selectionTokenHash: hashSelectionToken(token),
      selectionExpiresAt: { gt: now },
    },
  });
  if (!row) return null;
  await prisma.portalOtp.update({
    where: { id: row.id },
    data: { selectionTokenHash: null, selectionExpiresAt: null },
  });
  return { phone: row.phone };
}

/**
 * Delete spent and expired codes. Called by the retention sweeper.
 *
 * ⚠ The `consumedAt` arm deliberately spares rows with a LIVE selection token.
 * A consumed code carrying an unexpired token is mid-sign-in, and deleting it
 * would void the patient's selection with no error anywhere — they would simply
 * be told to sign in again.
 */
export async function purgeExpiredOtps(now: Date = new Date()): Promise<number> {
  const res = await prisma.portalOtp.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now }, OR: [{ selectionExpiresAt: null }, { selectionExpiresAt: { lt: now } }] },
        { consumedAt: { not: null }, OR: [{ selectionExpiresAt: null }, { selectionExpiresAt: { lt: now } }] },
      ],
    },
  });
  return res.count;
}
