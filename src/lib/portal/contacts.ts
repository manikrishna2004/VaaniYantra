import crypto from 'crypto';
import type { Contact, Portal } from '@prisma/client';
import { prisma } from '@/lib/db';
import { toE164 } from '@/lib/phone';
import { allocateUhid } from '@/lib/patients/uhid';
import { PRIMARY_KEY } from '@/lib/patients/household';

// Contacts (clinic patients) and their access to the clinic's chatbot.
//
// SECURITY MODEL — read this before changing anything here.
//
// A patient signs in with their phone number and a one-time code sent to it
// (src/lib/portal/otp.ts). They reach their own records only by proving control
// of the number the clinic already holds for them.
//
// This replaced a bearer token carried in the link itself, where whoever opened
// the link was treated as that patient. It was chosen for zero friction, and
// the cost was that forwarding an appointment SMS forwarded the patient's
// medical history — to a family member, a WhatsApp group, or anyone the phone
// was handed to. A code is a few seconds of friction against a real exposure.
//
// What holds the current model up:
//   • the session cookie is 32 random bytes and only its SHA-256 is stored, so
//     a database dump cannot impersonate a patient;
//   • sessions are bound to one portal and one tenant, expire, and slide;
//   • staff can block a patient's access, which also kills live sessions;
//   • every document download is written to the audit log.

const TOKEN_BYTES = 32;

/**
 * A random token for Contact.portalToken.
 *
 * That column is dead — nothing authenticates with it any more — but it is
 * NOT NULL and @unique, so rows still have to be created with a value. Kept
 * rather than dropped because dropping it is a destructive migration on live
 * patient data.
 */
export function issuePortalToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Where the portal is reachable from the public internet. */
export function portalBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
}

/**
 * The clinic's chatbot address: /c/<portal-slug>.
 *
 * No secret in it any more. It is safe to print on a card, put on a website, or
 * forward — opening it asks for a phone number and a code. The second argument
 * is ignored and kept only so existing call sites read unchanged.
 */
export function portalLink(portalSlug: string, _token?: string): string {
  return `${portalBaseUrl().replace(/\/+$/, '')}/c/${portalSlug}`;
}

/**
 * Find or create the contact for a phone number within a tenant, so repeat
 * visits accumulate one history instead of a row per booking. An existing
 * contact keeps its token (the patient's old links must not break) and only
 * fills in details it was missing.
 *
 * A patient without a UHID gets one here — whether they are new, or an existing
 * record from before patient numbering existed. Numbers are only drawn from the
 * counter when one is actually needed, so a clinic's repeat bookings don't burn
 * through the sequence.
 */
export async function upsertContact(input: {
  orgId: string;
  workspaceId: string;
  name: string;
  phone: string;
  email?: string | null;
  dateOfBirth?: Date | null;
  sex?: string | null;
}): Promise<Contact | null> {
  const phone = toE164(input.phone);
  // No number means no way to reach them and no stable identity — the caller
  // decides whether that is worth surfacing; here it is simply not a contact.
  if (!phone) return null;

  const name = input.name.trim().slice(0, 120) || 'Patient';
  // Always the household PRIMARY. Nothing spoken on a phone call may mint a
  // patient: a wrongly-attached appointment is a front-desk correction, while a
  // wrongly-attached allergy list is not recoverable and a duplicate patient
  // record is permanent sprawl. Dependents are only ever created deliberately,
  // by staff or by the clinic's own system.
  const where = {
    orgId_phone_dependentKey: { orgId: input.orgId, phone, dependentKey: PRIMARY_KEY },
  };
  const existing = await prisma.contact.findUnique({ where, select: { uhid: true } });
  const uhid = existing?.uhid ?? (await allocateUhid(input.orgId));

  return prisma.contact.upsert({
    where,
    create: {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      name,
      phone,
      email: input.email?.trim() || null,
      dateOfBirth: input.dateOfBirth ?? null,
      sex: input.sex ?? null,
      portalToken: issuePortalToken(),
      uhid,
    },
    update: {
      // Don't overwrite a name staff may have corrected with whatever the
      // agent heard on the phone this time; only fill genuine blanks.
      ...(input.email ? { email: input.email.trim() } : {}),
      // Demographics are written when supplied and left alone when not. Safe
      // because the only callers that pass them are the ones where a human
      // typed them in — the voice booking path (ensureContact) never does, so
      // nothing heard on a call can overwrite a staff-entered date of birth.
      ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
      ...(input.sex ? { sex: input.sex } : {}),
      workspaceId: input.workspaceId,
      // Fills in a patient who predates numbering; a no-op for everyone else.
      ...(existing?.uhid ? {} : { uhid }),
    },
  });
}

