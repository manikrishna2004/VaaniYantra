import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import {
  getTeamCallConfig,
  disconnectTeamCallCalendar,
  getTeamCallSlots,
  getTeamCallAvailability,
  saveTeamCallAvailability,
  listTeamCallBlocks,
  blockTeamCallTime,
  unblockTeamCallTime,
  BLOCK_PREFIX,
} from '@/lib/team-call';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Status and disconnect for VaaniYantra's OWN calendar — the one customers book
// onboarding calls against. Connecting happens through the normal Google OAuth
// flow at /api/integrations/google/connect?target=platform.
//
// Super-admin only, and never returns the refresh token.

async function requireSuperAdmin() {
  const { ctx, error } = await apiContext();
  if (error) return { error };
  if (!isSuperAdmin(ctx.user.email)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { ctx };
}

export async function GET() {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  const cfg = await getTeamCallConfig();
  // Also report how many slots it is currently offering. "Connected" alone does
  // not tell you the banner is working — a revoked grant or a calendar booked
  // solid both look identical from the config row.
  const slots = cfg ? await getTeamCallSlots() : [];

  const availability = await getTeamCallAvailability();
  // Everything on the calendar in the window, not only our own blocks: a real
  // meeting also closes a slot, and an owner asking "why is Tuesday empty?"
  // needs to see the meeting as readily as the block.
  const entries = cfg ? await listTeamCallBlocks() : [];

  return NextResponse.json({
    connected: Boolean(cfg),
    email: cfg?.email ?? null,
    calendarId: cfg?.calendarId ?? null,
    timezone: cfg?.timezone ?? null,
    openSlots: slots.length,
    availability,
    entries: entries.map((e) => ({ ...e, isBlock: e.summary.startsWith(BLOCK_PREFIX) })),
  });
}

// Save the bookable hours.
export async function PUT(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const saved = await saveTeamCallAvailability(body ?? {});
  await audit(auth.ctx!, 'platform.team_call_availability_saved', {
    targetType: 'Platform',
    metadata: { ...saved, weekly: undefined },
    req,
  });
  return NextResponse.json({ ok: true, availability: saved });
}

// Block time out, or release a block. A block is an ordinary busy event on the
// same calendar, so freeBusy removes it from availability with no extra state
// to keep in step.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  const b = (await req.json().catch(() => ({}))) as {
    action?: string;
    startISO?: string;
    endISO?: string;
    label?: string;
    eventId?: string;
  };

  if (b.action === 'unblock') {
    if (!b.eventId) return NextResponse.json({ error: 'eventId is required.' }, { status: 400 });
    const ok = await unblockTeamCallTime(b.eventId);
    if (!ok) return NextResponse.json({ error: 'Could not remove that entry.' }, { status: 502 });
    await audit(auth.ctx!, 'platform.team_call_unblocked', {
      targetType: 'Platform',
      metadata: { eventId: b.eventId },
      req,
    });
    return NextResponse.json({ ok: true });
  }

  const res = await blockTeamCallTime({
    startISO: b.startISO ?? '',
    endISO: b.endISO ?? '',
    label: b.label,
  });
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 400 });
  await audit(auth.ctx!, 'platform.team_call_blocked', {
    targetType: 'Platform',
    metadata: { startISO: b.startISO, endISO: b.endISO, label: b.label ?? null },
    req,
  });
  return NextResponse.json({ ok: true, id: res.id });
}

export async function DELETE(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  await disconnectTeamCallCalendar();
  await audit(auth.ctx!, 'platform.team_call_calendar_disconnected', {
    targetType: 'Platform',
    req,
  });
  return NextResponse.json({ ok: true });
}
