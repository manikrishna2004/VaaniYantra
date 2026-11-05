import { prisma } from '@/lib/db';
import { encryptSecret, decryptSecret } from '@/lib/crypto';
import { getPlatformConfig, setPlatformConfig, deletePlatformConfig } from '@/lib/platform';
import { refreshAccessToken } from '@/lib/google-oauth';
import {
  freeBusy,
  computeOpenSlots,
  createEvent,
  listEvents,
  deleteEvent,
  type CalendarConfig,
} from '@/lib/calendar';
import type { DayWindow } from '@/lib/agent-behavior';

// "Book a call with our team" — the onboarding call a signed-in customer books
// with VaaniYantra, on VaaniYantra's own calendar.
//
// Deliberately NOT stored in the Integration table. Every row there is tenant
// data, scoped to an orgId, and this connection belongs to no tenant — it is
// ours. It lives in PlatformConfig alongside the other founder-level settings,
// encrypted with the same seam that protects provider credentials, and only a
// super-admin can write it.
//
// Almost none of the mechanics are new. freeBusy(), computeOpenSlots() and
// createEvent() were built for patients booking with doctors and work here
// unchanged; the only addition they needed was attendee support on createEvent,
// which is what puts the meeting on the CUSTOMER's calendar. We never touch the
// customer's calendar and never ask for access to it — Google delivers the
// invitation and their own client files it.

const CONFIG_KEY = 'team_call_calendar';
const AVAILABILITY_KEY = 'team_call_availability';

/**
 * Defaults for how the call is offered. Deliberately conservative — a sales
 * call bookable at 6am or 30 days out is not a sales call anyone attends.
 *
 * These are now only the STARTING POINT: the owner edits the live values in the
 * admin panel and they are stored in PlatformConfig. Kept as a named constant
 * so a deployment with nothing saved still behaves sensibly.
 */
const TEAM_CALL = {
  durationMin: 30,
  lookaheadDays: 10,
  dailyStartHour: 10,
  dailyEndHour: 18,
  maxSlots: 6,
  timezone: 'Asia/Kolkata',
} as const;

/**
 * The owner's bookable hours.
 *
 * `weekly` is indexed by JS getDay() (0=Sun..6=Sat) and is what closes weekends
 * — computeOpenSlots already understands it, so this is configuration rather
 * than new logic. `minNoticeHours` is the one rule the patient-booking engine
 * had no need for: a prospect must not be able to book a walkthrough eleven
 * minutes from now while the owner is driving.
 */
export type TeamCallAvailability = {
  timezone: string;
  durationMin: number;
  lookaheadDays: number;
  minNoticeHours: number;
  maxPerDay: number;
  weekly: DayWindow[]; // length 7
};

const WEEKDAYS_10_TO_6: DayWindow[] = [
  { open: '10:00', close: '18:00', closed: true }, // Sun
  { open: '10:00', close: '18:00', closed: false },
  { open: '10:00', close: '18:00', closed: false },
  { open: '10:00', close: '18:00', closed: false },
  { open: '10:00', close: '18:00', closed: false },
  { open: '10:00', close: '18:00', closed: false },
  { open: '10:00', close: '18:00', closed: true }, // Sat
];

export const DEFAULT_AVAILABILITY: TeamCallAvailability = {
  timezone: TEAM_CALL.timezone,
  durationMin: TEAM_CALL.durationMin,
  lookaheadDays: TEAM_CALL.lookaheadDays,
  minNoticeHours: 4,
  maxPerDay: 4,
  weekly: WEEKDAYS_10_TO_6,
};

/** Clamp anything read back from config, so a hand-edited row cannot produce a
 *  calendar that offers 3000 slots a day or none at all. */
