import type { Agent, Contact, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { listBookableDoctors, matchDoctor, type BookableDoctor } from '@/lib/doctors';
import { resolveDoctorCalendar, freeBusy, computeOpenSlots, createEvent, patchEvent } from '@/lib/calendar';
import { refreshAccessToken } from '@/lib/google-oauth';
import { sendConfirmation } from '@/lib/connectors';
import {
  apptConfirmationTemplate,
  apptConfirmationPortalTemplate,
  apptRescheduledTemplate,
} from '@/lib/whatsapp-templates';
import { whatsappEnabled } from '@/lib/flags';
import { asBusinessHours, minutesOf, type DayWindow } from '@/lib/agent-behavior';
import { doctorWeekly, timeOffBusy } from '@/lib/doctors';
import { cancelAppointmentRecord } from '@/lib/appointments';
import { upsertContact, portalLink } from '@/lib/portal/contacts';
import { householdByPhone, matchHouseholdMember } from '@/lib/patients/household';
import { dispatchPatientEvent } from '@/lib/webhooks';
import { deliverOutcome } from '@/lib/connectors/outcomes';
import type { ConnectorTool, CallToolContext } from '@/lib/connectors/tools';

// Live appointment booking tools. The agent calls these mid-call to read real
// calendar availability and book a confirmed slot, then we message a
// confirmation (SMS or WhatsApp). Backed by the org's connected Google Calendar.

// A doctor patients can be booked with.
//
// `userId` links them to a team member who has connected their OWN Google

export type BookingConfig = {
  enabled: boolean;
  calendarId?: string;
  timezone: string;
  serviceName: string;
  serviceDurationMin: number;
  lookaheadDays: number;
  dailyStart: number; // local hour, 0–24
  dailyEnd: number; // local hour, 0–24
  slotCapacity: number; // how many bookings one slot can hold (1 = single)
  // Per-weekday opening hours, getDay()-indexed, or undefined for "same hours
  // every day". Taken from the agent's businessHours ONLY when those are
  // enabled — see readBookingConfig.
  weekly?: DayWindow[];
  businessName?: string; // clinic/business name, used in confirmations
};

// Read + normalize an agent's booking config, falling back to its businessHours
// timezone and sensible defaults so booking works with minimal setup.
export function readBookingConfig(agent: Agent): BookingConfig {
  const raw = (agent.bookingConfig ?? {}) as Record<string, unknown>;
  const hours = (agent.businessHours ?? {}) as Record<string, unknown>;
  const bh = asBusinessHours(agent.businessHours);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  // multiPerSlot is the user-facing toggle; slotCapacity the actual number.
  const multi = raw.multiPerSlot === true;
  const capacity = multi ? Math.max(2, num(raw.slotCapacity, 4)) : 1;
  return {
    enabled: raw.enabled === true,
    calendarId: typeof raw.calendarId === 'string' ? raw.calendarId : undefined,
    timezone:
      (typeof raw.timezone === 'string' && raw.timezone) ||
      (typeof hours.timezone === 'string' && hours.timezone) ||
      'Asia/Kolkata',
    serviceName: (typeof raw.serviceName === 'string' && raw.serviceName) || 'appointment',
    serviceDurationMin: num(raw.serviceDurationMin, 30),
    // #4: how far ahead bookings are allowed (up to a year).
    lookaheadDays: Math.min(Math.max(1, num(raw.lookaheadDays, 14)), 365),
    dailyStart: num(raw.dailyStart, 9),
    dailyEnd: num(raw.dailyEnd, 18),
    slotCapacity: capacity,
    // Booking weekdays follow the agent's business hours, but ONLY when the
    // clinic actually switched them on.
    //
    // Slot generation had no weekday concept at all, so a practice closed on
    // Sunday still handed out Sunday appointments — businessHours.days was read
    // only to decide whether to ANSWER the phone, never to decide when to book.
    //
    // Gating on `enabled` rather than always applying `days` is deliberate: the
    // defaults mark Saturday and Sunday closed, and every agent in production
    // currently has hours disabled. Applying them regardless would silently stop
    // a clinic that works Saturdays from being bookable at all — losing real
    // bookings to fix a bug that only ever gave away extra ones. A doctor's own
    // DoctorSchedule is the precise answer and overrides this.
    weekly: bh?.enabled ? bh.days : undefined,
    businessName: typeof raw.businessName === 'string' && raw.businessName.trim() ? raw.businessName.trim() : undefined,
  };
}

/**
 * A one-line description of the booking, for logs only.
 *
 * This used to be `renderConfirmation`, which rendered a clinic-authored
 * template into the message a patient received. That stopped being true when
 * WhatsApp became the only channel: sendConfirmation delivers an approved
 * template whenever one is passed, and the booking call site always passes one,
 * so the rendered string could no longer reach anybody. It is kept only because
 * sendConfirmation logs its `body` when nothing could be delivered, and a log
 * line naming the appointment beats a log line naming nothing.
 */
export function bookingSummary(
  cfg: BookingConfig,
  vars: { service?: string | null; time?: string | null; expert?: string | null },
): string {
  const service = vars.service || cfg.serviceName;
  const withExpert = vars.expert ? ` with ${vars.expert}` : '';
  const at = cfg.businessName ? ` at ${cfg.businessName}` : '';
  return `Your ${service}${withExpert}${at} is confirmed for ${vars.time || ''}.`
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * The `where` that finds our own confirmed bookings CLASHING with a time range.
 *
 * Two things here are load-bearing, and both were wrong before.
 *
 * 1. OVERLAP, not equality. This used to be `startAt: new Date(startMs)`, so a
 *    09:00–09:30 appointment and a 09:15–09:45 one did not clash as far as our
 *    database was concerned. Nothing caught that, because for single-capacity
 *    slots the ONLY collision check was Google's free/busy — which meant the
 *    moment Google was absent or optional, the clinic silently double-booked.
 *    Half-open comparison (`startAt < end && endAt > start`) so back-to-back
 *    appointments, where one ends exactly as the next begins, do not clash.
 *
 * 2. SCOPED TO A DOCTOR. This used to count across the whole org, so with
 *    capacity 1 a clinic could only ever have ONE appointment at 10:00 in total
 *    — the second doctor's 10:00 was refused as "full". Different doctors are
 *    different people and their calendars are independent.
 *
 * `doctorId: null` keeps its own bucket rather than clashing with everyone:
 * legacy rows and "any doctor" bookings should not block a named doctor.
 */
function clashWhere(args: {
  orgId: string;
  doctorId: string | null;
  startMs: number;
  endMs: number;
  excludeId?: string;
}) {
  return {
    orgId: args.orgId,
    doctorId: args.doctorId,
    status: 'CONFIRMED',
    startAt: { lt: new Date(args.endMs) },
    endAt: { gt: new Date(args.startMs) },
    ...(args.excludeId ? { NOT: { id: args.excludeId } } : {}),
  };
}

/**
 * The advisory-lock key guarding a claim.
 *
 * Keyed on (org, doctor, DAY) rather than the exact start instant. The old key
 * was `booking:${orgId}:${startMs}`, which is fine while a clash means "same
 * start" but useless once it means "overlapping range": two concurrent bookings
 * at 09:00 and 09:15 would hash to different locks, serialize against nothing,
 * each see no clash, and both be written.
 *
 * A day is coarse enough to make every overlapping pair contend, and fine enough
 * that a clinic never notices — bookings arrive at human speed, one doctor at a
 * time.
 */
function claimLockKey(orgId: string, doctorId: string | null): string {
  // No day component. It used to bucket by UTC day, which is 05:30 in IST: two
  // overlapping bookings either side of that boundary hashed to different keys,
  // each saw no clash inside its own transaction, and both were created — the
  // exact race the lock exists to prevent. Rare for a clinic, certain for a
  // 24-hour helpline, and the finer key bought nothing: bookings arrive at
  // human speed, one doctor at a time.
  return `booking:${orgId}:${doctorId ?? 'any'}`;
}

// How many of OUR confirmed appointments clash with a range for this doctor
// (used for multi-per-slot capacity, e.g. an OPD block taking N patients at 10am).
async function bookingsAtSlot(args: {
  orgId: string;
  doctorId: string | null;
  startMs: number;
  endMs: number;
  excludeId?: string;
}): Promise<number> {
  return prisma.appointment.count({ where: clashWhere(args) });
}

// Atomically claim a slot: under a per-(org, slot) Postgres advisory lock,
// re-count our confirmed bookings and create the appointment row only if the
// slot still has room. Serializes concurrent calls booking the same slot, so
// two callers can never both grab the last place (TOCTOU guard). Returns the
// created appointment id, or null when the slot is full.
export async function claimSlot(input: {
  orgId: string;
  doctorId: string | null;
  startMs: number;
  endMs: number;
  capacity: number;
  excludeId?: string;
  // Unchecked (raw foreign-key ids) rather than the relation-connect form:
  // every caller already has orgId/workspaceId/contactId in hand, and the
  // checked variant would force a nested connect for no benefit.
  create: Prisma.AppointmentUncheckedCreateInput;
}): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const key = claimLockKey(input.orgId, input.doctorId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const taken = await tx.appointment.count({ where: clashWhere(input) });
    if (taken >= input.capacity) return null;
    const row = await tx.appointment.create({ data: input.create });
    return row.id;
  });
}

