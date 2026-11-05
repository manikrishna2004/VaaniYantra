import { prisma } from '@/lib/db';
import { asBusinessHours, defaultBusinessHours, type BusinessHours, type DayWindow } from '@/lib/agent-behavior';
import { hasPermission, type Role } from '@/lib/auth/permissions';

// Doctors: the people patients are booked with.
//
// Until now a "doctor" was a free-text name inside Agent.bookingConfig.experts,
// matched at booking time by case-insensitive substring. That could not hold a
// schedule, could not own time off, could not be scoped to a login, and matched
// the wrong person whenever two doctors shared a surname. Production still shows
// the damage: appointments attributed to "Dr Raani" and "Dr Manikanta", neither
// of whom appears in any agent's expert list any more.
//
// A Doctor row is the fix. `userId` is OPTIONAL — see the schema comment — so a
// clinic gets per-doctor calendars immediately, and a doctor who later signs in
// gets self-service and a Google mirror on top.

export type DoctorSummary = {
  id: string;
  displayName: string;
  timezone: string | null;
  active: boolean;
  /** Whether the agent may offer them. False until a profile is filled in. */
  bookable: boolean;
  specialisation: string | null;
  qualifications: string | null;
  bio: string | null;
  phone: string | null;
  photoUrl: string | null;
  profileCompletedAt: string | null;
  userId: string | null;
  userEmail: string | null;
  hasCalendar: boolean;
};

/**
 * May this caller read or write this doctor's calendar, hours and time off?
 *
 * Two ways to qualify, and they are genuinely different:
 *   • STAFF — `call:read` / `call:write`. The front desk books for everyone, so
 *     their reach is the whole clinic.
 *   • THE DOCTOR THEMSELVES — `calendar:*_self` AND the row's `userId` matching
 *     the signed-in user. The permission says "may touch a calendar"; the
 *     identity match says "this one". Both are required: the permission alone
 *     would let any doctor edit any colleague's schedule.
 *
 * Returns a discriminated result rather than throwing, so routes surface it with
 * the same `{ error }` shape everything else uses.
 */
export async function doctorAccess(
  ctx: { org: { id: string }; user: { id: string }; role: Role },
  doctorId: string,
  mode: 'read' | 'write',
): Promise<{ ok: true; doctor: { id: string; userId: string | null; timezone: string | null } } | { ok: false; status: number; error: string }> {
  const doctor = await prisma.doctor.findFirst({
    where: { id: doctorId, orgId: ctx.org.id },
    select: { id: true, userId: true, timezone: true },
  });
  // 404 rather than 403 for a doctor in another org: whether an id exists
  // elsewhere is not this caller's business.
  if (!doctor) return { ok: false, status: 404, error: 'Not found' };

  const staff = hasPermission(ctx.role, mode === 'write' ? 'call:write' : 'call:read');
  const own =
    hasPermission(ctx.role, mode === 'write' ? 'calendar:write_self' : 'calendar:read_self') &&
    Boolean(doctor.userId) &&
    doctor.userId === ctx.user.id;

  if (!staff && !own) return { ok: false, status: 403, error: 'Forbidden' };
  return { ok: true, doctor };
}

/** Every doctor in an org, newest last, with their linked account if any. */
export async function listDoctors(orgId: string, opts?: { includeInactive?: boolean }): Promise<DoctorSummary[]> {
  const rows = await prisma.doctor.findMany({
    where: { orgId, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
    include: { user: { select: { email: true } } },
  });

  // A doctor has a Google mirror only when they are linked to an account that
  // has connected one. An unlinked doctor is native-only by construction.
  const linked = rows.map((r) => r.userId).filter((u): u is string => Boolean(u));
  const connected = linked.length
    ? new Set(
        (
          await prisma.integration.findMany({
            where: { orgId, provider: 'googleCalendar', enabled: true, userId: { in: linked } },
            select: { userId: true },
          })
        ).map((i) => i.userId),
      )
    : new Set<string>();

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    timezone: r.timezone,
    active: r.active,
    bookable: r.bookable,
    specialisation: r.specialisation,
    qualifications: r.qualifications,
    bio: r.bio,
    phone: r.phone,
    photoUrl: r.photoUrl,
    profileCompletedAt: r.profileCompletedAt?.toISOString() ?? null,
    userId: r.userId,
    userEmail: r.user?.email ?? null,
    hasCalendar: Boolean(r.userId && connected.has(r.userId)),
  }));
}

