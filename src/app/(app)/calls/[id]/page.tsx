import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { PageHeader, Card, Badge } from '@/components/ui';
import { SentimentBadge } from '@/components/SentimentBadge';
import { AutoRefresh } from '@/components/AutoRefresh';
import { getLanguage } from '@/lib/constants';
import { formatDuration, formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function statusTone(status: string) {
  if (status === 'COMPLETED') return 'success' as const;
  if (status === 'FAILED' || status === 'NO_ANSWER' || status === 'BUSY') return 'danger' as const;
  if (status === 'IN_PROGRESS' || status === 'RINGING' || status === 'QUEUED') return 'warning' as const;
  return 'neutral' as const;
}

function msToClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default async function CallDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { workspace } = await requireWorkspace();
  const call = await prisma.call.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    include: {
      agent: { select: { name: true, language: true } },
      phoneNumber: { select: { e164: true, label: true } },
      transcript: { orderBy: { atMs: 'asc' } },
    },
  });
  if (!call) notFound();

  const inProgress = ['QUEUED', 'RINGING', 'IN_PROGRESS'].includes(call.status);
  const lang = getLanguage(call.agent?.language ?? call.language);

  const meta = [
    { label: 'Direction', value: call.direction === 'INBOUND' ? 'Inbound' : 'Outbound' },
    { label: 'From', value: call.fromNumber },
    { label: 'To', value: call.toNumber },
    { label: 'Agent', value: call.agent?.name ?? '—' },
    { label: 'Language', value: lang?.label ?? call.language },
    { label: 'Duration', value: formatDuration(call.durationSec) },
    { label: 'Started', value: call.startedAt ? formatDateTime(call.startedAt) : '—' },
    { label: 'Created', value: formatDateTime(call.createdAt) },
  ];

  return (
    <>
      <AutoRefresh active={inProgress} />
      <PageHeader
        title="Call details"
        subtitle={`${call.direction === 'INBOUND' ? call.fromNumber : call.toNumber}`}
        action={
          <div className="flex items-center gap-4">
            <a
              href={`/api/calls/${call.id}/transcript`}
              download
              className="text-sm text-muted transition hover:text-ink"
            >
              Download record
            </a>
            <Link href="/calls" className="text-sm text-muted hover:text-ink">
              ← Back to calls
            </Link>
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge tone={statusTone(call.status)}>{call.status.toLowerCase().replace('_', ' ')}</Badge>
        <SentimentBadge sentiment={call.sentiment} />
        {inProgress && <span className="text-xs text-warning">● live — updating automatically</span>}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {call.summary && (
            <Card>
              <h2 className="mb-2 text-sm font-medium text-ink">Summary</h2>
              <p className="text-sm leading-relaxed text-ink/85">{call.summary}</p>
              {Array.isArray(call.topics) && call.topics.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(call.topics as string[]).map((t) => (
                    <Badge key={t} tone="primary">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          )}

          {call.collectedData && typeof call.collectedData === 'object' && (
            <Card>
              <h2 className="mb-3 text-sm font-medium text-ink">Collected information</h2>
              <dl className="grid gap-2 sm:grid-cols-2">
                {Object.entries(call.collectedData as Record<string, unknown>).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                    <dt className="text-[11px] uppercase tracking-wide text-muted">{k.replace(/_/g, ' ')}</dt>
                    <dd className="mt-0.5 text-sm text-ink">
                      {v == null || v === '' ? <span className="text-muted">—</span> : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          <Card>
            <h2 className="mb-4 text-sm font-medium text-ink">Transcript</h2>
            {call.transcript.length === 0 ? (
              <p className="text-sm text-muted">
                {inProgress ? 'Waiting for the conversation to start…' : 'No transcript recorded.'}
              </p>
            ) : (
              <div className="space-y-4">
                {call.transcript.map((t) => {
                  const isAgent = t.role === 'AGENT';
                  const isSystem = t.role === 'SYSTEM';
                  if (isSystem) {
                    return (
                      <div key={t.id} className="text-center text-[11px] text-muted">
                        {t.text}
                      </div>
                    );
                  }
                  return (
                    <div key={t.id} className={isAgent ? 'flex justify-start' : 'flex justify-end'}>
                      <div
                        className={
                          isAgent
                            ? 'max-w-[80%] rounded-2xl rounded-tl-sm bg-surface-2 px-4 py-2.5'
                            : 'max-w-[80%] rounded-2xl rounded-tr-sm bg-primary-soft px-4 py-2.5'
                        }
                      >
                        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                          <span>{isAgent ? 'Agent' : 'Caller'}</span>
                          <span>·</span>
                          <span>{msToClock(t.atMs)}</span>
                        </div>
                        <p className="text-sm leading-relaxed text-ink">{t.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {call.recordingUrl && (
            <Card>
              <h2 className="mb-3 text-sm font-medium text-ink">Recording</h2>
              <audio controls src={`/api/calls/${call.id}/recording`} className="w-full" />
              <p className="mt-2 text-[11px] text-muted">
                Mock mode generates a silent placeholder. Real calls store the provider recording.
              </p>
            </Card>
          )}

          <Card>
            <h2 className="mb-3 text-sm font-medium text-ink">Details</h2>
            <dl className="space-y-2.5 text-sm">
              {meta.map((m) => (
                <div key={m.label} className="flex justify-between gap-3">
                  <dt className="text-muted">{m.label}</dt>
                  <dd className="text-right text-ink">{m.value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
