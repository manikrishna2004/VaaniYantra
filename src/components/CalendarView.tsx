'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { Button, Card, EmptyState, Select, Spinner } from '@/components/ui';
import { useConfirm, useToast } from '@/components/Feedback';

// The clinic calendar.
//
// Hand-rolled pointer dragging: this project has no drag library and no date
// library, and adding either for one screen would be a large dependency for a
// small amount of arithmetic. Pointer events (not HTML5 drag) because they work
// on touch, which is what a front desk on a tablet actually uses.

type Appointment = {
  id: string;
  customerName: string;
  patientNo: string | null;
  doctorId: string | null;
  expertName: string | null;
  service: string;
  startAt: string;
  endAt: string;
  timezone: string | null;
  status: string;
};
type TimeOff = { id: string; startAt: string; endAt: string; allDay: boolean; title: string | null };
type Doctor = { id: string; displayName: string; hasCalendar: boolean };
type Feed = {
  doctors: Doctor[];
  appointments: Appointment[];
  timeOff: TimeOff[];
  external: { start: string; end: string }[];
  selfDoctorId: string | null;
  canManage: boolean;
  needsSetup?: boolean;
};

const DAY_MS = 86400000;
const START_HOUR = 7;
const END_HOUR = 21;
const SLOT_MIN = 15; // drop granularity
const PX_PER_HOUR = 56;

