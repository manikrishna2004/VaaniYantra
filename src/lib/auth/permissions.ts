// Role-based access control for VaaniYantra.
//
// Roles are stored on Membership.role (mirrored from Clerk org roles). Every
// protected action and nav item checks a Permission against the current user's
// role in the active organization. Keep this file as the single source of truth.

// DOCTOR sits deliberately OUTSIDE the VIEWER..OWNER ladder. The other four are
// a widening staircase of clinic-wide authority; a doctor is not "a bit more
// than a viewer", they are a different shape — near-total control of their own
// calendar and almost no reach beyond it. roleRank below keeps it off the
// ladder for that reason.
export const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'DOCTOR'] as const;
export type Role = (typeof ROLES)[number];

// resource:action — add new permissions here as modules land.
export type Permission =
  | 'agent:read'
  | 'agent:write'
  | 'agent:delete'
  | 'number:read'
  | 'number:write'
  | 'knowledge:read'
  | 'knowledge:write'
  | 'call:read'
  | 'call:write'
  // Patient medical records: demographics, allergies, visit records,
  // prescriptions, uploaded documents and the clinician's private
  // internalNotes. Deliberately NOT folded into call:read — a read-only seat
  // (an auditor, a demo login, a front-desk stand-in) has a good reason to see
  // call history and no reason at all to read a medical record.
  | 'patient:read'
  | 'patient:write'
  // Erasing a patient is not just a stronger write. It destroys the clinical
  // record and cannot be undone, so it sits with ADMIN rather than with the
  // front desk that creates and edits patients all day.
  | 'patient:delete'
  | 'workspace:read'
  | 'workspace:write'
  | 'workspace:delete'
  | 'member:read'
  | 'member:manage'
  | 'apikey:read'
  | 'apikey:manage'
  | 'integration:read'
  | 'integration:manage'
  // Connect or disconnect YOUR OWN Google Calendar. Distinct from
  // integration:manage, which governs the clinic-wide connection and stays with
  // admins: a doctor must be able to attach their own calendar so patients get
  // booked with them, without gaining the ability to re-point the whole
  // clinic's integrations.
  | 'integration:connect_self'
  // Read and manage YOUR OWN calendar: the appointments booked with you, your
  // weekly hours, and your time off. Scoped by doctorScope() in
  // src/lib/auth/tenant.ts — the permission says "may touch a calendar", the
  // scope says "which one", and both are required. Staff and admins reach every
  // doctor's calendar through call:read / call:write instead.
  | 'calendar:read_self'
  | 'calendar:write_self'
  | 'audit:read'
  /**
   * The clinic-wide oversight surfaces: the dashboard, live call monitoring
   * and reports. Held by ADMIN and OWNER only — a front-desk seat works the
   * appointment book, and a doctor works their own calendar; neither needs a
   * view of the whole practice's volume and outcomes.
   */
  | 'insights:read'
  | 'billing:manage'
  | 'org:manage';

// Permissions granted to each role. Higher roles are supersets, but we list
// explicitly rather than inheriting so the grants are auditable at a glance.
const VIEWER: Permission[] = [
  'agent:read',
  'number:read',
  'knowledge:read',
  'call:read',
  'workspace:read',
  'member:read',
];

// Day-to-day work, not setup. `agent:write`/`agent:delete` moved up to ADMIN and
// `number:write` up to OWNER: adding a phone number spends the clinic's money
// with a carrier, and building the agent that answers it is a supervisory act
// rather than a shift task.
const MEMBER: Permission[] = [
  ...VIEWER,
  'knowledge:write',
  'call:write',
  // Clinical staff, i.e. everyone from MEMBER up. See the note on the
  // permission itself for why VIEWER is excluded.
  'patient:read',
  'patient:write',
  // Deliberately not on VIEWER: a read-only account should not be able to
  // attach credentials to the organization.
  'integration:connect_self',
];

