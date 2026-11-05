import { describe, it, expect, vi, beforeEach } from 'vitest';

// "Book a call with our team".
//
// Two properties matter most and are what these tests hold down:
//   1. It fails INVISIBLE. This drives a sales banner on the dashboard, so a
//      revoked Google grant must produce no slots — never an exception that
//      breaks the page an operator actually came for.
//   2. It re-checks availability at booking time. The slot list the browser
//      posts back was computed seconds to minutes ago.

const prismaMock = vi.hoisted(() => ({ auditLog: { findFirst: vi.fn() } }));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const platform = vi.hoisted(() => ({
  getPlatformConfig: vi.fn(),
  setPlatformConfig: vi.fn(async () => {}),
  deletePlatformConfig: vi.fn(async () => {}),
}));
vi.mock('@/lib/platform', () => platform);

vi.mock('@/lib/crypto', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => {
    if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
    return s.slice(4);
  },
}));

const oauth = vi.hoisted(() => ({ refreshAccessToken: vi.fn(async () => 'access-token') }));
vi.mock('@/lib/google-oauth', () => oauth);

const cal = vi.hoisted(() => ({
  freeBusy: vi.fn(async () => [] as { start: number; end: number }[]),
  computeOpenSlots: vi.fn(() => [{ startISO: 'S', endISO: 'E' }]),
  // Params typed so `.mock.calls[0][2]` is reachable when asserting the event.
  createEvent: vi.fn(
    async (
      _token: string,
      _calendarId: string,
      _ev: {
        summary: string;
        startISO: string;
        endISO: string;
        attendees?: string[];
        notifyAttendees?: boolean;
        addMeet?: boolean;
      },
    ) => ({ id: 'e1', htmlLink: 'https://cal/e1', hangoutLink: 'https://meet/x' }),
  ),
}));
vi.mock('@/lib/calendar', () => cal);

import { getTeamCallSlots, bookTeamCall, DEFAULT_AVAILABILITY } from '@/lib/team-call';

const CONNECTED = 'enc:' + JSON.stringify({ refreshToken: 'rt', calendarId: 'primary', email: 'info@vaaniyantra.com' });

beforeEach(() => {
  vi.clearAllMocks();
  platform.getPlatformConfig.mockResolvedValue(CONNECTED);
  cal.freeBusy.mockResolvedValue([]);
  cal.computeOpenSlots.mockReturnValue([{ startISO: 'S', endISO: 'E' }]);
  cal.createEvent.mockResolvedValue({ id: 'e1', htmlLink: 'https://cal/e1', hangoutLink: 'https://meet/x' });
  oauth.refreshAccessToken.mockResolvedValue('access-token');
});

describe('getTeamCallSlots — fails invisible', () => {
  it('returns no slots when no calendar is connected', async () => {
    platform.getPlatformConfig.mockResolvedValue(null);
    expect(await getTeamCallSlots()).toEqual([]);
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('returns no slots when the Google grant has been revoked', async () => {
    oauth.refreshAccessToken.mockRejectedValue(new Error('invalid_grant'));
    await expect(getTeamCallSlots()).resolves.toEqual([]);
  });

  it('returns no slots when free/busy is unreachable', async () => {
    cal.freeBusy.mockRejectedValue(new Error('network'));
    await expect(getTeamCallSlots()).resolves.toEqual([]);
  });

  it('returns no slots when the stored config cannot be decrypted', async () => {
    // A rotated SECRET_ENC_KEY should disable the banner, not throw on render.
    platform.getPlatformConfig.mockResolvedValue('not-encrypted');
    await expect(getTeamCallSlots()).resolves.toEqual([]);
  });
});

describe('bookTeamCall — the slot must still be free', () => {
  const soon = () => new Date(Date.now() + 2 * 86400000).toISOString();

  it('refuses a slot that is now busy', async () => {
    const startISO = soon();
    const start = Date.parse(startISO);
    cal.freeBusy.mockResolvedValue([{ start: start - 60000, end: start + 60000 }]);

    const out = await bookTeamCall({ startISO, attendeeEmail: 'a@clinic.in' });

    expect(out).toEqual({ ok: false, reason: 'slot_taken' });
    expect(cal.createEvent).not.toHaveBeenCalled();
  });

  it('refuses a time in the past', async () => {
    const out = await bookTeamCall({
      startISO: new Date(Date.now() - 3600_000).toISOString(),
      attendeeEmail: 'a@clinic.in',
    });
    expect(out).toEqual({ ok: false, reason: 'bad_slot' });
    expect(cal.freeBusy).not.toHaveBeenCalled();
  });

  it('refuses a time beyond the window we advertise', async () => {
    const out = await bookTeamCall({
      startISO: new Date(Date.now() + (DEFAULT_AVAILABILITY.lookaheadDays + 5) * 86400000).toISOString(),
      attendeeEmail: 'a@clinic.in',
    });
    expect(out).toEqual({ ok: false, reason: 'bad_slot' });
  });

  it('refuses an unparseable time', async () => {
    const out = await bookTeamCall({ startISO: 'not-a-date', attendeeEmail: 'a@clinic.in' });
    expect(out).toEqual({ ok: false, reason: 'bad_slot' });
  });

  it('reports not_connected rather than throwing', async () => {
    platform.getPlatformConfig.mockResolvedValue(null);
    const out = await bookTeamCall({ startISO: soon(), attendeeEmail: 'a@clinic.in' });
    expect(out).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('reports failed when Google rejects the event', async () => {
    cal.createEvent.mockRejectedValue(new Error('500'));
    const out = await bookTeamCall({ startISO: soon(), attendeeEmail: 'a@clinic.in' });
    expect(out).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('bookTeamCall — the event it creates', () => {
  it('invites the customer and notifies them, with a Meet link', async () => {
    const startISO = new Date(Date.now() + 2 * 86400000).toISOString();

    const out = await bookTeamCall({
      startISO,
      attendeeEmail: 'owner@smiledental.in',
      attendeeName: 'Dr Rao',
      orgName: 'Smile Dental',
    });

    const [, calendarId, ev] = cal.createEvent.mock.calls[0];
    expect(calendarId).toBe('primary');
    // The attendee is the ONLY reason this reaches the customer's calendar.
    expect(ev.attendees).toEqual(['owner@smiledental.in']);
    expect(ev.notifyAttendees).toBe(true);
    expect(ev.addMeet).toBe(true);
    expect(ev.summary).toContain('Dr Rao');
    expect(ev.summary).toContain('Smile Dental');
    expect(Date.parse(ev.endISO) - Date.parse(ev.startISO)).toBe(DEFAULT_AVAILABILITY.durationMin * 60000);

    expect(out).toMatchObject({ ok: true, htmlLink: 'https://cal/e1', meetLink: 'https://meet/x' });
  });
});