/**
 * Block a patient's portal access, and end any session they already have.
 *
 * This is the lost-phone / disputed-record control. It replaced rotating a
 * bearer token, and is strictly better: there is no new secret to deliver, and
 * an open browser session is cut off rather than remaining valid until the
 * cookie happens to expire. Reversible — see restorePortalAccess.
 */
export async function revokePortalAccess(contactId: string): Promise<void> {
  await prisma.$transaction([
    prisma.contact.update({ where: { id: contactId }, data: { portalRevokedAt: new Date() } }),
    prisma.portalLogin.updateMany({ where: { contactId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

/** Let a patient sign in again. Their next code works; old sessions stay dead. */
export async function restorePortalAccess(contactId: string): Promise<void> {
  await prisma.contact.update({ where: { id: contactId }, data: { portalRevokedAt: null } });
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * How long a verified patient stays signed in, sliding.
 *
 * Much shorter than the 180 days the old bearer-link model used. That number
 * existed because the alternative was re-sending a link every time; with a code
 * a patient can sign in again in seconds, and a session over medical records
 * should not outlive a handset.
 */
export const PORTAL_LOGIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Renew only when this close to expiry, so it isn't a write per request. */
const RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

function hashLoginToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Start a session for a verified patient. Returns the raw cookie value, which
 * is never stored — only its hash — so a database dump cannot impersonate them.
 */
export async function createPortalLogin(args: {
  portalId: string;
  contactId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<string> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  await prisma.portalLogin.create({
    data: {
      tokenHash: hashLoginToken(token),
      portalId: args.portalId,
      contactId: args.contactId,
      expiresAt: new Date(Date.now() + PORTAL_LOGIN_TTL_MS),
      ip: args.ip ?? null,
      userAgent: args.userAgent?.slice(0, 300) ?? null,
    },
  });
  return token;
}

/** End one session (sign out on this device). */
export async function revokePortalLogin(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await prisma.portalLogin
    .updateMany({ where: { tokenHash: hashLoginToken(token), revokedAt: null }, data: { revokedAt: new Date() } })
    .catch(() => {});
}

export type PortalSession = { portal: Portal; contact: Contact };

/**
 * Resolve a session cookie against a portal slug.
 *
 * Signature and return type are unchanged from the bearer-token era on purpose:
 * /me, the chat endpoint, the document downloads and portal/tools.ts all depend
 * on this shape, and none of them should have to know how the patient proved
 * who they are.
 *
 * Returns null for anything that doesn't line up — unknown slug, disabled
 * portal, unknown/expired/revoked session, a patient whose access was blocked,
 * or a session belonging to a different portal or tenant. The last of those is
 * what stops one clinic's cookie from opening another clinic's chatbot.
 */
export async function resolvePortalSession(
  slug: string,
  token: string | null | undefined,
): Promise<PortalSession | null> {
  if (!token) return null;

  const [portal, login] = await Promise.all([
    prisma.portal.findUnique({ where: { slug } }),
    prisma.portalLogin.findUnique({
      where: { tokenHash: hashLoginToken(token) },
      include: { contact: true },
    }),
  ]);

  if (!portal || !portal.enabled) return null;
  if (!login || login.revokedAt || login.expiresAt <= new Date()) return null;
  // The session was issued for THIS portal, and the patient belongs to the same
  // tenant. Both are checked: a clinic could delete a portal and another could
  // later take the slug.
  if (login.portalId !== portal.id) return null;
  if (!login.contact || login.contact.portalRevokedAt) return null;
  if (login.contact.orgId !== portal.orgId) return null;

  // Sliding expiry, written only when it is nearly up.
  if (login.expiresAt.getTime() - Date.now() < RENEW_WITHIN_MS) {
    void prisma.portalLogin
      .update({
        where: { id: login.id },
        data: { expiresAt: new Date(Date.now() + PORTAL_LOGIN_TTL_MS), lastSeenAt: new Date() },
      })
      .catch(() => {});
  }

  return { portal, contact: login.contact };
}

/** Delete expired and revoked sessions. Called by the retention sweeper. */
export async function purgeExpiredLogins(now: Date = new Date()): Promise<number> {
  const res = await prisma.portalLogin.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
  });
  return res.count;
}

/** Note that a contact used their portal (shown to staff as "last seen"). */
export async function touchContact(contactId: string): Promise<void> {
  await prisma.contact
    .update({ where: { id: contactId }, data: { lastSeenAt: new Date() } })
    .catch(() => {});
}
