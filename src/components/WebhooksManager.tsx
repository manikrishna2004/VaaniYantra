'use client';

import { useEffect, useState } from 'react';
import { Card, Button, Badge, Input, Field, Spinner } from '@/components/ui';
import { useConfirm } from '@/components/Feedback';

// Client-safe copy of the event catalogue (the server lib imports prisma).
// Keep in sync with WEBHOOK_EVENTS in src/lib/webhooks.ts.
const EVENTS = [
  { key: 'call.completed', label: 'Call completed', hint: 'A call finished — includes summary, sentiment, collected data.' },
  { key: 'call.failed', label: 'Call failed', hint: 'A call ended without connecting (failed / busy / no answer).' },
  {
    key: 'appointment.created',
    label: 'Appointment booked',
    hint: 'An agent booked on a call, or a patient booked in the chatbot. Use this to mirror bookings into your own system.',
  },
  { key: 'appointment.cancelled', label: 'Appointment cancelled', hint: 'A booking was cancelled — free the slot on your side.' },
  { key: 'appointment.rescheduled', label: 'Appointment rescheduled', hint: 'A booking moved to a new time.' },
  { key: 'visit.recorded', label: 'Consultation recorded', hint: 'A prescription / visit record was filed against a patient.' },
] as const;

type Webhook = {
  id: string;
  type: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  secret: string;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  failureCount: number;
};

export function WebhooksManager({ canManage }: { canManage: boolean }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<'generic' | 'slack'>('generic');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(['call.completed']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const confirm = useConfirm();

  async function load() {
    const res = await fetch('/api/webhooks');
    const data = await res.json();
    if (Array.isArray(data)) setHooks(data);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  function toggleEvent(list: string[], key: string, set: (v: string[]) => void) {
    set(list.includes(key) ? list.filter((e) => e !== key) : [...list, key]);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, url, description: description || null, events }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b?.error?.fieldErrors?.url?.[0] || b?.error?.formErrors?.[0] || 'Could not add webhook');
      return;
    }
    setType('generic');
    setUrl('');
    setDescription('');
    setEvents(['call.completed']);
    await load();
  }

  async function patch(id: string, data: Partial<Webhook>) {
    await fetch(`/api/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await load();
  }

  async function remove(id: string) {
    if (!(await confirm({ title: 'Delete this webhook?', confirmLabel: 'Delete', danger: true }))) return;
    await fetch(`/api/webhooks/${id}`, { method: 'DELETE' });
    await load();
  }

  async function test(id: string) {
    setTestResult((r) => ({ ...r, [id]: 'Sending…' }));
    const res = await fetch(`/api/webhooks/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const r = await res.json().catch(() => ({}));
    setTestResult((t) => ({
      ...t,
      [id]: r.ok ? `✓ delivered (HTTP ${r.status})` : `✗ ${r.error || 'failed'}${r.status ? ` (HTTP ${r.status})` : ''}`,
    }));
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="h-display text-xl font-semibold">Webhooks</h2>
        <p className="mt-1 text-sm text-muted">
          Notify an external system when calls finish — a signed JSON POST to your endpoint, or a formatted
          message to a <span className="text-ink-soft">Slack</span> channel. For generic endpoints, verify the{' '}
          <code className="text-ink-soft">X-VaaniYantra-Signature</code> header (HMAC-SHA256 of the body, keyed by the
          webhook secret).
        </p>
      </div>

      {canManage && (
        <Card>
          <h3 className="mb-3 text-sm font-medium text-ink">Add a webhook</h3>
          <form onSubmit={add} className="space-y-3">
            <div>
              <label className="label">Destination</label>
              <div className="flex gap-2">
                {(['generic', 'slack'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                      type === t ? 'border-primary text-ink' : 'border-border text-muted hover:text-ink'
                    }`}
                  >
                    {t === 'generic' ? 'Generic JSON endpoint' : 'Slack channel'}
                  </button>
                ))}
              </div>
            </div>
            <Field
              label={type === 'slack' ? 'Slack Incoming Webhook URL' : 'Endpoint URL'}
              hint={
                type === 'slack'
                  ? 'In Slack: Apps → Incoming Webhooks → Add to a channel, then paste the https://hooks.slack.com/services/… URL here. We post a formatted message.'
                  : 'We POST a signed JSON payload here on each subscribed event.'
              }
            >
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={
                  type === 'slack'
                    ? 'https://hooks.slack.com/services/T000/B000/XXXX'
                    : 'https://example.com/hooks/vaaniyantra'
                }
                required
              />
            </Field>
            <Field label="Description" hint="Optional — for your reference.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Slack alerts" />
            </Field>
            <div>
              <label className="label">Events</label>
              <div className="space-y-1.5">
                {EVENTS.map((ev) => (
                  <label key={ev.key} className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      checked={events.includes(ev.key)}
                      onChange={() => toggleEvent(events, ev.key, setEvents)}
                      className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <span>
                      <span className="text-ink">{ev.label}</span>{' '}
                      <span className="text-xs text-muted">— {ev.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy || events.length === 0}>
              {busy ? 'Adding…' : 'Add webhook'}
            </Button>
          </form>
        </Card>
      )}

      {loading ? (
        <Spinner />
      ) : hooks.length === 0 ? (
        <p className="text-sm text-muted">No webhooks yet.</p>
      ) : (
        <div className="space-y-3">
          {hooks.map((h) => (
            <Card key={h.id} className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={h.type === 'slack' ? 'primary' : 'neutral'}>
                      {h.type === 'slack' ? 'Slack' : 'JSON'}
                    </Badge>
                    <span className="break-all font-mono text-sm text-ink">{h.url}</span>
                    <Badge tone={h.enabled ? 'success' : 'neutral'}>{h.enabled ? 'enabled' : 'disabled'}</Badge>
                  </div>
                  {h.description && <p className="mt-1 text-xs text-muted">{h.description}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {h.events.map((e) => (
                      <Badge key={e} tone="accent">
                        {e}
                      </Badge>
                    ))}
                  </div>
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => test(h.id)}>
                      Send test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => patch(h.id, { enabled: !h.enabled })}>
                      {h.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(h.id)}>
                      Delete
                    </Button>
                  </div>
                )}
              </div>

              {/* Signing secret (generic only — Slack doesn't verify a signature) */}
              {h.type !== 'slack' && (
                <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted">Signing secret</span>
                    <button onClick={() => setRevealed((r) => ({ ...r, [h.id]: !r[h.id] }))} className="text-primary hover:underline">
                      {revealed[h.id] ? 'Hide' : 'Reveal'}
                    </button>
                  </div>
                  <code className="mt-1 block break-all text-ink-soft">
                    {revealed[h.id] ? h.secret : '•'.repeat(24)}
                  </code>
                </div>
              )}

              {/* Delivery status */}
              <div className="text-xs text-muted">
                {testResult[h.id] && <div className="mb-1 text-ink-soft">{testResult[h.id]}</div>}
                {h.lastDeliveryAt ? (
                  <span>
                    Last delivery:{' '}
                    <span className={h.lastStatus && h.lastStatus >= 200 && h.lastStatus < 300 ? 'text-success' : 'text-danger'}>
                      {h.lastStatus ? `HTTP ${h.lastStatus}` : h.lastError || 'error'}
                    </span>{' '}
                    · {new Date(h.lastDeliveryAt).toLocaleString()}
                    {h.failureCount > 0 && ` · ${h.failureCount} consecutive failure${h.failureCount === 1 ? '' : 's'}`}
                  </span>
                ) : (
                  <span>No deliveries yet.</span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
