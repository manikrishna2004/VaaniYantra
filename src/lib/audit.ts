import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/auth/context';

type AuditInput = {
  orgId: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
};

export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: input.orgId,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: (input.metadata as Prisma.InputJsonValue) ?? undefined,
        ip: input.ip ?? null,
      },
    });
  } catch (e) {
    // Never let auditing break the actual operation.
    console.error('[audit] failed', e);
  }
}

/** Convenience overload using the request's WorkspaceContext as the actor. */
export async function audit(
  ctx: WorkspaceContext,
  action: string,
  opts?: {
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
    req?: Request;
  },
): Promise<void> {
  const ip = opts?.req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  await writeAudit({
    orgId: ctx.org.id,
    actorUserId: ctx.user.id,
    actorEmail: ctx.user.email,
    action,
    targetType: opts?.targetType,
    targetId: opts?.targetId,
    metadata: opts?.metadata,
    ip,
  });
}
