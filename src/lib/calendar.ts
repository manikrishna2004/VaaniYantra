import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import { minutesOf, type DayWindow } from '@/lib/agent-behavior';

// Phase 6C — Google Calendar. A workspace connects its Google account (OAuth);
// we store the refresh token + chosen calendar (encrypted) in the Integration
// table under provider "googleCalendar". On a completed call we extract any
// booked appointment and create a calendar event.

const PROVIDER = 'googleCalendar';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

export type CalendarConfig = {
  refreshToken: string;
  calendarId: string; // "primary" or a specific calendar id
  email?: string;
  timezone?: string;
};

// Who a Google connection belongs to. "" is the clinic's shared connection —
// the one the org has always had; a user id is a doctor's own account.
export const SHARED_CALENDAR_OWNER = '';

export async function getCalendarConfigFor(
  orgId: string | null | undefined,
  userId: string,
): Promise<CalendarConfig | null> {
  if (!orgId) return null;
  const row = await prisma.integration.findFirst({
    where: { orgId, provider: PROVIDER, userId, enabled: true },
  });
  if (!row) return null;
  try {
    return JSON.parse(decryptSecret(row.secret)) as CalendarConfig;
  } catch {
    return null;
  }
}

/**
 * The clinic's shared Google connection.
 *
 * Signature deliberately unchanged from before per-doctor calendars existed, so
 * every caller that only ever meant "the clinic's calendar" — post-call event
 * creation, connector status, the tool gates — keeps working untouched.
 */
export async function getCalendarConfig(orgId: string | null | undefined): Promise<CalendarConfig | null> {
  return getCalendarConfigFor(orgId, SHARED_CALENDAR_OWNER);
}

/**
 * The connection to use for a given doctor: their own if they have one, else
 * the clinic's shared account. Returns which one was used, because callers have
 * to persist that alongside the booking — see Appointment.calendarUserId.
 */
export async function resolveDoctorCalendar(
  orgId: string,
  userId: string | null | undefined,
): Promise<{ cfg: CalendarConfig; ownerUserId: string } | null> {
  if (userId) {
    const own = await getCalendarConfigFor(orgId, userId);
    if (own) return { cfg: own, ownerUserId: userId };
  }
  const shared = await getCalendarConfig(orgId);
  return shared ? { cfg: shared, ownerUserId: SHARED_CALENDAR_OWNER } : null;
}

export async function saveCalendarConfig(
  orgId: string,
  createdById: string,
  cfg: CalendarConfig,
  userId: string = SHARED_CALENDAR_OWNER,
): Promise<void> {
  const secret = encryptSecret(JSON.stringify(cfg));
  await prisma.integration.upsert({
    where: { orgId_provider_userId: { orgId, provider: PROVIDER, userId } },
    update: { secret, lastFour: 'cal', enabled: true },
    create: { orgId, provider: PROVIDER, userId, secret, lastFour: 'cal', createdById },
  });
}

export async function disconnectCalendar(orgId: string, userId: string = SHARED_CALENDAR_OWNER): Promise<void> {
  // Scoped to one connection: disconnecting the clinic's shared account must
  // not silently sever every doctor's personal calendar as well.
  await prisma.integration.deleteMany({ where: { orgId, provider: PROVIDER, userId } });
}

// Patch just the chosen calendar id (keeps the refresh token).
export async function setCalendarId(
  orgId: string,
  createdById: string,
  calendarId: string,
  userId: string = SHARED_CALENDAR_OWNER,
): Promise<boolean> {
  const cfg = await getCalendarConfigFor(orgId, userId);
  if (!cfg) return false;
  await saveCalendarConfig(orgId, createdById, { ...cfg, calendarId }, userId);
  return true;
}

/**
 * Whether ANY Google Calendar is connected for this org — the clinic's shared
 * account or any doctor's own.
 *
 * This is the right gate for "can this clinic book at all?". Checking only the
 * shared connection would silently disable booking for a practice where every
 * doctor connected their own calendar and nobody connected a clinic-wide one.
 */
export async function hasAnyCalendarConnection(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  const row = await prisma.integration.findFirst({
    where: { orgId, provider: PROVIDER, enabled: true },
    select: { id: true },
  });
  return Boolean(row);
}

