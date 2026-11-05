'use client';

import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Spinner, Textarea } from '@/components/ui';
import { DoctorSchedulePanel, type Doctor } from '@/components/DoctorsManager';

// A doctor's own setup. Deliberately one screen rather than a wizard: everything
// here is independently useful, and a doctor who only ever sets their hours is
// still better off than one who abandoned step 2 of 4.
//
// Hours and time off reuse DoctorSchedulePanel — the same editor staff use, so
// the two cannot drift apart.

export function DoctorSelfProfile({ doctor }: { doctor: Doctor }) {
  const [displayName, setDisplayName] = useState(doctor.displayName);
  const [specialisation, setSpecialisation] = useState(doctor.specialisation ?? '');
  const [qualifications, setQualifications] = useState(doctor.qualifications ?? '');
  const [phone, setPhone] = useState(doctor.phone ?? '');
  const [timezone, setTimezone] = useState(doctor.timezone ?? '');
  const [bio, setBio] = useState(doctor.bio ?? '');

  const [bookable, setBookable] = useState(doctor.bookable);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // The two the agent actually reads. Until both are set this doctor is not
  // offered to callers, so the prompt says so rather than leaving it a mystery.
  const ready = Boolean(displayName.trim() && specialisation.trim());

  async function save() {
    setBusy(true);
    setNote(null);
    const res = await fetch('/api/doctors/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, specialisation, qualifications, phone, timezone, bio }),
    });
    const b = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setNote(b.error ?? 'Could not save your profile.');
    setBookable(Boolean(b.doctor?.bookable));
    setNote('Saved.');
  }

  return (
    <div className="space-y-4">
      {!bookable && (
        <Card className="border-warning/40 bg-warning/5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">Not yet bookable</Badge>
            <span className="text-sm text-ink">Patients cannot be booked with you yet.</span>
          </div>
          <p className="mt-1.5 text-xs text-ink-soft">
            Set the name patients should hear and your specialisation below, and the agent will start offering you.
            Until then you are invited but not offered — which is deliberate, so nobody is booked with a
            half-finished profile.
          </p>
        </Card>
      )}

      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Your profile</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            The name and specialisation are read out on calls. Everything else is for your clinic&rsquo;s own
            records.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name patients hear" hint="How the agent refers to you.">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Dr. Aditi Sharma" />
          </Field>
          <Field label="Specialisation" hint="Lets a caller ask for “a dentist”.">
            <Input
              value={specialisation}
              onChange={(e) => setSpecialisation(e.target.value)}
              placeholder="Dentist"
            />
          </Field>
          <Field label="Qualifications" hint="Optional. Not read out on calls.">
            <Input
              value={qualifications}
              onChange={(e) => setQualifications(e.target.value)}
              placeholder="BDS, MDS"
            />
          </Field>
          <Field label="Contact number" hint="Optional. Internal only.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" />
          </Field>
          <Field label="Timezone" hint="Leave blank to use the clinic's.">
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Kolkata" />
          </Field>
        </div>

        <Field label="About you" hint="Optional. Shown to patients, never to the AI.">
          <Textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} disabled={busy}>
            {busy ? <Spinner /> : 'Save profile'}
          </Button>
          {!ready && <span className="text-xs text-muted">Name and specialisation are needed to go live.</span>}
          {note && <span className="text-xs text-ink-soft">{note}</span>}
        </div>
      </Card>

      {/* Hours + time off, the same editor staff use. No onClose: on this page
          there is nothing behind it to close back to, so it renders inline
          rather than as a dialog. */}
      <DoctorSchedulePanel doctor={doctor} />

      <Card className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Your calendar</h2>
        <p className="text-[12px] text-muted">
          Connect your own Google Calendar and appointments booked with you land on it, and your existing
          commitments block those times automatically. Without it, bookings go to the clinic&rsquo;s shared
          calendar instead.
        </p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => (window.location.href = '/api/integrations/google/connect?target=me')}
          >
            Connect my Google Calendar
          </Button>
        </div>
      </Card>
    </div>
  );
}
