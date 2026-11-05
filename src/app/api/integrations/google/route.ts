import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import {
  getCalendarConfig,
  getCalendarConfigFor,
  disconnectCalendar,
  setCalendarId,
  SHARED_CALENDAR_OWNER,
} from '@/lib/calendar';
import { googleOAuthConfigured } from '@/lib/google-oauth';
import { parseTarget, type CalendarTarget } from '@/lib/google-target';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Every write here is scoped by ?target: 'org' touches the clinic's shared
// connection (admins), 'me' touches only the caller's own. A doctor must be
// able to manage their own calendar without being able to reach the clinic's.
function permissionFor(target: CalendarTarget) {
  return target === 'me' ? ('integration:connect_self' as const) : ('integration:manage' as const);
}

// Connection status (never returns the refresh token).
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const target = parseTarget(new URL(req.url).searchParams.get('target'));
  // Reading your own connection needs no admin rights — you are the subject.
  const denied = target === 'me' ? null : deny(ctx, 'integration:read');
  if (denied) return denied;

  const owner = target === 'me' ? ctx.user.id : SHARED_CALENDAR_OWNER;
  const [cfg, shared] = await Promise.all([
    getCalendarConfigFor(ctx.org.id, owner),
    target === 'me' ? getCalendarConfig(ctx.org.id) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    oauthConfigured: googleOAuthConfigured(),
    connected: Boolean(cfg),
    email: cfg?.email ?? null,
    calendarId: cfg?.calendarId ?? null,
    // So a doctor's card can say "the clinic's shared calendar is being used
    // for your patients" rather than looking simply unconfigured.
    sharedConnected: target === 'me' ? Boolean(shared) : undefined,
  });
}

export async function PATCH(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const target = parseTarget(new URL(req.url).searchParams.get('target'));
  const denied = deny(ctx, permissionFor(target));
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { calendarId?: string };
  const calendarId = body.calendarId?.trim();
  if (!calendarId) return NextResponse.json({ error: 'calendarId required' }, { status: 400 });

  const owner = target === 'me' ? ctx.user.id : SHARED_CALENDAR_OWNER;
  const ok = await setCalendarId(ctx.org.id, ctx.user.id, calendarId, owner);
  if (!ok) return NextResponse.json({ error: 'Not connected' }, { status: 409 });
  return NextResponse.json({ ok: true, calendarId });
}

export async function DELETE(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const target = parseTarget(new URL(req.url).searchParams.get('target'));
  const denied = deny(ctx, permissionFor(target));
  if (denied) return denied;

  const owner = target === 'me' ? ctx.user.id : SHARED_CALENDAR_OWNER;
  await disconnectCalendar(ctx.org.id, owner);
  await audit(ctx, 'integration.deleted', {
    targetType: 'Integration',
    metadata: { provider: 'googleCalendar', target },
    req,
  });
  return NextResponse.json({ ok: true });
}
