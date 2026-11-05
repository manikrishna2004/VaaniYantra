'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  Copy,
  Database,
  EyeOff,
  FileText,
  Link2,
  Paperclip,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Field, Spinner, PageHeader } from '@/components/ui';
import { useConfirm, useToast } from '@/components/Feedback';
import { describePatient, SEXES } from '@/lib/patients/age';
import { AllergyBanner } from '@/components/AllergyBanner';
import { PrescriptionRows, EMPTY_RX_ROW, rxRowsEmpty } from '@/components/PrescriptionRows';
import { renderPrescription, type RxItemLike } from '@/lib/patients/prescription';
import type { AllergyStatus } from '@/lib/patients/allergies';

// The staff view of one patient: their link, their history, and the form that
// files a new consultation. This is the screen a doctor uses right after seeing
// someone, so the record form is the loudest thing on the page.

type Doc = { id: string; name: string; mimeType: string; sizeBytes: number };
type Visit = {
  id: string;
  visitedAt: string;
  expertName: string | null;
  service: string | null;
  diagnosis: string | null;
  prescription: string | null;
  items?: RxItemLike[];
  advice: string | null;
  followUpAt: string | null;
  internalNotes: string | null;
  sharedWithContact: boolean;
  diagnosisSharedAt: string | null;
  source: string; // native | push | rest | fhir
  documents: Doc[];
};
type Appointment = {
  id: string;
  service: string;
  expertName: string | null;
  startAt: string;
  timezone: string | null;
  status: string;
};
type Capabilities = {
  canWriteRecords: boolean;
  canWriteContacts: boolean;
  canReadDocuments: boolean;
  canWriteDocuments: boolean;
  canWriteAppointments: boolean;
  systemOfRecord: string;
};

type Data = {
  contact: {
    id: string;
    uhid: string | null;
    name: string;
    phone: string;
    dateOfBirth: string; // YYYY-MM-DD, or '' when not recorded
    sex: string | null;
    email: string | null;
    notes: string | null;
    externalId: string | null;
    lastSeenAt: string | null;
    portalRevokedAt: string | null;
  };
  allergies: AllergyStatus;
  capabilities: Capabilities;
  portalUrl: string | null;
  visits: Visit[];
  appointments: Appointment[];
};

const EMPTY_FORM = {
  visitedAt: '',
  expertName: '',
  service: '',
  diagnosis: '',
  prescription: '',
  advice: '',
  followUpAt: '',
  internalNotes: '',
  sharedWithContact: true,
  // Opt IN: a diagnosis is held unless the doctor says otherwise.
  releaseDiagnosis: false,
};

