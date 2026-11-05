import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { normalizeUhidPrefix } from '@/lib/patients/uhid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Update the active organization's profile (name, brand color). Admins+ only.
export async function PATCH(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    brandColor?: string;
    dataRetentionDays?: number | null;
    uhidPrefix?: string | null;
  };
  const data: {
    name?: string;
    brandColor?: string | null;
    dataRetentionDays?: number | null;
    uhidPrefix?: string | null;
  } = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
  if (typeof body.brandColor === 'string') {
    data.brandColor = /^#[0-9a-fA-F]{6}$/.test(body.brandColor) ? body.brandColor : null;
  }
  // Data retention: 1..3650 days, or null to keep forever.
  if (body.dataRetentionDays !== undefined) {
    if (body.dataRetentionDays === null) {
      data.dataRetentionDays = null;
    } else if (
      Number.isInteger(body.dataRetentionDays) &&
      body.dataRetentionDays >= 1 &&
      body.dataRetentionDays <= 3650
    ) {
      data.dataRetentionDays = body.dataRetentionDays;
    } else {
      return NextResponse.json(
        { error: 'dataRetentionDays must be a whole number of days between 1 and 3650, or null.' },
        { status: 400 },
      );
    }
  }
  // The letters in front of every patient number. Changing it only affects
  // numbers issued from now on — patients already registered keep the number
  // printed on their file, which is the whole point of storing the prefix
  // inside the number rather than applying it at render time.
  if (body.uhidPrefix !== undefined) {
    data.uhidPrefix = normalizeUhidPrefix(body.uhidPrefix);
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const org = await prisma.organization.update({ where: { id: ctx.org.id }, data });
  await audit(ctx, 'organization.updated', { targetType: 'Organization', targetId: org.id, metadata: data, req });
  return NextResponse.json({ ok: true, name: org.name, brandColor: org.brandColor, uhidPrefix: org.uhidPrefix });
}
