// Tenant-isolation guards.
//
// Audit F-5.2: multi-tenant isolation relies on every query carrying the right
// workspaceId/orgId — a convention, not an enforced invariant. One forgotten
// filter is a cross-tenant leak. These small, explicit, tested primitives make
// scoping intentional: build scoped `where` clauses that can't silently omit the
// tenant key, and assert ownership before acting on a fetched row.
//
// This is the safe, incremental step. Full enforcement (Prisma middleware that
// injects the scope, or Postgres row-level security) is larger and riskier and
// is tracked in OPEN_QUESTIONS.md (Q5).

export class TenantScopeError extends Error {
  constructor(message = 'resource is outside the caller tenant scope') {
    super(message);
    this.name = 'TenantScopeError';
  }
}

/** Throw unless `resourceOrgId` is present and equals `expectedOrgId`. */
export function assertSameOrg(
  resourceOrgId: string | null | undefined,
  expectedOrgId: string,
): void {
  if (!expectedOrgId || !resourceOrgId || resourceOrgId !== expectedOrgId) {
    throw new TenantScopeError('org mismatch');
  }
}

/** Throw unless `resourceWorkspaceId` is present and equals `expectedWorkspaceId`. */
export function assertSameWorkspace(
  resourceWorkspaceId: string | null | undefined,
  expectedWorkspaceId: string,
): void {
  if (!expectedWorkspaceId || !resourceWorkspaceId || resourceWorkspaceId !== expectedWorkspaceId) {
    throw new TenantScopeError('workspace mismatch');
  }
}

/**
 * Build an org-scoped Prisma `where` clause. The tenant key is spread LAST so a
 * caller cannot accidentally override it from `where`.
 */
export function orgScope<T extends object>(orgId: string, where?: T): T & { orgId: string } {
  if (!orgId) throw new TenantScopeError('orgId required for a scoped query');
  return { ...(where ?? ({} as T)), orgId };
}

/** Build a workspace-scoped Prisma `where` clause (tenant key wins). */
export function workspaceScope<T extends object>(
  workspaceId: string,
  where?: T,
): T & { workspaceId: string } {
  if (!workspaceId) throw new TenantScopeError('workspaceId required for a scoped query');
  return { ...(where ?? ({} as T)), workspaceId };
}

/**
 * Build a doctor-scoped Prisma `where` clause (the doctor key wins).
 *
 * The first per-USER scope in this codebase. Everything above stops at the
 * tenant boundary, because until now every authenticated person could see the
 * whole workspace — `/api/appointments` still reads every appointment in it.
 * A DOCTOR must see only their own, so the row filter has to go somewhere, and
 * putting it here rather than inline in a route means it is spelled once and
 * carries the same override protection as the tenant helpers.
 *
 * ⚠ This is a FILTER, not an authorization check. `calendar:read_self` says the
 * caller may look at a calendar; this says which one. A route needs both — the
 * scope alone would happily hand a doctor's appointments to anyone who asked.
 *
 * Throws on an empty doctorId rather than returning an unscoped clause: a
 * missing id must never silently widen to "every doctor".
 */
export function doctorScope<T extends object>(doctorId: string, where?: T): T & { doctorId: string } {
  if (!doctorId) throw new TenantScopeError('doctorId required for a scoped query');
  return { ...(where ?? ({} as T)), doctorId };
}

/** The shape of any Prisma model delegate we can check ownership against. */
type OwnableDelegate = {
  findMany(args: {
    where: { id: { in: string[] }; workspaceId: string };
    select: { id: true };
  }): Promise<{ id: string }[]>;
};

/**
 * True when every id in `ids` names a row inside `workspaceId`.
 *
 * For foreign keys that arrive in a request body. Scoping the row being edited
 * is not enough: a route that loads its own agent correctly and then writes a
 * body-supplied `documentId` still ends up holding a pointer into another
 * tenant. Both of those foreign keys are read back on the serving path, so an
 * unchecked one leaks the other tenant's content rather than just its ids.
 *
 * The delegate is injected rather than imported so this module stays free of a
 * database dependency, and so callers name the model they mean at the call site.
 * Duplicate ids are collapsed first — otherwise `['x','x']` could never match a
 * single found row and a legitimate request would be refused.
 */
export async function ownsAll(
  delegate: OwnableDelegate,
  workspaceId: string,
  ids: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  if (!workspaceId) throw new TenantScopeError('workspaceId required for an ownership check');
  const found = await delegate.findMany({
    where: { id: { in: unique }, workspaceId },
    select: { id: true },
  });
  return found.length === unique.length;
}