export function PatientDetail({
  patientId,
  canManage,
  canDelete = false,
}: {
  patientId: string;
  canManage: boolean;
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // Rows live OUTSIDE `form` — see the note in PrescriptionRows.tsx. Anything
  // that resets the form must reset these too.
  const [rxRows, setRxRows] = useState<RxItemLike[]>([{ ...EMPTY_RX_ROW }]);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Held locally so the date input stays editable while typing; committed on
  // blur (date) or change (select).
  const [dob, setDob] = useState('');
  const [sex, setSex] = useState('');
  const [notes, setNotes] = useState('');
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    const res = await fetch(`/api/patients/${patientId}`);
    if (!res.ok) {
      setNotFound(true);
      return;
    }
    const next: Data = await res.json();
    setData(next);
    setDob(next.contact.dateOfBirth ?? '');
    setSex(next.contact.sex ?? '');
    setNotes(next.contact.notes ?? '');
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveDemographics(patch: { dateOfBirth?: string; sex?: string; notes?: string }) {
    const res = await fetch(`/api/patients/${patientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      load();
    } else {
      const body = await res.json().catch(() => ({}));
      toast(body.error || 'Could not save that.', 'error');
      // Put the field back to what the server actually holds, so the screen
      // never shows a value that was rejected.
      setDob(data?.contact.dateOfBirth ?? '');
      setSex(data?.contact.sex ?? '');
    }
  }

  async function fileVisit(e: React.FormEvent) {
    e.preventDefault();
    if (
      rxRowsEmpty(rxRows) &&
      !form.prescription.trim() &&
      !form.diagnosis.trim() &&
      !form.advice.trim() &&
      files.length === 0
    ) {
      toast('Add a medicine, diagnosis, advice or a file before saving.', 'error');
      return;
    }
    setSaving(true);
    try {
      const body = new FormData();
      Object.entries(form).forEach(([k, v]) => body.append(k, String(v)));
      // One flat key, appended AFTER the generic loop above so that loop stays
      // untouched. The server parses and validates it (parseRxItems).
      body.append('prescriptionItems', JSON.stringify(rxRows.filter((r) => r.drug.trim())));
      files.forEach((f) => body.append('files', f));

      const res = await fetch(`/api/patients/${patientId}/visits`, { method: 'POST', body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(out.error || 'Could not save that record.', 'error');
        return;
      }
      if (out.rejected?.length) {
        // The record saved; only some attachments didn't. Say exactly that.
        toast(`Record saved, but some files were not: ${out.rejected.join('; ')}`, 'error');
      } else {
        // Say plainly that the diagnosis is held, or it will be forgotten.
        toast(
          form.diagnosis.trim() && !form.releaseDiagnosis
            ? 'Record saved. The diagnosis is held — release it when you are ready.'
            : 'Record saved. Your patient can now see it in their chat.',
          'success',
        );
      }
      setForm(EMPTY_FORM);
      // MUST accompany setForm — rows are not part of the form object, and a
      // stale row here would put the last patient's medicine on this one.
      setRxRows([{ ...EMPTY_RX_ROW }]);
      setFiles([]);
      load();
    } finally {
      setSaving(false);
    }
  }

  // Block or restore this patient's access to the chatbot. There is no link to
  // reissue any more — they sign in with a code sent to their number — so the
  // lost-phone answer is simply to shut them out until it is sorted.
  async function portalAccess(action: 'block-portal' | 'restore-portal') {
    const blocking = action === 'block-portal';
    const ok = await confirm({
      title: blocking ? 'Block portal access?' : 'Restore portal access?',
      message: blocking
        ? 'They will be signed out immediately and cannot sign in again — useful if their phone is lost or in the wrong hands. Their records are untouched.'
        : 'They will be able to sign in again with a code sent to their mobile number.',
      confirmLabel: blocking ? 'Block access' : 'Restore access',
      danger: blocking,
    });
    if (!ok) return;
    const res = await fetch(`/api/patients/${patientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      toast(blocking ? 'Portal access blocked.' : 'Portal access restored.', 'success');
      load();
    } else {
      toast('That did not work.', 'error');
    }
  }

  async function releaseDiagnosis(visit: Visit, release: boolean) {
    const res = await fetch(`/api/patients/${patientId}/visits/${visit.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: release ? 'release-diagnosis' : 'withhold-diagnosis' }),
    });
    if (res.ok) {
      toast(release ? 'Diagnosis released to the patient.' : 'Diagnosis held.', 'success');
      load();
    } else {
      toast('That did not work.', 'error');
    }
  }

  async function toggleShare(visit: Visit) {
    const res = await fetch(`/api/patients/${patientId}/visits/${visit.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharedWithContact: !visit.sharedWithContact }),
    });
    if (res.ok) {
      toast(visit.sharedWithContact ? 'Hidden from the patient.' : 'Shared with the patient.', 'success');
      load();
    }
  }

  async function deleteVisit(visit: Visit) {
    const ok = await confirm({
      title: 'Delete this record?',
      message: `The ${fmtDate(visit.visitedAt)} record and its attachments are permanently removed.`,
      confirmLabel: 'Delete record',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/patients/${patientId}/visits/${visit.id}`, { method: 'DELETE' });
    if (res.ok) {
      toast('Record deleted.', 'success');
      load();
    }
  }

  async function deletePatient() {
    if (!data) return;
    const ok = await confirm({
      title: `Delete ${data.contact.name}?`,
      message:
        'Their record, consultations, prescriptions, allergies and attachments are ' +
        'permanently removed, and they can no longer sign in to the chatbot. ' +
        'Past appointments stay in your history but no longer show their name or ' +
        'number. This cannot be undone.',
      confirmLabel: 'Delete patient',
      danger: true,
    });
    if (!ok) return;

    const res = await fetch(`/api/patients/${patientId}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));

    if (res.ok) {
      // Say what actually happened rather than a bare "deleted" — the kept
      // appointments are the part staff would otherwise think were lost.
      const kept = body.appointmentsAnonymised ?? 0;
      toast(
        kept > 0
          ? `Patient deleted. ${kept} appointment${kept === 1 ? '' : 's'} kept without their details.`
          : 'Patient deleted.',
        'success',
      );
      router.push('/patients');
      return;
    }
    // 409 is the household guard, and its message tells staff what to do next.
    toast(body.error || 'That did not work.', 'error');
  }

  async function copyLink() {
    if (!data?.portalUrl) return;
    await navigator.clipboard.writeText(data.portalUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  if (notFound) {
    return (
      <Card>
        <p className="text-sm text-muted">That patient no longer exists.</p>
        <Link href="/patients" className="mt-3 inline-block text-sm text-primary">
          Back to patients
        </Link>
      </Card>
    );
  }
  if (!data) return <Spinner />;

  const upcoming = data.appointments.filter((a) => a.status === 'CONFIRMED' && new Date(a.startAt) >= new Date());
  // Two separate gates: whether this user's role permits writing, and whether
  // this clinic's data provider does. Both must agree before we show a form.
  const canRecord = canManage && data.capabilities.canWriteRecords;
  // A cheap probe, not an extraction. Old free-text notes may mention an
  // allergy; a human decides what it says, because parsing prose and filing the
  // wrong allergy is worse than filing none.
  const mentionsAllergy = /allerg|एलर्जी|अलर्जी/i.test(notes);

  return (
    <>
      <Link href="/patients" className="mb-4 inline-flex items-center gap-2 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />
        Patients
      </Link>

      <PageHeader
        title={data.contact.name}
        // Age and sex lead, because they are what a clinician needs before
        // anything else on this page means much.
        subtitle={[describePatient(data.contact.dateOfBirth || null, data.contact.sex), data.contact.phone, data.contact.email]
          .filter(Boolean)
          .join(' · ')}
        action={
          data.contact.uhid ? (
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-widest text-muted">Patient no.</div>
              <div className="h-display text-lg font-semibold tabular-nums text-ink">{data.contact.uhid}</div>
            </div>
          ) : null
        }
      />

      {/* Full width, directly under the header — allergies are the first thing
          about a patient that can hurt them, so they sit above everything. */}
      <div className="mb-6">
        <AllergyBanner
          patientId={patientId}
          status={data.allergies}
          canManage={canManage && data.capabilities.canWriteRecords}
          onChange={load}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          {canManage && !data.capabilities.canWriteRecords && (
            <Card className="flex items-start gap-3">
              <Database className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="text-sm">
                <p className="font-medium text-ink">Records come from {data.capabilities.systemOfRecord}</p>
                <p className="mt-0.5 text-muted">
                  Add the consultation there and it appears here — and in your patient&apos;s chatbot — automatically.
                  Editing it here would be overwritten on the next sync, so we don&apos;t offer it.
                </p>
              </div>
            </Card>
          )}
          {canRecord && (
            <Card className="space-y-4">
              <h2 className="h-display text-base font-semibold">Record a consultation</h2>
              <form onSubmit={fileVisit} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Seen by" hint="Doctor or specialist.">
                    <Input
                      value={form.expertName}
                      onChange={(e) => setForm((f) => ({ ...f, expertName: e.target.value }))}
                      placeholder="Dr. Rao"
                    />
                  </Field>
                  <Field label="Reason for visit">
                    <Input
                      value={form.service}
                      onChange={(e) => setForm((f) => ({ ...f, service: e.target.value }))}
                      placeholder="Root canal — follow-up"
                    />
                  </Field>
                </div>

                <Field label="Diagnosis">
                  <Input
                    value={form.diagnosis}
                    onChange={(e) => setForm((f) => ({ ...f, diagnosis: e.target.value }))}
                    placeholder="Reversible pulpitis, lower left molar"
                  />
                </Field>

                {/* Repeated here on purpose. The moment of harm is when a drug
                    is being typed, not when the page was opened. */}
                <AllergyBanner
                  patientId={patientId}
                  status={data.allergies}
                  canManage={canManage && data.capabilities.canWriteRecords}
                  compact
                  onChange={load}
                />

                <Field
                  label="Prescription"
                  hint="One line per medicine. The chatbot reads these back to the patient exactly as written, and can answer 'how many today?' from the schedule."
                >
                  <PrescriptionRows rows={rxRows} onChange={setRxRows} disabled={saving} />
                </Field>

                {/* Free text stays available, but only as a fallback — and the
                    copy says plainly that it is ignored once medicines exist, so
                    nobody types a script here and wonders why it vanished. */}
                <Field
                  label="Other prescription notes"
                  hint={
                    rxRowsEmpty(rxRows)
                      ? 'Optional. Use the medicine rows above where you can — they are far more useful to the patient.'
                      : 'Not shown to the patient while the medicine rows above have anything in them.'
                  }
                >
                  <Textarea
                    value={form.prescription}
                    onChange={(e) => setForm((f) => ({ ...f, prescription: e.target.value }))}
                    className="min-h-[64px]"
                    placeholder="Anything the rows above don't cover."
                  />
                </Field>

                <Field label="Advice">
                  <Textarea
                    value={form.advice}
                    onChange={(e) => setForm((f) => ({ ...f, advice: e.target.value }))}
                    className="min-h-[80px]"
                    placeholder="Warm salt-water rinse twice daily. Avoid chewing on that side for 3 days."
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Visit date" hint="Leave blank for today.">
                    <Input
                      type="date"
                      value={form.visitedAt}
                      onChange={(e) => setForm((f) => ({ ...f, visitedAt: e.target.value }))}
                    />
                  </Field>
                  <Field label="Follow-up due">
                    <Input
                      type="date"
                      value={form.followUpAt}
                      onChange={(e) => setForm((f) => ({ ...f, followUpAt: e.target.value }))}
                    />
                  </Field>
                </div>

                <Field
                  label="Internal notes"
                  hint="Staff only. Never shown to the patient and never given to the chatbot."
                >
                  <Textarea
                    value={form.internalNotes}
                    onChange={(e) => setForm((f) => ({ ...f, internalNotes: e.target.value }))}
                    className="min-h-[70px]"
                  />
                </Field>

                <Field label="Attach prescription or reports" hint="PDF or photo, up to 5 MB each.">
                  <input
                    type="file"
                    multiple
                    accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                    className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:text-ink"
                  />
                </Field>
                {files.length > 0 && (
                  <p className="flex items-center gap-2 text-xs text-muted">
                    <Paperclip className="h-3.5 w-3.5" />
                    {files.map((f) => f.name).join(', ')}
                  </p>
                )}

                <label className="flex items-center gap-2.5 text-sm text-ink-soft">
                  <input
                    type="checkbox"
                    checked={form.sharedWithContact}
                    onChange={(e) => setForm((f) => ({ ...f, sharedWithContact: e.target.checked }))}
                    className="h-4 w-4 rounded border-border-strong"
                  />
                  Share with the patient right away
                </label>

                {/* Separate from the share toggle above, because the two are
                    genuinely different questions: the prescription is useful to
                    a patient immediately, a provisional diagnosis often is not. */}
                <label className="flex cursor-pointer items-start gap-2 text-sm text-ink-soft">
                  <input
                    type="checkbox"
                    checked={form.releaseDiagnosis}
                    onChange={(e) => setForm((f) => ({ ...f, releaseDiagnosis: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-border-strong"
                  />
                  <span>
                    Release the diagnosis to the patient now
                    <span className="block text-xs text-muted">
                      Off by default. The prescription and advice go out either way — you can release the diagnosis
                      later, once you have spoken to them.
                    </span>
                  </span>
                </label>

                <Button type="submit" disabled={saving}>
                  {saving ? <Spinner /> : 'Save record'}
                </Button>
              </form>
            </Card>
          )}

          <div className="space-y-3">
            <h2 className="h-display text-base font-semibold">History</h2>
            {data.visits.length === 0 ? (
              <Card>
                <p className="text-sm text-muted">No consultations recorded yet.</p>
              </Card>
            ) : (
              data.visits.map((v) => (
                <Card key={v.id} className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">{fmtDate(v.visitedAt)}</span>
                      {v.expertName && <span className="text-xs text-muted">{v.expertName}</span>}
                      {v.sharedWithContact ? (
                        <Badge tone="success">shared</Badge>
                      ) : (
                        <Badge tone="neutral">hidden</Badge>
                      )}
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-1">
                        {/* Hiding is ours to control — it only governs what the
                            patient sees in OUR portal. Deleting is not: a record
                            their system owns would simply return on the next
                            sync, so we don't offer a button that undoes itself. */}
                        <Button size="sm" variant="ghost" onClick={() => toggleShare(v)}>
                          <EyeOff className="h-3.5 w-3.5" />
                          {v.sharedWithContact ? 'Hide' : 'Share'}
                        </Button>
                        {v.diagnosis && !v.diagnosisSharedAt && (
                          <Button size="sm" variant="ghost" onClick={() => releaseDiagnosis(v, true)}>
                            Release diagnosis
                          </Button>
                        )}
                        {v.diagnosis && v.diagnosisSharedAt && (
                          <Button size="sm" variant="ghost" onClick={() => releaseDiagnosis(v, false)}>
                            Hold diagnosis
                          </Button>
                        )}
                        {v.source === 'native' && (
                          <Button size="sm" variant="ghost" onClick={() => deleteVisit(v)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {v.service && <p className="text-xs text-muted">{v.service}</p>}
                  {v.diagnosis && (
                    <div>
                      <Detail label="Diagnosis" value={v.diagnosis} />
                      {!v.diagnosisSharedAt && (
                        <span className="mt-0.5 inline-block text-[11px] text-warning">
                          Held — the patient cannot see this yet
                        </span>
                      )}
                    </div>
                  )}
                  <RxDetail visit={v} />
                  {v.advice && <Detail label="Advice" value={v.advice} />}
                  {v.followUpAt && <Detail label="Follow-up" value={fmtDate(v.followUpAt)} />}
                  {v.internalNotes && (
                    <div className="rounded-lg border border-warning/30 bg-warning/10 p-2.5">
                      <Detail label="Internal only" value={v.internalNotes} />
                    </div>
                  )}
                  {v.documents.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {v.documents.map((d) => (
                        <a
                          key={d.id}
                          href={`/api/patients/${patientId}/documents/${d.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 rounded-lg border border-border-strong px-3 py-1.5 text-xs text-ink transition hover:border-primary/60"
                        >
                          <FileText className="h-3.5 w-3.5 text-primary" />
                          {d.name}
                        </a>
                      ))}
                    </div>
                  )}
                </Card>
              ))
            )}
          </div>
        </div>

        <aside className="space-y-4">
          {/* Demographics first in the sidebar: a missing date of birth is a
              clinical gap, not an admin one, and it should be visible and
              fixable without hunting. */}
          <Card className="space-y-3">
            <h2 className="h-display text-sm font-semibold">Patient details</h2>
            {!data.contact.dateOfBirth && (
              <p className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning">
                No date of birth recorded — dosing and what counts as normal both depend on age.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date of birth">
                <Input
                  type="date"
                  value={dob}
                  disabled={!canManage}
                  onChange={(e) => setDob(e.target.value)}
                  onBlur={() => dob !== data.contact.dateOfBirth && saveDemographics({ dateOfBirth: dob })}
                />
              </Field>
              <Field label="Sex">
                <Select
                  value={sex}
                  disabled={!canManage}
                  onChange={(e) => {
                    setSex(e.target.value);
                    saveDemographics({ sex: e.target.value });
                  }}
                >
                  <option value="">Not recorded</option>
                  {SEXES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>

          {/* Staff notes were stored and fetched but never rendered anywhere —
              a field written and never read. The schema comment even suggested
              putting allergies here, which meant they could be typed in and
              then be invisible. Allergies now have their own structured home
              above; this is what is left: account notes, preferences, context. */}
          <Card className="space-y-2.5">
            <h2 className="h-display text-sm font-semibold">Staff notes</h2>
            <Textarea
              value={notes}
              disabled={!canManage}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => notes !== (data.contact.notes ?? '') && saveDemographics({ notes })}
              className="min-h-[90px] text-sm"
              maxLength={4000}
              placeholder="Anything the team should know. Never shown to the patient or the chatbot."
            />
            {mentionsAllergy && data.allergies.state === 'unknown' && (
              <p className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-warning">
                These notes look like they mention an allergy. Record it properly above so it shows on the
                prescription form — a note here is not checked when anyone prescribes.
              </p>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="h-display text-sm font-semibold">Their chatbot</h2>
            {data.contact.portalRevokedAt ? (
              <div className="space-y-2.5">
                <p className="flex items-center gap-2 text-xs text-warning">
                  <Link2 className="h-4 w-4" />
                  Access blocked — they cannot sign in.
                </p>
                {canManage && (
                  <Button size="sm" variant="secondary" onClick={() => portalAccess('restore-portal')}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Restore access
                  </Button>
                )}
              </div>
            ) : data.portalUrl ? (
              <>
                <p className="break-all rounded-lg bg-surface-2 p-2.5 text-[11px] text-ink-soft">{data.portalUrl}</p>
                <p className="text-xs text-muted">
                  Your clinic&apos;s public chatbot address — safe to read out or print. This patient signs in with a
                  code sent to {data.contact.phone}, so only they can see their records.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={copyLink}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                  {canManage && (
                    <Button size="sm" variant="danger" onClick={() => portalAccess('block-portal')}>
                      Block access
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-2 text-xs text-muted">
                <p className="flex items-center gap-2 text-ink-soft">
                  <Link2 className="h-4 w-4" />
                  No chatbot yet.
                </p>
                <p>
                  Create one under{' '}
                  <Link href="/chatbot" className="text-primary">
                    Patient Chatbot
                  </Link>{' '}
                  and its link goes out with every appointment confirmation.
                </p>
              </div>
            )}
            <p className="text-xs text-muted">
              {data.contact.lastSeenAt
                ? `Last opened ${fmtDate(data.contact.lastSeenAt)}`
                : 'They have not opened it yet.'}
            </p>
          </Card>

          <Card className="space-y-2">
            <h2 className="h-display text-sm font-semibold">Appointments</h2>
            {upcoming.length === 0 ? (
              <p className="text-xs text-muted">Nothing upcoming.</p>
            ) : (
              upcoming.map((a) => (
                <div key={a.id} className="text-xs">
                  <div className="text-ink">{fmtDateTime(a.startAt, a.timezone)}</div>
                  <div className="text-muted">
                    {a.service}
                    {a.expertName ? ` · ${a.expertName}` : ''}
                  </div>
                </div>
              ))
            )}
          </Card>

          {canDelete && (
            <Card className="space-y-2 border-danger/30">
              <h2 className="h-display text-sm font-semibold text-danger">Delete patient</h2>
              <p className="text-xs text-muted">
                Removes {data.contact.name}&apos;s record, consultations, prescriptions, allergies
                and attachments, and ends their chatbot access. Past appointments stay in your
                history with their name and number removed.
              </p>
              <Button size="sm" variant="danger" onClick={deletePatient}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete patient
              </Button>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

/**
 * A filed visit's medicines, through the shared renderer.
 *
 * Structured lines get a real numbered list; legacy free text keeps its verbatim
 * block. The doctor sees the same rendering the patient's chatbot reads from,
 * which is the only way to notice a script reads wrong before the patient does.
 */
function RxDetail({ visit }: { visit: Visit }) {
  const rx = renderPrescription(visit);
  if (rx.kind === 'none') return null;
  if (rx.kind === 'text') return <Detail label="Prescription" value={rx.text} />;
  return (
    <div className="text-sm">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Prescription</span>
      <ol className="mt-1 space-y-1">
        {rx.lines.map((line, i) => (
          <li key={i} className="flex gap-2 text-ink">
            <span className="tabular-nums text-muted">{i + 1}.</span>
            <span>{line}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-sm">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <p className="mt-0.5 whitespace-pre-wrap text-ink">{value}</p>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

function fmtDateTime(iso: string, tz: string | null): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz || undefined,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
