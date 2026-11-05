import { cookies } from 'next/headers';
import {
  resolvePortalSession,
  PORTAL_LOGIN_TTL_MS,
  type PortalSession,
} from '@/lib/portal/contacts';

// Where a signed-in patient's session token lives.
//
// One cookie for all portals rather than one per slug: a patient normally deals
// with a single clinic, and signing in at a second one simply re-issues the
// cookie. resolvePortalSession() checks the session actually belongs to the
// portal being viewed, so a stale cookie from another clinic reads as signed
// out rather than as somebody else's session.
export const PORTAL_COOKIE = 'vy_portal';

// Matches the server-side session lifetime, so the cookie and the row it points
// at expire together rather than the browser holding a token the server has
// already stopped honouring.
//
// Much shorter than the 180 days this used to be. That number came from the
// bearer-link model, where the alternative to a remembered session was
// re-sending a link; a patient can now sign in again with a code in seconds,
// and a session over medical records should not outlive a handset.
export const PORTAL_COOKIE_MAX_AGE = Math.floor(PORTAL_LOGIN_TTL_MS / 1000);

export function portalCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: PORTAL_COOKIE_MAX_AGE,
  };
}

/** Resolve the signed-in patient for a portal from their cookie, or null. */
export async function currentPortalSession(slug: string): Promise<PortalSession | null> {
  const jar = await cookies();
  return resolvePortalSession(slug, jar.get(PORTAL_COOKIE)?.value);
}
