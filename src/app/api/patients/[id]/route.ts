import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { portalLink, revokePortalAccess, restorePortalAccess } from '@/lib/portal/contacts';
import { getPatientProvider } from '@/lib/patients';
import { ensureUhid } from '@/lib/patients/uhid';
import { parseDateOfBirth, formatDateOfBirth, SEXES } from '@/lib/patients/age';
import { allergyStatus } from '@/lib/patients/allergies';
import { erasePatient } from '@/lib/patients/erase';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function loadScoped(id: string, workspaceId: string) {
  return prisma.contact.findFirst({ where: { id, workspaceId } });
}

// One patient, with their full history — internal notes included, because this
// is the staff view. The patient-facing equivalent is patientVisits().
export async function GET(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:read');
  if (denied) return denied;

  const contact = await loadScoped(id, ctx.workspace.id);
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Opening a patient's file is the event an investigation actually needs, and
  // until now only *writes* were audited. Logged after the scope check so a
  // probe for someone else's patient id leaves no row here (it was never this
  // workspace's record to read) — the 404 path is a tenancy concern, not a
  // record-access one.
  await audit(ctx, 'patient.read', { targetType: 'Contact', targetId: contact.id, req });

  const provider = await getPatientProvider(ctx.org.id);
  const [visits, appointments, portal, allergies] = await Promise.all([
    prisma.visitRecord.findMany({
      where: { contactId: contact.id },
      orderBy: { visitedAt: 'desc' },
      include: { documents: { select: { id: true, name: true, mimeType: true, sizeBytes: true } } },
    }),
    prisma.appointment.findMany({
      // Deliberately NARROWER than the patient-facing household scope: staff
      // looking at one person's page want that person's appointments, not the
      // whole family's rolled up. The Family card links to the others.
      //
      // The unlinked phone leg is kept only for a household primary —
      // appointments booked before contactId existed have no link, and dropping
      // it would make a long-standing patient's history silently vanish. A
      // dependent was created after that, so it can have no such rows.
      where: {
        orgId: ctx.org.id,
        OR: [
          { contactId: contact.id },
          ...(contact.dependentKey === '' ? [{ contactId: null, customerNumber: contact.phone }] : []),
        ],
      },
      orderBy: { startAt: 'desc' },
      take: 20,
      select: { id: true, service: true, expertName: true, startAt: true, timezone: true, status: true },
    }),
    prisma.portal.findFirst({
      where: { workspaceId: ctx.workspace.id, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { slug: true },
    }),
    prisma.allergy.findMany({ where: { contactId: contact.id } }),
  ]);

  return NextResponse.json({
    contact: {
      id: contact.id,
      // Fill in a number for a patient who predates numbering, so staff never
      // see a blank where the UHID should be.
      uhid: contact.uhid ?? (await ensureUhid(contact.id)),
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      // As YYYY-MM-DD, never a full ISO instant — a birth date is a calendar
      // date and must not acquire a timezone on the way to the browser.
      dateOfBirth: formatDateOfBirth(contact.dateOfBirth),
      sex: contact.sex,
      notes: contact.notes,
      externalId: contact.externalId,
      lastSeenAt: contact.lastSeenAt,
      portalRevokedAt: contact.portalRevokedAt,
    },
    // Three states, never a bare list — a blank list read as "no allergies" is
    // the error this whole feature exists to prevent.
    allergies: allergyStatus(contact, allergies),
    // Drives what the staff screen offers. When the clinic's own system owns
    // clinical records, the consultation form disappears rather than inviting
    // an edit their next sync would overwrite.
    capabilities: provider.capabilities,
    // The clinic's public chatbot address. No longer a secret — the patient
    // signs in with a code — so it is safe to read out or print.
    portalUrl: portal && !contact.portalRevokedAt ? portalLink(portal.slug) : null,
    visits,
    appointments,
  });
}

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:write');
  if (denied) return denied;

  const contact = await loadScoped(id, ctx.workspace.id);
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    email?: string | null;
    notes?: string | null;
    dateOfBirth?: string | null;
    sex?: string | null;
    // Portal access. There is no link to reissue any more — the patient signs
    // in with a code — so this is a straight block/unblock.
    action?: 'block-portal' | 'restore-portal';
  };

  if (body.action === 'block-portal') {
    await revokePortalAccess(contact.id);
    await audit(ctx, 'patient.portal_blocked', { targetType: 'Contact', targetId: contact.id, req });
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'restore-portal') {
    await restorePortalAccess(contact.id);
    await audit(ctx, 'patient.portal_restored', { targetType: 'Contact', targetId: contact.id, req });
    return NextResponse.json({ ok: true });
  }

  // A date of birth that will not parse is rejected, never silently dropped —
  // "" is an explicit clear, which is different from a typo.
  let dateOfBirth: Date | null | undefined;
  if (body.dateOfBirth !== undefined) {
    if (!body.dateOfBirth?.trim()) {
      dateOfBirth = null;
    } else {
      dateOfBirth = parseDateOfBirth(body.dateOfBirth);
      if (!dateOfBirth) {
        return NextResponse.json({ error: 'Enter the date of birth as YYYY-MM-DD.' }, { status: 400 });
      }
    }
  }

  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      ...(body.name?.trim() ? { name: body.name.trim().slice(0, 120) } : {}),
      ...(body.email !== undefined ? { email: body.email?.trim() || null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes?.slice(0, 4000) || null } : {}),
      ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
      ...(body.sex !== undefined ? { sex: SEXES.find((s) => s.value === body.sex)?.value ?? null } : {}),
    },
  });
  await audit(ctx, 'patient.updated', { targetType: 'Contact', targetId: contact.id, req });
  return NextResponse.json({ ok: true });
}

// Erase a patient. See src/lib/patients/erase.ts for what "erase" means here
// and why it is not a cascade — in short, the person goes and the clinic's
// booking history stays, with the identity scrubbed out of it.
//
// Gated on `patient:delete`, which lives with ADMIN rather than MEMBER: this is
// irreversible and destroys the clinical record, unlike every other patient
// write a front desk does all day.
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:delete');
  if (denied) return denied;

  const contact = await loadScoped(id, ctx.workspace.id);
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const result = await erasePatient({ id: contact.id, orgId: contact.orgId, phone: contact.phone });

  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          `This patient is the main contact for ${result.dependents} family ` +
          `member${result.dependents === 1 ? '' : 's'} on the same number. ` +
          `Delete or move ${result.dependents === 1 ? 'them' : 'those records'} first, ` +
          `so nobody's medical record is left without the adult responsible for it.`,
        reason: result.reason,
        dependents: result.dependents,
      },
      { status: 409 },
    );
  }

  // Audited only once the erase has actually committed. Writing this first
  // would have logged `patient.deleted` for the refusal above too, and an audit
  // trail that records deletions which never happened is worse than one that
  // could lose a row if the process dies in the gap — `erasePatient` is a single
  // transaction, so there is no state where the patient is half-gone.
  //
  // The name and UHID are captured here deliberately: this row is the only
  // remaining trace of who was erased, and "Contact abc123 was deleted" is not
  // answerable once the record is gone.
  await audit(ctx, 'patient.deleted', {
    targetType: 'Contact',
    targetId: contact.id,
    metadata: { uhid: contact.uhid, name: contact.name, ...result },
    req,
  });

  // Carries the counts, so the UI can tell staff what actually happened —
  // "3 appointments kept, name removed" rather than a bare success.
  return NextResponse.json(result);
}
