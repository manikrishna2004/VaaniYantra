import Link from 'next/link';
import {
  PhoneCall,
  Bot,
  Clock,
  CheckCircle2,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { Card, Badge } from '@/components/ui';
import { CallVolumeChart } from '@/components/CallVolumeChart';
import { formatDuration, formatRelativeTime } from '@/lib/utils';

// Presentational dashboard. The real page (server) passes live data; the public
// /preview route passes mock data — so both render byte-identical UI.
//
// This is an operator's screen, not a document: it is scanned, not read. So the
// order is "is anything wrong?" → "what are the numbers?" → "what just
// happened?", and state is carried by form (tone, stripe, icon) as well as by
// the number, so a problem is visible without reading any of it.

export type DashboardData = {
  totalCalls: number;
  inbound: number;
  outbound: number;
  totalDuration: number;
  avgDuration: number;
  completionRate: number;
  agentCount: number;
  numberCount: number;
  documentCount: number;
  daily: { date: string; count: number }[];
  recent: {
    id: string;
    direction: string;
    fromNumber: string;
    toNumber: string;
    status: string;
    createdAt: Date;
    agent: { name: string | null } | null;
  }[];
  sentiment: { positive: number; neutral: number; negative: number };
  // Optional so the mock /preview route can omit it.
  overage?: { minutes: number; amountInr: number; ratePerMinute: number | null };
};

const FAILED = ['FAILED', 'NO_ANSWER', 'BUSY'];

function statusTone(status: string) {
  if (status === 'COMPLETED') return 'success' as const;
  if (FAILED.includes(status)) return 'danger' as const;
  if (['IN_PROGRESS', 'RINGING', 'QUEUED'].includes(status)) return 'warning' as const;
  return 'neutral' as const;
}

/** Deterministic heights/delays so the server and client markup match. */
function Waveform({ bars = 36, className = '' }: { bars?: number; className?: string }) {
  return (
    <div className={`waveform ${className}`} aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const h = 30 + Math.round(50 * Math.abs(Math.sin(i * 1.1)));
        const delay = ((i * 83) % 900) / 1000;
        return <span key={i} style={{ height: `${h}%`, animationDelay: `${delay}s` }} />;
      })}
    </div>
  );
}

/**
 * Week-over-week change, derived from the 14-day series the page already loads
 * — no extra query. A bare count can't answer "is this good?"; a direction can.
 * Returns null when there is no prior week to compare against, so we show
 * nothing rather than a meaningless "+100%".
 */
function trend(daily: { count: number }[]): { pct: number; up: boolean } | null {
  if (daily.length < 14) return null;
  const sum = (a: { count: number }[]) => a.reduce((n, d) => n + d.count, 0);
  const recent = sum(daily.slice(-7));
  const prior = sum(daily.slice(-14, -7));
  if (prior === 0) return null;
  const pct = Math.round(((recent - prior) / prior) * 100);
  if (pct === 0) return null;
  return { pct: Math.abs(pct), up: pct > 0 };
}

/** Completion rate carries meaning, so it also carries tone. */
function completionTone(rate: number, hasCalls: boolean) {
  if (!hasCalls) return 'neutral' as const;
  if (rate < 60) return 'danger' as const;
  if (rate < 80) return 'warning' as const;
  return 'success' as const;
}

