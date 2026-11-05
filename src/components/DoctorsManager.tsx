'use client';

import { useCallback, useEffect, useState } from 'react';
import { Stethoscope } from 'lucide-react';
import { Button, Card, Field, Input, Modal, Select, Spinner, Textarea, Badge } from '@/components/ui';
import { WeeklyHours } from '@/components/WeeklyHours';
import { useConfirm, useToast } from '@/components/Feedback';
import { COMMON_TIMEZONES, type BusinessHours } from '@/lib/agent-behavior';

// Doctors, and their hours and leave.
//
// Lives on the Team page because that is where a clinic already goes to say who
// works here — the page header is literally "Invite a doctor or staff member".
// A separate Doctors page would split one job across two screens.

// Mirrors DoctorSummary in lib/doctors.ts. Declared here rather than imported
// because that module pulls in prisma, and this is a client component.
export type Doctor = {
  id: string;
  displayName: string;
  timezone: string | null;
  active: boolean;
  bookable: boolean;
  specialisation: string | null;
  qualifications: string | null;
  bio: string | null;
  phone: string | null;
  photoUrl: string | null;
  profileCompletedAt: string | null;
  userId: string | null;
  userEmail: string | null;
  hasCalendar: boolean;
};
type Member = { userId: string; name: string | null; email: string };
type TimeOff = { id: string; startAt: string; endAt: string; allDay: boolean; title: string | null };

