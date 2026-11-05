import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { encryptSecret, decryptSecret } from '@/lib/crypto';

// ── How a deployment proves who it is ───────────────────────────────────────
//
// HMAC request signing, modelled on the two signature paths this codebase
// already runs (src/lib/telephony-signature.ts and the outbound webhook
// signature in src/lib/webhooks.ts). Four headers:
//
//   X-Vaani-Deployment  dep_acme
//   X-Vaani-Timestamp   unix seconds
//   X-Vaani-Nonce       random, once
//   X-Vaani-Signature   v1=<hex HMAC-SHA256 over ts.nonce.METHOD.path.sha256(body)>
//
// Three things make it hold up:
//
//   1. THE BODY IS IN THE SIGNATURE, by its hash. Signing only the metadata
//      would let anything on the path rewrite the telemetry while the signature
//      still verified.
//   2. THE NONCE INSERT IS THE REPLAY CHECK. A second request carrying the same
//      nonce loses to the unique constraint — P2002 is "seen before", the same
//      arbitration PaymentApplication and UsageEvent already rely on. A
//      read-then-write would let two concurrent replays both pass.
//   3. EVERY LIVE KEY IS TRIED, in a timing-safe loop. That is what makes
//      rotation possible without a flag day: issue the new key, both verify,
//      then revoke the old.
//
// ⚠ WHAT THIS IS NOT. On a dedicated install the key sits in a file on a box
// the client's own ops team has root on. This is an IDENTITY mechanism, not a
// secrecy one. It is why no billing-affecting write is ever accepted over this
// channel, whatever it is signed with.
//
// mTLS was considered and rejected: Caddy terminates TLS and would have to pass
// a fingerprint through a header anyway, and the private key would sit on the
// same rooted box — a CA to run and rotate, for no more secrecy than this.

export const DEPLOY_HEADERS = {
  deployment: 'x-vaani-deployment',
  timestamp: 'x-vaani-timestamp',
  nonce: 'x-vaani-nonce',
  signature: 'x-vaani-signature',
} as const;

/** How far a request's clock may be from ours. Beyond it, the signature is stale. */
export const MAX_SKEW_SEC = 300;

export function generateDeploymentKey(): string {
  return 'dpk_' + crypto.randomBytes(32).toString('hex');
}

export function newNonce(): string {
  return crypto.randomBytes(18).toString('hex');
}

function sha256Hex(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * The exact bytes both sides sign.
 *
 * `path` is the pathname only — no host, no query. A proxy that rewrites the
 * host (Caddy does) must not invalidate a signature, and a query string on
 * these routes carries nothing the body does not.
 */
export function deploySigningString(parts: {
  timestamp: number | string;
  nonce: string;
  method: string;
  path: string;
  body: string;
}): string {
  return [
    String(parts.timestamp),
    parts.nonce,
    parts.method.toUpperCase(),
    parts.path,
    sha256Hex(parts.body ?? ''),
  ].join('.');
}

export function signDeployRequest(
  secret: string,
  parts: Parameters<typeof deploySigningString>[0],
): string {
  const mac = crypto
    .createHmac('sha256', secret)
    .update(deploySigningString(parts), 'utf8')
    .digest('hex');
  return `v1=${mac}`;
}

function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type DeployAuth = {
  deployment: {
    id: string;
    mode: string;
    orgId: string | null;
    status: string;
    entitlementRevokedAt: Date | null;
  };
  keyId: string;
};

function refuse(status: number, error: string): NextResponse {
  // Deliberately terse and uniform. A deployment that cannot authenticate gets
  // the same sentence whichever half failed — an unknown id, a revoked key and
  // a bad signature are not distinguished for whoever is probing.
  return NextResponse.json({ error }, { status });
}

/**
 * Authenticate a signed request from a deployment.
 *
 * Returns the deployment, or a ready-to-return NextResponse (check with
 * `instanceof NextResponse`). The caller must pass the RAW body text — the same
 * bytes that were signed. Reading `req.json()` first and re-serialising will
 * not reproduce them.
 */
export async function verifyDeployRequest(
  req: Request,
  rawBody: string,
): Promise<DeployAuth | NextResponse> {
  const id = req.headers.get(DEPLOY_HEADERS.deployment);
  const ts = req.headers.get(DEPLOY_HEADERS.timestamp);
  const nonce = req.headers.get(DEPLOY_HEADERS.nonce);
  const signature = req.headers.get(DEPLOY_HEADERS.signature);
  if (!id || !ts || !nonce || !signature) return refuse(401, 'Unsigned request');

  // Skew first: it is free, and it is what bounds how long a captured request
  // is worth replaying at all.
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return refuse(401, 'Unsigned request');
  const skew = Math.abs(Date.now() / 1000 - seconds);
  if (skew > MAX_SKEW_SEC) return refuse(401, 'Stale request');

  if (nonce.length < 16 || nonce.length > 128) return refuse(401, 'Unsigned request');

  const deployment = await prisma.deployment.findUnique({
    where: { id },
    select: {
      id: true,
      mode: true,
      orgId: true,
      status: true,
      entitlementRevokedAt: true,
      keys: {
        where: { revokedAt: null },
        select: { id: true, secretEnc: true },
      },
    },
  });
  if (!deployment || deployment.status === 'RETIRED') return refuse(401, 'Unknown deployment');

  const url = new URL(req.url);
  const parts = {
    timestamp: ts,
    nonce,
    method: req.method,
    path: url.pathname,
    body: rawBody,
  };

  let keyId: string | null = null;
  for (const key of deployment.keys) {
    let secret: string;
    try {
      secret = decryptSecret(key.secretEnc);
    } catch {
      // A key we cannot decrypt is a key this box cannot verify — usually a
      // SECRET_ENC_KEY that does not match the one it was written with. Skip
      // it rather than failing the whole request: another key may be live.
      continue;
    }
    if (signaturesMatch(signDeployRequest(secret, parts), signature)) {
      keyId = key.id;
      break;
    }
  }
  if (!keyId) return refuse(401, 'Bad signature');

  // Replay: the insert IS the check.
  try {
    await prisma.deploymentNonce.create({
      data: {
        deploymentId: deployment.id,
        nonce,
        expiresAt: new Date(Date.now() + MAX_SKEW_SEC * 2 * 1000),
      },
    });
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return refuse(401, 'Replayed request');
    }
    throw err;
  }

  // A suspended deployment authenticates — we want its heartbeat, and we want
  // to be able to tell it it is suspended — but every route decides for itself
  // what a suspended install may do.
  await prisma.deploymentKey
    .update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    deployment: {
      id: deployment.id,
      mode: deployment.mode,
      orgId: deployment.orgId,
      status: deployment.status,
      entitlementRevokedAt: deployment.entitlementRevokedAt,
    },
    keyId,
  };
}

