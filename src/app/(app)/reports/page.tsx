import Link from 'next/link';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/auth/context';
import { PageHeader, Card, Badge, EmptyState, Button } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { ExportMenu } from '@/components/ExportMenu';
import { formatDuration } from '@/lib/utils';
import { RANGES, EXPORT_TYPES, EXPORT_PERMISSION, parseRange, rangeSince, rangeLabel, type Range } from '@/lib/reports';
import { hasPermission } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';

type AgentRow = {
  name: string;
  total: number;
  completed: number;
  durationSum: number;
  positive: number;
  neutral: number;
  negative: number;
};

export default async function ReportsPage(
  props: {
    searchParams: Promise<{ range?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const ctx = await requireWorkspace();
  const { workspace, role } = ctx;
  // Clinic-wide oversight is ADMIN and OWNER only. Hiding the nav link is
  // not enough — the URL has to refuse too.
  if (!hasPermission(ctx.role, 'insights:read')) notFound();
  // Offer only what this seat can actually download — a VIEWER has call:read
  // but not patient:read, so the patient-bearing exports would 403 for them.
  const exportTypes = EXPORT_TYPES.filter((t) => hasPermission(role, EXPORT_PERMISSION[t]));
  const range = parseRange(searchParams.range);
  const since = rangeSince(range);
  const where = { workspaceId: workspace.id, ...(since ? { createdAt: { gte: since } } : {}) };

  const [calls, agents] = await Promise.all([
    prisma.call.findMany({
      where,
      select: { agentId: true, status: true, direction: true, durationSec: true, sentiment: true },
    }),
    prisma.agent.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true } }),
  ]);

  const total = calls.length;
  const completed = calls.filter((c) => c.status === 'COMPLETED');
  const totalDuration = calls.reduce((s, c) => s + (c.durationSec || 0), 0);
  const avgDuration = completed.length
    ? Math.round(completed.reduce((s, c) => s + c.durationSec, 0) / completed.length)
    : 0;
  const completionRate = total ? Math.round((completed.length / total) * 100) : 0;

  const sentiment = {
    positive: calls.filter((c) => c.sentiment === 'POSITIVE').length,
    neutral: calls.filter((c) => c.sentiment === 'NEUTRAL').length,
    negative: calls.filter((c) => c.sentiment === 'NEGATIVE').length,
  };
  const analyzed = sentiment.positive + sentiment.neutral + sentiment.negative;

  // Status distribution.
  const statusCounts = new Map<string, number>();
  for (const c of calls) statusCounts.set(c.status, (statusCounts.get(c.status) ?? 0) + 1);
  const statuses = [...statusCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Per-agent breakdown.
  const nameById = new Map(agents.map((a) => [a.id, a.name]));
  const byAgent = new Map<string, AgentRow>();
  for (const c of calls) {
    const key = c.agentId ?? '__none__';
    const name = c.agentId ? nameById.get(c.agentId) ?? 'Deleted agent' : 'No agent';
    const row =
      byAgent.get(key) ??
      { name, total: 0, completed: 0, durationSum: 0, positive: 0, neutral: 0, negative: 0 };
    row.total += 1;
    if (c.status === 'COMPLETED') {
      row.completed += 1;
      row.durationSum += c.durationSec || 0;
    }
    if (c.sentiment === 'POSITIVE') row.positive += 1;
    else if (c.sentiment === 'NEUTRAL') row.neutral += 1;
    else if (c.sentiment === 'NEGATIVE') row.negative += 1;
    byAgent.set(key, row);
  }
  const agentRows = [...byAgent.values()].sort((a, b) => b.total - a.total);

  const stats = [
    { label: 'Calls', value: total.toLocaleString() },
    { label: 'Completion rate', value: `${completionRate}%` },
    { label: 'Total talk time', value: formatDuration(totalDuration) },
    { label: 'Avg / completed call', value: formatDuration(avgDuration) },
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Call performance and sentiment across your agents. Export any of your records as a CSV."
        action={<ExportMenu range={range} types={exportTypes} />}
      />

      {/* Range selector */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {RANGES.map((r: Range) => (
          <Link key={r} href={`/reports?range=${r}`}>
            <Badge tone={r === range ? 'primary' : 'neutral'}>{rangeLabel(r)}</Badge>
          </Link>
        ))}
      </div>

      {total === 0 ? (
        <EmptyState title="No calls in this period" description="Try a wider date range, or place some calls." />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {stats.map((s) => (
              <Card key={s.label} className="p-4">
                <div className="text-xs text-muted">{s.label}</div>
                <div className="mt-2 text-2xl font-semibold text-ink">{s.value}</div>
              </Card>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <h2 className="mb-4 text-sm font-medium text-ink">Caller sentiment</h2>
              {analyzed === 0 ? (
                <p className="text-sm text-muted">No analyzed calls yet.</p>
              ) : (
                <div className="space-y-3">
                  <SentimentBar label="Positive" count={sentiment.positive} total={analyzed} tone="bg-success" />
                  <SentimentBar label="Neutral" count={sentiment.neutral} total={analyzed} tone="bg-muted" />
                  <SentimentBar label="Negative" count={sentiment.negative} total={analyzed} tone="bg-danger" />
                </div>
              )}
            </Card>

            <Card>
              <h2 className="mb-4 text-sm font-medium text-ink">Call outcomes</h2>
              <div className="space-y-2 text-sm">
                {statuses.map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between">
                    <span className="text-muted">{status.toLowerCase().replace('_', ' ')}</span>
                    <span className="text-ink">{count}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-medium text-ink">By agent</h2>
            <DataTable
              rows={agentRows}
              rowKey={(r) => r.name}
              caption="Per-agent totals: calls, completed, average duration and caller sentiment"
              columns={[
                { header: 'Agent', cell: (r) => <span className="text-ink">{r.name}</span> },
                { header: 'Calls', numeric: true, cell: (r) => <span className="text-muted">{r.total}</span> },
                {
                  header: 'Completed',
                  numeric: true,
                  cell: (r) => <span className="text-muted">{r.completed}</span>,
                },
                {
                  header: 'Avg duration',
                  numeric: true,
                  cell: (r) => (
                    <span className="text-muted">
                      {formatDuration(r.completed ? Math.round(r.durationSum / r.completed) : 0)}
                    </span>
                  ),
                },
                {
                  // The heading was "Sentiment (＋/●/－)" — symbols a screen
                  // reader cannot convey — and the cell separated three numbers
                  // by slashes, distinguishing them by colour alone. Each figure
                  // now carries its own visible label.
                  header: 'Sentiment',
                  cell: (r) => (
                    <span className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                      <span className="text-success">
                        {r.positive}
                        <span className="ml-1 text-[11px] text-muted">pos</span>
                      </span>
                      <span className="text-ink-soft">
                        {r.neutral}
                        <span className="ml-1 text-[11px] text-muted">neu</span>
                      </span>
                      <span className="text-danger">
                        {r.negative}
                        <span className="ml-1 text-[11px] text-muted">neg</span>
                      </span>
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </div>
      )}
    </>
  );
}

function SentimentBar({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: string;
}) {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="text-ink">
          {count} · {pct}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
