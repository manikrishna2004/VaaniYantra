import crypto from 'crypto';
import { prisma } from '@/lib/db';

// One-time codes proving control of the email address used to sign up.
//
// WHY THIS EXISTS. Sign-up used to create the Firebase account and immediately
// mint a session cookie, so anybody could open an account on an address they do
// not own — a competitor's, a doctor's, a real clinic's — and be inside the
// dashboard before the address had been checked at all. Every downstream
// promise we make about who a tenant is rested on an email nobody had verified.
//
// SECURITY MODEL — read before changing anything here.
//
// This mirrors src/lib/portal/otp.ts on purpose: same code length, same hash
// construction, same DATABASE-held limits. The limits live in Postgres and not
// in src/lib/rate-limit.ts because that limiter is per-process and resets on
// deploy, which would hand an attacker a fresh guessing budget for free. The
// in-process limiter is still used in front of the routes as a cheap per-IP
// throttle, but it is never the thing standing between an attacker and an
// account.
//
// The two are kept separate rather than merged because they guard different
// doors: PortalOtp lets a patient at their own records, this lets an operator
// at a clinic's dashboard. Sharing a table would mean one flow's rate limits,
// retention and incident response silently became the other's.

/** How long a code stays valid. Longer than the portal's 5 minutes: email is
 *  slower than SMS and often needs a second device to reach. */
export const EMAIL_OTP_TTL_MS = 15 * 60 * 1000;
/** Wrong guesses before the code is burned. */
export const EMAIL_OTP_MAX_ATTEMPTS = 5;
/** Minimum gap between codes to one account. */
export const EMAIL_OTP_RESEND_COOLDOWN_MS = 60 * 1000;
/** Codes one account may request per hour. */
export const EMAIL_OTP_MAX_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

function pepper(): string {
  // Falls back to the platform encryption key so the hash is never unsalted,
  // even when the dedicated pepper hasn't been set.
  //
  // SECRET_ENC_KEY, not ENCRYPTION_KEY. The latter is the name used by the
  // fallback in src/lib/portal/otp.ts and it does not exist — not in
  // config/env.ts, not in .env.example, and not on the production VM. That
  // fallback therefore does nothing, and the portal's pepper has always been the
  // hardcoded literal in production. Worth fixing there too, but changing it
  // invalidates every patient code currently in flight, so it is left alone
  // here rather than folded silently into an auth change.
  return process.env.EMAIL_OTP_PEPPER || process.env.SECRET_ENC_KEY || 'vaaniyantra-email-otp';
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
 * Binding in BOTH the uid and the email matters: a code minted for an account
 * must not verify after that account's address is changed underneath it, and a
 * row lifted from the database cannot be replayed against a different account.
 */
export function hashCode(code: string, uid: string, email: string): string {
  return crypto
    .createHash('sha256')
    .update(`${code}:${uid}:${email.toLowerCase()}:${pepper()}`)
    .digest('hex');
}

/** Constant-time comparison, so verification leaks nothing through timing. */
function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export type StartResult =
  | { ok: true; code: string }
  | { ok: false; retryAfterSec: number };

/**
 * Create a code for a pending account, or refuse on cooldown / hourly cap.
 *
 * Returns the plaintext code for the caller to send. It is returned rather than
 * mailed here so this module has no dependency on the mailer and stays
 * trivially testable — the same split src/lib/portal/otp.ts makes.
 */
export async function startEmailOtp(args: {
  uid: string;
  email: string;
  now?: Date;
}): Promise<StartResult> {
  const now = args.now ?? new Date();
  const email = args.email.toLowerCase();

  const recent = await prisma.emailOtp.findFirst({
    where: { uid: args.uid },
    orderBy: { createdAt: 'desc' },
  });

  // Cooldown between sends, so a signed-up-but-unverified account cannot be
  // used to hammer someone's inbox — the address is attacker-chosen, so this is
  // the control that stops us being turned into a mailbomb.
  if (recent) {
    const since = now.getTime() - recent.lastSentAt.getTime();
    if (since < EMAIL_OTP_RESEND_COOLDOWN_MS) {
      return { ok: false, retryAfterSec: Math.ceil((EMAIL_OTP_RESEND_COOLDOWN_MS - since) / 1000) };
    }
  }

  const lastHour = await prisma.emailOtp.count({
    where: { uid: args.uid, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
  });
  if (lastHour >= EMAIL_OTP_MAX_PER_HOUR) {
    return { ok: false, retryAfterSec: 900 };
  }

  const code = generateCode();
  await prisma.emailOtp.create({
    data: {
      uid: args.uid,
      email,
      codeHash: hashCode(code, args.uid, email),
      expiresAt: new Date(now.getTime() + EMAIL_OTP_TTL_MS),
      lastSentAt: now,
    },
  });

  return { ok: true, code };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'expired' | 'too_many' };

/**
 * Check a code, consuming it on success.
 *
 * The reasons exist for logging and for choosing between "that code has
 * expired" and "that code is not right"; they are safe to show here in a way
 * they are not in the portal, because the person holding this session already
 * proved they hold the Firebase password for this account.
 */
export async function verifyEmailOtp(args: {
  uid: string;
  email: string;
  code: string;
  now?: Date;
}): Promise<VerifyResult> {
  const now = args.now ?? new Date();
  const email = args.email.toLowerCase();

  const row = await prisma.emailOtp.findFirst({
    where: { uid: args.uid, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.attempts >= EMAIL_OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many' };
  if (row.expiresAt <= now) return { ok: false, reason: 'expired' };

  const matches = hashesEqual(row.codeHash, hashCode(args.code, args.uid, email));
  if (!matches) {
    // Count the attempt in the database, so restarting the app doesn't reset an
    // attacker's budget.
    await prisma.emailOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: 'invalid' };
  }

  // Consume it: a code is good exactly once.
  await prisma.emailOtp.update({ where: { id: row.id }, data: { consumedAt: now } });
  return { ok: true };
}

/**
 * Delete spent and expired codes. Called by the retention sweeper.
 *
 * Unlike the portal's purge there is no live-token case to spare here: once a
 * code is consumed the account is verified in Firebase, and that flag — not
 * this row — is what the session route reads from then on.
 */
export async function purgeExpiredEmailOtps(now: Date = new Date()): Promise<number> {
  const res = await prisma.emailOtp.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }] },
  });
  return res.count;
}
