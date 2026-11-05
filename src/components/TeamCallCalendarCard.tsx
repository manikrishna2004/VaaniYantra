'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Select, Spinner } from '@/components/ui';
import { DAY_LABELS } from '@/lib/agent-behavior';
import { useConfirm } from '@/components/Feedback';

// Admin card for VaaniYantra's own booking calendar.
//
// Self-contained rather than threaded through AdminDashboard's `data` prop:
// this is one narrow concern with its own endpoint, and widening the admin
// loader for it would couple the whole page to a Google round-trip.

type DayWindow = { open: string; close: string; closed: boolean };
type Availability = {
  timezone: string;
  durationMin: number;
  lookaheadDays: number;
  minNoticeHours: number;
  maxPerDay: number;
  weekly: DayWindow[];
};
type Entry = { id: string; summary: string; startISO: string; endISO: string; isBlock: boolean };
type Status = {
  connected: boolean;
  email: string | null;
  calendarId: string | null;
  timezone: string | null;
  openSlots: number;
  availability: Availability;
  entries: Entry[];
};

// Mon-first, which is how anyone reads a working week — the array itself stays
// getDay()-indexed because that is what the slot engine expects.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function TeamCallCalendarCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [av, setAv] = useState<Availability | null>(null);
  const [blockStart, setBlockStart] = useState('');
  const [blockEnd, setBlockEnd] = useState('');
  const [blockLabel, setBlockLabel] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const load = useCallback(() => {
    fetch('/api/admin/team-call-calendar')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Status | null) => {
        if (!d) return;
        setStatus(d);
        setAv(d.availability);
      })
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function disconnect() {
    const ok = await confirm({
      title: 'Disconnect the booking calendar?',
      message:
        'The "book a call with our team" prompt disappears from every customer dashboard until you reconnect. Calls already booked stay in your calendar.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    await fetch('/api/admin/team-call-calendar', { method: 'DELETE' }).catch(() => {});
    setBusy(false);
    load();
  }

  async function saveAvailability() {
    if (!av) return;
    setBusy(true);
    setNote(null);
    const res = await fetch('/api/admin/team-call-calendar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(av),
    });
    setBusy(false);
    setNote(res.ok ? 'Bookable hours saved.' : 'Could not save the hours.');
    load();
  }

  function setDay(index: number, patch: Partial<DayWindow>) {
    setAv((a) =>
      a ? { ...a, weekly: a.weekly.map((w, i) => (i === index ? { ...w, ...patch } : w)) } : a,
    );
  }

  async function addBlock() {
    if (!blockStart || !blockEnd) return setNote('Give a start and an end.');
    setBusy(true);
    setNote(null);
    const res = await fetch('/api/admin/team-call-calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // datetime-local has no zone; the browser reads it as local time, which is
      // the owner's own clock and so exactly what they meant.
      body: JSON.stringify({
        startISO: new Date(blockStart).toISOString(),
        endISO: new Date(blockEnd).toISOString(),
        label: blockLabel,
      }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setNote(b.error ?? 'Could not block that time.');
    setBlockStart('');
    setBlockEnd('');
    setBlockLabel('');
    setNote('Time blocked.');
    load();
  }

  async function removeEntry(e: Entry) {
    const ok = await confirm({
      title: e.isBlock ? 'Reopen this time?' : `Delete "${e.summary}"?`,
      message: e.isBlock
        ? 'The block is removed and the slots become bookable again.'
        : 'This is a real calendar entry, not a block we created. Deleting it removes the meeting from your calendar.',
      confirmLabel: e.isBlock ? 'Reopen' : 'Delete',
      danger: !e.isBlock,
    });
    if (!ok) return;
    setBusy(true);
    await fetch('/api/admin/team-call-calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unblock', eventId: e.id }),
    }).catch(() => {});
    setBusy(false);
    load();
  }

  const fmtEntry = (iso: string) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: status?.timezone || 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Team call calendar</h3>
        {!status ? null : status.connected ? (
          <Badge tone={status.openSlots > 0 ? 'success' : 'warning'}>
            {status.openSlots > 0 ? `${status.openSlots} slots offered` : 'connected · no free slots'}
          </Badge>
        ) : (
          <Badge tone="neutral">not connected</Badge>
        )}
      </div>

      <p className="text-xs text-muted">
        The calendar customers book onboarding calls against, from the prompt on their dashboard. We
        read its free/busy to offer real times, create the event on it, and invite the customer so the
        meeting lands on their calendar too — with a Google Meet link. Connect the account you want to
        appear as the organiser on those invitations.
      </p>

      {status?.connected && (
        <p className="text-xs text-ink-soft">
          Organiser: <span className="text-ink">{status.email ?? 'unknown'}</span>
          {status.timezone ? ` · ${status.timezone}` : ''}
          {status.openSlots === 0 && (
            <span className="text-warning">
              {' '}
              — no free slots in the next few days, so the prompt is hidden. Check the account is still
              granted, and that the working hours are not fully booked.
            </span>
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {/* A real navigation, not a client-side route change: this hands the
            browser to Google's consent screen. Same shape ConnectorsManager
            uses for the org and doctor connections. */}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => (window.location.href = '/api/integrations/google/connect?target=platform')}
        >
          {status?.connected ? 'Reconnect / change account' : 'Connect Google Calendar'}
        </Button>
        {status?.connected && (
          <Button size="sm" variant="danger" onClick={disconnect} disabled={busy}>
            {busy ? <Spinner /> : null}
            Disconnect
          </Button>
        )}
      </div>

      {status?.connected && av && (
        <>
          {/* Bookable hours */}
          <div className="border-t border-border pt-4">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted">Bookable hours</h4>
            <p className="mt-1 text-xs text-muted">
              What the public booking page offers. A closed day disappears entirely; anything already in the
              calendar is excluded on top of this.
            </p>

            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <Field label="Call length" hint="Minutes.">
                <Input
                  type="number"
                  value={String(av.durationMin)}
                  onChange={(e) => setAv({ ...av, durationMin: Number(e.target.value) })}
                />
              </Field>
              <Field label="Book up to" hint="Days ahead.">
                <Input
                  type="number"
                  value={String(av.lookaheadDays)}
                  onChange={(e) => setAv({ ...av, lookaheadDays: Number(e.target.value) })}
                />
              </Field>
              <Field label="Least notice" hint="Hours.">
                <Input
                  type="number"
                  value={String(av.minNoticeHours)}
                  onChange={(e) => setAv({ ...av, minNoticeHours: Number(e.target.value) })}
                />
              </Field>
              <Field label="Most per day" hint="Slots offered.">
                <Input
                  type="number"
                  value={String(av.maxPerDay)}
                  onChange={(e) => setAv({ ...av, maxPerDay: Number(e.target.value) })}
                />
              </Field>
            </div>

            <div className="mt-3 space-y-1.5">
              {DAY_ORDER.map((i) => {
                const w = av.weekly[i];
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex w-32 items-center gap-2 text-ink-soft">
                      <input
                        type="checkbox"
                        checked={!w.closed}
                        onChange={(e) => setDay(i, { closed: !e.target.checked })}
                      />
                      {DAY_LABELS[i]}
                    </label>
                    {w.closed ? (
                      <span className="text-xs text-muted">closed</span>
                    ) : (
                      <>
                        <Input
                          type="time"
                          value={w.open}
                          onChange={(e) => setDay(i, { open: e.target.value })}
                          className="w-auto"
                        />
                        <span className="text-muted">to</span>
                        <Input
                          type="time"
                          value={w.close}
                          onChange={(e) => setDay(i, { close: e.target.value })}
                          className="w-auto"
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <Button size="sm" className="mt-3" onClick={saveAvailability} disabled={busy}>
              {busy ? <Spinner /> : 'Save hours'}
            </Button>
          </div>

          {/* Block time out */}
          <div className="border-t border-border pt-4">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted">Block time out</h4>
            <p className="mt-1 text-xs text-muted">
              Puts a busy entry on the same calendar, so those slots stop being offered. You can do the same from
              your phone&rsquo;s calendar app — anything on this calendar closes the time.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Field label="From">
                <Input type="datetime-local" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="datetime-local" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
              </Field>
              <Field label="Reason" hint="Optional.">
                <Input value={blockLabel} onChange={(e) => setBlockLabel(e.target.value)} placeholder="Travelling" />
              </Field>
              <div className="flex items-end">
                <Button size="sm" variant="secondary" onClick={addBlock} disabled={busy}>
                  Block
                </Button>
              </div>
            </div>

            {status.entries.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {status.entries.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="text-sm text-ink">{e.summary}</span>
                      <div className="text-[11px] text-muted">
                        {fmtEntry(e.startISO)} — {fmtEntry(e.endISO)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {e.isBlock ? <Badge tone="warning">block</Badge> : <Badge tone="accent">meeting</Badge>}
                      <Button size="sm" variant="secondary" onClick={() => removeEntry(e)} disabled={busy}>
                        {e.isBlock ? 'Reopen' : 'Delete'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {note && <p className="text-xs text-ink-soft">{note}</p>}
    </Card>
  );
}
