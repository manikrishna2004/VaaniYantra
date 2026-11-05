// Scopes for the public v1 REST API.
//
// ── Why this vocabulary and not a new one ───────────────────────────────────
//
// These are the same `resource:action` strings as the RBAC permissions in
// src/lib/auth/permissions.ts. Deliberately: a key that may do a thing and a
// human seat that may do the same thing should not be described in two
// different languages, or the two lists drift and one of them ends up wrong.
// The sets are not identical — a key has no calendar of its own, and a human
// does not have `usage:read` — but where they overlap the string is the same.
//
// ── Why empty means "allow", for now ────────────────────────────────────────
//
// ApiKey.scopes has existed since the model was written and has never been
// enforced, so every key in the field today carries `[]`. Reading `[]` as
// "deny" would break every live integration on the deploy that shipped
// enforcement; reading it as "allow" forever would leave the column decorative.
//
// So: `[]` means allow AND logs a warning, until API_SCOPES_STRICT=true. The
// order is backfill every existing key to ['*'] (scripts/backfill-api-scopes.ts),
// watch for a week, then set the env flag. The flag is the rollback — flipping
// it back is a restart, not a deploy.

export const API_SCOPES = [
  'agents:read',
  'agents:write',
  'calls:read',
  'calls:write',
  'numbers:read',
  'numbers:write',
  'appointments:read',
  'appointments:write',
  'patients:read',
  'patients:write',
  'usage:read',
  'wallet:read',
  'webhooks:read',
  'webhooks:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Grants everything. What the backfill writes onto every pre-scope key. */
export const WILDCARD = '*';

const SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export function isApiScope(value: string): value is ApiScope {
  return SCOPE_SET.has(value);
}

/**
 * Strict mode: an empty scope list denies instead of allowing.
 *
 * Off by default. Turn on only after every live key has been backfilled — see
 * the header. Env rather than PlatformConfig because it gates authentication,
 * and an auth decision must not depend on a database read that can fail open.
 */
export function scopesStrict(): boolean {
  return (process.env.API_SCOPES_STRICT ?? '').trim().toLowerCase() === 'true';
}

/**
 * Does this key's grant cover the scope a route asked for?
 *
 * Accepts the exact scope, the wildcard, or a resource wildcard (`calls:*`).
 * A resource wildcard is worth supporting because "read and write calls, and
 * keep working when we add calls:delete" is a thing integrators actually want,
 * and without it they would ask for `*`.
 */
export function grantCovers(granted: readonly string[], need: ApiScope): boolean {
  if (granted.includes(WILDCARD)) return true;
  if (granted.includes(need)) return true;
  const resource = need.slice(0, need.indexOf(':'));
  return granted.includes(`${resource}:*`);
}

/**
 * Normalise a caller-supplied scope list: drop unknown strings, de-duplicate,
 * keep a lone wildcard as a wildcard. Used when a key is created or edited, so
 * a typo becomes a missing grant at creation time rather than a 403 in
 * production three weeks later.
 */
export function normalizeScopes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (s === WILDCARD) return [WILDCARD];
    if (isApiScope(s)) out.add(s);
    else if (s.endsWith(':*') && API_SCOPES.some((k) => k.startsWith(s.slice(0, -1)))) out.add(s);
  }
  return [...out].sort();
}
