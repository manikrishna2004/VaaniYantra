import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { getCalendarConfigFor, listCalendars, SHARED_CALENDAR_OWNER } from '@/lib/calendar';
import { refreshAccessToken } from '@/lib/google-oauth';
import { parseTarget } from '@/lib/google-target';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// List the connected account's writable calendars, for the picker.
// ?target=me lists the caller's own account instead of the clinic's shared one.
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;

  const target = parseTarget(new URL(req.url).searchParams.get('target'));
  const denied = target === 'me' ? null : deny(ctx, 'integration:read');
  if (denied) return denied;

  const owner = target === 'me' ? ctx.user.id : SHARED_CALENDAR_OWNER;
  const cfg = await getCalendarConfigFor(ctx.org.id, owner);
  if (!cfg) return NextResponse.json({ error: 'Not connected' }, { status: 409 });

  try {
    const token = await refreshAccessToken(cfg.refreshToken);
    const cals = await listCalendars(token);
    return NextResponse.json({
      calendars: cals.map((c) => ({ id: c.id, summary: c.summary, primary: Boolean(c.primary) })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Could not list calendars', detail: err?.message }, { status: 502 });
  }
}
