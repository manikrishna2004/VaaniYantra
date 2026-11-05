import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase/admin';
import { startEmailOtp } from '@/lib/auth/email-otp';
import { sendMail, verificationEmail, mailerConfigured, mailFrom } from '@/lib/mailer';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { checkPlatformAccess } from '@/lib/access';

// firebase-admin needs the Node runtime (not Edge).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mail a one-time code to the address on a freshly-created account.
 *
 * The caller proves who it is with a Firebase ID token, not with an email in
 * the body. That is the whole reason this endpoint cannot be used to spray
 * codes at arbitrary strangers: the address is read off the verified token, so
 * asking for a code requires already holding the password for the account that
 * owns it.
 */
export async function POST(req: Request) {
  // Cheap first line only. The limits that actually bound abuse (cooldown,
  // per-hour cap, attempt cap) are in the database — see lib/auth/email-otp.ts.
  const ipLimit = checkRateLimit(`auth:verify-email:start:${clientIp(req)}`, {
    limit: 20,
    windowMs: 10 * 60_000,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) } },
    );
  }

  let idToken: string | undefined;
  try {
    ({ idToken } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!idToken) return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(idToken);
  } catch {
    return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
  }

  const email = decoded.email;
  if (!email) {
    return NextResponse.json({ error: 'This account has no email address.' }, { status: 400 });
  }

  // Invite-only: do not even mail a code to an address that will be refused a
  // session two steps later. Sending one would be a lie of omission — the code
  // would arrive, work, and still end at a locked door.
  const access = await checkPlatformAccess(email);
  if (!access.allowed) {
    return NextResponse.json({ error: access.message, code: 'invite_only' }, { status: 403 });
  }

  // Already verified — say so plainly instead of sending a pointless code. The
  // client uses this to skip straight to the session exchange, which is what
  // makes a half-finished sign-up resumable rather than a dead end.
  if (decoded.email_verified === true) {
    return NextResponse.json({ ok: true, verified: true });
  }

  // Without a mail backend nobody can ever receive the code, and a signup that
  // silently hangs on a code that was never sent is worse than one that says
  // so. This is a hard failure on purpose: unlike an invite, there is no link
  // to fall back on and no way for the user to make progress.
  if (!mailerConfigured()) {
    console.error(
      '[auth/verify-email] no mail backend configured — set RESEND_API_KEY or SMTP_URL. ' +
        'Email sign-up cannot complete until one is set.',
    );
    return NextResponse.json(
      { error: 'We could not send the verification email. Please contact support.' },
      { status: 503 },
    );
  }

  const started = await startEmailOtp({ uid: decoded.uid, email });
  if (!started.ok) {
    return NextResponse.json(
      { error: 'A code was just sent. Please wait a moment before asking for another.' },
      { status: 429, headers: { 'Retry-After': String(started.retryAfterSec) } },
    );
  }

  const mail = verificationEmail({
    code: started.code,
    name: (decoded.name as string | undefined) ?? null,
  });
  const sent = await sendMail({ to: email, ...mail });
  if (!sent) {
    // The code row stays. Resending is cheap and the cooldown protects the
    // inbox, so the user's next attempt just works if the outage was transient.
    return NextResponse.json(
      { error: 'We could not send the verification email. Please try again in a moment.' },
      { status: 502 },
    );
  }

  // The sender is reported back rather than hardcoded in the component. The
  // address is configurable per environment, and a "check your spam for mail
  // from X" hint naming the wrong X is worse than no hint at all.
  return NextResponse.json({ ok: true, verified: false, from: mailFrom() });
}