export function normaliseAvailability(raw: Partial<TeamCallAvailability> | null): TeamCallAvailability {
  const d = DEFAULT_AVAILABILITY;
  const num = (v: unknown, fallback: number, lo: number, hi: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const weekly =
    Array.isArray(raw?.weekly) && raw!.weekly.length === 7
      ? raw!.weekly.map((w, i) => ({
          open: typeof w?.open === 'string' ? w.open : d.weekly[i].open,
          close: typeof w?.close === 'string' ? w.close : d.weekly[i].close,
          closed: Boolean(w?.closed),
        }))
      : d.weekly;
  return {
    timezone: typeof raw?.timezone === 'string' && raw.timezone ? raw.timezone : d.timezone,
    durationMin: num(raw?.durationMin, d.durationMin, 10, 120),
    lookaheadDays: num(raw?.lookaheadDays, d.lookaheadDays, 1, 60),
    minNoticeHours: num(raw?.minNoticeHours, d.minNoticeHours, 0, 168),
    maxPerDay: num(raw?.maxPerDay, d.maxPerDay, 1, 24),
    weekly,
  };
}

export async function getTeamCallAvailability(): Promise<TeamCallAvailability> {
  const raw = await getPlatformConfig(AVAILABILITY_KEY);
  if (!raw) return DEFAULT_AVAILABILITY;
  try {
    return normaliseAvailability(JSON.parse(raw) as Partial<TeamCallAvailability>);
  } catch {
    console.error('[team-call] availability config is not valid JSON — using defaults');
    return DEFAULT_AVAILABILITY;
  }
}

export async function saveTeamCallAvailability(raw: Partial<TeamCallAvailability>): Promise<TeamCallAvailability> {
  const clean = normaliseAvailability(raw);
  // Not a secret: opening hours are on the public booking page anyway.
  await setPlatformConfig(AVAILABILITY_KEY, JSON.stringify(clean), false);
  return clean;
}

export type TeamCallConfig = CalendarConfig;

/** The connected VaaniYantra calendar, or null when nobody has connected one. */
export async function getTeamCallConfig(): Promise<TeamCallConfig | null> {
  const raw = await getPlatformConfig(CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(decryptSecret(raw)) as TeamCallConfig;
  } catch {
    // A key rotation or a hand-edited row should disable the feature, not throw
    // on every dashboard render.
    console.error('[team-call] stored calendar config could not be decrypted');
    return null;
  }
}

export async function saveTeamCallConfig(cfg: TeamCallConfig): Promise<void> {
  await setPlatformConfig(CONFIG_KEY, encryptSecret(JSON.stringify(cfg)), true);
}

export async function disconnectTeamCallCalendar(): Promise<void> {
  await deletePlatformConfig(CONFIG_KEY);
}

export type TeamCallSlot = { startISO: string; endISO: string };

/**
 * Open slots on the team calendar. Returns [] rather than throwing when the
 * calendar is not connected or Google is unreachable — this drives a banner on
 * the dashboard, and a marketing prompt must never be able to break the page a
 * customer actually came for.
 */
export async function getTeamCallSlots(
  opts: { now?: Date; onDate?: string; maxSlots?: number } = {},
): Promise<TeamCallSlot[]> {
  const now = opts.now ?? new Date();
  const cfg = await getTeamCallConfig();
  if (!cfg) return [];
  const av = await getTeamCallAvailability();

  try {
    const token = await refreshAccessToken(cfg.refreshToken);
    const windowEnd = new Date(now.getTime() + av.lookaheadDays * 86400000);
    const busy = await freeBusy(token, cfg.calendarId, now.toISOString(), windowEnd.toISOString());

    // Min notice is applied by moving the clock forward, so every downstream
    // rule (past-time filtering, the day walk) sees the same earliest-bookable
    // moment rather than each having to know about the rule.
    const earliest = new Date(now.getTime() + av.minNoticeHours * 3600000);

    return computeOpenSlots(
      busy,
      {
        timezone: cfg.timezone || av.timezone,
        durationMin: av.durationMin,
        lookaheadDays: av.lookaheadDays,
        // Superseded by `weekly` for every day, but SlotOptions requires them.
        dailyStartHour: TEAM_CALL.dailyStartHour,
        dailyEndHour: TEAM_CALL.dailyEndHour,
        weekly: av.weekly,
        maxPerDay: av.maxPerDay,
        maxSlots: opts.maxSlots ?? TEAM_CALL.maxSlots,
        onDate: opts.onDate,
      },
      earliest,
    );
  } catch (e) {
    console.error('[team-call] could not read availability', e);
    return [];
  }
}

/**
 * Which of the next `lookaheadDays` have any slot at all — what the booking
 * page needs to grey out a date before anyone clicks it.
 *
 * One freeBusy call for the whole window, then the slot scan is run per day
 * locally. Asking Google once per day would be `lookaheadDays` round-trips to
 * render a date picker.
 */
export async function getTeamCallDays(
  now = new Date(),
): Promise<Array<{ date: string; slots: number }>> {
  const cfg = await getTeamCallConfig();
  if (!cfg) return [];
  const av = await getTeamCallAvailability();

  try {
    const token = await refreshAccessToken(cfg.refreshToken);
    const windowEnd = new Date(now.getTime() + av.lookaheadDays * 86400000);
    const busy = await freeBusy(token, cfg.calendarId, now.toISOString(), windowEnd.toISOString());
    const earliest = new Date(now.getTime() + av.minNoticeHours * 3600000);
    const tz = cfg.timezone || av.timezone;
    const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

    const out: Array<{ date: string; slots: number }> = [];
    for (let d = 0; d < av.lookaheadDays; d++) {
      const ref = new Date(now.getTime() + d * 86400000);
      const p = Object.fromEntries(dtf.formatToParts(ref).map((x) => [x.type, x.value]));
      const date = `${p.year}-${p.month}-${p.day}`;
      const slots = computeOpenSlots(
        busy,
        {
          timezone: tz,
          durationMin: av.durationMin,
          lookaheadDays: av.lookaheadDays,
          dailyStartHour: TEAM_CALL.dailyStartHour,
          dailyEndHour: TEAM_CALL.dailyEndHour,
          weekly: av.weekly,
          maxPerDay: av.maxPerDay,
          maxSlots: av.maxPerDay,
          onDate: date,
        },
        earliest,
      );
      out.push({ date, slots: slots.length });
    }
    return out;
  } catch (e) {
    console.error('[team-call] could not read the day map', e);
    return [];
  }
}

// ── Blocking time out ───────────────────────────────────────────────────────
//
// A block is an ordinary busy event on the same calendar. freeBusy already
// excludes it, so this needs no storage, no new schema and no second source of
// truth — and the owner can equally block time from their phone's calendar app
// and have the booking page respect it immediately.

export const BLOCK_PREFIX = 'Blocked';

export async function listTeamCallBlocks(
  now = new Date(),
): Promise<Array<{ id: string; summary: string; startISO: string; endISO: string }>> {
  const cfg = await getTeamCallConfig();
  if (!cfg) return [];
  const av = await getTeamCallAvailability();
  try {
    const token = await refreshAccessToken(cfg.refreshToken);
    const end = new Date(now.getTime() + av.lookaheadDays * 86400000);
    return await listEvents(token, cfg.calendarId, now.toISOString(), end.toISOString());
  } catch (e) {
    console.error('[team-call] could not list calendar entries', e);
    return [];
  }
}

export async function blockTeamCallTime(input: {
  startISO: string;
  endISO: string;
  label?: string;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const cfg = await getTeamCallConfig();
  if (!cfg) return { ok: false, reason: 'No calendar connected.' };
  const start = Date.parse(input.startISO);
  const end = Date.parse(input.endISO);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ok: false, reason: 'Give a start and an end, with the end after the start.' };
  }
  const av = await getTeamCallAvailability();
  try {
    const token = await refreshAccessToken(cfg.refreshToken);
    const ev = await createEvent(token, cfg.calendarId, {
      summary: input.label?.trim() ? `${BLOCK_PREFIX} — ${input.label.trim()}` : BLOCK_PREFIX,
      description: 'Blocked from the VaaniYantra admin panel. Delete this event to reopen the time.',
      startISO: new Date(start).toISOString(),
      endISO: new Date(end).toISOString(),
      timezone: cfg.timezone || av.timezone,
      // No attendees and no invitations: this is the owner's own time, not a
      // meeting with anybody.
    });
    return { ok: true, id: ev.id };
  } catch (e) {
    console.error('[team-call] blocking failed', e);
    return { ok: false, reason: 'Google rejected the block.' };
  }
}

