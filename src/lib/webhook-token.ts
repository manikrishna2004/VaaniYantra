import crypto from 'crypto';

// Authenticating status callbacks from providers that don't sign them.
//
// Twilio and Plivo sign their webhooks, so those are verified cryptographically
// against the account's own auth token. Exotel does not sign at all — its only
// documented control is an IP allowlist, and the IP ranges have to be requested
// from their support team.
//
// But we build the callback URL ourselves and hand it to the provider, so we can
// carry our own proof in it: an HMAC over the call id, keyed with a server-side
// secret. The provider echoes the whole URL back, we recompute, and a forged
// request fails because the attacker cannot produce the token for a call id.
//
// This matters because these callbacks write `duration`, which drives overage
// billing — an unauthenticated one lets anybody inflate another org's bill or
// zero out their own.
//
// The token proves "this URL was minted by us for this call". It is not a
// replay defence: a captured URL stays valid for that one call, which is fine
// since it can only ever update that call's own row.

/**
 * Key for callback tokens. Falls back to SECRET_ENC_KEY so a deployment that
 * hasn't set a dedicated secret still gets real authentication rather than
 * silently degrading to none — that fallback is already required in production.
 */
function tokenKey(): string | null {
  return process.env.WEBHOOK_TOKEN_SECRET || process.env.SECRET_ENC_KEY || null;
}

/** True when tokens can be produced and checked at all. */
export function webhookTokensAvailable(): boolean {
  return Boolean(tokenKey());
}

/**
 * Token for one call's status callback. `purpose` scopes it to a provider so a
 * token minted for one cannot be replayed against another's endpoint.
 */
export function callbackToken(callId: string, purpose: string): string {
  const key = tokenKey();
  if (!key) return '';
  return crypto
    .createHmac('sha256', key)
    .update(`${purpose}:${callId}`)
    .digest('base64url')
    .slice(0, 32); // 192 bits — far past brute force, short enough for a URL
}

/** Timing-safe comparison; false on any missing or malformed input. */
export function verifyCallbackToken(callId: string, purpose: string, provided: string | null | undefined): boolean {
  if (!provided || !callId) return false;
  const expected = callbackToken(callId, purpose);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Append the token to a status-callback URL we are about to hand a provider. */
export function signCallbackUrl(url: string, callId: string, purpose: string): string {
  const token = callbackToken(callId, purpose);
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${token}`;
}
