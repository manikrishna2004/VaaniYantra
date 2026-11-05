'use client';

import { useEffect, useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Card, Badge, Spinner, EmptyState } from '@/components/ui';

type Outcome = {
  id: string;
  type: string;
  vertical: string | null;
  fields: Record<string, string>;
  callerName: string | null;
  callerNumber: string | null;
  createdAt: string;
  agent: { id: string; name: string } | null;
};

const TYPE_TONE: Record<string, 'primary' | 'success' | 'accent' | 'neutral' | 'danger'> = {
  lead: 'primary',
  appointment: 'success',
  reservation: 'success',
  order: 'accent',
  callback: 'neutral',
  enquiry: 'neutral',
  // A patient described an emergency in the chatbot. Must not look like a lead.
  emergency: 'danger',
};

function fmt(iso: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

// Humanize a captured field key ("partySize" -> "Party size") for display.
function labelize(key: string) {
  const s = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function OutcomesFeed() {
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [type, setType] = useState<string>('all');

  useEffect(() => {
    fetch('/api/outcomes')
      .then((r) => (r.ok ? r.json() : []))
      .then(setOutcomes)
      .catch(() => setOutcomes([]));
  }, []);

  const types = useMemo(() => {
    const set = new Set<string>();
    (outcomes ?? []).forEach((o) => set.add(o.type));
    return Array.from(set).sort();
  }, [outcomes]);

  if (!outcomes) return <Spinner />;

  if (outcomes.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No updates yet"
        description="When an agent captures an enquiry, a callback request or an appointment request on a call, it appears here — and is texted to you as it happens."
      />
    );
  }

  const shown = type === 'all' ? outcomes : outcomes.filter((o) => o.type === type);

  return (
    <div className="space-y-4">
      {types.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {['all', ...types].map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition ${
                type === t ? 'bg-primary text-on-primary' : 'border border-border bg-surface text-ink-soft hover:border-primary/50'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {shown.map((o) => {
          const entries = Object.entries(o.fields || {}).filter(([, v]) => v != null && String(v).trim());
          return (
            <Card key={o.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge tone={TYPE_TONE[o.type] ?? 'neutral'}>{o.type}</Badge>
                  <span className="text-sm font-medium text-ink">{o.callerName || o.fields?.name || 'Caller'}</span>
                  {o.callerNumber && <span className="text-xs text-muted">{o.callerNumber}</span>}
                </div>
                <span className="text-xs text-muted">
                  {fmt(o.createdAt)}
                  {o.agent ? ` · ${o.agent.name}` : ''}
                </span>
              </div>
              {entries.length > 0 && (
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                  {entries.map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-xs">
                      <dt className="shrink-0 text-muted">{labelize(k)}:</dt>
                      <dd className="min-w-0 truncate text-ink-soft">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
