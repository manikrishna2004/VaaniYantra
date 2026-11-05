'use client';

import { useState } from 'react';
import { AlertTriangle, Plus, ShieldCheck, X } from 'lucide-react';
import { Button, Field, Input, Select } from '@/components/ui';
import { useToast } from '@/components/Feedback';
import { ALLERGY_SEVERITIES, type AllergyStatus } from '@/lib/patients/allergies';

// Allergies, put where a clinician cannot miss them.
//
// This renders twice on the patient page on purpose: once under the header, and
// again immediately above the Prescription field. The second one is the one
// that matters — the moment of harm is when a drug is being typed, not when the
// page was opened five minutes earlier.

export function AllergyBanner({
  patientId,
  status,
  canManage,
  compact,
  onChange,
}: {
  patientId: string;
  status: AllergyStatus;
  canManage: boolean;
  /** The tighter variant that sits above the prescription field. */
  compact?: boolean;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ substance: '', reaction: '', severity: 'moderate' });
  const toast = useToast();

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/patients/${patientId}/allergies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        toast(b.error || 'Could not save that.', 'error');
        return false;
      }
      onChange();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function retire(allergyId: string) {
    const res = await fetch(`/api/patients/${patientId}/allergies?allergyId=${allergyId}`, { method: 'DELETE' });
    if (res.ok) onChange();
    else toast('Could not remove that.', 'error');
  }

  async function addAllergy(e: React.FormEvent) {
    e.preventDefault();
    if (!form.substance.trim()) return;
    if (await post(form)) {
      setForm({ substance: '', reaction: '', severity: 'moderate' });
      setAdding(false);
      toast('Allergy recorded.', 'success');
    }
  }

  const known = status.state === 'known';
  const unknown = status.state === 'unknown';

  return (
    <div
      className={[
        'rounded-xl border px-3.5 py-3',
        known
          ? 'border-danger/40 bg-danger/10'
          : unknown
            ? 'border-warning/30 bg-warning/10'
            : 'border-border bg-surface-2',
        compact ? 'text-xs' : 'text-sm',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {known ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          ) : unknown ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          ) : (
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          )}
          <div className="min-w-0">
            {known && (
              <>
                <span className="font-semibold uppercase tracking-wide text-danger">Allergies</span>
                <ul className="mt-1 space-y-0.5">
                  {status.items.map((a) => (
                    <li key={a.id} className="flex items-center gap-1.5 text-ink">
                      <span className="font-medium">{a.substance}</span>
                      <span className="text-muted">
                        ({a.severity}
                        {a.reaction ? ` — ${a.reaction}` : ''})
                      </span>
                      {canManage && !compact && (
                        <button
                          type="button"
                          onClick={() => retire(a.id)}
                          aria-label={`Remove ${a.substance}`}
                          className="text-muted transition hover:text-ink"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {unknown && (
              <div className="text-warning">
                <span className="font-semibold">Allergies not recorded.</span>{' '}
                {/* "Not asked" is not "none" — say so, and make recording the
                    answer a single click, or every patient stays here forever. */}
                <span className="text-ink-soft">Ask the patient before prescribing.</span>
              </div>
            )}
            {status.state === 'none-known' && <span className="text-muted">No known allergies.</span>}
          </div>
        </div>

        {canManage && !adding && (
          <div className="flex shrink-0 gap-1.5">
            {unknown && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ action: 'none-known' })}>
                No known allergies
              </Button>
            )}
            <Button size="sm" variant={known ? 'secondary' : 'primary'} onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        )}
      </div>

      {adding && canManage && (
        <form onSubmit={addAllergy} className="mt-3 grid gap-2 sm:grid-cols-[1.4fr_1.4fr_1fr_auto] sm:items-end">
          <Field label="Allergic to">
            <Input
              autoFocus
              value={form.substance}
              onChange={(e) => setForm((f) => ({ ...f, substance: e.target.value }))}
              placeholder="Penicillin"
              required
            />
          </Field>
          <Field label="Reaction">
            <Input
              value={form.reaction}
              onChange={(e) => setForm((f) => ({ ...f, reaction: e.target.value }))}
              placeholder="rash, swelling"
            />
          </Field>
          <Field label="Severity">
            <Select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
              {ALLERGY_SEVERITIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={busy || !form.substance.trim()}>
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
