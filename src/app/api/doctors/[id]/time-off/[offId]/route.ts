import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { doctorAccess } from '@/lib/doctors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(req: Request, props: { params: Promise<{ id: string; offId: string }> }) {
  const { id, offId } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;

  const access = await doctorAccess(ctx, id, 'write');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  // Scoped by doctorId as well as id: an offId belonging to another doctor must
  // not be deletable just because the caller can write to this one.
  const row = await prisma.doctorTimeOff.findFirst({ where: { id: offId, doctorId: id, orgId: ctx.org.id } });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.doctorTimeOff.delete({ where: { id: offId } });
  await audit(ctx, 'doctor.time_off_removed', {
    targetType: 'Doctor',
    targetId: id,
    metadata: { from: row.startAt.toISOString(), to: row.endAt.toISOString() },
    req,
  });
  return NextResponse.json({ ok: true });
}