/** Which members of an org have connected their own calendar. */
export async function listDoctorCalendarOwners(orgId: string): Promise<string[]> {
  const rows = await prisma.integration.findMany({
    where: { orgId, provider: PROVIDER, enabled: true, NOT: { userId: SHARED_CALENDAR_OWNER } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

type GoogleCalendarListItem = { id: string; summary: string; primary?: boolean; accessRole?: string };

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListItem[]> {
  const res = await fetch(`${CAL_API}/users/me/calendarList?minAccessRole=writer&maxResults=250`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`calendarList failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { items?: GoogleCalendarListItem[] };
  return json.items ?? [];
}

export type CalendarEventInput = {
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  timezone?: string;
  /**
   * Email addresses to invite.
   *
   * This is how an event reaches SOMEONE ELSE'S calendar. There is no need for —
   * and no way to get — access to the other person's calendar: Google delivers
   * the invitation and their own client adds it. Sending is gated on
   * `notifyAttendees`, because an event created with attendees and no
   * sendUpdates is silently invisible to everyone but the organiser.
   */
  attendees?: string[];
  /** Send Google's invitation emails to attendees. Off unless asked for. */
  notifyAttendees?: boolean;
  /** Attach a Google Meet link. Requires a calendar that can host Meet. */
  addMeet?: boolean;
};

export async function createEvent(
  accessToken: string,
  calendarId: string,
  ev: CalendarEventInput,
): Promise<{ id: string; htmlLink: string; hangoutLink?: string }> {
  const attendees = (ev.attendees ?? []).filter(Boolean);
  const body: Record<string, unknown> = {
    summary: ev.summary,
    description: ev.description,
    start: { dateTime: ev.startISO, ...(ev.timezone ? { timeZone: ev.timezone } : {}) },
    end: { dateTime: ev.endISO, ...(ev.timezone ? { timeZone: ev.timezone } : {}) },
    ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
    ...(ev.addMeet
      ? {
          conferenceData: {
            createRequest: {
              // Google requires a caller-supplied id it can dedupe retries on.
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  };

  // Both of these are QUERY parameters, not body fields — a very easy thing to
  // get wrong, and the failure is silent: the event is created, the Meet link
  // is missing and nobody is ever told about the invitation.
  const params = new URLSearchParams();
  if (ev.addMeet) params.set('conferenceDataVersion', '1');
  if (attendees.length) params.set('sendUpdates', ev.notifyAttendees ? 'all' : 'none');
  const qs = params.toString();

  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events${qs ? `?${qs}` : ''}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`createEvent failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Free/busy + open-slot computation (live booking, Phase A) ───────────────

export type BusyInterval = { start: number; end: number }; // epoch ms

// Query Google free/busy for a calendar across a window. Returns busy intervals.
export async function freeBusy(
  accessToken: string,
  calendarId: string,
  startISO: string,
  endISO: string,
): Promise<BusyInterval[]> {
  const res = await fetch(`${CAL_API}/freeBusy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: startISO, timeMax: endISO, items: [{ id: calendarId }] }),
  });
  if (!res.ok) throw new Error(`freeBusy failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[] }> };
  const busy = json.calendars?.[calendarId]?.busy ?? [];
  return busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

// Offset (minutes) of a timezone at a given instant, via Intl (handles DST).
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Convert a wall-clock time in `timeZone` to a UTC Date.
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = Date.UTC(y, m, d, hh, mm);
  const offset = tzOffsetMinutes(new Date(guess), timeZone);
  return new Date(guess - offset * 60000);
}

export type SlotOptions = {
  timezone: string;
  durationMin: number;
  lookaheadDays: number;
  dailyStartHour: number; // local hour, e.g. 9
  dailyEndHour: number; // local hour, e.g. 18
  maxSlots?: number;
  /**
   * Most slots to take from any ONE day while scanning the window.
   *
   * This is what makes the result span the window instead of stopping at the
   * first day. See the note on the day loop below — without it, a caller asking
   * for next week is offered this afternoon.
   */
  maxPerDay?: number;
  /** Restrict to a single calendar date, `YYYY-MM-DD` as read in `timezone`. */
  onDate?: string;
  /**
   * The time the caller actually asked for, as minutes past local midnight.
   *
   * Without this, a caller naming an hour got the first slots of the day and
   * nothing else — "I asked for 11 and it offered me 9:00 and 9:20, every day".
   * The day is scanned in full and the results are the ones NEAREST this time,
   * the requested slot itself first when it is free.
   *
   * Only meaningful with `onDate`; a time means nothing without a day.
   */
  nearMin?: number;
  /**
   * Offer times across the whole day rather than the first few of it.
   *
   * Same complaint, other half: a caller who named only a day was read the
   * opening hour every time, so nothing after mid-morning could ever be booked
   * through the agent. Ignored when `nearMin` is set, which has its own order.
   */
  spread?: boolean;
  /**
   * Per-weekday opening hours, indexed by JS `getDay()` (0=Sun..6=Sat).
   *
   * When present it overrides `dailyStartHour`/`dailyEndHour` for that weekday,
   * and a `closed` day produces no slots at all. Absent means "open the same
   * hours every day", which is what every clinic got before this existed — and
   * why a practice closed on Sundays was still handing out Sunday appointments.
   */
  weekly?: DayWindow[];
};

// Compute open appointment slots in the next `lookaheadDays`, within daily
// business hours (in `timezone`), excluding busy intervals and past times.
//
// ⚠ THE DAY LOOP MUST NOT BE CAPPED BY THE TOTAL COUNT. It used to read
// `for (let day = 0; day < opts.lookaheadDays && out.length < max; day++)`, and
// that single clause was the "agent can only book same-day" bug: one 9-to-6 day
// at 20-minute slots offers 27 candidates, so `out.length` hit the cap of 6
// before the loop could ever reach day 1. Every one of the first 16
// appointments in production was booked for the same day it was created, and
// the per-agent `lookaheadDays: 14` setting was dead code.
//
// The total cap now lives only on the inner hour loop, alongside a per-day
// counter, so the scan always walks the whole window.
export function computeOpenSlots(busy: BusyInterval[], opts: SlotOptions, now = new Date()): { startISO: string; endISO: string }[] {
  const out: { startISO: string; endISO: string }[] = [];
  const max = opts.maxSlots ?? 6;
  // A named date means every slot has to come from that date, so the per-day
  // cap is simply the total: offer as many times on the requested day as we can.
  //
  // Asking about a specific time, or wanting the day spread, needs every
  // candidate the day holds before anything is chosen — picking the nearest to
  // 11:00 out of a list already truncated at 10:40 is how this went wrong in the
  // first place. Selection happens after the scan instead.
  const wantsWholeDay = Boolean(opts.onDate) && (opts.nearMin != null || opts.spread);
  const perDay = wantsWholeDay ? Number.MAX_SAFE_INTEGER : opts.onDate ? max : Math.max(1, opts.maxPerDay ?? 2);
  const scanMax = wantsWholeDay ? Number.MAX_SAFE_INTEGER : max;
  const durMs = opts.durationMin * 60000;
  const overlapsBusy = (s: number, e: number) => busy.some((b) => s < b.end && e > b.start);
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: opts.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

  for (let day = 0; day < opts.lookaheadDays; day++) {
    if (out.length >= scanMax) break;
    const ref = new Date(now.getTime() + day * 86400000);
    // Day's calendar date in the target tz.
    const p = Object.fromEntries(dtf.formatToParts(ref).map((x) => [x.type, x.value]));
    const ymd = `${p.year}-${p.month}-${p.day}`;
    // Walking day-by-day and comparing the formatted date (rather than doing
    // arithmetic on the requested one) keeps this correct across DST shifts and
    // naturally returns nothing for a date outside the booking window.
    if (opts.onDate && ymd !== opts.onDate) continue;
    const y = +p.year, m = +p.month - 1, d = +p.day;

    // Weekday of the LOCAL calendar date, not of `ref`. Building a UTC date
    // from the already-localised y/m/d is what keeps these in step: near
    // midnight the clinic's Monday and UTC's Sunday are different days, and
    // using the wrong one would close the clinic on the wrong weekday.
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
    const win = opts.weekly?.[dow];
    if (win?.closed) continue;
    const startHour = win ? minutesOf(win.open) / 60 : opts.dailyStartHour;
    const endHour = win ? minutesOf(win.close) / 60 : opts.dailyEndHour;

    // Step in whole MINUTES, not fractional hours.
    //
    // This used to accumulate `h += durationMin / 60`, and the rounding error
    // silently ate the last slot of any day whose length was not an exact
    // multiple of the duration: 09:00-11:00 in 20-minute slots ends up at
    // 10.66666666666667, and adding a third of an hour gives 11.000000000000004
    // — just over the line, so 10:40 was never offered. Integer minutes are
    // exact, and are what the clinic actually thinks in.
    const startMin = Math.round(startHour * 60);
    const endMin = Math.round(endHour * 60);
    let takenToday = 0;
    for (let mins = startMin; mins + opts.durationMin <= endMin && takenToday < perDay && out.length < scanMax; mins += opts.durationMin) {
      const start = zonedToUtc(y, m, d, Math.floor(mins / 60), mins % 60, opts.timezone);
      const s = start.getTime();
      const e = s + durMs;
      if (s > now.getTime() + 60000 && !overlapsBusy(s, e)) {
        out.push({ startISO: new Date(s).toISOString(), endISO: new Date(e).toISOString() });
        takenToday++;
      }
    }
    if (opts.onDate) break; // that was the requested day; there is no other.
  }

  if (!wantsWholeDay) return out;

  // ── Choosing which of the day's slots to actually offer ──────────────────
  if (opts.nearMin != null) {
    const target = opts.nearMin;
    const minuteOfDay = (iso: string) => {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: opts.timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
          .formatToParts(new Date(iso))
          .map((x) => [x.type, x.value]),
      );
      return Number(parts.hour) * 60 + Number(parts.minute);
    };
    // Nearest first, earlier winning a tie — offering 10:40 before 11:20 for an
    // 11:00 request is what a receptionist would do.
    return out
      .map((slot) => ({ slot, gap: Math.abs(minuteOfDay(slot.startISO) - target) }))
      .sort((a, b) => a.gap - b.gap || Date.parse(a.slot.startISO) - Date.parse(b.slot.startISO))
      .slice(0, max)
      .map((x) => x.slot);
  }

  // Spread: keep the opening slot, then step evenly through the rest so the
  // afternoon is represented. Reading six consecutive twenty-minute slots to
  // somebody on the telephone was never useful anyway.
  if (out.length <= max) return out;
  const step = out.length / max;
  const picked: typeof out = [];
  for (let i = 0; i < max; i++) picked.push(out[Math.min(out.length - 1, Math.floor(i * step))]);
  return picked;
}

// Move an existing event to a new time (reschedule). Keeps the same event id.
// List events in a window. Used to show the owner the times they have blocked
// out, which are ordinary calendar events — freeBusy already excludes them from
// availability, so a block needs no storage of its own and can equally be made
// from a phone's calendar app.
export async function listEvents(
  accessToken: string,
  calendarId: string,
  timeMinISO: string,
  timeMaxISO: string,
): Promise<Array<{ id: string; summary: string; startISO: string; endISO: string }>> {
  const url =
    `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events` +
    `?timeMin=${encodeURIComponent(timeMinISO)}&timeMax=${encodeURIComponent(timeMaxISO)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=250`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Calendar list failed: ${res.status}`);
  const json = (await res.json()) as {
    items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }>;
  };
  return (json.items ?? [])
    .map((e) => ({
      id: e.id,
      summary: e.summary ?? '(no title)',
      startISO: e.start?.dateTime ?? e.start?.date ?? '',
      endISO: e.end?.dateTime ?? e.end?.date ?? '',
    }))
    .filter((e) => e.startISO && e.endISO);
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  startISO: string,
  endISO: string,
  timezone?: string,
): Promise<void> {
  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: startISO, ...(timezone ? { timeZone: timezone } : {}) },
        end: { dateTime: endISO, ...(timezone ? { timeZone: timezone } : {}) },
      }),
    },
  );
  if (!res.ok) throw new Error(`patchEvent failed: ${res.status} ${await res.text()}`);
}

// Delete an event (cancellation). Treats 404/410 (already gone) as success.
export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`deleteEvent failed: ${res.status} ${await res.text()}`);
  }
}

// Use an access token to get the primary calendar's id (= the account email).
export async function primaryEmail(accessToken: string): Promise<string | undefined> {
  try {
    const cals = await listCalendars(accessToken);
    return cals.find((c) => c.primary)?.id;
  } catch {
    return undefined;
  }
}

// Best-effort: if the call's org has Calendar connected, extract a booked
// appointment from the transcript and create an event. Gated on a connected
// calendar, so it adds no cost to workspaces that haven't connected one.