export function DoctorsManager({ canManage }: { canManage: boolean }) {
  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState('');
  const [linkUser, setLinkUser] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Doctor | null>(null);
  const [profiling, setProfiling] = useState<Doctor | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [d, m] = await Promise.all([
      fetch('/api/doctors?all=1').then((r) => (r.ok ? r.json() : { doctors: [] })),
      fetch('/api/members').then((r) => (r.ok ? r.json() : { members: [] })).catch(() => ({ members: [] })),
    ]);
    setDoctors(d.doctors ?? []);
    setMembers(m.members ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/doctors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name, userId: linkUser || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(body.error || 'Could not add the doctor.', 'error');
        return;
      }
      setName('');
      setLinkUser('');
      await load();
      toast('Doctor added.', 'success');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, patchBody: Record<string, unknown>) {
    const res = await fetch(`/api/doctors/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      toast(b.error || 'Could not save.', 'error');
    }
    await load();
  }

  if (!doctors) return <Spinner />;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">Doctors</h2>
        <p className="mt-1 text-sm text-muted">
          Who patients can be booked with. Each doctor has their own calendar here; connecting a Google
          account is optional and only possible once they have a VaaniYantra login.
        </p>
      </div>

      {canManage && (
        <Card>
          <form onSubmit={add} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1">
              <Field label="Name patients hear">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Aditi Sharma" required />
              </Field>
            </div>
            <div className="min-w-[12rem] flex-1">
              <Field label="Their login (optional)" hint="Only needed for self-service and Google sync.">
                <Select value={linkUser} onChange={(e) => setLinkUser(e.target.value)}>
                  <option value="">Not linked</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name || m.email}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" disabled={busy || !name.trim()}>
              Add doctor
            </Button>
          </form>
        </Card>
      )}

      {doctors.length === 0 ? (
        <Card className="flex items-center gap-3 text-sm text-muted">
          <Stethoscope className="h-4 w-4 shrink-0" />
          No doctors yet. Add one so appointments can be booked with a named person.
        </Card>
      ) : (
        <div className="space-y-2">
          {doctors.map((d) => (
            <Card key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{d.displayName}</span>
                  {d.specialisation && <span className="text-xs text-muted">{d.specialisation}</span>}
                  {!d.active && <Badge tone="neutral">retired</Badge>}
                  {/* The state that decides whether the agent offers them at
                      all. Without it on the row, an invited doctor who never
                      finished their profile looks identical to a working one. */}
                  {d.active && !d.bookable && <Badge tone="warning">not bookable</Badge>}
                  {d.hasCalendar ? (
                    <Badge tone="success">Google connected</Badge>
                  ) : d.userId ? (
                    <Badge tone="warning">no Google calendar</Badge>
                  ) : (
                    <Badge tone="neutral">VaaniYantra calendar</Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {d.userEmail ?? 'No login linked'}
                  {d.timezone ? ` · ${d.timezone}` : ''}
                </p>
              </div>
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setProfiling(d)}>
                    Edit profile
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(d)}>
                    Hours &amp; leave
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => patch(d.id, { active: !d.active })}>
                    {d.active ? 'Retire' : 'Restore'}
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {editing && <DoctorSchedulePanel doctor={editing} onClose={() => setEditing(null)} />}
      {profiling && (
        <DoctorProfilePanel
          doctor={profiling}
          onClose={() => setProfiling(null)}
          onSaved={() => {
            setProfiling(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Weekly hours + time off for one doctor. */
// Exported so the doctor's own setup screen uses the SAME hours and time-off
// editor staff use, rather than a second one that drifts from it.
//
// `onClose` decides the CHROME, not the content. Staff reach this from a list of
// doctors, so for them it is a dialog they dismiss to get back. A doctor's own
// page has no list behind it — this IS the page — so there it renders inline.
// Passing a no-op onClose instead produced a modal over /my-practice with a
// close button that did nothing.
export function DoctorSchedulePanel({ doctor, onClose }: { doctor: Doctor; onClose?: () => void }) {
  const [schedule, setSchedule] = useState<BusinessHours | null>(null);
  const [timeOff, setTimeOff] = useState<TimeOff[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    const [s, t] = await Promise.all([
      fetch(`/api/doctors/${doctor.id}/schedule`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/doctors/${doctor.id}/time-off`).then((r) => (r.ok ? r.json() : { timeOff: [] })),
    ]);
    if (s?.schedule) setSchedule(s.schedule);
    setTimeOff(t.timeOff ?? []);
  }, [doctor.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveHours() {
    if (!schedule) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/doctors/${doctor.id}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule }),
      });
      toast(res.ok ? 'Hours saved.' : 'Could not save hours.', res.ok ? 'success' : 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addTimeOff(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(`/api/doctors/${doctor.id}/time-off`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startISO: new Date(from).toISOString(),
          endISO: new Date(to).toISOString(),
          title,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(b.error || 'Could not save.', 'error');
        return;
      }
      setFrom('');
      setTo('');
      setTitle('');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeTimeOff(id: string) {
    if (!(await confirm({ title: 'Remove this time off?', confirmLabel: 'Remove', danger: true }))) return;
    await fetch(`/api/doctors/${doctor.id}/time-off/${id}`, { method: 'DELETE' });
    await load();
  }

  const panelTitle = `${doctor.displayName} — hours & leave`;
  const description = 'Slots are only offered inside these hours, and never during time off.';
  const body = (
      <div className="space-y-5">
        {schedule ? (
          <>
            <WeeklyHours value={schedule} onChange={setSchedule} />
            <div className="flex items-center gap-2">
              <Button onClick={saveHours} disabled={busy}>
                Save hours
              </Button>
              <span className="text-xs text-muted">
                {COMMON_TIMEZONES.includes(schedule.timezone) ? '' : 'Custom timezone'}
              </span>
            </div>
          </>
        ) : (
          <Spinner />
        )}

        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium text-ink">Time off</p>
          <form onSubmit={addTimeOff} className="flex flex-wrap items-end gap-2">
            <Field label="From">
              <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
            </Field>
            <Field label="To">
              <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required />
            </Field>
            <Field label="Label">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leave" />
            </Field>
            <Button type="submit" variant="secondary" disabled={busy || !from || !to}>
              Add
            </Button>
          </form>

          {timeOff.length === 0 ? (
            <p className="text-xs text-muted">None booked.</p>
          ) : (
            <ul className="space-y-1">
              {timeOff.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-ink">
                    {t.title || 'Time off'}{' '}
                    <span className="text-muted">
                      {new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t.startAt))}
                      {' → '}
                      {new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(t.endAt))}
                    </span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => removeTimeOff(t.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
  );

  if (!onClose) {
    return (
      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Hours &amp; leave</h2>
          <p className="mt-0.5 text-[12px] text-muted">{description}</p>
        </div>
        {body}
      </Card>
    );
  }

  return (
    <Modal open onClose={onClose} title={panelTitle} description={description}>
      {body}
    </Modal>
  );
}

/**
 * Staff editing a doctor's profile.
 *
 * The same fields the doctor sets on /my-practice, plus `bookable`, which they
 * cannot set for themselves — for them it is earned by completing the profile.
 * Staff need it directly because an invited doctor who never signs in would
 * otherwise be permanently unbookable with nobody able to fix it.
 */
function DoctorProfilePanel({
  doctor,
  onClose,
  onSaved,
}: {
  doctor: Doctor;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(doctor.displayName);
  const [specialisation, setSpecialisation] = useState(doctor.specialisation ?? '');
  const [qualifications, setQualifications] = useState(doctor.qualifications ?? '');
  const [phone, setPhone] = useState(doctor.phone ?? '');
  const [timezone, setTimezone] = useState(doctor.timezone ?? '');
  const [bio, setBio] = useState(doctor.bio ?? '');
  const [bookable, setBookable] = useState(doctor.bookable);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function save() {
    if (!displayName.trim()) return toast('A name patients hear is required.', 'error');
    setBusy(true);
    const res = await fetch(`/api/doctors/${doctor.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, specialisation, qualifications, phone, timezone, bio, bookable }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return toast(b.error ?? 'Could not save.', 'error');
    }
    toast('Profile saved.');
    onSaved();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${doctor.displayName} — profile`}
      description="Name and specialisation are what the agent reads out on a call. The rest is for your own records."
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name patients hear">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Dr. Aditi Sharma" />
          </Field>
          <Field label="Specialisation" hint="Lets a caller ask for “a dentist”.">
            <Input value={specialisation} onChange={(e) => setSpecialisation(e.target.value)} placeholder="Dentist" />
          </Field>
          <Field label="Qualifications" hint="Optional. Never read out.">
            <Input value={qualifications} onChange={(e) => setQualifications(e.target.value)} placeholder="BDS, MDS" />
          </Field>
          <Field label="Contact number" hint="Optional. Internal only.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" />
          </Field>
          <Field label="Timezone" hint="Blank uses the clinic's.">
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Kolkata" />
          </Field>
        </div>

        <Field label="About them" hint="Optional. Shown to patients, never to the AI.">
          <Textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
        </Field>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface-2 p-3.5">
          <input
            type="checkbox"
            checked={bookable}
            onChange={(e) => setBookable(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>
            <span className="text-sm text-ink">Offer this doctor to callers</span>
            <span className="mt-0.5 block text-xs text-muted">
              Turn off to keep someone on the team without the agent booking patients with them. A doctor invited by
              link starts off, and turns on for themselves once they have set a name and specialisation.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={busy}>
            {busy ? <Spinner /> : 'Save profile'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
