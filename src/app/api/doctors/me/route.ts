import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { doctorForUser } from '@/lib/doctors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// A doctor's own profile.
//
// THE ROUTE TAKES NO ID. That is the entire access-control design: the row is
// resolved from the session with doctorForUser(), so there is no parameter a
// doctor could change to reach a colleague. It is the same shape as
// /api/appointments/calendar, which ignores a requested doctorId rather than
// validating one — a check you cannot get wrong beats a check you must remember.
//
// Permission is `calendar:write_self`, which DOCTOR, ADMIN and OWNER already
// hold and which already means "your own doctor-shaped things". A new
// doctor:write_self would have to be added to three role arrays and would earn
// nothing.

/** Fields a doctor may set about themselves. Everything else is administrative. */
const PROFILE_FIELDS = [
  'displayName',
  'specialisation',
  'qualifications',
  'bio',
  'photoUrl',
  'phone',
  'timezone',
] as const;

export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'calendar:read_self');
  if (denied) return denied;

  const doctor = await doctorForUser(ctx.org.id, ctx.user.id);
  return NextResponse.json({ doctor: doctor ?? null });
}

export async function PATCH(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'calendar:write_self');
  if (denied) return denied;

  const doctor = await doctorForUser(ctx.org.id, ctx.user.id);
  // 404, not 403: whether this org has doctors at all is not the interesting
  // fact — the caller simply is not one.
  if (!doctor) return NextResponse.json({ error: 'You are not set up as a doctor here.' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, string | null> = {};
  for (const key of PROFILE_FIELDS) {
    if (!(key in body)) continue;
    const raw = body[key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    // displayName is what a patient hears; it may be corrected but not emptied.
    if (key === 'displayName' && !value) continue;
    data[key] = value || null;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  // Anything NOT in PROFILE_FIELDS is silently ignored — `active`, `bookable`,
  // `userId`, `orgId`, `email` and `calendarId` stay administrative and remain
  // on /api/doctors/[id] behind member:manage. A doctor cannot un-retire
  // themselves, re-point their calendar into the clinic's account, or take over
  // another user's link by posting the field.
  const displayName = (data.displayName ?? doctor.displayName) || '';
  const specialisation = 'specialisation' in data ? data.specialisation : doctor.specialisation;

  // Becoming bookable is a consequence of having said who you are, not a
  // separate switch. Until both are set the agent must not offer this person to
  // a caller — the invite created them as a placeholder name.
  const ready = Boolean(displayName.trim() && specialisation?.trim());

  const updated = await prisma.doctor.update({
    where: { id: doctor.id },
    data: {
      ...data,
      ...(ready ? { bookable: true, profileCompletedAt: doctor.profileCompletedAt ?? new Date() } : {}),
    },
  });

  await audit(ctx, 'doctor.profile_updated', {
    targetType: 'Doctor',
    targetId: doctor.id,
    metadata: { fields: Object.keys(data), bookable: updated.bookable },
    req,
  });

  return NextResponse.json({ ok: true, doctor: updated });
}
