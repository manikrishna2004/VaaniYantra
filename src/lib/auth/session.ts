// Server-side session management.
//
// We store a Firebase **session cookie** — a long-lived credential minted by
// createSessionCookie() and verified with verifySessionCookie(). It lasts 14
// days and survives closing the browser.
//
// It used to be the raw Firebase **ID token**, which lives ~1 hour. That was
// chosen because verifyIdToken() is pure offline JWT verification needing no
// IAM role, whereas createSessionCookie() calls the Identity Toolkit API and
// requires the service account to hold roles/iam.serviceAccountTokenCreator.
// The cost was that closing a tab for an hour logged you out: the cookie died
// while Firebase's own session in the browser lived on, so returning users met
// the sign-in page's "Continue as <you>" panel every morning.
//
// ⚠ BOTH PATHS ARE KEPT, deliberately, and this is not belt-and-braces for its
// own sake. If the service account lacks the IAM role, createSessionCookie()
// throws — and without the fallback every single login would break the moment
// this deployed. So minting degrades to the old ID-token cookie with a loud
// warning, and verification accepts either shape. That makes this safe to ship
// before the role is granted, and it upgrades itself the moment it is. It also
// means sessions issued before this shipped keep working instead of logging
// everyone out on deploy.
//
// Once the role is granted and the warning has stopped appearing in logs, the
// fallback can be deleted.
import { cookies } from 'next/headers';
import { adminAuth } from '@/lib/firebase/admin';
import { SESSION_COOKIE } from './session-cookie';

export { SESSION_COOKIE };

const SESSION_DAYS = 14;
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * SESSION_DAYS;
const EXPIRES_IN_MS = COOKIE_MAX_AGE_S * 1000;

export type SessionUser = {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
};

function cookieOptions() {
  return {
    maxAge: COOKIE_MAX_AGE_S,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

/**
 * Exchange a freshly-minted Firebase ID token for a session cookie.
 *
 * The ID token must be recent — every caller mints one immediately before
 * calling this, which is the condition createSessionCookie() requires.
 */
export async function createSession(idToken: string): Promise<void> {
  let value = idToken;
  try {
    value = await adminAuth.createSessionCookie(idToken, { expiresIn: EXPIRES_IN_MS });
  } catch (err) {
    // Almost always the missing IAM role. Loud, because the symptom otherwise
    // is the subtle one this change exists to fix: users quietly logged out
    // after an hour, with nothing obviously broken.
    console.error(
      '[auth] createSessionCookie failed — falling back to a 1-hour ID-token cookie. ' +
        'Grant roles/iam.serviceAccountTokenCreator to the service account to enable 14-day sessions.',
      err,
    );
  }
  (await cookies()).set(SESSION_COOKIE, value, cookieOptions());
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Verify the stored credential and return the Firebase user, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  // A session cookie and an ID token are both JWTs and are indistinguishable
  // by shape, so this tries the current format first and falls back to the old
  // one rather than guessing.
  //
  // checkRevoked is off: it costs a network round trip to Firebase on EVERY
  // authenticated request. The trade is that a revoked session stays usable
  // until the cookie expires. Worth revisiting alongside a "sign out
  // everywhere" feature, which is the thing that would make revocation
  // meaningful — today nothing in the product revokes a session.
  let decoded: Awaited<ReturnType<typeof adminAuth.verifySessionCookie>> | null = null;
  try {
    decoded = await adminAuth.verifySessionCookie(token);
  } catch {
    try {
      decoded = await adminAuth.verifyIdToken(token);
    } catch {
      return null;
    }
  }

  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    name: (decoded.name as string | undefined) ?? null,
    picture: (decoded.picture as string | undefined) ?? null,
  };
}
