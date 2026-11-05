import Link from 'next/link';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { PageHeader, Card, Badge, EmptyState } from '@/components/ui';
import { AutoRefresh } from '@/components/AutoRefresh';
import { LiveElapsed } from '@/components/LiveElapsed';
import { ACTIVE_STATUSES, STALE_AFTER_MS } from '@/lib/calls/stale';

export const dynamic = 'force-dynamic';

function statusTone(status: string) {
  if (status === 'IN_PROGRESS') return 'success' as const;
  if (status === 'RINGING' || status === 'QUEUED') return 'warning' as const;
  return 'neutral' as const;
}

export default async function LivePage() {
  const ctx = await requireWorkspace();
  const { workspace } = ctx;
  // Clinic-wide oversight is ADMIN and OWNER only. Hiding the nav link is
  // not enough — the URL has to refuse too.
  if (!hasPermission(ctx.role, 'insights:read')) notFound();
  const active = await prisma.call.findMany({
    where: { workspaceId: workspace.id, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
    include: {
      agent: { select: { name: true } },
      transcript: { orderBy: { atMs: 'desc' }, take: 2 },
    },
  });

  // An active status alone does not mean the call is still up: a lost end
  // signal (voice-server killed mid-call, or a provider status callback that
  // never arrived) leaves the row active forever, and this page used to render
  // those day-old calls with the elapsed timer still climbing. The sweeper in
  // lib/calls/stale closes them out; judging liveness by the same last-activity
  // rule here keeps the page honest in the window before its next tick.
  // Server component (async + force-dynamic): this runs once per request, not on
  // client re-renders, so Date.now() here is stable for the render it belongs to.
  // eslint-disable-next-line react-hooks/purity -- not a client render
  const cutoff = Date.now() - STALE_AFTER_MS;
  const calls = active.filter((c) => {
    const lastActivity = c.transcript[0]?.createdAt ?? c.startedAt ?? c.createdAt;
    return lastActivity.getTime() > cutoff;
  });

  return (
    <>
      {/* Always poll on this page so newly started calls appear without a manual refresh. */}
      <AutoRefresh active intervalMs={3000} />
      <PageHeader
        title="Live Calls"
        subtitle="Calls happening right now across this workspace. Updates automatically."
        action={
          <span className="flex items-center gap-2 text-xs text-muted">
            <span className={calls.length ? 'text-success' : 'text-muted'}>●</span>
            {calls.length} active
          </span>
        }
      />

      {calls.length === 0 ? (
        <EmptyState
          title="No calls in progress"
          description="When an agent is on a call, it shows up here live with its transcript."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {calls.map((c) => {
            const latest = [...c.transcript].reverse(); // back to chronological
            return (
              <Card key={c.id} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={c.direction === 'INBOUND' ? 'accent' : 'primary'}>
                        {c.direction === 'INBOUND' ? '↓ in' : '↑ out'}
                      </Badge>
                      <Badge tone={statusTone(c.status)}>
                        {c.status.toLowerCase().replace('_', ' ')}
                      </Badge>
                    </div>
                    <div className="mt-2 truncate text-base font-medium text-ink">
                      {c.direction === 'INBOUND' ? c.fromNumber : c.toNumber}
                    </div>
                    <div className="text-xs text-muted">{c.agent?.name ?? 'No agent'}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-lg text-ink">
                      <LiveElapsed since={(c.startedAt ?? c.createdAt).toISOString()} />
                    </div>
                    <div className="text-[11px] text-muted">elapsed</div>
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-surface-2/50 p-3">
                  {latest.length === 0 ? (
                    <p className="text-xs text-muted">Waiting for the conversation to start…</p>
                  ) : (
                    <div className="space-y-1.5">
                      {latest.map((t) => (
                        <p key={t.id} className="text-xs leading-relaxed">
                          <span className="text-muted">
                            {t.role === 'AGENT' ? 'Agent' : t.role === 'CALLER' ? 'Caller' : 'System'}:{' '}
                          </span>
                          <span className="text-ink">{t.text}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex justify-end">
                  <Link href={`/calls/${c.id}`} className="text-xs text-primary hover:underline">
                    Open full transcript →
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
