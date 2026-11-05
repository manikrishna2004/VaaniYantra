import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase/admin';
import { verifyEmailOtp } from '@/lib/auth/email-otp';
import { createSession } from '@/lib/auth/session';
import { provisionUser } from '@/lib/auth/provision';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { checkPlatformAccess } from '@/lib/access';

// firebase-admin needs the Node runtime (not Edge).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Redeem a one-time code, then — and only then — issue the session.
 *
 * This route is where sign-up actually completes. It deliberately does the work
 * /api/auth/session used to do at the moment the Firebase account was created:
 * mark the address verified, mint the cookie, provision the Postgres tenant.
 * Nothing exists in our database for an account that never got this far, which
 * is the point — an unverified sign-up leaves a Firebase account and no tenant.
 */
export async function POST(req: Request) {
  const ipLimit = checkRateLimit(`auth:verify-email:confirm:${clientIp(req)}`, {
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfterSec) } },
    );
  }

  let idToken: string | undefined;
  let code: string | undefined;
  // Same meaning as on /api/auth/session: set by the sign-up form when the
  // acceptance box was ticked, and only stamped on the org this login creates.
  let acceptedTerms = false;
  try {
    ({ idToken, code, acceptedTerms = false } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!idToken) return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });

  const entered = String(code ?? '').replace(/\D/g, '');
  if (entered.length !== 6) {
    return NextResponse.json({ error: 'Enter the 6-digit code from your email.' }, { status: 400 });
  }

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

  // The access gate, before the code is spent and before a tenant is created.
  // This route is where sign-up completes, so leaving it ungated would make the
  // whole invite-only policy a decoration: anyone could create an account, take
  // the code, and provision an organisation without ever touching
  // /api/auth/session.
  const access = await checkPlatformAccess(email);
  if (!access.allowed) {
    return NextResponse.json({ error: access.message, code: 'invite_only' }, { status: 403 });
  }

  // An already-verified account skips the code entirely rather than being told
  // its code is invalid — this is the path a user lands on after a refresh, or
  // when the same code is submitted twice by a double-clicked button.
  if (decoded.email_verified !== true) {
    const result = await verifyEmailOtp({ uid: decoded.uid, email, code: entered });
    if (!result.ok) {
      const message =
        result.reason === 'expired'
          ? 'That code has expired. Ask for a new one.'
          : result.reason === 'too_many'
            ? 'Too many incorrect attempts. Ask for a new code.'
            : 'That code is not right. Check the email and try again.';
      return NextResponse.json({ error: message, reason: result.reason }, { status: 400 });
    }

    // Persist the fact on the Firebase account, because that — not our OTP
    // table — is what /api/auth/session checks on every future sign-in. Purging
    // spent codes must never be able to lock a verified customer out.
    await adminAuth.updateUser(decoded.uid, { emailVerified: true });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  try {
    await createSession(idToken);
    await provisionUser(
      {
        uid: decoded.uid,
        email,
        name: (decoded.name as string | undefined) ?? null,
        picture: (decoded.picture as string | undefined) ?? null,
      },
      acceptedTerms === true ? { ip } : undefined,
    );
  } catch (err) {
    console.error('[auth/verify-email/confirm] session or provisioning failed', err);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