function fmtSlot(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** 540 -> "9am", 1080 -> "6pm", 570 -> "9:30am". How a receptionist says a time. */
function spokenTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/**
 * The opening hours in force on one date, said the way a person would.
 *
 * Reading a list of twenty-minute slots down the telephone is not what a
 * receptionist does — they tell you when the clinic is open and ask what suits
 * you. This is what lets the agent do the same, and it has to resolve the same
 * per-weekday windows the slot scan uses, or it will announce hours the booking
 * then refuses.
 */
export function hoursForDate(
  dateISO: string | undefined,
  weekly: DayWindow[] | null | undefined,
  cfg: Pick<BookingConfig, 'dailyStart' | 'dailyEnd'>,
): { closed: boolean; open: string; close: string; label: string } {
  let win: DayWindow | undefined;
  if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    const [y, m, d] = dateISO.split('-').map(Number);
    // Weekday of the LOCAL calendar date, built from the already-localised
    // pieces — the same rule computeOpenSlots follows, and for the same reason.
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    win = weekly?.[dow];
  }
  if (win?.closed) return { closed: true, open: '', close: '', label: 'closed' };

  const openMin = win ? minutesOf(win.open) : Math.round(cfg.dailyStart * 60);
  const closeMin = win ? minutesOf(win.close) : Math.round(cfg.dailyEnd * 60);
  return {
    closed: false,
    open: win ? win.open : String(Math.floor(cfg.dailyStart)).padStart(2, '0') + ':00',
    close: win ? win.close : String(Math.floor(cfg.dailyEnd)).padStart(2, '0') + ':00',
    label: `${spokenTime(openMin)} to ${spokenTime(closeMin)}`,
  };
}

/**
 * `doctors` is a snapshot, used ONLY to write description strings — the handlers
 * below re-read the table, because a call runs for minutes and because they are
 * also entered from the portal and the staff booking widget with no snapshot in
 * hand.
 *
 * Still synchronous on purpose: this is a pure schema builder, and its one
 * caller (getCallConnectorTools) is already async and already holds the orgId,
 * so making it async would buy nothing and cost the ability to build a tool set
 * in a test without a database.
 */
