import { describe, it, expect, vi, beforeEach } from 'vitest';

// The alert that would have caught the 2026-08-27 outage. Its whole value is
// being trusted, so the two things pinned hardest here are: it fires on the
// shape of a real outage, and it stays quiet on a quiet night. An alert that
// cries wolf at 3am gets muted, and then it is worth nothing.

const prismaMock = vi.hoisted(() => ({
  call: { count: vi.fn(async () => 0) },
  webhook: { count: vi.fn(async () => 0) },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const marks = vi.hoisted(() => ({ reminder: null as string | null, stale: null as string | null }));
vi.mock('@/lib/reminder-dispatcher', () => ({ lastReminderTickAt: async () => marks.reminder }));
vi.mock('@/lib/calls/stale', () => ({ lastStaleSweepAt: async () => marks.stale }));

const authMock = vi.hoisted(() => ({ email: 'founder@vaaniyantra.com', superAdmin: true }));
vi.mock('@/lib/auth/api', () => ({
  apiContext: async () => ({ ctx: { user: { email: authMock.email } } }),
}));
vi.mock('@/lib/platform', () => ({ isSuperAdmin: () => authMock.superAdmin }));

import { GET } from '@/app/api/admin/ops-health/route';

const req = (auth?: string) =>
  new Request('http://t/api/admin/ops-health', auth ? { headers: { authorization: auth } } : undefined);

/** total calls in the window, of which `bad` ended before anyone spoke. */
const calls = (total: number, bad: number) => {
  prismaMock.call.count
    .mockResolvedValueOnce(total) // total
    .mockResolvedValueOnce(bad); // no_conversation
};

const body = async (r: Response) => r.json() as Promise<Record<string, any>>;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.call.count.mockResolvedValue(0);
  prismaMock.webhook.count.mockResolvedValue(0);
  marks.reminder = new Date().toISOString();
  marks.stale = new Date().toISOString();
  authMock.superAdmin = true;
  delete process.env.OPS_CRON_SECRET;
});

describe('the outage this was written for', () => {
  it('reports a high no-conversation rate when the agent cannot speak', async () => {
    calls(20, 18);
    const b = await body(await GET(req()));
    expect(b.calls.noConversationPct).toBe(90);
    expect(b.calls.rated).toBe(true);
  });

  it('reports a healthy clinic as near zero', async () => {
    calls(40, 1);
    const b = await body(await GET(req()));
    expect(b.calls.noConversationPct).toBeCloseTo(2.5, 1);
  });
});

describe('not crying wolf', () => {
  // The failure mode that gets an alert muted: at 2 calls, one wrong number is
  // 50% and looks identical to a total outage.
  it('declines to rate an hour with too few calls', async () => {
    calls(2, 1);
    const b = await body(await GET(req()));
    expect(b.calls.noConversationPct).toBeNull();
    expect(b.calls.rated).toBe(false);
  });

  it('reports null rather than 0% for an hour with no calls at all', async () => {
    calls(0, 0);
    const b = await body(await GET(req()));
    expect(b.calls.noConversationPct).toBeNull();
    expect(b.calls.total).toBe(0);
  });
});

describe('background job liveness', () => {
  it('ages the markers so a dispatcher that stopped is visible', async () => {
    marks.reminder = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const b = await body(await GET(req()));
    expect(b.reminders.ageHours).toBeCloseTo(5, 1);
  });

  // Distinct from "old": a job that has never run at all has no marker, and the
  // script says so differently, because it usually means it never started.
  it('reports null age when a job has never completed a pass', async () => {
    marks.reminder = null;
    const b = await body(await GET(req()));
    expect(b.reminders.lastTickAt).toBeNull();
    expect(b.reminders.ageHours).toBeNull();
  });
});

describe('access', () => {
  it('refuses a signed-in user who is not a super admin', async () => {
    authMock.superAdmin = false;
    expect((await GET(req())).status).toBe(403);
  });

  it('accepts the cron with the right bearer secret', async () => {
    process.env.OPS_CRON_SECRET = 'sekret';
    authMock.superAdmin = false; // cron has no session at all
    expect((await GET(req('Bearer sekret'))).status).toBe(200);
  });

  // The rule cron-auth exists to enforce: an unset secret must authenticate
  // nothing, or a machine that forgot the env var accepts anything.
  it('refuses a bearer token when no secret is configured', async () => {
    authMock.superAdmin = false;
    expect((await GET(req('Bearer anything'))).status).toBe(403);
  });
});
