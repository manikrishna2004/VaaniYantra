'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UserRound, Plus, Search } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Field, Spinner, EmptyState } from '@/components/ui';
import { ExportMenu } from '@/components/ExportMenu';
import { useToast } from '@/components/Feedback';
import { formatAgeShort, sexLabel, SEXES } from '@/lib/patients/age';

type Patient = {
  id: string;
  uhid: string | null;
  name: string;
  phone: string;
  dateOfBirth: string | null;
  sex: string | null;
  lastSeenAt: string | null;
  portalRevokedAt: string | null;
  createdAt: string;
  _count: { visits: number };
};

export function PatientsManager({ canManage }: { canManage: boolean }) {
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', dateOfBirth: '', sex: '' });
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function load(query = '') {
    const res = await fetch(`/api/patients${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    setPatients(res.ok ? await res.json() : []);
  }
  // Also does the initial load (q is empty on mount). Debounced so typing a
  // name doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => load(q.trim()), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/patients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body.error || 'Could not add that patient.', 'error');
        return;
      }
      toast('Patient added.', 'success');
      setForm({ name: '', phone: '', dateOfBirth: '', sex: '' });
      setAdding(false);
      load(q.trim());
    } finally {
      setSaving(false);
    }
  }

  if (!patients) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, mobile or patient number"
            aria-label="Search patients"
            className="pl-9"
          />
        </div>
        <ExportMenu range="all" only="patients" size="md" />
        {canManage && (
          <Button variant="secondary" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            Add patient
          </Button>
        )}
      </div>

      {adding && canManage && (
        <Card>
          <form onSubmit={add} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Ravi Kumar"
                  required
                />
              </Field>
              <Field label="Mobile number" hint="This is what they sign in to your chatbot with.">
                <Input
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="98765 43210"
                  required
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Date of birth" hint="Dosing and normal ranges both depend on age.">
                <Input
                  type="date"
                  value={form.dateOfBirth}
                  onChange={(e) => setForm((f) => ({ ...f, dateOfBirth: e.target.value }))}
                />
              </Field>
              <Field label="Sex">
                <Select value={form.sex} onChange={(e) => setForm((f) => ({ ...f, sex: e.target.value }))}>
                  <option value="">Not recorded</option>
                  {SEXES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" disabled={saving}>
                {saving ? <Spinner /> : 'Save'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {patients.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title={q ? 'No matches' : 'No patients yet'}
          description={
            q
              ? 'Nothing matched that search.'
              : 'Patients appear here automatically the first time an agent books them an appointment. You can also add a walk-in by hand.'
          }
        />
      ) : (
        <div className="space-y-2">
          {patients.map((p) => (
            <Link key={p.id} href={`/patients/${p.id}`} className="block">
              <Card className="tile-interactive flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                    {p.uhid && (
                      <code className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] tabular-nums text-muted">
                        {p.uhid}
                      </code>
                    )}
                    {p.portalRevokedAt && <Badge tone="warning">portal blocked</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {[formatAgeShort(p.dateOfBirth), sexLabel(p.sex)].filter(Boolean).join(' ')}
                    {p.dateOfBirth || p.sex ? ' · ' : ''}
                    {p.phone} · {p._count.visits} {p._count.visits === 1 ? 'visit' : 'visits'}
                    {p.lastSeenAt ? ` · opened chat ${fmt(p.lastSeenAt)}` : ' · has not opened the chat'}
                  </div>
                </div>
                <span className="text-xs text-muted">View</span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function fmt(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(iso));
}
