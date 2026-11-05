import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiAuth, paging } from '@/lib/api/v1';
import { toE164 } from '@/lib/phone';
import { issuePortalToken, portalLink } from '@/lib/portal/contacts';
import { allocateUhid } from '@/lib/patients/uhid';
import { parseDateOfBirth, formatDateOfBirth, SEXES } from '@/lib/patients/age';
import { newHouseholdSlot } from '@/lib/patients/household';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Public v1: the clinic's own system pushes patients into the platform.
//
// This is the integration path most clinics can actually deliver. Their
// developer writes one authenticated POST; they need no read API of their own,
// no inbound network access, and no credentials of theirs stored by us. It also
// means a patient opening their prescription at 10pm is not depending on the
// clinic's server being awake.
//
// Idempotent on `externalId` — their patient id. Re-sending the same patient is
// an update, so a client can safely replay a day's changes after an outage
// without creating duplicates.

function serializeContact(c: {
  id: string;
  externalId: string | null;
  uhid: string | null;
  name: string;
  phone: string;
  email: string | null;
  dateOfBirth: Date | null;
  sex: string | null;
  createdAt: Date;
}) {
  return {
    id: c.id,
    externalId: c.externalId,
    // Our patient number, as shown on our screens. Additive to the response —
    // existing integrations are unaffected.
    uhid: c.uhid,
    name: c.name,
    phone: c.phone,
    email: c.email,
    // A calendar date, so YYYY-MM-DD rather than a full ISO instant — an
    // integrator must not have to reason about a birthday's timezone.
    dateOfBirth: formatDateOfBirth(c.dateOfBirth),
    sex: c.sex,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function GET(req: Request) {
  const auth = await requireApiAuth(req, 'patients:read');
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const { take, skip, limit, offset } = paging(url);
  const phone = toE164(url.searchParams.get('phone') ?? '');
  const externalId = url.searchParams.get('externalId')?.trim();

  const where = {
    orgId: auth.orgId,
    ...(phone ? { phone } : {}),
    ...(externalId ? { externalId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
      select: { id: true, externalId: true, uhid: true, name: true, phone: true, email: true, dateOfBirth: true, sex: true, createdAt: true },
    }),
    prisma.contact.count({ where }),
  ]);
  return NextResponse.json({ data: rows.map(serializeContact), total, limit, offset });
}

export async function POST(req: Request) {
  const auth = await requireApiAuth(req, 'patients:write');
  if (auth instanceof NextResponse) return auth;

  const body = (await req.json().catch(() => null)) as {
    name?: string;
    phone?: string;
    email?: string;
    externalId?: string;
    workspaceId?: string;
    dateOfBirth?: string;
    sex?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const name = (body.name ?? '').trim();
  const phone = toE164(body.phone ?? '');
  const externalId = body.externalId?.trim() || null;
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (!phone) {
    return NextResponse.json(
      { error: 'phone is required and must be a valid mobile number (E.164, e.g. +919876543210)' },
      { status: 400 },
    );
  }

  // Resolve the workspace: explicit if given, else the org's first. Most orgs
  // have exactly one, and requiring integrators to know about workspaces would
  // be exposing our internals for no benefit to them.
  const workspace = body.workspaceId
    ? await prisma.workspace.findFirst({ where: { id: body.workspaceId, orgId: auth.orgId }, select: { id: true } })
    : await prisma.workspace.findFirst({ where: { orgId: auth.orgId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!workspace) return NextResponse.json({ error: 'No workspace found for this organization' }, { status: 400 });

  // Match on their id first, then fall back to phone — the same human must not
  // become two records because a push arrived before the phone booking did.
  //
  // The phone fallback runs even when an externalId was supplied but matched
  // nothing. Without it, pushing a NEW externalId on an EXISTING phone fell
  // through to `create` and violated the phone uniqueness — a live 500 that hit
  // the very first time a clinic pushed a second family member, and the reason
  // INTEGRATION_GUIDE.md carried a "family members sharing a number will
  // collide" caveat. Now the second family member becomes a dependent instead.
  const existing =
    (externalId ? await prisma.contact.findFirst({ where: { orgId: auth.orgId, externalId } }) : null) ??
    (await prisma.contact.findFirst({ where: { orgId: auth.orgId, phone, dependentKey: '' } }));

  // A patient pushed from the clinic's own system still gets one of OUR patient
  // numbers, because that is what our screens, exports and chatbot display.
  // Their `externalId` stays untouched and authoritative on their side.
  const uhid = existing?.uhid ?? (await allocateUhid(auth.orgId));

  // Rejected rather than dropped: an integration silently losing a date of
  // birth is how a paediatric dose gets calculated against no age at all.
  const dateOfBirth = body.dateOfBirth ? parseDateOfBirth(body.dateOfBirth) : null;
  if (body.dateOfBirth?.trim() && !dateOfBirth) {
    return NextResponse.json({ error: 'dateOfBirth must be a valid date in YYYY-MM-DD form' }, { status: 400 });
  }
  const sex = body.sex !== undefined ? (SEXES.find((s) => s.value === body.sex)?.value ?? null) : undefined;
  if (body.sex !== undefined && body.sex !== '' && sex === null) {
    return NextResponse.json({ error: 'sex must be one of: female, male, other' }, { status: 400 });
  }

  const contact = existing
    ? await prisma.contact.update({
        where: { id: existing.id },
        data: {
          name,
          phone,
          ...(body.email !== undefined ? { email: body.email?.trim() || null } : {}),
          ...(externalId ? { externalId } : {}),
          ...(existing.uhid ? {} : { uhid }),
          ...(dateOfBirth ? { dateOfBirth } : {}),
          ...(sex !== undefined ? { sex } : {}),
        },
      })
    : await prisma.contact.create({
        data: {
          orgId: auth.orgId,
          workspaceId: workspace.id,
          name,
          phone,
          email: body.email?.trim() || null,
          externalId,
          portalToken: issuePortalToken(),
          uhid,
          dateOfBirth,
          sex: sex ?? null,
          // A second person on a number already in use is a DEPENDENT, not a
          // replacement. The household primary keeps `""`; everyone after gets
          // their own slot, their own UHID and their own allergy list.
          ...(await newHouseholdSlot(auth.orgId, phone)),
        },
      });

  // Hand back the patient's portal link so their system can put it in its own
  // SMS/print/discharge summary if it would rather own that message.
  const portal = await prisma.portal.findFirst({
    where: { workspaceId: contact.workspaceId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { slug: true },
  });

  return NextResponse.json(
    {
      ...serializeContact(contact),
      portalUrl: portal && !contact.portalRevokedAt ? portalLink(portal.slug) : null,
      created: !existing,
    },
    { status: existing ? 200 : 201 },
  );
}
