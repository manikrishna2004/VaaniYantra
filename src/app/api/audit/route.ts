import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Recent audit events for the active organization (admins+).
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'audit:read');
  if (denied) return denied;

  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit')) || 100, 200);
  const logs = await prisma.auditLog.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return NextResponse.json({
    logs: logs.map((l) => ({
      id: l.id,
      action: l.action,
      actorEmail: l.actorEmail,
      targetType: l.targetType,
      targetId: l.targetId,
      metadata: l.metadata,
      ip: l.ip,
      createdAt: l.createdAt,
    })),
  });
}
