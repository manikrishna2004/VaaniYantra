import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const ACTION_LABELS: Record<string, string> = {
  'agent.created': 'created an agent',
  'agent.deleted': 'deleted an agent',
  'member.invited': 'invited a member',
  'member.role_changed': 'changed a member role',
  'member.removed': 'removed a member',
  'apikey.created': 'created an API key',
  'apikey.revoked': 'revoked an API key',
  'organization.updated': 'updated the organization',
};

export default async function AuditPage() {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx.role, 'audit:read')) notFound();

  const logs = await prisma.auditLog.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="text-sm font-medium text-ink">Audit log</h2>
      <p className="mt-1 text-xs text-muted">Recent activity in this organization.</p>

      {logs.length === 0 ? (
        <div className="mt-4 text-sm text-muted">No activity recorded yet.</div>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {logs.map((l) => {
            const meta = (l.metadata ?? null) as Record<string, unknown> | null;
            const detail = meta
              ? Object.entries(meta)
                  .map(([k, v]) => `${k}: ${String(v)}`)
                  .join(', ')
              : '';
            return (
              <li key={l.id} className="flex items-start gap-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="text-ink">{l.actorEmail ?? 'Someone'}</span>{' '}
                  <span className="text-muted">{ACTION_LABELS[l.action] ?? l.action}</span>
                  {detail && <span className="text-muted"> — {detail}</span>}
                </div>
                <time className="shrink-0 text-[11px] text-muted">
                  {new Date(l.createdAt).toLocaleString()}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