// A doctor. Everything about their own calendar, essentially nothing else.
//
// Not built on VIEWER, and that is the point of the role existing at all: the
// closest existing fit was MEMBER, which grants agent:write, agent:delete and
// clinic-wide patient:read/write. A doctor given MEMBER so they could see their
// own schedule could also delete every agent in the clinic and read every
// patient record in it.
//
// NO call:read, and that is the correction that matters most here.
//
// It was granted "because the calendar surface reads Appointment rows", with
// doctorScope() expected to narrow them. It did not: every scoped route decides
// self-vs-clinic with `const staff = hasPermission(role, 'call:read')`, so
// holding it made a doctor STAFF — the scope was skipped entirely and they saw
// every appointment in the clinic, plus the full doctor list. It also quietly
// carried every call transcript, outcome, portal and CSV export with it.
//
// calendar:read_self is what the calendar surface should have keyed on all
// along, and does now. No agent:*, no clinic-wide patient:*, no member:*.
const DOCTOR: Permission[] = [
  'calendar:read_self',
  'calendar:write_self',
  'workspace:read',
  // So they can attach their own Google account and have bookings mirror to it.
  'integration:connect_self',
];

const ADMIN: Permission[] = [
  ...MEMBER,
  'agent:write',
  'agent:delete',
  // Staff and admins manage every doctor's calendar; the _self permissions are
  // about which ROWS you may touch, and their scope is widened by call:write.
  'calendar:read_self',
  'calendar:write_self',
  'workspace:write',
  'workspace:delete',
  'patient:delete',
  'member:manage',
  'apikey:read',
  'integration:read',
  'audit:read',
  'insights:read',
];

// Owner-only, and all for one reason: each either spends money, binds the
// practice, or hands out a credential. `integration:manage` connects the
// clinic's Google and WhatsApp accounts — note that `integration:connect_self`,
// a doctor attaching their OWN calendar, is a different permission and stays
// with MEMBER and DOCTOR.
const OWNER: Permission[] = [
  ...ADMIN,
  'number:write',
  'apikey:manage',
  'integration:manage',
  'billing:manage',
  'org:manage',
];

const MATRIX: Record<Role, Permission[]> = {
  VIEWER: VIEWER,
  MEMBER: MEMBER,
  ADMIN: ADMIN,
  OWNER: OWNER,
  DOCTOR: DOCTOR,
};

export function permissionsFor(role: Role): Permission[] {
  return MATRIX[role] ?? [];
}

export function hasPermission(role: Role | null | undefined, perm: Permission): boolean {
  if (!role) return false;
  return MATRIX[role]?.includes(perm) ?? false;
}

/** Throws a tagged error when the role lacks the permission. */
export function assertPermission(role: Role | null | undefined, perm: Permission): void {
  if (!hasPermission(role, perm)) {
    const err = new Error(`Forbidden: requires ${perm}`);
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}

export function isRole(value: string | null | undefined): value is Role {
  return !!value && (ROLES as readonly string[]).includes(value);
}

/**
 * Normalize a stored role string to a valid Role, defaulting to the LEAST
 * privileged one.
 *
 * This runs on Membership.role straight out of the database (auth/context.ts),
 * so the default is what an unrecognised value gets: a legacy, mistyped or
 * hand-edited role must degrade to read-only rather than quietly granting
 * writes. Failing closed costs a confused admin one support question; failing
 * open hands out edit rights nobody granted.
 */
export function toRole(value: string | null | undefined): Role {
  return isRole(value) ? value : 'VIEWER';
}

/** Rank for comparing roles (higher = more privileged). */
export function roleRank(role: Role): number {
  // DOCTOR is 0 because it is NOT on this ladder at all — it is a sideways role,
  // not a rung. Nothing authorizes on rank today (only the seniority assertion in
  // tests/rbac.test.ts uses it), and if anything ever does, "lowest" is the safe
  // answer for a role that must never outrank clinic staff. Authority over a
  // doctor comes from member:manage, which is ADMIN and above.
  return { VIEWER: 0, DOCTOR: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 }[role];
}

/**
 * Where a role should land after signing in.
 *
 * /dashboard is ADMIN+ now, so sending everyone there produced a redirect on
 * every sign-in. Kept here, beside the matrix, so the sign-in pages and the
 * dashboard's own guard cannot disagree about where someone belongs.
 */
export function homePathFor(role: Role | null | undefined): string {
  if (role && hasPermission(role, 'insights:read')) return '/dashboard';
  // A doctor's home is their own practice; everyone else works the book.
  if (role === 'DOCTOR') return '/my-practice';
  return '/appointments';
}
