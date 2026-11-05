import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { upsertContact, issuePortalToken } from '@/lib/portal/contacts';
import { newHouseholdSlot } from '@/lib/patients/household';
import { allocateUhid } from '@/lib/patients/uhid';
import { toE164 } from '@/lib/phone';
import { parseDateOfBirth, SEXES } from '@/lib/patients/age';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Staff-facing patient list. Most patients arrive here on their own, created by
// the booking flow; this also allows adding a walk-in by hand.
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:read');
  if (denied) return denied;

  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  const contacts = await prisma.contact.findMany({
    where: {
      workspaceId: ctx.workspace.id,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { phone: { contains: q } },
              // Staff search by patient number more than by anything else once
              // a clinic has more than a few hundred patients.
              { uhid: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      uhid: true,
      name: true,
      phone: true,
      dateOfBirth: true,
      sex: true,
      lastSeenAt: true,
      portalRevokedAt: true,
      createdAt: true,
      _count: { select: { visits: true } },
    },
  });

  // The list hands back names, phone numbers and dates of birth, so reaching it
  // is a record access like opening one file. The search term is recorded (it is
  // what the staff member was looking for) but not the results — a hundred
  // patient ids per page-load would bury the log without adding anything a
  // targeted query cannot recover.
  await audit(ctx, 'patient.searched', {
    targetType: 'Contact',
    metadata: { query: q || null, results: contacts.length },
    req,
  });

  return NextResponse.json(contacts);
}

export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'patient:write');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    phone?: string;
    email?: string;
    dateOfBirth?: string;
    sex?: string;
    /** Register a SECOND person on a number that already has a patient. */
    asFamilyMember?: boolean;
  };
  const name = (body.name ?? '').trim();
  const phone = toE164(body.phone ?? '');
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 });
  if (!phone) return NextResponse.json({ error: 'Enter a valid mobile number.' }, { status: 400 });

  // Reject a bad date rather than dropping it silently — a wrong or missing DOB
  // corrupts every age-based clinical judgement downstream.
  const dateOfBirth = body.dateOfBirth ? parseDateOfBirth(body.dateOfBirth) : null;
  if (body.dateOfBirth?.trim() && !dateOfBirth) {
    return NextResponse.json({ error: 'Enter the date of birth as YYYY-MM-DD.' }, { status: 400 });
  }
  const sex = SEXES.find((s) => s.value === body.sex)?.value ?? null;

  // Registering a family member on a number that already has a patient is an
  // explicit act, not something to infer — `upsertContact` would quietly return
  // the existing primary and the new person would vanish. So the caller has to
  // say so, and the UI shows them who is already on that number first.
  let contact;
  if (body.asFamilyMember) {
    const slot = await newHouseholdSlot(ctx.org.id, phone);
    contact = await prisma.contact.create({
      data: {
        orgId: ctx.org.id,
        workspaceId: ctx.workspace.id,
        name,
        phone,
        email: body.email?.trim() || null,
        dateOfBirth,
        sex,
        portalToken: issuePortalToken(),
        uhid: await allocateUhid(ctx.org.id),
        ...slot,
      },
    });
  } else {
    contact = await upsertContact({
      orgId: ctx.org.id,
      workspaceId: ctx.workspace.id,
      name,
      phone,
      email: body.email,
      dateOfBirth,
      sex,
    });
  }
  if (!contact) return NextResponse.json({ error: 'Could not save that patient.' }, { status: 400 });

  await audit(ctx, 'patient.created', {
    targetType: 'Contact',
    targetId: contact.id,
    metadata: { uhid: contact.uhid },
    req,
  });
  return NextResponse.json({ id: contact.id, uhid: contact.uhid, name: contact.name, phone: contact.phone }, { status: 201 });
}
