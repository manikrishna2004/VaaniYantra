/**
 * Say hello to the control plane, and fetch this deployment's entitlement.
 *
 *   npx tsx scripts/deployment-heartbeat.ts
 *   npx tsx scripts/deployment-heartbeat.ts --version=2026.09.03+4ab3175
 *
 * Reads DEPLOYMENT_ID, DEPLOYMENT_KEY and CONTROL_PLANE_URL from the
 * environment (or the app's .env). On the shared cloud, CONTROL_PLANE_URL is
 * our own public URL — it heartbeats to itself, which is exactly the point:
 * the signing, the replay check and the entitlement path all run in production
 * against a real deployment before any client depends on them.
 *
 * The channel is outbound-only by design. Nothing ever dials INTO a deployment,
 * so no client has to open a firewall for us, and we never become a route into
 * their network. This script is the whole client side of it.
 *
 * Exits non-zero when the control plane refuses, so cron mails the failure.
 */
import 'dotenv/config';
import { deployAuthHeaders, readEntitlement } from '../src/lib/deploy/deploy-auth';

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

async function signedFetch(args: {
  base: string;
  id: string;
  secret: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}) {
  const body = args.body === undefined ? '' : JSON.stringify(args.body);
  const headers = deployAuthHeaders({
    deploymentId: args.id,
    secret: args.secret,
    method: args.method,
    path: args.path,
    body,
  });
  const res = await fetch(`${args.base}${args.path}`, {
    method: args.method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a proxy error page, not our JSON — the raw text is the diagnosis */
  }
  return { status: res.status, json, text };
}

async function main() {
  const id = (process.env.DEPLOYMENT_ID ?? '').trim();
  const secret = (process.env.DEPLOYMENT_KEY ?? '').trim();
  const base = (process.env.CONTROL_PLANE_URL ?? '').trim().replace(/\/+$/, '');
  if (!id || !secret || !base) {
    console.error('✖ DEPLOYMENT_ID, DEPLOYMENT_KEY and CONTROL_PLANE_URL must all be set');
    process.exit(2);
  }

  const version = arg('version') ?? process.env.DEPLOYMENT_VERSION ?? null;

  const beat = await signedFetch({
    base,
    id,
    secret,
    method: 'POST',
    path: '/api/deploy/v1/heartbeat',
    body: { version },
  });
  if (beat.status !== 200) {
    console.error(`✖ heartbeat ${beat.status}: ${beat.text.slice(0, 300)}`);
    process.exit(1);
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(beat.json?.serverTime ?? 0));
  console.log(
    `[deployment] ${id} heartbeat ok — status ${beat.json?.status}, entitled ${beat.json?.entitled}, clock skew ${skew}s`,
  );
  // Signing fails outright at 300s of skew, and "your clock drifted" is a far
  // better thing to read at 200s than a wall of 401s at 301.
  if (skew > 120) console.error(`⚠ clock skew is ${skew}s — signatures are refused past 300s`);

  const ent = await signedFetch({ base, id, secret, method: 'GET', path: '/api/deploy/v1/entitlement' });
  if (ent.status !== 200) {
    console.error(`✖ entitlement ${ent.status}: ${ent.text.slice(0, 300)}`);
    process.exit(1);
  }
  const claims = readEntitlement(secret, String(ent.json?.token ?? ''));
  if (!claims) {
    console.error('✖ entitlement token did not verify against this deployment key');
    process.exit(1);
  }
  const mins = Math.round((claims.expiresAt * 1000 - Date.now()) / 60000);
  console.log(`[deployment] entitled for ${mins} more minutes (org ${claims.orgId ?? '—'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
