import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// ── Which install is this? ──────────────────────────────────────────────────
//
// The same image runs in two places: our shared cloud, and a client's own. The
// difference is not a build flag — it is environment, read at RUNTIME. That
// matters more than it looks: the client install is a Docker image built once
// in CI, and anything resolved at build time would be baked in as `shared` and
// silently stay that way on every client box. So these are functions, not
// constants, and nothing here may be inlined at build time.
//
//   DEPLOYMENT_MODE      shared | dedicated   (default: shared)
//   DEPLOYMENT_ID        the Deployment row's id, e.g. dep_acme
//   DEPLOYMENT_ORG_ID    the single org a dedicated install serves
//   DEPLOYMENT_KEY       the signing secret, plaintext, on the client's box
//   CONTROL_PLANE_URL    where the install polls us

export type DeploymentMode = 'shared' | 'dedicated';

export function deploymentMode(): DeploymentMode {
  return (process.env.DEPLOYMENT_MODE ?? '').trim().toLowerCase() === 'dedicated'
    ? 'dedicated'
    : 'shared';
}

export function isDedicated(): boolean {
  return deploymentMode() === 'dedicated';
}

export function deploymentId(): string | null {
  const raw = (process.env.DEPLOYMENT_ID ?? '').trim();
  return raw === '' ? null : raw;
}

/** The one organisation a dedicated install is allowed to serve. */
export function dedicatedOrgId(): string | null {
  if (!isDedicated()) return null;
  const raw = (process.env.DEPLOYMENT_ORG_ID ?? '').trim();
  return raw === '' ? null : raw;
}

export function controlPlaneUrl(): string | null {
  const raw = (process.env.CONTROL_PLANE_URL ?? '').trim();
  return raw === '' ? null : raw.replace(/\/+$/, '');
}

/**
 * Refuse the request unless this is the shared cloud.
 *
 * **404, not 403.** A dedicated install must not advertise that an admin
 * surface exists at all — a 403 tells whoever is probing that there is
 * something there and that the only missing piece is credentials. The shape is
 * "returns a response or null" so a route can make it the first line:
 *
 *     const blocked = requireSharedDeployment();
 *     if (blocked) return blocked;
 *
 * Deliberately NOT implemented in middleware, though one rule there would cover
 * every route at once: middleware runs on the Edge runtime, where env values
 * are fixed when the image is BUILT. A client image built with the default
 * would carry `shared` into every dedicated box and the guard would quietly do
 * nothing. Read at runtime, in the Node runtime, per route.
 */
export function requireSharedDeployment(): NextResponse | null {
  if (!isDedicated()) return null;
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

/**
 * Refuse to serve if a dedicated install is pointed at a database holding more
 * than its own organisation.
 *
 * The failure this prevents is not hypothetical: a client's box restored from
 * the wrong dump, or an install pointed at a staging URL, would serve another
 * clinic's patients to whoever holds root on it. Single-tenant is the promise
 * that mode is sold on, so it is asserted rather than assumed.
 *
 * Returns a reason when the database is wrong, null when it is fine. Callers
 * decide whether to refuse to boot or to alarm — it never throws on its own,
 * because a transient DB error must not be indistinguishable from a real
 * tenancy violation.
 */
export async function assertSingleTenantDatabase(): Promise<string | null> {
  if (!isDedicated()) return null;
  const orgId = dedicatedOrgId();
  if (!orgId) return 'DEPLOYMENT_MODE=dedicated but DEPLOYMENT_ORG_ID is not set';

  const orgs = await prisma.organization.findMany({ select: { id: true }, take: 2 });
  if (orgs.length === 0) return `no organisation in this database (expected ${orgId})`;
  if (orgs.length > 1) return 'this database holds more than one organisation';
  if (orgs[0].id !== orgId) {
    return `this database holds ${orgs[0].id}, not the configured ${orgId}`;
  }
  return null;
}

/**
 * What a dedicated install must never be given, in one list, so the compose
 * template and the install checklist cannot drift apart.
 *
 * ⚠ The most dangerous credential is NOT in this list, because it is not an env
 * var: the platform-level OmniDimension reseller key lives encrypted in
 * `PlatformConfig` (`omnidimension_api_key`), set from /admin, exactly like the
 * Cashfree credentials. A dedicated install must not carry those ROWS either —
 * that key can move credits between every client's sub-account, so one client
 * with root on their own box would be able to read every other client's
 * minutes. A dedicated box gets at most its own sub-account key.
 */
export const FORBIDDEN_IN_DEDICATED = [
  'SUPERADMIN_EMAILS',
  'OVERAGE_CRON_SECRET',
  'RETENTION_CRON_SECRET',
  'RECONCILE_CRON_SECRET',
] as const;

/**
 * The PlatformConfig keys a dedicated install must not hold. Checked by the
 * install's own preflight rather than by us: it is their database.
 */
export const FORBIDDEN_CONFIG_KEYS_IN_DEDICATED = [
  'omnidimension_api_key',
  'cashfree_app_id',
  'cashfree_secret_key',
] as const;

/** Which of the above are set here. Non-empty on a dedicated box is a misconfiguration. */
export function forbiddenSecretsPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isDedicated()) return [];
  return FORBIDDEN_IN_DEDICATED.filter((k) => (env[k] ?? '').trim() !== '');
}
