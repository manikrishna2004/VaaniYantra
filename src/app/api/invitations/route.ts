import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { isRole } from '@/lib/auth/permissions';
import { audit } from '@/lib/audit';
import { sendMail, inviteEmail, mailerConfigured } from '@/lib/mailer';
import { checkRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const INVITE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

function inviteUrl(token: string): string {
  const base =
    process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/invite/${token}`;
}

// Pending invitations for the active org.
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  const invitations = await prisma.invitation.findMany({
    where: { orgId: ctx.org.id, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({
    // So the Team page can say "we emailed them" vs "copy this link to them"
    // without guessing at the server's configuration.
    mailerConfigured: mailerConfigured(),
    invitations: invitations.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      url: inviteUrl(i.token),
    })),
  });
}

// Create (or refresh) an invitation; returns a shareable link.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'member:manage');
  if (denied) return denied;

  // This endpoint sends mail to an address the caller chooses, so it is a spam
  // relay if left unthrottled. Generous enough that onboarding a whole practice
  // in one sitting never hits it.
  const rl = checkRateLimit(`invite:${ctx.org.id}`, INVITE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Too many invitations just now. Try again in a little while.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string };
  const email = body.email?.trim().toLowerCase();
  const role = body.role ?? 'MEMBER';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }
  if (!isRole(role)) return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
  if (role === 'OWNER' && ctx.role !== 'OWNER') {
    return NextResponse.json({ error: 'Only owners can invite owners' }, { status: 403 });
  }

  // Already a member?
  const existingMember = await prisma.membership.findFirst({
    where: { orgId: ctx.org.id, user: { email } },
  });
  if (existingMember) {
    return NextResponse.json({ error: 'That person is already a member' }, { status: 409 });
  }

  const token = randomBytes(24).toString('hex');
  const invitation = await prisma.invitation.upsert({
    where: { orgId_email: { orgId: ctx.org.id, email } },
    update: { role, token, status: 'PENDING', expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    create: {
      orgId: ctx.org.id,
      email,
      role,
      token,
      status: 'PENDING',
      invitedById: ctx.user.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  const url = inviteUrl(token);

  // Best-effort: sendMail never throws and returns false when no backend is
  // configured. The invite exists either way, so the UI falls back to a link
  // the owner can send themselves rather than the whole action failing.
  const mail = inviteEmail({
    orgName: ctx.org.name,
    inviterName: ctx.user.name || ctx.user.email,
    role,
    url,
  });
  const emailed = await sendMail({ to: email, ...mail });

  await audit(ctx, 'member.invited', {
    targetType: 'Invitation',
    targetId: invitation.id,
    metadata: { email, role, emailed },
    req,
  });

  return NextResponse.json({ id: invitation.id, email, role, url, emailed }, { status: 201 });
}
