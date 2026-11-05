import { prisma } from '@/lib/db';

// Operator-controlled service state for a tenant. Set from the admin panel;
// see Organization.status in the schema for what each value means.
//
// The split matters in one specific way: PAUSED stops the service but NOT the
// dashboard, because the usual reason to pause an org is an unpaid invoice and
// the person who needs to fix that has to be able to reach the billing page.
// Locking them out would make the pause self-defeating.

export const ORG_STATUSES = ['ACTIVE', 'PAUSED', 'DEACTIVATED'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export function isOrgStatus(v: unknown): v is OrgStatus {
  return typeof v === 'string' && (ORG_STATUSES as readonly string[]).includes(v);
}

/** Can this org's agents take and place calls? */
export const canUseService = (status: string) => status === 'ACTIVE';

/** Can this org's staff sign in and use the dashboard? */
export const canSignIn = (status: string) => status !== 'DEACTIVATED';

/** What a caller hears / an API caller is told when the service is stopped. */
export function suspendedMessage(status: string, reason?: string | null): string {
  const base =
    status === 'DEACTIVATED'
      ? 'This account has been deactivated.'
      : 'This account is paused.';
  return reason?.trim() ? `${base} ${reason.trim()}` : base;
}

/** Status of the org owning a workspace, or null when the workspace is unknown. */
export async function orgStatusForWorkspace(
  workspaceId: string | null | undefined,
): Promise<{ orgId: string; status: string; reason: string | null } | null> {
  if (!workspaceId) return null;
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    // The id comes back too: every caller that cares about an org's status is
    // about to need the org itself, and this query already has it.
    select: { org: { select: { id: true, status: true, statusReason: true } } },
  });
  return ws ? { orgId: ws.org.id, status: ws.org.status, reason: ws.org.statusReason } : null;
}

/** Status of an org by id. */
export async function orgStatus(orgId: string): Promise<{ status: string; reason: string | null }> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { status: true, statusReason: true },
  });
  // An unknown org is not a licence to place calls.
  return { status: org?.status ?? 'DEACTIVATED', reason: org?.statusReason ?? null };
}
