import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { writeAudit } from '@/lib/audit';
import { LEGAL_VERSION, LEGAL_DOCUMENTS } from '@/lib/legal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Accept the current version of the Terms, Privacy Policy and DPA for this
// organisation. Used by the prompt shown to orgs created before the sign-up
// acceptance box existed, and by any org whose accepted version has gone stale
// after a material change to the documents.
//
// Gated on org:manage (OWNER only). Accepting a DPA binds the clinic as Data
// Fiduciary — a front-desk MEMBER cannot commit the practice to it, and an
// acceptance taken from someone without authority is worth less than none,
// because it looks like evidence and is not.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const forbidden = deny(ctx, 'org:manage');
  if (forbidden) return forbidden;

  // Idempotent: re-accepting the version already on record is a no-op rather
  // than a second row, so a double-click cannot muddy the audit trail.
  if (ctx.org.termsVersion === LEGAL_VERSION) {
    return NextResponse.json({ ok: true, alreadyAccepted: true });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const previous = ctx.org.termsVersion;

  await prisma.organization.update({
    where: { id: ctx.org.id },
    data: {
      termsAcceptedAt: new Date(),
      termsVersion: LEGAL_VERSION,
      termsAcceptedByUserId: ctx.user.id,
      termsAcceptedIp: ip,
    },
  });

  await writeAudit({
    orgId: ctx.org.id,
    actorUserId: ctx.user.id,
    actorEmail: ctx.user.email,
    action: 'org.terms_accepted',
    targetType: 'Organization',
    targetId: ctx.org.id,
    // `previous` distinguishes a first-ever acceptance from an upgrade off an
    // older version. The columns only ever show the latest, so without this the
    // history of what an org agreed to at each point is unrecoverable.
    metadata: {
      version: LEGAL_VERSION,
      previousVersion: previous,
      documents: LEGAL_DOCUMENTS,
      source: 're-accept',
    },
    ip,
  });

  return NextResponse.json({ ok: true });
}