export async function unblockTeamCallTime(eventId: string): Promise<boolean> {
  const cfg = await getTeamCallConfig();
  if (!cfg) return false;
  try {
    const token = await refreshAccessToken(cfg.refreshToken);
    await deleteEvent(token, cfg.calendarId, eventId);
    return true;
  } catch (e) {
    console.error('[team-call] unblocking failed', e);
    return false;
  }
}

export type BookTeamCallInput = {
  startISO: string;
  /** The customer, who becomes an attendee and so gets it on their calendar. */
  attendeeEmail: string;
  attendeeName?: string;
  orgName?: string;
  note?: string;
  /** Where the booking came from — 'dashboard' for a signed-in customer,
   *  'walkthrough' for the public page. Only affects the event description,
   *  but knowing which funnel produced a meeting is worth one string. */
  source?: 'dashboard' | 'walkthrough';
};

export type BookTeamCallResult =
  | { ok: true; startISO: string; endISO: string; htmlLink: string; meetLink?: string }
  | { ok: false; reason: 'not_connected' | 'slot_taken' | 'bad_slot' | 'failed' };

/**
 * Book the call. Re-checks availability inside the same request rather than
 * trusting the slot the browser sent back: the list was computed seconds to
 * minutes ago, and two customers looking at the same free Tuesday is exactly
 * the race this has to lose gracefully.
 */
