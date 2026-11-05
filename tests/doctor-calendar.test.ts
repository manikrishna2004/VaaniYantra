import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-doctor calendars are the one change here that can quietly write to the
// WRONG doctor's calendar rather than failing loudly, so the resolution rules
// are pinned down directly.

const findFirst = vi.fn();
vi.mock('@/lib/db', () => ({ prisma: { integration: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));
vi.mock('@/lib/crypto', () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));
vi.mock('@/lib/adapters/llm', () => ({ getLlmProvider: () => ({}) }));
vi.mock('@/lib/google-oauth', () => ({ refreshAccessToken: async () => 'tok' }));

const { resolveDoctorCalendar, getCalendarConfig, SHARED_CALENDAR_OWNER } = await import('@/lib/calendar');

/** Rows keyed by owner: "" is the clinic's shared connection. */
function seed(rows: Record<string, { calendarId: string; email: string }>) {
  findFirst.mockImplementation(async (args: any) => {
    const owner = args?.where?.userId;
    const row = rows[owner];
    return row ? { secret: JSON.stringify({ refreshToken: 'r', ...row }) } : null;
  });
}

beforeEach(() => findFirst.mockReset());

describe('resolveDoctorCalendar', () => {
  it("uses the doctor's own connection when they have one", async () => {
    seed({ '': { calendarId: 'clinic', email: 'clinic@x.com' }, u1: { calendarId: 'primary', email: 'dr@x.com' } });
    const r = await resolveDoctorCalendar('org1', 'u1');
    expect(r?.ownerUserId).toBe('u1');
    expect(r?.cfg.email).toBe('dr@x.com');
  });

  it("falls back to the clinic's shared connection when the doctor has none", async () => {
    seed({ '': { calendarId: 'clinic', email: 'clinic@x.com' } });
    const r = await resolveDoctorCalendar('org1', 'u2');
    expect(r?.ownerUserId).toBe(SHARED_CALENDAR_OWNER);
    expect(r?.cfg.email).toBe('clinic@x.com');
  });

  it('falls back for a legacy appointment with no recorded owner', async () => {
    // Every appointment booked before per-doctor calendars has
    // calendarUserId = null. It must resolve to the shared connection — the
    // exact one it was originally booked on — or reschedule/cancel would break.
    seed({ '': { calendarId: 'clinic', email: 'clinic@x.com' } });
    const r = await resolveDoctorCalendar('org1', null);
    expect(r?.ownerUserId).toBe(SHARED_CALENDAR_OWNER);
  });

  it('returns null when nothing is connected at all', async () => {
    seed({});
    expect(await resolveDoctorCalendar('org1', 'u1')).toBeNull();
  });

  it("a doctor's own connection does NOT stand in for the clinic's", async () => {
    // getCalendarConfig means "the clinic's shared calendar" everywhere it is
    // called. If a doctor's row could satisfy it, post-call events would land
    // in a random doctor's calendar.
    seed({ u1: { calendarId: 'primary', email: 'dr@x.com' } });
    expect(await getCalendarConfig('org1')).toBeNull();
  });
});
