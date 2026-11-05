import { NextResponse } from 'next/server';
import { getWorkspaceContext, type WorkspaceContext } from './context';
import { hasPermission, type Permission } from './permissions';

export type { WorkspaceContext };

/** Resolve the API caller's context, or a 401 response. */
export async function apiContext(): Promise<
  { ctx: WorkspaceContext; error?: never } | { ctx?: never; error: NextResponse }
> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { ctx };
}

/** Returns a 403 response if the role lacks the permission, else null. */
export function deny(ctx: WorkspaceContext, perm: Permission): NextResponse | null {
  if (!hasPermission(ctx.role, perm)) {
    return NextResponse.json({ error: `Forbidden: requires ${perm}` }, { status: 403 });
  }
  return null;
}
