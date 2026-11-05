import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { listDoctorCalendarOwners } from '@/lib/calendar';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// List members of the active organization.
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:read');
  if (denied) return denied;

  const [memberships, calendarOwners] = await Promise.all([
    prisma.membership.findMany({
      where: { orgId: ctx.org.id },
      include: { user: { select: { id: true, name: true, email: true, imageUrl: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    listDoctorCalendarOwners(ctx.org.id),
  ]);

  const withCalendar = new Set(calendarOwners);
  const members = memberships.map((m) => ({
    membershipId: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    imageUrl: m.user.imageUrl,
    role: m.role,
    isYou: m.userId === ctx.user.id,
    // Whether they've connected their OWN Google Calendar. Drives the Team page
    // and the doctor picker in the agent form, so it is obvious at a glance who
    // still needs to connect one before bookings can route to them.
    hasCalendar: withCalendar.has(m.userId),
  }));

  return NextResponse.json({ members, yourRole: ctx.role });
}
