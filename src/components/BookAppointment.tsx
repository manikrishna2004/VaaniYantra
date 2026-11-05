'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Search, UserPlus } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Spinner } from '@/components/ui';
import { useToast } from '@/components/Feedback';
import { describePatient } from '@/lib/patients/age';

type PatientHit = {
  id: string;
  uhid: string | null;
  name: string;
  phone: string;
  dateOfBirth: string | null;
  sex: string | null;
};
type Slot = { startISO: string; label: string };
type SlotResponse = {
  ok?: boolean;
  error?: string;
  slots?: Slot[];
  message?: string;
  experts?: string[];
  serviceName?: string;
  timezone?: string;
};

// Book a patient in from the front desk.
//
// The patient comes first and everything else follows, because that is the
// order the conversation actually happens in ("Hello, it's Asha Rao"). Staff
// either find an existing patient — who already has a number and a history — or
// register a new one, who is given a number automatically.
export function BookAppointment({ onBooked }: { onBooked?: () => void }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" />
        Book appointment
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Book an appointment"
        description="Find the patient or register a new one. They get a confirmation by text, and the slot goes on the doctor's calendar."
      >
        <BookingForm
          onDone={(msg) => {
            setOpen(false);
            toast(msg, 'success');
            onBooked?.();
          }}
          onCancel={() => setOpen(false)}
        />
      </Modal>
    </>
  );
}

function BookingForm({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  // Patient selection
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PatientHit[] | null>(null);
  const [chosen, setChosen] = useState<PatientHit | null>(null);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  // Slot selection
  const [meta, setMeta] = useState<SlotResponse | null>(null);
  const [expert, setExpert] = useState('');
  const [date, setDate] = useState('');
  const [startISO, setStartISO] = useState('');
  const [manualTime, setManualTime] = useState('');

  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  // Debounced patient search. `seq` guards against an earlier, slower request
  // landing after a later one and overwriting fresher results.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      fetch(`/api/patients?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: PatientHit[]) => {
          if (seq === searchSeq.current) setHits(rows.slice(0, 6));
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Availability, re-read whenever the doctor or the day changes.
  useEffect(() => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (expert) params.set('expert', expert);
    fetch(`/api/appointments/slots?${params}`)
      .then((r) => r.json())
      .then((d: SlotResponse) => {
        setMeta(d);
        setStartISO('');
      })
      .catch(() => setMeta({ ok: false, error: 'Could not read availability.' }));
  }, [date, expert]);

  // A typed time wins over a suggested slot — a front desk regularly has to
  // squeeze someone in at a time the availability list would never offer.
  const effectiveStart = manualTime ? new Date(manualTime).toISOString() : startISO;
  const patientReady = chosen != null || (newName.trim() !== '' && newPhone.trim() !== '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!effectiveStart) {
      setError('Pick a slot, or enter a time.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: chosen?.id,
          customerName: chosen ? undefined : newName.trim(),
          customerNumber: chosen ? undefined : newPhone.trim(),
          startISO: effectiveStart,
          expert: expert || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not book that appointment.');
        return;
      }
      onDone(
        body.patientNo
          ? `Booked ${chosen?.name ?? newName.trim()} (${body.patientNo}) for ${body.when}.`
          : `Booked for ${body.when}.`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Who ── */}
      {chosen ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-3.5 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">
              {chosen.name}
              {chosen.uhid && <span className="ml-2 text-xs tabular-nums text-muted">{chosen.uhid}</span>}
            </div>
            <div className="truncate text-xs text-muted">
              {[describePatient(chosen.dateOfBirth, chosen.sex), chosen.phone].filter(Boolean).join(' · ')}
            </div>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setChosen(null)}>
            Change
          </Button>
        </div>
      ) : (
        <>
          <Field label="Find the patient" hint="Search by name, mobile number or patient number.">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Asha Rao, 98765 43210, SDC-000147"
                className="pl-9"
              />
            </div>
          </Field>

          {hits && hits.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border">
              {hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    setChosen(h);
                    setQuery('');
                    setHits(null);
                  }}
                  className="flex w-full items-center justify-between gap-3 border-b border-border px-3.5 py-2.5 text-left transition last:border-0 hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{h.name}</span>
                    {/* Age and sex here are what let the front desk pick the
                        right person when two family members share a number and
                        a surname. */}
                    <span className="block truncate text-xs text-muted">
                      {[describePatient(h.dateOfBirth, h.sex), h.phone].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {h.uhid && <code className="shrink-0 text-[11px] tabular-nums text-muted">{h.uhid}</code>}
                </button>
              ))}
            </div>
          )}

          {hits && hits.length === 0 && (
            <p className="text-xs text-muted">No patient matches “{query.trim()}”. Register them below.</p>
          )}

          <div className="rounded-xl border border-border bg-surface-2 p-3.5">
            <p className="mb-3 text-xs font-medium text-ink">Or register a new patient</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Patient name">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Asha Rao" />
              </Field>
              <Field label="Mobile number" hint="They get their confirmation and chatbot link here.">
                <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="98765 43210" />
              </Field>
            </div>
            <p className="mt-2 text-xs text-muted">
              A patient number is assigned automatically — you never have to pick one.
            </p>
          </div>
        </>
      )}

      {/* ── When ── */}
      <div className="grid gap-3 sm:grid-cols-2">
        {meta?.experts && meta.experts.length > 0 && (
          <Field label="Doctor">
            <Select value={expert} onChange={(e) => setExpert(e.target.value)}>
              <option value="">Any available</option>
              {meta.experts.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Day" hint="Leave blank for the next open slots.">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>

      <Field label="Open slots" hint={meta?.timezone ? `Times shown in ${meta.timezone}.` : undefined}>
        {!meta ? (
          <Spinner />
        ) : meta.ok === false ? (
          <p className="text-sm text-warning">{meta.error}</p>
        ) : meta.slots && meta.slots.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {meta.slots.map((s) => (
              <button
                key={s.startISO}
                type="button"
                onClick={() => {
                  setStartISO(s.startISO);
                  setManualTime('');
                }}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  startISO === s.startISO && !manualTime
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-ink-soft hover:border-primary/50'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{meta.message ?? 'No open slots.'}</p>
        )}
      </Field>

      <Field
        label="Or set the time yourself"
        hint="Overrides the slot above. Use this to fit someone in outside the usual pattern."
      >
        <Input type="datetime-local" value={manualTime} onChange={(e) => setManualTime(e.target.value)} />
      </Field>

      <Field label="Notes" hint="Goes on the calendar event. Not shown to the patient.">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Follow-up, bring previous reports" />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !patientReady || !effectiveStart}>
          {saving ? <Spinner /> : 'Book appointment'}
        </Button>
      </div>
    </form>
  );
}