export function bookingTools(cfg: BookingConfig, doctors: BookableDoctor[] = []): ConnectorTool[] {
  // Name plus specialisation, so a caller can ask for "a dentist" and not only
  // for a surname they may not know.
  const label = (d: BookableDoctor) =>
    d.specialisation ? `${d.displayName} (${d.specialisation})` : d.displayName;
  const doctorList = doctors.map(label).join(', ');
  const expertParam = doctors.length
    ? {
        type: 'STRING',
        description: `Which doctor the appointment is with. One of: ${doctorList}. You may also pass a specialisation the caller names, such as "dentist". Ask the caller if they have a preference; omit only if they have none.`,
      }
    : undefined;

  return [
    {
      declaration: {
        name: 'check_availability',
        description:
          'Get available appointment time slots from the real calendar. Call this before offering times to the caller. Returns open slots you can read out.' +
          (doctors.length ? ` Available doctors: ${doctorList}.` : ''),
        parameters: {
          type: 'OBJECT',
          properties: {
            date: {
              type: 'STRING',
              description:
                'The date the caller asked for, as YYYY-MM-DD. ALWAYS pass this whenever they name a day at all — ' +
                '"tomorrow", "next Monday", "the 14th" — working it out from the current date given in your ' +
                'instructions. Omit it only when they have expressed no preference, which returns the next ' +
                'available slots spread across upcoming days.',
            },
            time: {
              type: 'STRING',
              description:
                'The time the caller asked for, as 24-hour HH:MM. ALWAYS pass this whenever they name an hour at ' +
                'all — "11", "11 am", "half past four", "in the afternoon" is not a time but "4pm" is. The reply ' +
                'tells you whether that exact time is free, and offers the nearest times to it if not. Omit it ' +
                'only when they have named no time, which returns options across the whole day.',
            },
            ...(expertParam ? { expert: expertParam } : {}),
          },
        },
      },
      handler: (args, ctx) => findOpenSlots(cfg, ctx.orgId, args),
    },
    {
      declaration: {
        name: 'book_appointment',
        description:
          'Book a confirmed appointment at one of the slots returned by check_availability. Only call after the caller agrees to a specific time.',
        parameters: {
          type: 'OBJECT',
          properties: {
            startISO: { type: 'STRING', description: 'The exact slot start in ISO-8601, from check_availability.' },
            customerName: { type: 'STRING', description: "The caller's name for the booking." },
            notes: { type: 'STRING', description: 'Optional notes about the appointment.' },
            ...(expertParam ? { expert: expertParam } : {}),
          },
          required: ['startISO', 'customerName'],
        },
      },
      handler: (args, ctx) => bookAppointment(cfg, args, ctx),
    },
    {
      declaration: {
        name: 'find_appointment',
        description:
          "Look up the caller's upcoming appointment(s) by their phone number. Call this before cancelling or rescheduling so you have the appointment id.",
        parameters: { type: 'OBJECT', properties: {} },
      },
      handler: (_args, ctx) => findAppointment(cfg, ctx),
    },
    {
      declaration: {
        name: 'cancel_appointment',
        description: 'Cancel a booked appointment. Use find_appointment first to get the appointmentId.',
        parameters: {
          type: 'OBJECT',
          properties: { appointmentId: { type: 'STRING', description: 'The id from find_appointment.' } },
          required: ['appointmentId'],
        },
      },
      handler: (args, ctx) => cancelAppointment(cfg, args, ctx),
    },
    {
      declaration: {
        name: 'reschedule_appointment',
        description:
          'Move an existing appointment to a new time. Use find_appointment for the id and check_availability for an open newStartISO.',
        parameters: {
          type: 'OBJECT',
          properties: {
            appointmentId: { type: 'STRING', description: 'The id from find_appointment.' },
            newStartISO: { type: 'STRING', description: 'The new slot start in ISO-8601, from check_availability.' },
          },
          required: ['appointmentId', 'newStartISO'],
        },
      },
      handler: (args, ctx) => rescheduleBooking(cfg, args, ctx),
    },
  ];
}

/**
 * An access token for a Google connection, plus which connection it came from.
 *
 * `userId` picks a doctor's own account when they have one, falling back to the
 * clinic's shared account. `ownerUserId` is the answer to "whose account is
 * this?" and MUST be persisted with any event created — see resolveCalendarTarget.
 */
async function resolveToken(
  orgId: string,
  userId?: string | null,
): Promise<{ token: string; calendarId: string; ownerUserId: string } | null> {
  const resolved = await resolveDoctorCalendar(orgId, userId);
  if (!resolved) return null;
  try {
    const token = await refreshAccessToken(resolved.cfg.refreshToken);
    return { token, calendarId: resolved.cfg.calendarId || 'primary', ownerUserId: resolved.ownerUserId };
  } catch (err) {
    // A revoked or expired grant used to throw straight through and fail the
    // whole booking. Now that VaaniYantra owns the calendar, a dead Google
    // connection is a lost MIRROR, not a lost booking — degrade to native.
    console.error('[booking] google token refresh failed; continuing without the calendar mirror', err);
    return null;
  }
}

/**
 * Where a booking should be MIRRORED, if anywhere.
 *
 * `connected: false` is an ordinary outcome, not an error. VaaniYantra is the
 * system of record for appointments; Google is an optional per-doctor mirror.
 * This used to return null and every caller treated that as fatal, which is why
 * a clinic with no Google account could not book at all — availability, booking
 * and rescheduling all refused, even though the appointment rows live entirely
 * in our own database.
 */
type CalendarMirror =
  | { connected: true; token: string; calendarId: string; ownerUserId: string }
  | { connected: false };

/**
 * Which Google account and which calendar a booking with this doctor belongs on.
 *
 * One helper used by both availability and booking, because they previously
 * duplicated the precedence expression and would have drifted the first time
 * either changed.
 *
 * Precedence, and the reason for it:
 *   • the doctor has connected their OWN Google account → use their token and
 *     their calendar. The clinic's shared `cfg.calendarId` must NOT win here:
 *     that id names a calendar inside a different account, so pairing it with
 *     this doctor's token points at something that isn't theirs, or nothing.
 *   • otherwise everything runs in the clinic's shared account, where an expert
 *     may still own a named calendar.
 */
async function resolveCalendarTarget(
  cfg: BookingConfig,
  orgId: string,
  doctor: BookableDoctor | undefined,
): Promise<CalendarMirror> {
  const conn = await resolveToken(orgId, doctor?.userId ?? undefined);
  if (!conn) return { connected: false };

  const usingDoctorAccount = Boolean(doctor?.userId) && conn.ownerUserId === doctor?.userId;
  const calendarId = usingDoctorAccount
    ? doctor?.calendarId || conn.calendarId
    : doctor?.calendarId || cfg.calendarId || conn.calendarId;

  return { connected: true, token: conn.token, calendarId, ownerUserId: conn.ownerUserId };
}

/**
 * Open slots for a business, honouring expert calendars, per-slot capacity and
 * an optional preferred date.
 *
 * Extracted from the in-call tool so the patient portal's chat can offer the
 * exact same availability the phone agent would — one implementation, so the
 * two channels can never disagree about what is free.
 */
