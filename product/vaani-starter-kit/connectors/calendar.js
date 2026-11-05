/**
 * Google Calendar — the agent's source of truth for what is free and what got
 * booked.
 *
 * Deliberately uses plain fetch against the REST API instead of the googleapis
 * SDK: it is three endpoints, and the SDK is a large dependency that hides the
 * one thing you actually need to understand — the refresh-token dance.
 *
 * Leave the GOOGLE_* keys blank in .env and every function here degrades to
 * "no calendar": the agent still answers and still takes the caller's details,
 * it just does not book anything.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export function calendarConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN,
  );
}

// Access tokens last an hour. Refreshing on every call would add a round trip
// to the first thing the caller hears, so we hold one until a minute before it
// expires. A refresh token, unlike an access token, does not expire — which is
// why GUIDE section 6 has you mint one once and paste it into .env forever.
let cached = { token: null, expiresAt: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The overwhelmingly common cause is an app still in "Testing" mode, whose
    // refresh tokens expire after 7 days. Say so, rather than leaving the
    // reader to decode "invalid_grant" on their own.
    throw new Error(
      'Google token refresh failed (' + res.status + '): ' +
        (body.error_description || body.error || 'unknown') +
        '. If this says invalid_grant, your refresh token has expired — see GUIDE section 6.5.',
    );
  }

  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

async function api(path, init = {}) {
  const token = await accessToken();
  const res = await fetch(API + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      'Calendar API ' + (init.method || 'GET') + ' ' + path +
        ' failed (' + res.status + '): ' + text.slice(0, 300),
    );
  }
  return res.status === 204 ? null : res.json();
}

const calendarPath = () => encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');

/** Busy intervals on the calendar between two instants. */
export async function busyIntervals(fromISO, toISO) {
  const data = await api('/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: fromISO,
      timeMax: toISO,
      items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }],
    }),
  });
  const cal = Object.values(data.calendars || {})[0] || {};
  return (cal.busy || []).map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));
}

/**
 * Open appointment slots on one local date.
 *
 * Returns [] for a day the business is closed, or a date already gone. The
 * agent is told, in its prompt, never to offer a time this did not return —
 * that single rule is what stops it cheerfully inventing "how about 3pm?".
 */
export async function openSlots(dateISO, { now = new Date() } = {}) {
  const tz = process.env.BUSINESS_TIMEZONE || 'UTC';
  const openHour = Number(process.env.OPEN_HOUR || 9);
  const closeHour = Number(process.env.CLOSE_HOUR || 17);
  const slotMins = Number(process.env.SLOT_MINUTES || 30);
  const openDays = (process.env.OPEN_DAYS || '1,2,3,4,5').split(',').map((d) => Number(d.trim()));

  if (!openDays.includes(localWeekday(dateISO, tz))) return [];

  // Build the day's boundaries as real instants. dateISO is a wall-clock date
  // in the business's timezone, which is neither the server's timezone nor the
  // caller's — getting this wrong is how an agent books 9am Tuesday into
  // Monday night.
  const dayStart = zonedTime(dateISO, openHour, 0, tz);
  const dayEnd = zonedTime(dateISO, closeHour, 0, tz);
  if (dayStart === null || dayEnd === null) return [];

  const busy = calendarConfigured()
    ? await busyIntervals(new Date(dayStart).toISOString(), new Date(dayEnd).toISOString())
    : [];

  const slots = [];
  const lengthMs = slotMins * 60000;
  // Never offer a slot in the past, and never one starting within the next 15
  // minutes — a caller cannot physically be there, and offering it makes the
  // agent sound like it is not paying attention.
  const earliest = now.getTime() + 15 * 60000;

  for (let t = dayStart; t + lengthMs <= dayEnd; t += lengthMs) {
    if (t < earliest) continue;
    if (busy.some((b) => t < b.end && t + lengthMs > b.start)) continue;
    slots.push({
      startISO: new Date(t).toISOString(),
      endISO: new Date(t + lengthMs).toISOString(),
      label: spokenTime(t, tz),
    });
  }
  return slots;
}

/** Put a real event on the calendar. Returns its id so it can be moved later. */
export async function createEvent({ startISO, endISO, summary, description }) {
  if (!calendarConfigured()) return { id: 'local-' + Date.now(), simulated: true };
  const event = await api('/calendars/' + calendarPath() + '/events', {
    method: 'POST',
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
    }),
  });
  return { id: event.id, htmlLink: event.htmlLink };
}

export async function cancelEvent(eventId) {
  if (!calendarConfigured() || String(eventId).startsWith('local-')) return;
  await api('/calendars/' + calendarPath() + '/events/' + encodeURIComponent(eventId), {
    method: 'DELETE',
  });
}

// ── Timezone helpers ────────────────────────────────────────────────────────
// Done without a date library: Intl already knows every timezone, so we ask it
// what a given instant looks like locally and correct for the difference.

function zonedTime(dateISO, hour, minute, tz) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  if (!y || !m || !d) return null;
  // First guess: treat the wall clock as if it were UTC, then measure how far
  // off that is in the target zone and subtract the gap.
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  return guess - zoneOffsetMs(guess, tz);
}

function zoneOffsetMs(instant, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUTC - instant;
}

function localWeekday(dateISO, tz) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const noon = Date.UTC(y, m - 1, d, 12);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    .format(new Date(noon));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** "2:30 PM" — how the agent should say a time out loud. */
export function spokenTime(instant, tz = process.env.BUSINESS_TIMEZONE || 'UTC') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(instant));
}

/** Today's date in the business's timezone, as YYYY-MM-DD. */
export function todayISO(tz = process.env.BUSINESS_TIMEZONE || 'UTC') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day;
}

/** "Thursday, 25 September 2026, 3:04 PM" — for the prompt's TODAY line. */
export function nowInZone(tz = process.env.BUSINESS_TIMEZONE || 'UTC') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date());
}