export function DashboardView({
  data: d,
  canBill = false,
}: {
  data: DashboardData;
  /** billing:manage. An admin sees the dashboard but cannot open billing. */
  canBill?: boolean;
}) {
  const hasCalls = d.totalCalls > 0;
  const volumeTrend = trend(d.daily);
  const compTone = completionTone(d.completionRate, hasCalls);
  const recentFailures = d.recent.filter((c) => FAILED.includes(c.status)).length;
  const overageMinutes = d.overage?.minutes ?? 0;

  // Everything that wants the operator's attention, resolved once so the header
  // can state a single verdict instead of scattering warnings down the page.
  const alerts: { tone: 'danger' | 'warning'; text: React.ReactNode }[] = [];
  if (overageMinutes > 0) {
    alerts.push({
      tone: 'warning',
      text: (
        <>
          Included minutes used up — {overageMinutes.toLocaleString('en-IN')} extra minute
          {overageMinutes === 1 ? '' : 's'} will add{' '}
          <span className="font-medium text-ink">₹{(d.overage?.amountInr ?? 0).toLocaleString('en-IN')}</span> to
          this month&rsquo;s bill.{' '}
          {canBill ? (
            <Link href="/settings/billing" className="font-medium text-primary underline underline-offset-2">
              See billing
            </Link>
          ) : (
            // An admin should still know the clinic is into overage — they run
            // the place. They just cannot act on it, so do not offer a link
            // that 404s for them.
            <span className="text-muted">The practice owner can review the plan.</span>
          )}
        </>
      ),
    });
  }
  if (recentFailures > 0) {
    alerts.push({
      tone: 'danger',
      text: (
        <>
          {recentFailures} of the last {d.recent.length} calls didn&rsquo;t connect.{' '}
          <Link href="/calls" className="font-medium text-primary underline underline-offset-2">
            Review call history
          </Link>
        </>
      ),
    });
  }
  if (hasCalls && d.completionRate < 80) {
    alerts.push({
      tone: d.completionRate < 60 ? 'danger' : 'warning',
      text: <>Only {d.completionRate}% of calls are completing. Check agent settings and number routing.</>,
    });
  }

  const stats = [
    {
      label: 'Total calls',
      value: d.totalCalls.toLocaleString('en-IN'),
      sub: `${d.inbound.toLocaleString('en-IN')} in · ${d.outbound.toLocaleString('en-IN')} out`,
      icon: PhoneCall,
      tone: 'neutral' as const,
      trend: volumeTrend,
    },
    {
      label: 'Talk time',
      value: formatDuration(d.totalDuration),
      sub: `${formatDuration(d.avgDuration)} average`,
      icon: Clock,
      tone: 'neutral' as const,
      trend: null,
    },
    {
      label: 'Completion',
      value: hasCalls ? `${d.completionRate}%` : '—',
      sub: hasCalls ? 'connected and finished' : 'no calls yet',
      icon: CheckCircle2,
      tone: compTone,
      trend: null,
    },
    {
      label: 'Agents',
      value: String(d.agentCount),
      sub: `${d.numberCount} number${d.numberCount === 1 ? '' : 's'} · ${d.documentCount} doc${d.documentCount === 1 ? '' : 's'}`,
      icon: Bot,
      tone: 'neutral' as const,
      trend: null,
    },
  ];

  const sentimentTotal = d.sentiment.positive + d.sentiment.neutral + d.sentiment.negative;

  return (
    <div className="space-y-6">
      {/* ── Status header ────────────────────────────────────────────────────
          Replaces a decorative hero that restated the page name. An operator's
          first question is "is anything wrong?", so that is what it answers. */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="h-display text-display-md font-semibold">Overview</h1>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                alerts.length
                  ? 'bg-warning/10 text-warning'
                  : d.agentCount > 0
                    ? 'bg-success/10 text-success'
                    : 'bg-surface-2 text-muted'
              }`}
            >
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                {!alerts.length && d.agentCount > 0 && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75 motion-reduce:hidden" />
                )}
                <span
                  className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                    alerts.length ? 'bg-warning' : d.agentCount > 0 ? 'bg-success' : 'bg-muted'
                  }`}
                />
              </span>
              {alerts.length
                ? `${alerts.length} thing${alerts.length > 1 ? 's' : ''} need attention`
                : d.agentCount > 0
                  ? `${d.agentCount} agent${d.agentCount > 1 ? 's' : ''} live`
                  : 'No agents yet'}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted">
            {hasCalls
              ? `${d.totalCalls.toLocaleString('en-IN')} calls handled to date.`
              : 'Create an agent and connect a number to start taking calls.'}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="hidden h-9 w-24 text-primary/50 lg:block" aria-hidden="true">
            <Waveform bars={22} />
          </div>
          <Link
            href="/agents/new"
            className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition-colors duration-fast ease-standard hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <Bot className="h-4 w-4" aria-hidden="true" />
            New agent
          </Link>
        </div>
      </header>

      {/* ── Alerts ─────────────────────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((a, i) => (
            <div
              key={i}
              className={`flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${
                a.tone === 'danger'
                  ? 'border-danger/30 bg-danger/[0.07] text-ink-soft'
                  : 'border-warning/30 bg-warning/[0.07] text-ink-soft'
              }`}
            >
              <AlertTriangle
                className={`mt-0.5 h-4 w-4 shrink-0 ${a.tone === 'danger' ? 'text-danger' : 'text-warning'}`}
                aria-hidden="true"
              />
              <p className="min-w-0">{a.text}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Metrics ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label} className="relative overflow-hidden p-5">
              {/* Severity stripe: a struggling metric is visible before it is read. */}
              {s.tone !== 'neutral' && (
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 w-0.5 ${
                    s.tone === 'danger' ? 'bg-danger' : s.tone === 'warning' ? 'bg-warning' : 'bg-success'
                  }`}
                />
              )}
              <div className="flex items-start justify-between gap-2">
                <span className="eyebrow">{s.label}</span>
                <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                {/* tabular-nums so the four tiles' digits line up as a row. */}
                <span className="h-display text-display-md font-semibold tabular-nums">{s.value}</span>
                {s.trend && (
                  <span
                    className={`inline-flex items-center gap-0.5 text-xs font-medium ${
                      s.trend.up ? 'text-success' : 'text-muted'
                    }`}
                    title="versus the previous 7 days"
                  >
                    {s.trend.up ? (
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
                    )}
                    {s.trend.pct}%
                    <span className="sr-only">
                      {s.trend.up ? 'up' : 'down'} versus the previous 7 days
                    </span>
                  </span>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-muted">{s.sub}</div>
            </Card>
          );
        })}
      </div>

      {/* ── Volume + recent ────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="p-6 lg:col-span-3">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
            <h2 className="h-display text-display-sm font-semibold">Call volume</h2>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
              Last 14 days
            </span>
          </div>
          {!hasCalls ? (
            <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
              <div className="h-10 w-36 text-border-strong" aria-hidden="true">
                <Waveform bars={24} />
              </div>
              <p className="max-w-xs text-sm text-muted">
                No calls yet. Once your agent takes its first call, volume shows up here.
              </p>
            </div>
          ) : (
            <>
              <CallVolumeChart data={d.daily} />
              {sentimentTotal > 0 && (
                <div className="mt-6 border-t border-border pt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="eyebrow">Caller sentiment</span>
                    <span className="text-xs text-muted tabular-nums">
                      {Math.round((d.sentiment.positive / sentimentTotal) * 100)}% positive
                    </span>
                  </div>
                  {/* A real stacked bar. The previous version used coloured ●
                      characters, which encoded meaning in colour alone. */}
                  <div className="flex h-2 overflow-hidden rounded-full bg-surface-2">
                    {(
                      [
                        ['positive', d.sentiment.positive, 'bg-success'],
                        ['neutral', d.sentiment.neutral, 'bg-muted'],
                        ['negative', d.sentiment.negative, 'bg-danger'],
                      ] as const
                    ).map(([key, count, cls]) =>
                      count > 0 ? (
                        <div
                          key={key}
                          className={cls}
                          style={{ width: `${(count / sentimentTotal) * 100}%` }}
                          title={`${count} ${key}`}
                        />
                      ) : null,
                    )}
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    {(
                      [
                        ['Positive', d.sentiment.positive, 'bg-success'],
                        ['Neutral', d.sentiment.neutral, 'bg-muted'],
                        ['Negative', d.sentiment.negative, 'bg-danger'],
                      ] as const
                    ).map(([label, count, cls]) => (
                      <span key={label} className="inline-flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${cls}`} aria-hidden="true" />
                        {label} <span className="text-ink-soft tabular-nums">{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </Card>

        <Card className="p-6 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="h-display text-display-sm font-semibold">Recent calls</h2>
            {d.recent.length > 0 && (
              <Link
                href="/calls"
                className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-primary transition-colors duration-fast hover:text-primary-hover"
              >
                View all
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            )}
          </div>
          {d.recent.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">
              Calls will appear here as they come in.
            </p>
          ) : (
            <ul className="-mx-2 divide-y divide-border">
              {d.recent.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/calls/${c.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors duration-fast hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                          FAILED.includes(c.status) ? 'bg-danger/10 text-danger' : 'bg-surface-2 text-muted'
                        }`}
                        aria-hidden="true"
                      >
                        {c.direction === 'INBOUND' ? (
                          <ArrowDownRight className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink tabular-nums">
                          {c.direction === 'INBOUND' ? c.fromNumber : c.toNumber}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {c.agent?.name ?? 'No agent'} · {formatRelativeTime(c.createdAt)}
                        </span>
                      </span>
                    </span>
                    <Badge tone={statusTone(c.status)}>{c.status.toLowerCase().replace(/_/g, ' ')}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