/**
 * "11", "11:00", "11 am", "4pm" -> minutes past midnight. Null for anything else.
 *
 * Deliberately forgiving: this value arrives from a language model reading back
 * a telephone transcript, and refusing "11 am" because it wanted "11:00" would
 * put us straight back to never checking the time at all.
 */
export function parseClock(value: unknown): number | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/.exec(raw);
  if (!m) return null;
  let hours = Number(m[1]);
  const mins = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (mins > 59) return null;
  if (suffix === 'pm' && hours < 12) hours += 12;
  if (suffix === 'am' && hours === 12) hours = 0;
  if (hours > 23) return null;
  return hours * 60 + mins;
}

/** Where a moment falls in its own local day, in minutes. */
function minuteOfDayIn(iso: string, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export async function findOpenSlots(
  cfg: BookingConfig,
  orgId: string,
  args: { date?: unknown; time?: unknown; expert?: unknown } = {},
): Promise<Record<string, unknown>> {
  try {
    // Read availability from wherever a booking with this doctor would land —
    // the same resolution the booking itself uses, so the slots offered are the
    // slots that can actually be taken.
    const doctors = await listBookableDoctors(orgId);
    const m = matchDoctor(doctors, args.expert);
    // Several doctors share the specialisation the caller named. Asking which
    // is the only honest answer — silently assigning one of three dentists is
    // worse than a follow-up question.
    if (m.choices) {
      return {
        ok: true,
        slots: [],
        needsChoice: m.choices.map((d) => d.displayName),
        message: `More than one doctor does that: ${m.choices.map((d) => d.displayName).join(', ')}. Ask the caller which one.`,
      };
    }
    const doctor = m.doctor;
    const mirror = await resolveCalendarTarget(cfg, orgId, doctor);

    const now = new Date();
    const windowStart = now.toISOString();
    const windowEnd = new Date(now.getTime() + cfg.lookaheadDays * 86400000).toISOString();

    // External busy comes from Google when this doctor has it connected, and is
    // simply empty when they do not. No connection is no longer a refusal:
    // availability is generated from the configured hours and narrowed by our
    // own bookings below, which is all a clinic without Google needs.
    //
    // Free/busy is read regardless of capacity. It used to be
    // `cfg.slotCapacity > 1 ? [] : await freeBusy(...)`, so an OPD-block clinic
    // never queried it — meaning the all-day "leave" event the agent form
    // promises will block a doctor's day did nothing at all for exactly the
    // clinics most likely to run blocks.
    // Everything that makes this doctor unavailable, in one list.
    //
    // Google contributes only when they have connected it. Time off is ours and
    // always applies — it is the native replacement for the all-day "leave"
    // event, which never worked for a doctor without Google and was skipped
    // entirely for multi-per-slot agents.
    const doctorId = doctor?.id ?? null;
    const [googleBusy, offBusy] = await Promise.all([
      mirror.connected ? freeBusy(mirror.token, mirror.calendarId, windowStart, windowEnd) : Promise.resolve([]),
      doctorId
        ? timeOffBusy(doctorId, now.getTime(), now.getTime() + cfg.lookaheadDays * 86400000)
        : Promise.resolve([]),
    ]);
    const busy = [...googleBusy, ...offBusy];

    // A doctor's own hours beat the clinic-wide ones. Null means they have never
    // set any, which falls back rather than closing their week.
    const weekly = (doctorId ? await doctorWeekly(doctorId) : null) ?? cfg.weekly;

    // A requested date is AUTHORITATIVE: generate slots for that date rather
    // than filtering a list that has already been capped.
    //
    // This used to filter after the fact — `if (onDate.length) slots = onDate;`
    // — so a date the truncated list didn't reach matched nothing, the filter
    // quietly did nothing, and today's slots were returned with ok:true. The
    // agent then read out times for a day the caller never asked about and
    // booked one, believing it had complied. Silence was the whole problem, so
    // an unreachable date now comes back empty and says so.
    const date = typeof args.date === 'string' ? args.date.slice(0, 10) : '';
    const onDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;

    // A time is only meaningful alongside a day. Speech recognition hands over
    // "11", "11:00" and "11 am" in roughly equal measure, so all three parse.
    const nearMin = onDate ? parseClock(args.time) : null;

    let slots = computeOpenSlots(busy, {
      timezone: cfg.timezone,
      durationMin: cfg.serviceDurationMin,
      lookaheadDays: cfg.lookaheadDays,
      dailyStartHour: cfg.dailyStart,
      dailyEndHour: cfg.dailyEnd,
      maxSlots: cfg.slotCapacity > 1 ? 12 : 6,
      onDate,
      ...(nearMin != null ? { nearMin } : onDate ? { spread: true } : {}),
      weekly,
    }, now);

    // Drop slots that already clash with our own bookings for this doctor.
    //
    // This now runs at EVERY capacity, not only when slotCapacity > 1. At
    // capacity 1 the clash check used to be Google's alone, which is why making
    // Google optional needed this first: without it a clinic with no connected
    // calendar would offer a slot it had already filled itself.
    const counts = await Promise.all(
      slots.map((s) =>
        bookingsAtSlot({
          orgId,
          doctorId,
          startMs: Date.parse(s.startISO),
          endMs: Date.parse(s.endISO),
        }),
      ),
    );
    slots = slots.filter((_, i) => counts[i] < Math.max(1, cfg.slotCapacity)).slice(0, 6);

    // Did the caller get the time they actually asked for? Answering this
    // explicitly is the whole point: the model used to receive a list with no
    // way to tell "11:00 is free" from "11:00 was never considered", and told
    // callers their time was unavailable when it was not.
    const requested =
      nearMin != null ? slots.find((s) => minuteOfDayIn(s.startISO, cfg.timezone) === nearMin) ?? null : null;

    const hours = hoursForDate(onDate, weekly, cfg);

    if (hours.closed) {
      return { ok: true, slots: [], closed: true, message: `Closed on ${onDate}.` };
    }

    if (slots.length === 0) {
      return {
        ok: true,
        slots: [],
        hours,
        // Read by BOTH the model and the staff booking form
        // (src/components/BookAppointment.tsx:292), so it stays a plain
        // statement of fact — `say` below is the part addressed to the model.
        message: onDate
          ? `No open slots on ${onDate}.`
          : 'No open slots in the next ' + cfg.lookaheadDays + ' days.',
        say: 'Say that day is full and offer to check another. Never read out times from a different day.',
      };
    }
    return {
      ok: true,
      timezone: cfg.timezone,
      // The hours come back on every reply so the agent can offer the RANGE and
      // ask what suits the caller, instead of reciting slot times at them.
      hours,
      ...(nearMin != null
        ? {
            requestedTimeAvailable: Boolean(requested),
            ...(requested
              ? {
                  requestedSlot: { startISO: requested.startISO, label: fmtSlot(requested.startISO, cfg.timezone) },
                  say: 'They asked for this time and it is free — offer it back to them. Do not read out the list.',
                }
              : {
                  message: 'That exact time is not free. The slots below are the nearest to it.',
                  say: 'Say that time is taken, then offer one or two of the nearest slots below.',
                }),
          }
        : {
            say: 'They named no time. Tell them the opening hours from hours.label and ask what would suit. ' +
              'Only read out specific times if they say they have no preference.',
          }),
      slots: slots.map((s) => ({ startISO: s.startISO, label: fmtSlot(s.startISO, cfg.timezone) })),
    };
  } catch (err) {
    console.error('[booking] check_availability failed', err);
    return { ok: false, error: 'Could not read the calendar right now.' };
  }
}

export type BookingRequest = {
  orgId: string;
  workspaceId: string;
  agent: Agent;
  // The call this booking came from, when it came from one. Null for bookings
  // made in the patient portal chat, where there is no call to annotate.
  callId?: string | null;
  customerNumber: string | null;
  customerName: string;
  // An existing patient to book, chosen by staff. When set, the patient is used
  // as-is rather than matched on phone — front-desk staff who have already
  // picked "Asha Rao (SDC-000147)" must not have that decision second-guessed
  // by a phone-number match.
  contactId?: string | null;
  startISO: string;
  expert?: unknown;
  notes?: string;
  // Who made this booking, for the webhook payload. Inferred from callId when
  // omitted; staff bookings must say so explicitly, since "no call id" no
  // longer implies the patient chatbot.
  source?: 'agent' | 'portal' | 'staff';
};

/**
 * Book a confirmed appointment: claim the slot, write the calendar event,
 * message the customer, and route the booking through the outcome engine.
 *
 * Shared by the in-call `book_appointment` tool and the patient portal chat, so
 * a booking made by typing is indistinguishable from one made by talking — same
 * capacity guard, same confirmation, same owner alert.
 */
export async function createBooking(
  cfg: BookingConfig,
  req: BookingRequest,
): Promise<Record<string, unknown>> {
  const startISO = req.startISO;
  const customerName = req.customerName.trim();
  const notes = req.notes ?? '';
  if (!startISO || Number.isNaN(Date.parse(startISO))) return { ok: false, error: 'Invalid start time.' };
  if (!customerName) return { ok: false, error: 'A customer name is required to book.' };
  // A time in the past is never a real booking — it is a model that resolved a
  // relative date wrongly, or a stale slot the caller sat on. Deliberately no
  // UPPER bound: staff legitimately book months out via the manual-time field
  // in BookAppointment, and capping that would break the "squeeze them in" flow.
  if (Date.parse(startISO) < Date.now()) return { ok: false, error: 'That time has already passed. Offer a later one.' };

  try {
    // Book on the chosen doctor's own calendar when they have one.
    const doctors = await listBookableDoctors(req.orgId);
    const m = matchDoctor(doctors, req.expert);
    if (m.choices) {
      return {
        ok: false,
        error: `Which doctor? ${m.choices.map((d) => d.displayName).join(' or ')}.`,
      };
    }
    // A named doctor we do not have is a refusal, not a silent unattributed
    // booking. This is a deliberate behaviour change: before, an unmatched name
    // booked with nobody and the caller was told it was confirmed. Now that the
    // doctor list is authoritative, asking again beats guessing.
    if (!m.doctor && typeof req.expert === 'string' && req.expert.trim()) {
      return { ok: false, error: 'I do not have a doctor by that name. Offer one of the doctors listed.' };
    }
    const doctor = m.doctor;
    const expertName = doctor?.displayName;
    const mirror = await resolveCalendarTarget(cfg, req.orgId, doctor);
    const calendarId = mirror.connected ? mirror.calendarId : null;

    const start = Date.parse(startISO);
    const end = start + cfg.serviceDurationMin * 60000;

    // A last look at external busy, when there is a calendar to look at. Our own
    // clashes are caught by claimSlot's advisory-locked overlap check below,
    // which is what makes this safe to skip entirely when Google is absent.
    if (mirror.connected && cfg.slotCapacity <= 1) {
      const busy = await freeBusy(mirror.token, mirror.calendarId, new Date(start).toISOString(), new Date(end).toISOString());
      if (busy.some((b) => start < b.end && end > b.start)) {
        return { ok: false, error: 'That slot was just taken. Offer another time.' };
      }
    }

    // Register the patient BEFORE claiming the slot.
    //
    // Two reasons for the order. First, allocating a patient number takes a row
    // lock on the organization, and doing that inside claimSlot's advisory-lock
    // transaction would serialise every booking for the clinic behind one
    // counter. Second, a patient who tried to book and lost the slot is still
    // someone the clinic wants on file.
    //
    // `contact` is null when there is no phone number at all.
    let contact = req.contactId
      ? await prisma.contact.findFirst({ where: { id: req.contactId, orgId: req.orgId } })
      : await ensureContact({
          orgId: req.orgId,
          workspaceId: req.workspaceId,
          name: customerName,
          phone: req.customerNumber,
        });

    // A call from a shared family number resolves to the household PRIMARY
    // above, because nothing spoken on a phone may create a patient. If the
    // spoken name unambiguously matches somebody already on that number,
    // though, attach the appointment to them instead.
    //
    // Selecting among people who already exist is the safe half of fuzzy
    // matching. It is never allowed to create.
    if (!req.contactId && contact && req.customerNumber) {
      const household = await householdByPhone(req.orgId, req.customerNumber).catch(() => []);
      const matched = matchHouseholdMember(household, customerName);
      if (matched) contact = matched;
    }

    // Atomically claim the slot (advisory-locked re-check + create), so two
    // concurrent calls can never both book the last place.
    const doctorId = doctor?.id ?? null;
    const appointmentId = await claimSlot({
      orgId: req.orgId,
      doctorId,
      startMs: start,
      endMs: end,
      capacity: Math.max(1, cfg.slotCapacity),
      create: {
        doctorId,
        orgId: req.orgId,
        workspaceId: req.workspaceId,
        agentId: req.agent.id,
        callId: req.callId ?? null,
        customerName,
        customerNumber: req.customerNumber,
        contactId: contact?.id ?? null,
        // Snapshot, not a join: lists, exports and the webhook all want the
        // patient number without reaching for the Contact row.
        patientNo: contact?.uhid ?? null,
        expertName: expertName ?? null,
        service: cfg.serviceName,
        startAt: new Date(start),
        endAt: new Date(end),
        timezone: cfg.timezone,
        calendarId,
        // Whose Google account `calendarId` lives in. Without this, a later
        // reschedule or cancel cannot know which token to use — and since
        // calendarId is usually the literal "primary", the wrong token would
        // silently touch a different doctor's calendar.
        calendarUserId: mirror.connected ? mirror.ownerUserId : null,
        // A record of how this customer was messaged, not a setting. Older rows
        // legitimately say "sms"; everything booked from here on is WhatsApp.
        channel: 'whatsapp',
      },
    });
    if (!appointmentId) return { ok: false, error: 'That slot is fully booked. Offer another time.' };

    // Mirror it into Google, if this doctor has Google.
    //
    // The appointment already exists at this point and is the real record. A
    // clinic with no connected calendar simply has no mirror, and the booking
    // stands — which is the whole point of VaaniYantra owning the calendar.
    // The mirrored Google event id, or null when this doctor has no mirror.
    // Carried past the block below because the call record, the webhook payload
    // and the log line all report it.
    let calendarEventId: string | null = null;
    if (mirror.connected) {
      const who = req.customerNumber ? ` (${req.customerNumber})` : '';
      const summaryExpert = expertName ? ` with ${expertName}` : '';
      let event: { id: string };
      try {
        event = await createEvent(mirror.token, mirror.calendarId, {
          summary: `${cfg.serviceName}${summaryExpert} — ${customerName}`,
          description: [
            `Booked by VaaniYantra agent ${req.agent.name}.`,
            `Customer: ${customerName}${who}`,
            expertName ? `With: ${expertName}` : '',
            notes,
          ]
            .filter(Boolean)
            .join('\n'),
          startISO: new Date(start).toISOString(),
          endISO: new Date(end).toISOString(),
          timezone: cfg.timezone,
        });
      } catch (err) {
        // Release the claimed slot so it stays bookable.
        //
        // Still a hard rollback rather than "keep the row, skip the mirror":
        // this doctor DOES have a calendar, their colleagues can see it, and an
        // appointment missing from it would be invisible to everyone but us.
        // That is a different failure from having no calendar at all.
        await prisma.appointment.delete({ where: { id: appointmentId } }).catch(() => {});
        throw err;
      }
      calendarEventId = event.id;
      await prisma.appointment
        .update({ where: { id: appointmentId }, data: { calendarEventId } })
        .catch((e) => console.error('[booking] eventId persist failed', e));
    }

    const label = fmtSlot(new Date(start).toISOString(), cfg.timezone);
    const dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: cfg.timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(start));

    // Flag the call so post-call processing doesn't also create an event.
    if (req.callId) {
      const callId = req.callId;
      const existing = await prisma.call.findUnique({ where: { id: callId }, select: { collectedData: true } });
      await prisma.call.update({
        where: { id: callId },
        data: {
          collectedData: {
            ...((existing?.collectedData as object) ?? {}),
            appointmentBooked: true,
            appointment: { eventId: calendarEventId, startISO: new Date(start).toISOString(), customerName, expert: expertName, label },
          },
        },
      }).catch((e) => console.error('[booking] flagging call failed', e));
    }

    // Their chatbot link, so the confirmation doubles as the way back in later.
    const portalUrl = await portalLinkFor(req.workspaceId, contact);

    // Best-effort confirmation to the customer over the agent's channel, using
    // the org's template (#5/#8) with real name/time/expert/business values.
    if (req.customerNumber) {
      void sendConfirmation(
        req.orgId,
        req.customerNumber,
        // SMS / free-text fallback body:
        bookingSummary(cfg, { time: `${dateLabel} ${label}`, expert: expertName }),
        // Approved template for the WhatsApp path (required business-initiated).
        // The portal variant carries the link and is preferred; sendConfirmation
        // falls back to the plain one, then to SMS, so a clinic whose new
        // template isn't approved yet still gets a working confirmation.
        portalUrl
          ? apptConfirmationPortalTemplate({
              name: customerName,
              business: cfg.businessName,
              service: cfg.serviceName,
              when: `${dateLabel} ${label}`,
              portal: portalUrl,
            })
          : apptConfirmationTemplate({
              name: customerName,
              business: cfg.businessName,
              service: cfg.serviceName,
              when: `${dateLabel} ${label}`,
            }),
        portalUrl
          ? apptConfirmationTemplate({
              name: customerName,
              business: cfg.businessName,
              service: cfg.serviceName,
              when: `${dateLabel} ${label}`,
            })
          : undefined,
      )
        // sendConfirmation reports non-delivery by returning false rather than
        // throwing, and this return value used to be discarded — so a booking
        // the caller was promised a WhatsApp for could silently never get one,
        // and the only trace was a log line nobody reads.
        .then((delivered) =>
          prisma.appointment.update({
            where: { id: appointmentId },
            data: { confirmationDelivered: delivered },
          }),
        )
        .catch((e) => console.error('[booking] recording confirmation delivery failed', e));
    }

    // Route the booking through the outcome engine too, so it lands in the
    // owner alerts, the in-app feed, and the monthly sheet — one pipeline with
    // record_outcome. The caller was already messaged above (notifyCaller:false).
    void deliverOutcome({
      orgId: req.orgId,
      workspaceId: req.workspaceId,
      agent: req.agent,
      callId: req.callId ?? undefined,
      type: 'appointment',
      fields: {
        name: customerName,
        service: cfg.serviceName,
        time: label,
        date: dateLabel,
        ...(expertName ? { expert: expertName } : {}),
      },
      callerName: customerName,
      callerNumber: req.customerNumber,
      businessName: cfg.businessName,
      notifyCaller: false,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'service', label: 'Service' },
        { key: 'date', label: 'Date' },
        { key: 'time', label: 'Time' },
        { key: 'expert', label: 'With' },
      ],
    }).catch((e) => console.error('[booking] deliverOutcome failed', e));

    // Write-back: push the booking into whatever the clinic already runs. This
    // is the integration most clinics ask for first — their front desk should
    // not have to watch a second screen to know the AI booked someone.
    void dispatchPatientEvent(req.workspaceId, 'appointment.created', {
      id: appointmentId,
      customerName,
      customerNumber: req.customerNumber,
      patientNo: contact?.uhid ?? null,
      contactId: contact?.id ?? null,
      service: cfg.serviceName,
      expertName: expertName ?? null,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      timezone: cfg.timezone,
      status: 'CONFIRMED',
      calendarEventId,
      bookedBy: req.source ?? (req.callId ? 'agent' : 'portal'),
      callId: req.callId ?? null,
    });

    console.log(
      '[booking] booked',
      calendarEventId ?? appointmentId,
      req.callId ? `for call ${req.callId}` : `(${req.source ?? 'portal'})`,
    );
    return {
      ok: true,
      booked: true,
      appointmentId,
      patientNo: contact?.uhid ?? null,
      when: label,
      date: dateLabel,
      expert: expertName,
      confirmation: 'Appointment confirmed.',
    };
  } catch (err) {
    console.error('[booking] createBooking failed', err);
    return { ok: false, error: 'Could not book the appointment. Try again or take a message.' };
  }
}

