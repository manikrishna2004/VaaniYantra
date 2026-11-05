import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext } from '@/lib/auth/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Public: invitation details for the accept screen (the token is the secret).
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { org: { select: { name: true } } },
  });
  if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
    return NextResponse.json({ valid: false }, { status: 404 });
  }
  return NextResponse.json({
    valid: true,
    email: invitation.email,
    role: invitation.role,
    orgName: invitation.org.name,
  });
}

// Authed: the signed-in user accepts and joins the organization.
/**
 * Make sure this newly-joined user is a Doctor in this org, exactly once.
 *
 * Order matters, and each step is a real case:
 *   1. Already a doctor here — a re-accepted or double-clicked link. Return.
 *   2. An unlinked row the admin already typed in, matched by email. CLAIM it,
 *      so the schedule, time off and appointment history they already have
 *      survive instead of being orphaned beside a fresh duplicate. Only an
 *      unambiguous single match is claimed; two candidates are a judgement an
 *      admin should make, not us.
 *   3. Otherwise create one, deliberately NOT bookable — see the note below.
 *
 * The unique on (orgId, userId) is the real guard; the lookup is the fast path.
 * A P2002 from two concurrent accepts is expected and re-read, not an error.
 */
async function ensureDoctor(a: {
  orgId: string;
  workspaceId: string;
  userId: string;
  email: string;
  name: string | null;
}): Promise<void> {
  try {
    const existing = await prisma.doctor.findUnique({
      where: { orgId_userId: { orgId: a.orgId, userId: a.userId } },
      select: { id: true },
    });
    if (existing) return;

    const unlinked = await prisma.doctor.findMany({
      where: { orgId: a.orgId, userId: null, email: a.email },
      select: { id: true },
      take: 2,
    });
    if (unlinked.length === 1) {
      await prisma.doctor.update({ where: { id: unlinked[0].id }, data: { userId: a.userId } });
      return;
    }

    await prisma.doctor.create({
      data: {
        orgId: a.orgId,
        workspaceId: a.workspaceId,
        userId: a.userId,
        email: a.email,
        // A placeholder until they set a real one. Which is exactly why the row
        // starts NOT bookable: without this the agent would begin offering
        // callers an appointment with "manikanta" seconds after the invite was
        // accepted. Saving a name and specialisation flips it.
        displayName: a.name?.trim() || a.email.split('@')[0],
        bookable: false,
      },
    });
  } catch (err) {
    // Losing the race is fine — the winner created the row. Anything else is
    // logged and swallowed: failing to become a doctor must not fail the join,
    // or the user is left signed in to an org they cannot see.
    console.error('[invite] could not ensure doctor row', err);
  }
}

export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const body = (await req.json().catch(() => ({}))) as { token?: string };
  if (!body.token) return NextResponse.json({ error: 'Missing token' }, { status: 400 });

  const invitation = await prisma.invitation.findUnique({ where: { token: body.token } });
  if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
    return NextResponse.json({ error: 'This invitation is no longer valid' }, { status: 410 });
  }
  if (invitation.email.toLowerCase() !== ctx.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: `This invitation was sent to ${invitation.email}. Sign in with that email to accept.` },
      { status: 403 },
    );
  }

  // Join the org (idempotent) and mark the invite accepted.
  await prisma.membership.upsert({
    where: { userId_orgId: { userId: ctx.user.id, orgId: invitation.orgId } },
    update: {},
    create: { userId: ctx.user.id, orgId: invitation.orgId, role: invitation.role },
  });
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: 'ACCEPTED' },
  });

  const firstWs = await prisma.workspace.findFirst({
    where: { orgId: invitation.orgId },
    orderBy: { createdAt: 'asc' },
  });

  // A DOCTOR invite is the act that makes someone bookable. Doing it here, in
  // the same request that grants membership, is what removes the old two-step
  // where an admin invited a person AND separately typed their name into a
  // doctor list — the split that meant a Doctor row almost never had a linked
  // account, and so could never be resolved on a call.
  if (invitation.role === 'DOCTOR' && firstWs) {
    await ensureDoctor({
      orgId: invitation.orgId,
      workspaceId: firstWs.id,
      userId: ctx.user.id,
      email: invitation.email,
      name: ctx.user.name,
    });
  }
  await prisma.user.update({
    where: { id: ctx.user.id },
    data: { activeOrgId: invitation.orgId, activeWorkspaceId: firstWs?.id ?? null },
  });

  const org = await prisma.organization.findUnique({
    where: { id: invitation.orgId },
    select: { name: true },
  });
  // `role` lets the invite page send a doctor to their own setup screen
  // rather than to a dashboard built for clinic staff.
  return NextResponse.json({ ok: true, orgName: org?.name ?? 'the organization', role: invitation.role });
}