/** Midnight of the week's Monday, in local time. */
function weekStart(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const dow = (out.getDay() + 6) % 7; // Mon = 0
  out.setDate(out.getDate() - dow);
  return out;
}

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function CalendarView({ canManage }: { canManage: boolean }) {
  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  const [doctorId, setDoctorId] = useState<string>('');
  const [feed, setFeed] = useState<Feed | null>(null);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  const from = anchor;
  const to = useMemo(() => new Date(anchor.getTime() + 7 * DAY_MS), [anchor]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (doctorId) params.set('doctorId', doctorId);
    const res = await fetch(`/api/appointments/calendar?${params}`);
    if (!res.ok) {
      setFeed({ doctors: [], appointments: [], timeOff: [], external: [], selfDoctorId: null, canManage: false });
      return;
    }
    const data: Feed = await res.json();
    setFeed(data);
    // A doctor viewing their own calendar has no switcher; adopt the id the
    // server resolved so subsequent loads stay scoped the same way.
    if (!doctorId && data.selfDoctorId) setDoctorId(data.selfDoctorId);
  }, [from, to, doctorId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Dragging ──────────────────────────────────────────────────────────────
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; dayIdx: number; minutes: number } | null>(null);

  function pointToSlot(clientX: number, clientY: number): { dayIdx: number; minutes: number } | null {
    const el = gridRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const dayW = r.width / 7;
    const dayIdx = Math.floor((clientX - r.left) / dayW);
    if (dayIdx < 0 || dayIdx > 6) return null;
    const hours = (clientY - r.top + el.scrollTop) / PX_PER_HOUR + START_HOUR;
    // Snap to the drop granularity, so a slightly wobbly finger still lands on a
    // sensible time rather than 10:37.
    const minutes = Math.round((hours * 60) / SLOT_MIN) * SLOT_MIN;
    if (minutes < START_HOUR * 60 || minutes > END_HOUR * 60) return null;
    return { dayIdx, minutes };
  }

  // `commit` is defined BEFORE the effect that calls it, and takes the drag
  // position as an argument rather than reading state — an effect reaching
  // forward to a later binding is both a lint error and a real staleness hazard.
  const commit = useCallback(
    async (at: { id: string; dayIdx: number; minutes: number }) => {
      const appt = feed?.appointments.find((a) => a.id === at.id);
      if (!appt) return;

      // Built by construction rather than by mutating a Date: the local day, at
      // the dropped minute.
      const dayStart = new Date(anchor.getTime() + at.dayIdx * DAY_MS);
      const target = new Date(
        dayStart.getFullYear(),
        dayStart.getMonth(),
        dayStart.getDate(),
        0,
        at.minutes,
        0,
        0,
      );
      if (target.getTime() === Date.parse(appt.startAt)) return; // no move

      // Unavailable is a warning, not a wall. The front desk genuinely does
      // squeeze people in outside hours, and the booking form already offers a
      // manual time for exactly that — blocking here would push staff back to
      // the phone. A real clash with another appointment is different: the
      // server refuses it, because that is a double-booking, not a judgement.
      const reason = unavailableReason(target, feed);
      if (reason) {
        const ok = await confirm({
          title: 'Move outside available time?',
          message: `${reason} You can still move it, and the patient will be told the new time.`,
          confirmLabel: 'Move anyway',
        });
        if (!ok) return;
      }

      setSaving(true);
      try {
        const res = await fetch(`/api/appointments/${at.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startISO: target.toISOString() }),
        });
        const body = await res.json().catch(() => ({}));
        toast(res.ok ? 'Appointment moved.' : body.error || 'Could not move the appointment.', res.ok ? 'success' : 'error');
      } finally {
        setSaving(false);
        await load();
      }
    },
    [feed, anchor, confirm, toast, load],
  );

  useEffect(() => {
    if (!drag) return;
    function move(e: PointerEvent) {
      const at = pointToSlot(e.clientX, e.clientY);
      if (at) setDrag((d) => (d ? { ...d, ...at } : d));
    }
    function up() {
      setDrag((current) => {
        // Read the LATEST position out of the updater rather than the value this
        // effect closed over — a pointerup can land after a move that has not
        // re-run the effect yet, and dropping on the stale position would move
        // the appointment to where the drag started.
        if (current) void commit(current);
        return null;
      });
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, commit]);


  if (!feed) return <Spinner />;

  if (feed.needsSetup) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No doctor record yet"
        description="Ask an admin to add you under Team → Doctors, and your calendar will appear here."
      />
    );
  }

  const days = Array.from({ length: 7 }, (_, i) => new Date(anchor.getTime() + i * DAY_MS));
  const hours = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i);
  const editable = canManage && feed.canManage;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setAnchor(new Date(anchor.getTime() - 7 * DAY_MS))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAnchor(weekStart(new Date()))}>
            This week
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAnchor(new Date(anchor.getTime() + 7 * DAY_MS))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-1 text-sm text-muted">
            {new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(days[0])} –{' '}
            {new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(days[6])}
          </span>
        </div>

        {feed.doctors.length > 0 && (
          <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="w-56">
            <option value="">All doctors</option>
            {feed.doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.displayName}
                {d.hasCalendar ? '' : ' — no Google calendar'}
              </option>
            ))}
          </Select>
        )}
      </div>

      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-[3.5rem_1fr]">
          <div />
          <div className="grid grid-cols-7 border-b border-border">
            {days.map((d) => (
              <div key={d.toISOString()} className="px-2 py-2 text-center text-xs">
                <div className="text-muted">{new Intl.DateTimeFormat('en-IN', { weekday: 'short' }).format(d)}</div>
                <div className="text-ink">{d.getDate()}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Wide content scrolls inside its own container: the app shell caps at
            max-w-6xl and the page body must never scroll sideways. */}
        <div className="max-h-[70vh] overflow-auto">
          <div className="grid grid-cols-[3.5rem_1fr]">
            <div>
              {hours.map((h) => (
                <div key={h} className="border-b border-border pr-2 text-right text-[11px] text-muted" style={{ height: PX_PER_HOUR }}>
                  {h}:00
                </div>
              ))}
            </div>
            <div ref={gridRef} className="relative grid grid-cols-7">
              {days.map((d, i) => (
                <div key={d.toISOString()} className={i < 6 ? 'border-r border-border' : ''}>
                  {hours.map((h) => (
                    <div key={h} className="border-b border-border" style={{ height: PX_PER_HOUR }} />
                  ))}
                </div>
              ))}

              {feed.timeOff.map((t) => (
                <Block key={t.id} anchor={anchor} startISO={t.startAt} endISO={t.endAt} className="bg-warning/15 border-warning/30 text-warning">
                  {t.title || 'Time off'}
                </Block>
              ))}

              {feed.external.map((x, i) => (
                <Block key={`x${i}`} anchor={anchor} startISO={x.start} endISO={x.end} className="bg-surface-2 border-border text-muted">
                  Busy
                </Block>
              ))}

              {feed.appointments
                .filter((a) => a.status === 'CONFIRMED')
                .map((a) => {
                  const dragging = drag?.id === a.id;
                  const startISO = dragging
                    ? new Date(new Date(anchor.getTime() + drag.dayIdx * DAY_MS).setHours(0, drag.minutes, 0, 0)).toISOString()
                    : a.startAt;
                  const dur = Date.parse(a.endAt) - Date.parse(a.startAt);
                  return (
                    <Block
                      key={a.id}
                      anchor={anchor}
                      startISO={startISO}
                      endISO={new Date(Date.parse(startISO) + dur).toISOString()}
                      className={`border-primary/30 bg-primary-soft text-primary ${dragging ? 'opacity-80 ring-2 ring-primary/40' : ''} ${editable ? 'cursor-grab' : ''}`}
                      onPointerDown={
                        editable
                          ? (e) => {
                              e.preventDefault();
                              const at = pointToSlot(e.clientX, e.clientY);
                              setDrag({ id: a.id, dayIdx: at?.dayIdx ?? 0, minutes: at?.minutes ?? 0 });
                            }
                          : undefined
                      }
                    >
                      <span className="block truncate font-medium">{a.customerName}</span>
                      <span className="block truncate text-[10px] opacity-80">
                        {fmtTime(startISO)}
                        {a.expertName ? ` · ${a.expertName}` : ''}
                      </span>
                    </Block>
                  );
                })}
            </div>
          </div>
        </div>
      </Card>

      {saving && <p className="text-xs text-muted">Saving…</p>}
      {feed.appointments.length === 0 && (
        <p className="text-sm text-muted">Nothing booked this week.</p>
      )}
    </div>
  );
}

/** Why this instant is unavailable, or null when it is fine. */
function unavailableReason(at: Date, feed: Feed | null): string | null {
  if (!feed) return null;
  const t = at.getTime();
  const off = feed.timeOff.find((o) => t >= Date.parse(o.startAt) && t < Date.parse(o.endAt));
  if (off) return `That is inside ${off.title || 'booked time off'}.`;
  const hour = at.getHours() + at.getMinutes() / 60;
  if (hour < START_HOUR || hour >= END_HOUR) return 'That is outside the working day.';
  return null;
}

/** One absolutely-positioned block on the week grid. */
function Block({
  anchor,
  startISO,
  endISO,
  className,
  children,
  onPointerDown,
}: {
  anchor: Date;
  startISO: string;
  endISO: string;
  className?: string;
  children: React.ReactNode;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const start = new Date(startISO);
  const dayIdx = Math.floor((new Date(start).setHours(0, 0, 0, 0) - anchor.getTime()) / DAY_MS);
  if (dayIdx < 0 || dayIdx > 6) return null;

  const startH = start.getHours() + start.getMinutes() / 60;
  const endH = Math.min(END_HOUR, new Date(endISO).getHours() + new Date(endISO).getMinutes() / 60);
  const top = (startH - START_HOUR) * PX_PER_HOUR;
  // A floor so a 15-minute appointment is still readable and still grabbable.
  const height = Math.max(18, (endH - startH) * PX_PER_HOUR);

  return (
    <div
      onPointerDown={onPointerDown}
      className={`absolute overflow-hidden rounded-lg border px-1.5 py-1 text-[11px] leading-tight ${className ?? ''}`}
      style={{
        top,
        height,
        left: `calc(${(dayIdx * 100) / 7}% + 2px)`,
        width: `calc(${100 / 7}% - 4px)`,
        touchAction: 'none',
      }}
    >
      {children}
    </div>
  );
}
