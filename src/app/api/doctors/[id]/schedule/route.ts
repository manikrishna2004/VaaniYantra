import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { doctorAccess, blankDoctorSchedule } from '@/lib/doctors';
import { asBusinessHours } from '@/lib/agent-behavior';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// A doctor's weekly working hours.
//
// Stored in the SAME shape as Agent.businessHours so one parser and one editor
// serve both. A second schedule format is how two calendars start disagreeing
// about when a clinic is open.
//
// Permission is not a flat `deny(ctx, ...)` here: staff may edit any doctor's
// hours, a doctor may edit only their own. doctorAccess() holds that rule so
// this route and the time-off route cannot answer it differently.

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;

  const access = await doctorAccess(ctx, id, 'read');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const row = await prisma.doctorSchedule.findUnique({ where: { doctorId: id } });
  const tz = access.doctor.timezone || 'Asia/Kolkata';
  // No row yet is not an error, and must not read as "closed all week" — hand
  // back a blank week so the editor has something to open.
  return NextResponse.json({ schedule: (row && asBusinessHours(row.days)) || blankDoctorSchedule(tz) });
}

export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;

  const access = await doctorAccess(ctx, id, 'write');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const body = (await req.json().catch(() => ({}))) as { schedule?: unknown };
  const parsed = asBusinessHours(body.schedule);
  if (!parsed) return NextResponse.json({ error: 'A full seven-day schedule is required.' }, { status: 400 });

  await prisma.doctorSchedule.upsert({
    where: { doctorId: id },
    create: { doctorId: id, days: parsed as unknown as object },
    update: { days: parsed as unknown as object },
  });

  await audit(ctx, 'doctor.schedule_updated', { targetType: 'Doctor', targetId: id, req });
  return NextResponse.json({ ok: true });
}
