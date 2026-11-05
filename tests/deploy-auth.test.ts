import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, sep } from 'path';

// Phase 7 — the channel a deployment speaks to us over, proved against our own
// cloud before any client has one. What these tests hold:
//
//   • the BODY is inside the signature, so nothing on the path can rewrite
//     telemetry and still verify;
//   • a replayed request loses to the nonce's unique constraint, not to a
//     read-then-write two concurrent replays could both win;
//   • two live keys verify at once, which is the only way to rotate a key on a
//     box we cannot log into without an outage;
//   • a client-cloud install can never write a billable minute, whatever it
//     signs — its telemetry lands under a metric the biller does not read;
//   • a dedicated install answers 404 on every admin route.

const store = vi.hoisted(() => ({
  deployment: null as any,
  nonces: new Set<string>(),
  orgs: [] as any[],
}));

const db = vi.hoisted(() => ({
  deployment: {
    findUnique: vi.fn(async () => store.deployment),
    update: vi.fn(async () => ({})),
  },
  deploymentKey: {
    update: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => ({ secretEnc: 'enc:dpk_first' })),
  },
  deploymentNonce: {
    create: vi.fn(async ({ data }: any) => {
      const key = `${data.deploymentId}:${data.nonce}`;
      if (store.nonces.has(key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      store.nonces.add(key);
      return { id: 'n1', ...data };
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  organization: { findMany: vi.fn(async () => store.orgs) },
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
// The real thing needs SECRET_ENC_KEY and an AES round trip; neither is what
// these tests are about. Encryption itself is covered by tests/crypto.test.ts.
vi.mock('@/lib/crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => {
    if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
    return s.slice(4);
  },
}));
const recordUsage = vi.hoisted(() => vi.fn(async () => ({ recorded: true, billingMonth: '2026-09' })));
vi.mock('@/lib/usage/ledger', () => ({ recordUsage, BILLABLE_METRIC: 'voice.minutes' }));

import {
  deploySigningString,
  signDeployRequest,
  deployAuthHeaders,
  verifyDeployRequest,
  mintEntitlement,
  readEntitlement,
  MAX_SKEW_SEC,
} from '@/lib/deploy/deploy-auth';
import {
  requireSharedDeployment,
  assertSingleTenantDatabase,
  forbiddenSecretsPresent,
  deploymentMode,
  dedicatedOrgId,
} from '@/lib/deploy/deployment';
import { POST as telemetryPOST } from '@/app/api/deploy/v1/telemetry/route';

/** First argument of the nth call to a mock, untyped on purpose. */
const argOf = (fn: unknown, n = 0): any => (fn as { mock: { calls: any[][] } }).mock.calls.at(n)![0];

const FIRST = 'dpk_first';
const SECOND = 'dpk_second';

function deployment(over: Record<string, unknown> = {}) {
  return {
    id: 'dep_acme',
    mode: 'dedicated',
    orgId: 'org_1',
    status: 'ACTIVE',
    entitlementRevokedAt: null,
    keys: [{ id: 'k1', secretEnc: `enc:${FIRST}` }],
    ...over,
  };
}

function signed(args: {
  secret?: string;
  method?: 'GET' | 'POST';
  path?: string;
  body?: string;
  headers?: Record<string, string>;
}) {
  const method = args.method ?? 'POST';
  const path = args.path ?? '/api/deploy/v1/telemetry';
  const body = args.body ?? '';
  const headers = {
    ...deployAuthHeaders({
      deploymentId: 'dep_acme',
      secret: args.secret ?? FIRST,
      method,
      path,
      body,
    }),
    ...(args.headers ?? {}),
  };
  return new Request(`http://test${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.deployment = deployment();
  store.nonces = new Set();
  store.orgs = [];
  delete process.env.DEPLOYMENT_MODE;
  delete process.env.DEPLOYMENT_ORG_ID;
});

describe('the signing string', () => {
  it('binds the body by hash, not by trust', () => {
    const base = { timestamp: 1, nonce: 'n', method: 'POST', path: '/x' };
    const a = deploySigningString({ ...base, body: '{"seconds":60}' });
    const b = deploySigningString({ ...base, body: '{"seconds":6000}' });
    expect(a).not.toBe(b);
    // The body appears only as a digest — a 4 MB payload does not become a
    // 4 MB HMAC input.
    expect(a).toMatch(/^1\.n\.POST\.\/x\.[0-9a-f]{64}$/);
  });

  it('is stable across identical inputs and versioned in the header', () => {
    const parts = { timestamp: 7, nonce: 'abc', method: 'get', path: '/y', body: '' };
    expect(signDeployRequest('s', parts)).toBe(signDeployRequest('s', { ...parts, method: 'GET' }));
    expect(signDeployRequest('s', parts).startsWith('v1=')).toBe(true);
  });
});

describe('verifyDeployRequest', () => {
  it('accepts a correctly signed request', async () => {
    const res = await verifyDeployRequest(signed({ body: '{}' }), '{}');
    expect(res).toMatchObject({ keyId: 'k1', deployment: { id: 'dep_acme' } });
  });

  it('rejects a body swapped after signing', async () => {
    const req = signed({ body: '{"seconds":60}' });
    const res: any = await verifyDeployRequest(req, '{"seconds":600000}');
    expect(res.status).toBe(401);
  });

  it('rejects a request signed with the wrong key', async () => {
    const res: any = await verifyDeployRequest(signed({ secret: 'dpk_wrong', body: '{}' }), '{}');
    expect(res.status).toBe(401);
  });

  it('rejects one whose clock is outside the skew window', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - MAX_SKEW_SEC - 5);
    const req = signed({ body: '{}', headers: { 'x-vaani-timestamp': stale } });
    const res: any = await verifyDeployRequest(req, '{}');
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned request', async () => {
    const bare = new Request('http://test/api/deploy/v1/config', { method: 'GET' });
    const res: any = await verifyDeployRequest(bare, '');
    expect(res.status).toBe(401);
  });

  it('rejects a retired deployment', async () => {
    store.deployment = deployment({ status: 'RETIRED' });
    const res: any = await verifyDeployRequest(signed({ body: '{}' }), '{}');
    expect(res.status).toBe(401);
  });

  it('rejects a replay — the nonce insert is the check', async () => {
    const req = signed({ body: '{}' });
    const first = await verifyDeployRequest(req.clone(), '{}');
    expect(first).toMatchObject({ keyId: 'k1' });
    // Byte for byte the same request, captured and sent again.
    const second: any = await verifyDeployRequest(req, '{}');
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: 'Replayed request' });
  });

  it('asks the database only for keys that are not revoked', async () => {
    await verifyDeployRequest(signed({ body: '{}' }), '{}');
    const select = argOf(db.deployment.findUnique).select;
    expect(select.keys.where).toEqual({ revokedAt: null });
  });

  it('verifies against EITHER live key, so rotation is not an outage', async () => {
    store.deployment = deployment({
      keys: [
        { id: 'k1', secretEnc: `enc:${FIRST}` },
        { id: 'k2', secretEnc: `enc:${SECOND}` },
      ],
    });
    expect(await verifyDeployRequest(signed({ secret: FIRST, body: '{}' }), '{}')).toMatchObject({ keyId: 'k1' });
    expect(await verifyDeployRequest(signed({ secret: SECOND, body: '{}' }), '{}')).toMatchObject({ keyId: 'k2' });
  });

  it('skips a key it cannot decrypt instead of failing the request', async () => {
    // A key written under a different SECRET_ENC_KEY. Another key is live and
    // the request is signed with that one.
    store.deployment = deployment({
      keys: [
        { id: 'k0', secretEnc: 'garbage' },
        { id: 'k1', secretEnc: `enc:${FIRST}` },
      ],
    });
    expect(await verifyDeployRequest(signed({ body: '{}' }), '{}')).toMatchObject({ keyId: 'k1' });
  });
});

describe('the entitlement token', () => {
  const claims = {
    deploymentId: 'dep_acme',
    orgId: 'org_1',
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  it('round-trips against the key that signed it', () => {
    const { token } = mintEntitlement(FIRST, claims);
    expect(readEntitlement(FIRST, token)).toMatchObject({ deploymentId: 'dep_acme', orgId: 'org_1' });
  });

  it('does not verify against a different key', () => {
    const { token } = mintEntitlement(FIRST, claims);
    expect(readEntitlement(SECOND, token)).toBeNull();
  });

  it('is refused once it expires — that is the whole mechanism', () => {
    const { token } = mintEntitlement(FIRST, { ...claims, expiresAt: claims.issuedAt + 60 });
    const later = new Date(Date.now() + 61 * 1000);
    expect(readEntitlement(FIRST, token, later)).toBeNull();
  });

  it('rejects a payload edited to extend itself', () => {
    const { token } = mintEntitlement(FIRST, claims);
    const [, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims, expiresAt: claims.expiresAt + 86400 }),
      'utf8',
    ).toString('base64url');
    expect(readEntitlement(FIRST, `${forged}.${mac}`)).toBeNull();
  });
});

describe('POST /api/deploy/v1/telemetry — the untrusted reporter', () => {
  const body = JSON.stringify({
    events: [{ externalId: 'call-1', seconds: 125, occurredAt: '2026-09-01T10:00:00Z' }],
  });

  it('writes a metric billing does not sum', async () => {
    const res = await telemetryPOST(signed({ path: '/api/deploy/v1/telemetry', body }));
    expect(res.status).toBe(200);
    const arg = argOf(recordUsage);
    // THE crux of client-cloud mode. Not a flag on the row — a different name.
    expect(arg.metric).toBe('voice.minutes.reported');
    expect(arg.metric).not.toBe('voice.minutes');
    expect(arg.source).toBe('client_cloud');
    expect(arg.quantity).toBe(125);
  });

  it('takes the org from the authenticated deployment, never from the body', async () => {
    const hostile = JSON.stringify({
      events: [
        {
          externalId: 'call-2',
          seconds: 60,
          occurredAt: '2026-09-01T10:00:00Z',
          orgId: 'org_someone_else',
          metric: 'voice.minutes',
          source: 'omnidimension',
        },
      ],
    });
    await telemetryPOST(signed({ path: '/api/deploy/v1/telemetry', body: hostile }));
    const arg = argOf(recordUsage);
    expect(arg.orgId).toBe('org_1');
    expect(arg.metric).toBe('voice.minutes.reported');
    expect(arg.source).toBe('client_cloud');
  });

  it('namespaces the external id by deployment, so two installs cannot collide', async () => {
    await telemetryPOST(signed({ path: '/api/deploy/v1/telemetry', body }));
    expect(argOf(recordUsage).externalId).toBe('dep_acme:call-1');
  });

  it('refuses an unsigned caller', async () => {
    const res = await telemetryPOST(
      new Request('http://test/api/deploy/v1/telemetry', { method: 'POST', body }),
    );
    expect(res.status).toBe(401);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('counts a rejected event rather than guessing at it', async () => {
    const junk = JSON.stringify({
      events: [{ externalId: '', seconds: 'lots', occurredAt: 'whenever' }],
    });
    const res = await telemetryPOST(signed({ path: '/api/deploy/v1/telemetry', body: junk }));
    expect(await res.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

describe('single-tenant guardrails', () => {
  it('is the shared cloud unless the environment says otherwise', () => {
    expect(deploymentMode()).toBe('shared');
    expect(requireSharedDeployment()).toBeNull();
    expect(dedicatedOrgId()).toBeNull();
  });

  it('answers 404, not 403, on a dedicated install', async () => {
    process.env.DEPLOYMENT_MODE = 'dedicated';
    const res = requireSharedDeployment();
    expect(res?.status).toBe(404);
    // Nothing in the body hints that an admin surface exists here.
    expect(await res!.json()).toEqual({ error: 'Not found' });
  });

  it('refuses a database holding more than its own organisation', async () => {
    process.env.DEPLOYMENT_MODE = 'dedicated';
    process.env.DEPLOYMENT_ORG_ID = 'org_1';
    store.orgs = [{ id: 'org_1' }, { id: 'org_2' }];
    expect(await assertSingleTenantDatabase()).toMatch(/more than one organisation/);
  });

  it('refuses a database holding somebody else', async () => {
    process.env.DEPLOYMENT_MODE = 'dedicated';
    process.env.DEPLOYMENT_ORG_ID = 'org_1';
    store.orgs = [{ id: 'org_2' }];
    expect(await assertSingleTenantDatabase()).toMatch(/not the configured org_1/);
  });

  it('passes on the right database, and never runs on the shared cloud', async () => {
    process.env.DEPLOYMENT_MODE = 'dedicated';
    process.env.DEPLOYMENT_ORG_ID = 'org_1';
    store.orgs = [{ id: 'org_1' }];
    expect(await assertSingleTenantDatabase()).toBeNull();

    delete process.env.DEPLOYMENT_MODE;
    store.orgs = [{ id: 'org_1' }, { id: 'org_2' }];
    expect(await assertSingleTenantDatabase()).toBeNull();
  });

  it('names the platform secrets a dedicated box must not hold', () => {
    process.env.DEPLOYMENT_MODE = 'dedicated';
    const env = { SUPERADMIN_EMAILS: 'me@example.com' } as unknown as NodeJS.ProcessEnv;
    expect(forbiddenSecretsPresent(env)).toEqual([
      'SUPERADMIN_EMAILS',
    ]);
    expect(forbiddenSecretsPresent({} as unknown as NodeJS.ProcessEnv)).toEqual([]);
  });
});

// ── The guard on the guard ──────────────────────────────────────────────────
//
// requireSharedDeployment() is opt-in per route: an admin route that forgets it
// works perfectly in our cloud and quietly exposes the founder's surface on a
// client's box, where their ops team has root. Nothing about the omission reads
// as wrong in review, so it is enforced here — the same way v1-route-scopes
// enforces that every public route names a scope.
describe('every admin route refuses a dedicated install', () => {
  const ADMIN = join(process.cwd(), 'src', 'app', 'api', 'admin');

  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...routeFiles(full));
      else if (entry === 'route.ts') out.push(full);
    }
    return out;
  }

  const files = routeFiles(ADMIN);
  const rel = (f: string) => f.slice(process.cwd().length + 1).split(sep).join('/');

  it('finds the admin routes at all', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files.map((f) => [rel(f), f]))('%s', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    const handlers = src.match(/^export async function (?:GET|POST|PATCH|PUT|DELETE)\(/gm) ?? [];
    const guards = src.match(/const blocked = requireSharedDeployment\(\);/g) ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    expect(guards.length).toBe(handlers.length);
  });
});
