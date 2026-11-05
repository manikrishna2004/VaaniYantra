import crypto from 'crypto';

// Shared bearer-secret check for endpoints a VM cron calls unattended.
//
// Extracted from `overage-sweep.ts` when the retention sweep grew the same
// need. Two rules matter and are easy to get wrong independently in each
// caller, which is why this lives in one place:
//
//  - an unset secret must never authenticate anything (otherwise a machine that
//    forgot the env var silently accepts `Authorization: Bearer undefined`), and
//  - the comparison is timing-safe, since the caller controls the candidate.

/** Timing-safe compare of a caller-supplied secret against the expected one. */
export function secretMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so the length check has to come
  // first. Length is not itself a secret.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Pull the bearer token out of an Authorization header, if present. */
export function bearerFrom(req: Request): string | null {
  return req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}