/**
 * Sign an outbound request as a deployment. Used by the install itself (and by
 * the shared cloud's self-heartbeat), so that exactly one implementation of the
 * signing string exists on both sides of the channel.
 */
export function deployAuthHeaders(args: {
  deploymentId: string;
  secret: string;
  method: string;
  path: string;
  body: string;
}): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = newNonce();
  const parts = {
    timestamp,
    nonce,
    method: args.method,
    path: args.path,
    body: args.body,
  };
  return {
    [DEPLOY_HEADERS.deployment]: args.deploymentId,
    [DEPLOY_HEADERS.timestamp]: String(timestamp),
    [DEPLOY_HEADERS.nonce]: nonce,
    [DEPLOY_HEADERS.signature]: signDeployRequest(args.secret, parts),
  };
}

// ── Entitlement ─────────────────────────────────────────────────────────────
//
// A short-lived signed statement that this deployment is currently entitled to
// place calls. The install refuses to dial without a live one.
//
// ⚠ READ THIS BEFORE RELYING ON IT. A client with root on the box can patch the
// check out, and nothing here prevents that. Its value is evidentiary: with it,
// calls placed after an entitlement lapses are a provable breach of the
// agreement rather than a billing argument. Designed as evidence, not as a
// security control, and it should never be described internally as one.

export const ENTITLEMENT_TTL_SEC = 3600;

export type EntitlementClaims = {
  deploymentId: string;
  orgId: string | null;
  /** Unix seconds. */
  issuedAt: number;
  expiresAt: number;
};

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/**
 * Mint a token for a deployment, signed with the key that authenticated it, so
 * the install can verify it offline with the secret it already holds.
 */
export function mintEntitlement(
  secret: string,
  claims: EntitlementClaims,
): { token: string; expiresAt: number } {
  const payload = b64url(JSON.stringify(claims));
  const mac = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return { token: `${payload}.${mac}`, expiresAt: claims.expiresAt };
}

/** Verify and decode a token. Null when the signature is wrong or it has expired. */
export function readEntitlement(
  secret: string,
  token: string,
  now: Date = new Date(),
): EntitlementClaims | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  if (!signaturesMatch(expected, mac)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as EntitlementClaims;
    if (!claims?.expiresAt || claims.expiresAt * 1000 <= now.getTime()) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Issue a deployment its first key, or another one alongside the existing ones.
 *
 * Returns the plaintext ONCE. It is encrypted at rest (not hashed) because an
 * HMAC has to be recomputed on our side — and so the only moment it can be
 * handed over is now.
 */
export async function issueDeploymentKey(args: {
  deploymentId: string;
  label: string;
}): Promise<{ id: string; secret: string }> {
  const secret = generateDeploymentKey();
  const row = await prisma.deploymentKey.create({
    data: {
      deploymentId: args.deploymentId,
      label: args.label,
      secretEnc: encryptSecret(secret),
    },
    select: { id: true },
  });
  return { id: row.id, secret };
}

/**
 * The plaintext secret behind a key id.
 *
 * Only the entitlement route needs it — a token has to be signed with the key
 * the install already holds, or the install cannot verify it offline. Kept as a
 * narrow named function rather than returned from `verifyDeployRequest`, so
 * that the number of places holding a deployment secret stays countable.
 */
export async function deploymentKeySecret(keyId: string): Promise<string | null> {
  const key = await prisma.deploymentKey.findUnique({
    where: { id: keyId },
    select: { secretEnc: true },
  });
  if (!key) return null;
  try {
    return decryptSecret(key.secretEnc);
  } catch {
    return null;
  }
}

/**
 * Drop nonces past their window.
 *
 * Safe at any time and by anyone: a nonce older than the skew window cannot be
 * replayed, because the timestamp check rejects the request before the nonce is
 * ever consulted.
 */
export async function pruneDeploymentNonces(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.deploymentNonce.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
