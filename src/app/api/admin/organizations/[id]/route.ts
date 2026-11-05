import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { isSuperAdmin } from '@/lib/platform';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { countOrgData, deleteOrganization } from '@/lib/org-delete';
import { isOrgStatus } from '@/lib/org-status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Tenant offboarding, operator-only.
//
// Super-admin session ONLY — no cron-secret path, unlike the retention sweep.
// A bearer token that deletes an entire customer is a credential nobody should
// be able to leave in a shell history, and this runs a handful of times a year
// with a human present. `scripts/delete-org.ts` is the other way in.
//
// There is deliberately no customer-facing route: /dpa §8 and /data-deletion
// promise deletion by our team within 30 days, and that promise is what this
// implements. Adding an owner-facing button would mean rewriting both.

async function requireSuperAdmin() {
  const { ctx, error } = await apiContext();
  if (error) return { error };
  if (!isSuperAdmin(ctx.user.email)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ctx };
}

// What a deletion would remove. Always call this first — it is the figures the
// operator confirms against.
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { id } = await props.params;
  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  const report = await countOrgData(id);
  if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(report);
}

// Pause / deactivate / reactivate. Reversible and data-preserving, which is why
// this needs no name confirmation the way DELETE below does.
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { id } = await props.params;
  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  const body = (await req.json().catch(() => ({}))) as { status?: string; reason?: string | null };
  if (!isOrgStatus(body.status)) {
    return NextResponse.json(
      { error: 'status must be ACTIVE, PAUSED or DEACTIVATED.' },
      { status: 400 },
    );
  }

  const org = await prisma.organization.findUnique({ where: { id }, select: { name: true, status: true } });
  if (!org) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const updated = await prisma.organization.update({
    where: { id },
    data: {
      status: body.status,
      // Reason is the message the org is shown, so it is cleared on the way
      // back to ACTIVE rather than left behind to reappear at the next pause.
      statusReason: body.status === 'ACTIVE' ? null : body.reason?.trim() || null,
      statusChangedAt: new Date(),
    },
    select: { id: true, name: true, status: true, statusReason: true, statusChangedAt: true },
  });

  // Audited, unlike DELETE: the org survives, so its audit trail survives with
  // it and is the right place for "who stopped this account, and when".
  await audit(auth.ctx!, 'platform.org_status_changed', {
    targetType: 'Organization',
    targetId: id,
    metadata: { orgName: org.name, from: org.status, to: body.status, reason: updated.statusReason },
    req,
  });

  return NextResponse.json({ ok: true, org: updated });
}

export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { id } = await props.params;
  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  const body = (await req.json().catch(() => ({}))) as { confirm?: string };

  const report = await countOrgData(id);
  if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // The caller must name the tenant they are destroying. An id is easy to
  // paste from the wrong tab; a name is not something you get right by accident.
  if (body.confirm !== report.orgName) {
    return NextResponse.json(
      {
        error: "To delete an organisation, `confirm` must be its exact name.",
        expected: report.orgName,
        counts: report.counts,
      },
      { status: 400 },
    );
  }

  const startedAt = new Date().toISOString();
  const done = await deleteOrganization(id);

  // Logged, not audited: AuditLog cascades away with the organisation, so a row
  // written there would be destroyed by the operation it records. This line is
  // the surviving record and lands in pm2 / Cloud Logging.
  console.log(
    `[org-delete] DELETED ${JSON.stringify({
      orgId: report.orgId,
      orgName: report.orgName,
      by: auth.ctx?.user.email ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: done?.counts,
    })}`,
  );

  return NextResponse.json({ ok: true, ...done });
}
