// Cookie name + a cheap, dependency-free liveness check.
//
// Safe to import from Edge middleware AND from server components: no Node-only
// dependencies, no firebase-admin. Deliberately does NOT verify the signature —
// it cannot, on the Edge runtime. Callers must treat a `true` here as "worth
// trying", never as "authenticated"; the real check is getSessionUser(), which
// verifies against Google's certs.
export const SESSION_COOKIE = '__session';

/**
 * Decode a JWT's payload and report whether its `exp` is still in the future.
 *
 * Used to avoid bouncing a user with an obviously-dead cookie, and to decide
 * whether the marketing page shows "Dashboard" or "Get started". An expired
 * token returns false; a tampered or foreign-issuer token with a future `exp`
 * returns true, which is exactly why nothing security-relevant may depend on it.
 */
export function isTokenLive(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    p += '==='.slice((p.length + 3) % 4);
    const payload = JSON.parse(atob(p)) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
