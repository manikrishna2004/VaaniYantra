import { prisma } from '@/lib/db';
import { getPlatformConfig, setPlatformConfig, isSuperAdmin } from '@/lib/platform';

// ── Platform access gate ────────────────────────────────────────────────────
//
// Sign-up is closed. While `inviteOnly` is on, a Firebase account can still be
// created (Firebase is not ours to gate), but it gets no session and no tenant
// unless the address behind it was let in on purpose. That distinction is the
// whole design: the gate sits in front of createSession/provisionUser, so a
// stranger who signs up ends up with a Firebase shell and nothing else — no
// organisation, no workspace, no row in our database, nothing to clean up.
//
// It deliberately does NOT lock out anyone already using the product. Existing
// members, people holding a live team invitation, and the founder always get
// through, so turning this on is not an outage for paying clinics.
//
// Turning it off again — "later I will allow everyone" — is one toggle in
// /admin (or INVITE_ONLY=off), with no deploy and no data migration.

export const ACCESS_KEYS = {
  inviteOnly: 'access_invite_only',
  allowlist: 'access_allowlist',
} as const;

/** The message a refused visitor sees. Kept here so every route says the same thing. */
export const INVITE_ONLY_MESSAGE =
  'VaaniYantra is invite-only right now. Tell us about your practice on our contact page and we will set you up.';

/**
 * Default when nothing has been saved in the database yet.
 *
 * Closed by default, and only INVITE_ONLY=off opens it. An unset env must not
 * mean "open": the first boot after a deploy is exactly when an unprotected
 * sign-up form would be found.
 */
function envInviteOnly(): boolean {
  return (process.env.INVITE_ONLY ?? 'on').trim().toLowerCase() !== 'off';
}

/** Addresses/domains allowed in without a team invitation, seeded from env. */
function envAllowlist(): string[] {
  return normalizeEntries((process.env.ACCESS_ALLOWLIST || '').split(','));
}

function normalizeEntries(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const entry of raw) {
    const v = entry.trim().toLowerCase();
    // An address, or "@domain.com" for a whole domain. Anything else is noise
    // that would silently never match, so it is dropped at the door.
    if (!v) continue;
    if (v.startsWith('@') ? v.length > 1 && v.includes('.') : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      seen.add(v);
    }
  }
  return [...seen];
}

export async function inviteOnlyEnabled(): Promise<boolean> {
  try {
    const raw = await getPlatformConfig(ACCESS_KEYS.inviteOnly);
    if (raw === 'on') return true;
    if (raw === 'off') return false;
  } catch {
    /* fall through to the env default */
  }
  return envInviteOnly();
}

export async function setInviteOnly(on: boolean): Promise<void> {
  await setPlatformConfig(ACCESS_KEYS.inviteOnly, on ? 'on' : 'off', false);
}

/** The stored allowlist, merged with the env seed. Lower-cased, de-duplicated. */
export async function getAccessAllowlist(): Promise<string[]> {
  let stored: string[] = [];
  try {
    const raw = await getPlatformConfig(ACCESS_KEYS.allowlist);
    if (raw) stored = normalizeEntries(JSON.parse(raw) as string[]);
  } catch {
    /* a corrupt value must not lock the founder out — env still applies */
  }
  return normalizeEntries([...envAllowlist(), ...stored]);
}

/** Replace the stored allowlist. The env seed is never written, only merged. */
export async function setAccessAllowlist(entries: string[]): Promise<string[]> {
  const clean = normalizeEntries(entries);
  await setPlatformConfig(ACCESS_KEYS.allowlist, JSON.stringify(clean), false);
  return clean;
}

/** Whether `email` matches an allowlist entry (exact address, or "@domain"). */
export function allowlistMatches(allowlist: string[], email: string): boolean {
  const addr = email.trim().toLowerCase();
  if (!addr) return false;
  const domain = addr.slice(addr.lastIndexOf('@'));
  return allowlist.some((e) => (e.startsWith('@') ? e === domain : e === addr));
}

export type AccessDecision = { allowed: true; reason: string } | { allowed: false; message: string };

/**
 * May this address hold a session on the platform?
 *
 * Order matters — each branch is a real person who must not be turned away:
 *   1. gate off        — everyone, which is the "later I will allow everyone" switch.
 *   2. founder         — the super-admins, who cannot be locked out of their own console.
 *   3. existing member — anyone already inside an organisation keeps signing in.
 *   4. team invitation — the invite flow, unchanged: an OWNER inviting their staff.
 *   5. allowlist       — an address (or domain) let in from /admin ahead of sign-up.
 *
 * Note (3): membership, not merely "a User row exists". A refused visitor can
 * leave a User row behind from an earlier flow, and matching on that alone
 * would turn the first refusal into a permanent bypass.
 */
export async function checkPlatformAccess(email: string | null | undefined): Promise<AccessDecision> {
  if (!(await inviteOnlyEnabled())) return { allowed: true, reason: 'open' };

  const addr = (email ?? '').trim().toLowerCase();
  if (!addr) return { allowed: false, message: INVITE_ONLY_MESSAGE };

  if (isSuperAdmin(addr)) return { allowed: true, reason: 'superadmin' };

  const member = await prisma.membership.findFirst({
    where: { user: { email: { equals: addr, mode: 'insensitive' } } },
    select: { id: true },
  });
  if (member) return { allowed: true, reason: 'member' };

  const invitation = await prisma.invitation.findFirst({
    where: {
      email: { equals: addr, mode: 'insensitive' },
      status: 'PENDING',
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (invitation) return { allowed: true, reason: 'invitation' };

  if (allowlistMatches(await getAccessAllowlist(), addr)) return { allowed: true, reason: 'allowlist' };

  return { allowed: false, message: INVITE_ONLY_MESSAGE };
}