export async function bookTeamCall(input: BookTeamCallInput): Promise<BookTeamCallResult> {
  const cfg = await getTeamCallConfig();
  if (!cfg) return { ok: false, reason: 'not_connected' };

  const av = await getTeamCallAvailability();
  const start = Date.parse(input.startISO);
  if (!Number.isFinite(start)) return { ok: false, reason: 'bad_slot' };
  // The advertised window, enforced again here rather than trusted from the
  // browser — including minimum notice, which is a rule about when someone may
  // book and so has to bind the booking, not just the list it was chosen from.
  const now = Date.now();
  const earliest = now + av.minNoticeHours * 3600000;
  if (start < earliest || start > now + av.lookaheadDays * 86400000) {
    return { ok: false, reason: 'bad_slot' };
  }
  const end = start + av.durationMin * 60000;

  try {
    const token = await refreshAccessToken(cfg.refreshToken);

    const busy = await freeBusy(
      token,
      cfg.calendarId,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
    );
    if (busy.some((b) => start < b.end && end > b.start)) {
      return { ok: false, reason: 'slot_taken' };
    }

    const who = input.attendeeName || input.attendeeEmail;
    const org = input.orgName ? ` · ${input.orgName}` : '';
    const ev = await createEvent(token, cfg.calendarId, {
      summary: `VaaniYantra call — ${who}${org}`,
      description: [
        input.source === 'walkthrough'
          ? `Walkthrough booked from the website by ${input.attendeeEmail}.`
          : `Booked from the VaaniYantra dashboard by ${input.attendeeEmail}.`,
        input.orgName ? `Organisation: ${input.orgName}` : null,
        input.note ? `\nWhat they want to talk about:\n${input.note}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      startISO: new Date(start).toISOString(),
      endISO: new Date(end).toISOString(),
      timezone: cfg.timezone || av.timezone,
      attendees: [input.attendeeEmail],
      notifyAttendees: true,
      addMeet: true,
    });

    return {
      ok: true,
      startISO: new Date(start).toISOString(),
      endISO: new Date(end).toISOString(),
      htmlLink: ev.htmlLink,
      meetLink: ev.hangoutLink,
    };
  } catch (e) {
    console.error('[team-call] booking failed', e);
    return { ok: false, reason: 'failed' };
  }
}

