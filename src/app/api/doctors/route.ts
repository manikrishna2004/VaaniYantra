import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { listDoctors } from '@/lib/doctors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Doctors a clinic can book patients with.
//
// Reading is `call:read`, because the front desk needs the list to book and the
// calendar needs it to render. Creating is `member:manage`: adding a doctor is
// an administrative act, and one that a DOCTOR must not be able to perform for
// themselves.

export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'call:read');
  if (denied) return denied;

  const includeInactive = new URL(req.url).searchParams.get('all') === '1';
  return NextResponse.json({ doctors: await listDoctors(ctx.org.id, { includeInactive }) });
}

export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { displayName?: unknown; timezone?: unknown; userId?: unknown };
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName) return NextResponse.json({ error: 'A name is required.' }, { status: 400 });

  const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null;
  if (userId) {
    // Only a member of THIS org may be linked. Without this check an id from
    // anywhere could attach a stranger's account to a clinic's doctor.
    const member = await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId: ctx.org.id } } });
    if (!member) return NextResponse.json({ error: 'That person is not in this organisation.' }, { status: 400 });

    const clash = await prisma.doctor.findUnique({ where: { orgId_userId: { orgId: ctx.org.id, userId } } });
    if (clash) return NextResponse.json({ error: 'That person is already set up as a doctor.' }, { status: 409 });
  }

  const doctor = await prisma.doctor.create({
    data: {
      orgId: ctx.org.id,
      workspaceId: ctx.workspace.id,
      displayName,
      timezone: typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : null,
      userId,
    },
  });

  await audit(ctx, 'doctor.created', {
    targetType: 'Doctor',
    targetId: doctor.id,
    metadata: { displayName, linked: Boolean(userId) },
    req,
  });
  return NextResponse.json(doctor, { status: 201 });
}