/** The Doctor this signed-in user is, in this org, or null if they are not one. */
export async function doctorForUser(orgId: string, userId: string) {
  return prisma.doctor.findUnique({ where: { orgId_userId: { orgId, userId } } });
}

/** A doctor the agent may offer on a call. */
export type BookableDoctor = {
  id: string;
  displayName: string;
  specialisation: string | null;
  timezone: string | null;
  userId: string | null;
  calendarId: string | null;
};

/**
 * Every doctor the agent may offer, name-ordered so the list it reads out is
 * stable between calls.
 *
 * `bookable` is checked as well as `active`: a doctor who accepted an invite
 * but has not filled anything in is employed, and not yet someone to offer a
 * patient by name.
 */
export async function listBookableDoctors(orgId: string): Promise<BookableDoctor[]> {
  return prisma.doctor.findMany({
    where: { orgId, active: true, bookable: true },
    select: { id: true, displayName: true, specialisation: true, timezone: true, userId: true, calendarId: true },
    orderBy: { displayName: 'asc' },
  });
}

export type DoctorMatch =
  /** Exactly who the caller asked for. */
  | { doctor: BookableDoctor; choices?: never }
  /** They named a specialisation several doctors share — ask which. */
  | { doctor?: never; choices: BookableDoctor[] }
  /** They named nobody, or nobody we have. */
  | { doctor?: never; choices?: never };

/**
 * Resolve a doctor from what the agent heard.
 *
 * PURE, over a list the caller already fetched. It replaced an async version
 * that ran its own findMany, which would have fired a query per availability
 * check and again per booking — and which, being un-mockable without prisma,
 * was never tested.
 *
 * Name tiers first, exactly as `matchExpert` did in booking.ts, so a name that
 * routed to someone before routes to the same person now. Specialisation tiers
 * are new: a caller asking for "a dentist" should reach one. When several share
 * it the answer is `choices`, not a guess — being assigned a random dentist is
 * worse than being asked which.
 */
export function matchDoctor(doctors: BookableDoctor[], name: unknown): DoctorMatch {
  const q = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!q) return {};
  const withName = doctors.map((d) => ({ d, n: d.displayName.toLowerCase() }));

  const exactName = withName.find((r) => r.n === q);
  if (exactName) return { doctor: exactName.d };
  const partName = withName.find((r) => r.n.includes(q) || q.includes(r.n));
  if (partName) return { doctor: partName.d };

  const withSpec = doctors
    .filter((d) => d.specialisation)
    .map((d) => ({ d, s: d.specialisation!.toLowerCase() }));
  const exactSpec = withSpec.filter((r) => r.s === q);
  const specHits = exactSpec.length
    ? exactSpec
    : withSpec.filter((r) => r.s.includes(q) || q.includes(r.s));

  if (specHits.length === 1) return { doctor: specHits[0].d };
  if (specHits.length > 1) return { choices: specHits.map((r) => r.d) };
  return {};
}

/**
 * A doctor's weekly hours, or null when they have not set any.
 *
 * Null means "fall back to the agent's hours", NOT "closed all week". A doctor
 * who has never opened the schedule editor must keep being bookable exactly as
 * they were.
 */
export async function doctorWeekly(doctorId: string): Promise<DayWindow[] | null> {
  const row = await prisma.doctorSchedule.findUnique({ where: { doctorId } });
  if (!row) return null;
  const parsed = asBusinessHours(row.days);
  if (!parsed) return null;
  // `enabled: false` on a doctor's own schedule means "I have not set hours",
  // which is the same fall-back as having no row at all.
  return parsed.enabled ? parsed.days : null;
}

/** A blank week to seed the editor with. */
export function blankDoctorSchedule(timezone: string): BusinessHours {
  return { ...defaultBusinessHours(), enabled: true, timezone };
}

/**
 * Time off as busy intervals, in the shape computeOpenSlots already consumes.
 *
 * Returning the SAME `{start, end}` shape as Google free/busy is deliberate: the
 * slot generator then has one notion of "busy" and does not care whether it came
 * from a doctor's leave, a Google event, or both merged.
 */
export async function timeOffBusy(
  doctorId: string,
  fromMs: number,
  toMs: number,
): Promise<{ start: number; end: number }[]> {
  const rows = await prisma.doctorTimeOff.findMany({
    where: { doctorId, startAt: { lt: new Date(toMs) }, endAt: { gt: new Date(fromMs) } },
    select: { startAt: true, endAt: true },
  });
  return rows.map((r) => ({ start: r.startAt.getTime(), end: r.endAt.getTime() }));
}
