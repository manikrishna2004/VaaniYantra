import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { PageHeader, Badge, Button } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { SentimentBadge } from '@/components/SentimentBadge';
import { PlaceCallPanel } from '@/components/PlaceCallPanel';
import { formatDuration, formatRelativeTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function statusTone(status: string) {
  if (status === 'COMPLETED') return 'success' as const;
  if (status === 'FAILED' || status === 'NO_ANSWER' || status === 'BUSY') return 'danger' as const;
  if (status === 'IN_PROGRESS' || status === 'RINGING' || status === 'QUEUED') return 'warning' as const;
  return 'neutral' as const;
}

const STATUS_OPTIONS = [
  'COMPLETED',
  'IN_PROGRESS',
  'FAILED',
  'NO_ANSWER',
  'BUSY',
  'QUEUED',
  'RINGING',
];

export default async function CallsPage(
  props: {
    searchParams: Promise<{ agentId?: string; status?: string; direction?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const { workspace } = await requireWorkspace();

  const fAgent = searchParams.agentId || '';
  const fStatus = STATUS_OPTIONS.includes(searchParams.status ?? '') ? searchParams.status! : '';
  const fDirection = ['INBOUND', 'OUTBOUND'].includes(searchParams.direction ?? '')
    ? searchParams.direction!
    : '';

  const where = {
    workspaceId: workspace.id,
    ...(fAgent ? { agentId: fAgent } : {}),
    ...(fStatus ? { status: fStatus } : {}),
    ...(fDirection ? { direction: fDirection } : {}),
  };

  const [calls, agents, numbers] = await Promise.all([
    prisma.call.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { agent: { select: { name: true } } },
    }),
    prisma.agent.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.phoneNumber.findMany({
      where: { workspaceId: workspace.id },
      select: { id: true, e164: true, label: true },
    }),
  ]);

  return (
    <>
      <PageHeader title="Call History" subtitle="Every inbound and outbound call, with transcripts and recordings." />

      <div className="mb-6">
        <PlaceCallPanel agents={agents} numbers={numbers} />
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <select name="agentId" defaultValue={fAgent} className="input cursor-pointer w-auto">
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={fStatus} className="input cursor-pointer w-auto">
          <option value="">Any status</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase().replace('_', ' ')}
            </option>
          ))}
        </select>
        <select name="direction" defaultValue={fDirection} className="input cursor-pointer w-auto">
          <option value="">In &amp; out</option>
          <option value="INBOUND">Inbound</option>
          <option value="OUTBOUND">Outbound</option>
        </select>
        <Button type="submit" variant="secondary" size="sm">
          Filter
        </Button>
        {(fAgent || fStatus || fDirection) && (
          <Link href="/calls" className="px-2 py-1.5 text-xs text-muted hover:text-ink">
            Clear
          </Link>
        )}
      </form>

      <DataTable
        rows={calls}
        rowKey={(c) => c.id}
        caption="Call history — direction, number, agent, status, sentiment, duration and time"
        // The whole row is navigable now. Previously only the first two cells
        // wrapped a link, so most of a row that visibly highlighted on hover
        // did nothing when clicked.
        rowHref={(c) => `/calls/${c.id}`}
        empty={{
          title: 'No calls match',
          description:
            'Try clearing the filters, placing an outbound call, or pointing a phone number at an agent.',
        }}
        columns={[
          {
            header: 'Direction',
            cell: (c) => (
              <Badge tone={c.direction === 'INBOUND' ? 'accent' : 'primary'}>
                {c.direction === 'INBOUND' ? '↓ in' : '↑ out'}
              </Badge>
            ),
          },
          {
            header: 'Number',
            cell: (c) => (
              <span className="text-ink tabular-nums">
                {c.direction === 'INBOUND' ? c.fromNumber : c.toNumber}
              </span>
            ),
          },
          { header: 'Agent', cell: (c) => <span className="text-muted">{c.agent?.name ?? '—'}</span> },
          {
            header: 'Status',
            cell: (c) => <Badge tone={statusTone(c.status)}>{c.status.toLowerCase().replace(/_/g, ' ')}</Badge>,
          },
          {
            header: 'Sentiment',
            hideOnMobile: true,
            cell: (c) => <SentimentBadge sentiment={c.sentiment} />,
          },
          {
            header: 'Duration',
            numeric: true,
            cell: (c) => <span className="text-muted">{formatDuration(c.durationSec)}</span>,
          },
          {
            header: 'When',
            hideOnMobile: true,
            cell: (c) => <span className="whitespace-nowrap text-muted">{formatRelativeTime(c.createdAt)}</span>,
          },
        ]}
      />
    </>
  );
}
