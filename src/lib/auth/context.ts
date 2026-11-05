// The request's tenancy context: which user, organization, and workspace are
// active, plus the user's role. This replaces the MVP's getCurrentUser(): every
// page and API route resolves its data scope from here.
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSessionUser } from './session';
import { provisionUser } from './provision';
import { toRole, type Role } from './permissions';

export type WorkspaceContext = {
  user: { id: string; email: string; name: string | null; imageUrl: string | null };
  org: {
    id: string;
    name: string;
    slug: string;
    // Which version of the legal documents this org has accepted, if any. Null
    // means no acceptance is on record — true of every org created before the
    // acceptance box shipped. Carried on the context because the app shell
    // prompts on it; the membership query already loads the org row, so this
    // costs nothing extra.
    termsVersion: string | null;
    status: string;
    statusReason: string | null;
  };
  workspace: { id: string; name: string; slug: string };
  role: Role;
};

export async function getWorkspaceContext(): Promise<WorkspaceContext | null> {
  const fb = await getSessionUser();
  if (!fb) return null;

  const user = await provisionUser(fb);

  // Pick the active membership: the user's activeOrgId if they still belong to
  // it, otherwise their oldest membership.
  const membership =
    (user.activeOrgId &&
      (await prisma.membership.findFirst({
        where: { userId: user.id, orgId: user.activeOrgId },
        include: { org: true },
      }))) ||
    (await prisma.membership.findFirst({
      where: { userId: user.id },
      include: { org: true },
      orderBy: { createdAt: 'asc' },
    }));
  if (!membership) return null;

  // Resolve the active workspace within the active org (fall back to the first).
  let workspace =
    (user.activeWorkspaceId &&
      (await prisma.workspace.findFirst({
        where: { id: user.activeWorkspaceId, orgId: membership.orgId },
      }))) ||
    (await prisma.workspace.findFirst({
      where: { orgId: membership.orgId },
      orderBy: { createdAt: 'asc' },
    }));
  if (!workspace) return null;

  return {
    user: { id: user.id, email: user.email, name: user.name, imageUrl: user.imageUrl },
    org: {
      id: membership.org.id,
      name: membership.org.name,
      slug: membership.org.slug,
      termsVersion: membership.org.termsVersion,
      status: membership.org.status,
      statusReason: membership.org.statusReason,
    },
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    role: toRole(membership.role),
  };
}

/**
 * Require an authenticated workspace context. In pages this redirects to
 * /sign-in when unauthenticated; in API routes (already gated by middleware)
 * that redirect is effectively a 307 the client can follow.
 */
export async function requireWorkspace(): Promise<WorkspaceContext> {
  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/sign-in');
  return ctx;
}
