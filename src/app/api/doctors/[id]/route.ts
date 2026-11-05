import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Edit a doctor: rename, retime, link or unlink an account, retire or restore.
 *
 * Partial-update idiom from src/app/api/patients/[id]/route.ts — `undefined`
 * means untouched, an explicit `null` or `''` means clear. Without that
 * distinction there is no way to say "unlink this account" as opposed to "leave
 * the link alone".
 */
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  const doctor = await prisma.doctor.findFirst({ where: { id, orgId: ctx.org.id } });
  if (!doctor) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    displayName?: string;
    timezone?: string | null;
    userId?: string | null;
    active?: boolean;
    bookable?: boolean;
    specialisation?: string | null;
    qualifications?: string | null;
    bio?: string | null;
    photoUrl?: string | null;
    phone?: string | null;
  };

  if (body.displayName !== undefined && !body.displayName.trim()) {
    return NextResponse.json({ error: 'A name is required.' }, { status: 400 });
  }

  if (body.userId) {
    const member = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: body.userId, orgId: ctx.org.id } },
    });
    if (!member) return NextResponse.json({ error: 'That person is not in this organisation.' }, { status: 400 });

    const clash = await prisma.doctor.findUnique({
      where: { orgId_userId: { orgId: ctx.org.id, userId: body.userId } },
    });
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: 'That person is already set up as a doctor.' }, { status: 409 });
    }
  }

  await prisma.doctor.update({
    where: { id },
    data: {
      ...(body.displayName !== undefined ? { displayName: body.displayName.trim() } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone?.trim() || null } : {}),
      ...(body.userId !== undefined ? { userId: body.userId || null } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      // Profile fields. A doctor normally fills these in themselves on
      // /my-practice, but staff must be able to do it for someone who never
      // signs in — otherwise an invited doctor who ignores the link can never
      // be made bookable by anyone, and the clinic is stuck.
      ...(body.specialisation !== undefined ? { specialisation: body.specialisation?.trim() || null } : {}),
      ...(body.qualifications !== undefined ? { qualifications: body.qualifications?.trim() || null } : {}),
      ...(body.bio !== undefined ? { bio: body.bio?.trim() || null } : {}),
      ...(body.photoUrl !== undefined ? { photoUrl: body.photoUrl?.trim() || null } : {}),
      ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
      // Staff may set this directly, unlike the doctor themselves, for whom it
      // is a consequence of completing their profile.
      ...(body.bookable !== undefined ? { bookable: body.bookable } : {}),
    },
  });

  await audit(ctx, body.active === false ? 'doctor.deactivated' : 'doctor.updated', {
    targetType: 'Doctor',
    targetId: id,
    metadata: { displayName: body.displayName ?? doctor.displayName },
    req,
  });
  return NextResponse.json({ ok: true });
}
