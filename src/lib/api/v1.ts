import { NextResponse } from 'next/server';
import { authenticateApiKey } from '@/lib/api-keys';
import { checkRateLimit, clientIp, type RateLimitResult } from '@/lib/rate-limit';
import { grantCovers, scopesStrict, type ApiScope } from '@/lib/api/scopes';

// Shared helpers for the public v1 REST API (authenticated by API key, scoped to
// the owning organization). Keep response shapes stable — external integrations
// depend on them.

export function unauthorized() {
  return NextResponse.json({ error: 'Invalid or missing API key' }, { status: 401 });
}

/**
 * 403, not 401 — and the difference matters to whoever is debugging.
 *
 * 401 says "this key is not valid"; a caller retries with a different key. 403
 * says "this key is valid and may not do this"; a caller goes and widens the
 * key's scopes. Collapsing them into one status sends people to the wrong fix.
 */
export function forbidden(required: ApiScope) {
  return NextResponse.json(
    { error: `This API key is missing the "${required}" scope`, required: [required] },
    { status: 403 },
  );
}

// Per-IP cap on auth *attempts* (every attempt costs a DB lookup — this stops
// key-guessing floods) and a per-key cap on authenticated requests.
const IP_LIMIT = { limit: 240, windowMs: 60_000 };
const KEY_LIMIT = { limit: 120, windowMs: 60_000 };

function tooManyRequests(rl: RateLimitResult) {
  return NextResponse.json(
    { error: 'Rate limit exceeded, retry later' },
    {
      status: 429,
      headers: {
        'Retry-After': String(rl.retryAfterSec),
        'X-RateLimit-Remaining': String(rl.remaining),
        'X-RateLimit-Reset': String(Math.ceil(rl.resetAt / 1000)),
      },
    },
  );
}

export type ApiAuth = {
  orgId: string;
  keyId: string;
  scopes: string[];
  hasScope(s: ApiScope): boolean;
};

/**
 * Authenticate + rate limit + authorize a public v1 request. Returns the
 * API-key auth context, or a ready-to-return 401/403/429 NextResponse (check
 * with `instanceof NextResponse`).
 *
 * `need` is not optional in spirit: every v1 route passes one, and
 * tests/v1-api-auth.test.ts fails the build if a route handler forgets. It is
 * optional in the signature only so a non-route caller can authenticate
 * without asserting an action.
 */
export async function requireApiAuth(
  req: Request,
  need?: ApiScope,
): Promise<ApiAuth | NextResponse> {
  const ipLimit = checkRateLimit(`v1:ip:${clientIp(req)}`, IP_LIMIT);
  if (!ipLimit.ok) return tooManyRequests(ipLimit);

  const auth = await authenticateApiKey(req);
  if (!auth) return unauthorized();

  const keyLimit = checkRateLimit(`v1:key:${auth.keyId}`, KEY_LIMIT);
  if (!keyLimit.ok) return tooManyRequests(keyLimit);

  const scopes = auth.scopes ?? [];
  const ctx: ApiAuth = {
    orgId: auth.orgId,
    keyId: auth.keyId,
    scopes,
    hasScope: (s) => (scopes.length === 0 && !scopesStrict() ? true : grantCovers(scopes, s)),
  };

  if (need) {
    if (scopes.length === 0) {
      // A key predating scopes. Allowed until the backfill has run everywhere
      // and API_SCOPES_STRICT is on — but never silently, because this warning
      // is the signal that says when the flip is safe.
      if (scopesStrict()) return forbidden(need);
      console.warn(
        `[api-keys] key ${auth.keyId} (org ${auth.orgId}) has no scopes; allowing "${need}" under the pre-enforcement default. Run scripts/backfill-api-scopes.ts.`,
      );
    } else if (!grantCovers(scopes, need)) {
      return forbidden(need);
    }
  }

  return ctx;
}

// Parse ?limit=&offset= with sane bounds (default 25, max 100).
export function paging(url: URL): { take: number; skip: number; limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  return { take: limit, skip: offset, limit, offset };
}

// Serialize a Call row to the public shape (same fields as the webhook payload).
export function serializeCall(call: any, opts?: { transcript?: boolean }) {
  const out: Record<string, unknown> = {
    id: call.id,
    direction: call.direction,
    status: call.status,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    durationSec: call.durationSec,
    language: call.language,
    agent: call.agent ? { id: call.agent.id, name: call.agent.name } : null,
    summary: call.summary ?? null,
    sentiment: call.sentiment ?? null,
    sentimentScore: call.sentimentScore ?? null,
    topics: call.topics ?? [],
    collectedData: call.collectedData ?? null,
    recordingUrl: call.recordingUrl ?? null,
    createdAt: call.createdAt,
    startedAt: call.startedAt ?? null,
    endedAt: call.endedAt ?? null,
  };
  if (opts?.transcript && Array.isArray(call.transcript)) {
    out.transcript = call.transcript.map((t: any) => ({ role: t.role, text: t.text, atMs: t.atMs }));
  }
  return out;
}