/**
 * Register the person being booked as a patient of this clinic, returning the
 * Contact (or null when there is no phone number to identify them by, or the
 * write failed).
 *
 * This used to be fused with minting the chatbot link, which meant it returned
 * early for any clinic that had not created a chatbot — so those clinics
 * accumulated appointments but no patients, and an empty Patients page. Patient
 * registration is not conditional on a chatbot existing; only the link is.
 *
 * Never throws: a patient-record problem must not fail a real booking.
 */
async function ensureContact(input: {
  orgId: string;
  workspaceId: string;
  name: string;
  phone: string | null;
}): Promise<Contact | null> {
  if (!input.phone) return null;
  try {
    return await upsertContact({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      name: input.name,
      phone: input.phone,
    });
  } catch (err) {
    console.error('[booking] patient record failed', err);
    return null;
  }
}

/**
 * That patient's private chatbot link, or null when the workspace has no
 * chatbot or their access has been revoked. This is how a patient ever finds
 * the assistant holding their prescription.
 */
async function portalLinkFor(workspaceId: string, contact: Contact | null): Promise<string | null> {
  if (!contact || contact.portalRevokedAt) return null;
  try {
    const portal = await prisma.portal.findFirst({
      where: { workspaceId, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { slug: true },
    });
    if (!portal) return null;
    return portalLink(portal.slug);
  } catch (err) {
    console.error('[booking] portal link failed', err);
    return null;
  }
}

async function bookAppointment(
  cfg: BookingConfig,
  args: Record<string, unknown>,
  ctx: CallToolContext,
): Promise<Record<string, unknown>> {
  return createBooking(cfg, {
    orgId: ctx.orgId,
    workspaceId: ctx.agent.workspaceId,
    agent: ctx.agent,
    callId: ctx.callId,
    customerNumber: ctx.customerNumber,
    customerName: typeof args.customerName === 'string' ? args.customerName : '',
    startISO: typeof args.startISO === 'string' ? args.startISO : '',
    expert: args.expert,
    notes: typeof args.notes === 'string' ? args.notes : '',
  });
}

// Load an appointment by id, scoped to this org and (when known) the caller's
// number, so a caller can only touch their own bookings.
/**
 * Who may act on an appointment.
 *
 * `customerNumber` is the caller-identity guard: on a phone call it confines
 * every lookup to the number on the line, which is what stops "cancel Ravi's
 * appointment" from working. Staff have no such number and are confined by
 * `workspaceId` instead — they are authenticated and authorised, and moving
 * someone else's appointment is their actual job.
 */
export type AppointmentScope = {
  orgId: string;
  customerNumber?: string | null;
  workspaceId?: string;
};

async function loadOwnedAppointment(id: string, ctx: AppointmentScope) {
  if (!id) return null;
  return prisma.appointment.findFirst({
    where: {
      id,
      orgId: ctx.orgId,
      status: 'CONFIRMED',
      ...(ctx.customerNumber ? { customerNumber: ctx.customerNumber } : {}),
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    },
  });
}

async function findAppointment(cfg: BookingConfig, ctx: CallToolContext): Promise<Record<string, unknown>> {
  if (!ctx.customerNumber) {
    return { ok: false, error: "No caller number is available, so I can't look up the booking." };
  }
  try {
    const appts = await prisma.appointment.findMany({
      where: { orgId: ctx.orgId, customerNumber: ctx.customerNumber, status: 'CONFIRMED', startAt: { gte: new Date() } },
      orderBy: { startAt: 'asc' },
      take: 5,
    });
    if (appts.length === 0) return { ok: true, appointments: [], message: 'No upcoming appointments for this number.' };
    return {
      ok: true,
      appointments: appts.map((a) => ({
        appointmentId: a.id,
        service: a.service,
        expert: a.expertName ?? undefined,
        when: fmtSlot(a.startAt.toISOString(), a.timezone || cfg.timezone),
      })),
    };
  } catch (err) {
    console.error('[booking] find_appointment failed', err);
    return { ok: false, error: 'Could not look up the appointment right now.' };
  }
}

async function cancelAppointment(
  _cfg: BookingConfig,
  args: Record<string, unknown>,
  ctx: CallToolContext,
): Promise<Record<string, unknown>> {
  try {
    const id = typeof args.appointmentId === 'string' ? args.appointmentId : '';
    // A voice caller IS the number on the line, so household-wide authority is
    // correct here — a mother ringing in may cancel her child's appointment.
    // This is the one scope that keeps phone matching.
    if (!ctx.customerNumber) {
      return { ok: false, error: "I can't look up the booking without a caller number." };
    }
    const res = await cancelAppointmentRecord(id, {
      by: 'caller',
      orgId: ctx.orgId,
      customerNumber: ctx.customerNumber,
    });
    if (!res.ok) return { ok: false, error: 'I could not find that appointment to cancel.' };
    return { ok: true, cancelled: true, when: res.when };
  } catch (err) {
    console.error('[booking] cancel_appointment failed', err);
    return { ok: false, error: 'Could not cancel the appointment right now.' };
  }
}

/**
 * Move an appointment, and its Google event if it has one.
 *
 * EXPORTED so the staff PATCH route calls exactly this rather than writing a
 * second move. src/app/api/appointments/route.ts:41-50 states the rule for
 * booking — "A second write path would drift from all of it within a release" —
 * and it applies here at least as strongly: this function holds the advisory
 * lock, the overlap re-check, the reminder-flag reset and the rollback that puts
 * the row back if Google rejects the patch. A hand-rolled staff version would
 * miss at least one of those.
 */
export async function rescheduleBooking(
  cfg: BookingConfig,
  args: Record<string, unknown>,
  ctx: AppointmentScope,
): Promise<Record<string, unknown>> {
  const newStartISO = typeof args.newStartISO === 'string' ? args.newStartISO : '';
  if (!newStartISO || Number.isNaN(Date.parse(newStartISO))) return { ok: false, error: 'Invalid new time.' };
  // The same guard createBooking has. Without it a mis-resolved "next Tuesday"
  // moves a live booking into the past, where it disappears from findAppointment
  // and from the staff list, and has its reminder flags reset so nothing is ever
  // sent — while the caller has just been told on the phone that it moved. The
  // clinic sees a no-show it cannot explain.
  if (Date.parse(newStartISO) < Date.now()) {
    return { ok: false, error: 'That time has already passed. Offer a later one.' };
  }
  try {
    const appt = await loadOwnedAppointment(typeof args.appointmentId === 'string' ? args.appointmentId : '', ctx);
    if (!appt) return { ok: false, error: 'I could not find that appointment to reschedule.' };

    // Reuse the account this appointment was BOOKED on, not whatever the
    // agent's config resolves to now. `appt.calendarId` is very often the
    // literal "primary", which means a different calendar under a different
    // doctor's token — so the stored owner is the only safe thing to key off.
    // No connection is not a refusal any more. An appointment booked without a
    // mirror, or whose clinic has since disconnected Google, still lives in our
    // database and must stay movable — refusing here meant a clinic that
    // disconnected could never reschedule anything it had already booked.
    const conn = await resolveToken(ctx.orgId, appt.calendarUserId);
    const calendarId = conn ? appt.calendarId || conn.calendarId : null;

    const durationMs = appt.endAt.getTime() - appt.startAt.getTime();
    const start = Date.parse(newStartISO);
    const end = start + durationMs;

    // Re-check the new slot against the mirror, when there is one. Our own
    // clashes are caught by the advisory-locked overlap check below.
    if (conn && calendarId) {
      const busy = await freeBusy(conn.token, calendarId, new Date(start).toISOString(), new Date(end).toISOString());
      if (busy.some((b) => start < b.end && end > b.start)) {
        return { ok: false, error: 'That new slot is taken. Offer another time.' };
      }
    }

    // Atomically move the row under the same per-slot advisory lock used by
    // bookAppointment, so a concurrent booking can't take the new slot between
    // the check and the move.
    const prevStart = appt.startAt;
    const prevEnd = appt.endAt;
    const moved = await prisma.$transaction(async (tx) => {
      // Same lock key and same overlap test as claimSlot — a reschedule is a
      // claim on the new slot, and must contend with concurrent bookings on it.
      const key = claimLockKey(ctx.orgId, appt.doctorId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const taken = await tx.appointment.count({
        where: clashWhere({
          orgId: ctx.orgId,
          doctorId: appt.doctorId,
          startMs: start,
          endMs: end,
          excludeId: appt.id,
        }),
      });
      if (taken >= Math.max(1, cfg.slotCapacity)) return false;
      await tx.appointment.update({
        where: { id: appt.id },
        // Reset reminder flags so the moved appointment is reminded again.
        data: { startAt: new Date(start), endAt: new Date(end), remind24Sent: false, remind1Sent: false },
      });
      return true;
    });
    if (!moved) return { ok: false, error: 'That new slot is taken. Offer another time.' };

    if (conn && calendarId && appt.calendarEventId) {
      try {
        await patchEvent(conn.token, calendarId, appt.calendarEventId, new Date(start).toISOString(), new Date(end).toISOString(), appt.timezone || cfg.timezone);
      } catch (err) {
        // Put the row back where the calendar still says it is.
        await prisma.appointment
          .update({ where: { id: appt.id }, data: { startAt: prevStart, endAt: prevEnd } })
          .catch(() => {});
        throw err;
      }
    }

    const when = fmtSlot(new Date(start).toISOString(), appt.timezone || cfg.timezone);
    if (ctx.customerNumber) {
      const withExpert = appt.expertName ? ` with ${appt.expertName}` : '';
      const at = cfg.businessName ? ` at ${cfg.businessName}` : '';
      void sendConfirmation(
        ctx.orgId,
        ctx.customerNumber,
        // SMS / free-text fallback body:
        `Your ${appt.service}${withExpert}${at} has been moved to ${when}.`,
        // This used to pass no template at all, so on the WhatsApp channel the
        // free text above was the whole message — and Meta rejects free text
        // for a business-initiated send, quietly dropping every reschedule
        // notice to SMS.
        apptRescheduledTemplate({
          name: appt.customerName,
          business: cfg.businessName,
          service: appt.service,
          when,
        }),
      );
    }

    void dispatchPatientEvent(appt.workspaceId, 'appointment.rescheduled', {
      id: appt.id,
      customerName: appt.customerName,
      customerNumber: appt.customerNumber,
      service: appt.service,
      expertName: appt.expertName,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      previousStartAt: prevStart.toISOString(),
      timezone: appt.timezone || cfg.timezone,
      status: 'CONFIRMED',
    });

    return { ok: true, rescheduled: true, when };
  } catch (err) {
    console.error('[booking] reschedule_appointment failed', err);
    return { ok: false, error: 'Could not reschedule the appointment right now.' };
  }
}
