import { describe, it, expect, vi, beforeEach } from 'vitest';

// Accepting a DOCTOR invite is now the act that makes someone bookable, and
// /api/doctors/me is how they fill themselves in. Both are access-control
// surfaces: the first must not duplicate or steal rows, the second must not let
// a doctor touch a colleague or promote themselves.

const prismaMock = vi.hoisted(() => ({
  invitation: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  membership: { upsert: vi.fn(async () => ({})) },
  workspace: { findFirst: vi.fn(async () => ({ id: 'ws1' })) },
  user: { update: vi.fn(async () => ({})) },
  organization: { findUnique: vi.fn(async () => ({ name: 'Smilecare' })) },
  doctor: {
    findUnique: vi.fn(async () => null as unknown),
    findFirst: vi.fn(async () => null as unknown),
    findMany: vi.fn(async () => [] as unknown[]),
    create: vi.fn(async (a: { data: unknown }) => ({ id: 'new', ...(a.data as object) })),
    update: vi.fn(async (a: { data: unknown }) => ({ id: 'd1', bookable: true, ...(a.data as object) })),
  },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const ctxMock = vi.hoisted(() => ({
  ctx: {
    user: { id: 'u1', email: 'dr@x.com', name: 'Aditi' },
    org: { id: 'o1', name: 'Smilecare' },
    workspace: { id: 'ws1' },
    role: 'DOCTOR',
  },
}));
vi.mock('@/lib/auth/api', async () => {
  const { hasPermission } = await import('@/lib/auth/permissions');
  const { NextResponse } = await import('next/server');
  return {
    apiContext: async () => ({ ctx: ctxMock.ctx }),
    deny: (c: { role: string }, perm: string) =>
      hasPermission(c.role as never, perm as never)
        ? null
        : NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
  };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

import { POST as acceptInvite } from '@/app/api/invitations/accept/route';
import { PATCH as patchMe } from '@/app/api/doctors/me/route';

const invite = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  token: 't',
  orgId: 'o1',
  email: 'dr@x.com',
  role: 'DOCTOR',
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 86400000),
  ...over,
});

const post = (body: unknown, url = 'http://t/api') =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (body: unknown) =>
  new Request('http://t/api/doctors/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  for (const model of Object.values(prismaMock)) {
    for (const fn of Object.values(model)) (fn as { mockClear?: () => void }).mockClear?.();
  }
  prismaMock.doctor.findUnique.mockResolvedValue(null);
  prismaMock.doctor.findMany.mockResolvedValue([]);
  ctxMock.ctx.role = 'DOCTOR';
});

describe('accepting a DOCTOR invite', () => {
  it('creates the doctor row, so there is no second admin step', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invite());
    await acceptInvite(post({ token: 't' }));
    expect(prismaMock.doctor.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.doctor.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.userId).toBe('u1');
    expect(data.orgId).toBe('o1');
  });

  // The placeholder name is why. Without this the agent starts offering callers
  // an appointment with "dr" seconds after the invite is accepted.
  it('creates them NOT bookable, so a placeholder name is never read out', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invite());
    await acceptInvite(post({ token: 't' }));
    const data = prismaMock.doctor.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.bookable).toBe(false);
  });

  it('is idempotent — a re-opened link does not make a second doctor', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invite());
    prismaMock.doctor.findUnique.mockResolvedValue({ id: 'already' });
    await acceptInvite(post({ token: 't' }));
    expect(prismaMock.doctor.create).not.toHaveBeenCalled();
  });

  // Claiming beats duplicating: the admin's row already carries a schedule,
  // time off and appointment history.
  it('claims an unlinked row the admin already typed in, by email', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invite());
    prismaMock.doctor.findMany.mockResolvedValue([{ id: 'typed' }]);
    await acceptInvite(post({ token: 't' }));
    expect(prismaMock.doctor.create).not.toHaveBeenCalled();
    expect(prismaMock.doctor.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'typed' }, data: { userId: 'u1' } }),
    );
  });

  it('refuses to guess when two unlinked rows share the email', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invite());
    prismaMock.doctor.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await acceptInvite(post({ token: 't' }));
    expect(prismaMock.doctor.update).not.toHaveBeenCalled();
    expect(prismaMock.doctor.create).toHaveBeenCalledTimes(1);
  });

  it('makes no doctor for a non-doctor invite', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invite({ role: 'MEMBER' }));
    await acceptInvite(post({ token: 't' }));
    expect(prismaMock.doctor.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/doctors/me', () => {
  const mine = {
    id: 'd1',
    displayName: 'dr',
    specialisation: null,
    bookable: false,
    profileCompletedAt: null,
  };

  it('edits only the caller’s own row — the route takes no id to tamper with', async () => {
    prismaMock.doctor.findUnique.mockResolvedValue(mine);
    await patchMe(patch({ displayName: 'Dr. Aditi Sharma', specialisation: 'Dentist', id: 'someone-else' }));
    expect(prismaMock.doctor.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'd1' } }),
    );
  });

  it('ignores administrative fields a doctor must not set for themselves', async () => {
    prismaMock.doctor.findUnique.mockResolvedValue(mine);
    await patchMe(patch({ displayName: 'Dr. A', active: true, bookable: true, userId: 'u9', calendarId: 'c9' }));
    const data = prismaMock.doctor.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.userId).toBeUndefined();
    expect(data.calendarId).toBeUndefined();
    expect(data.active).toBeUndefined();
  });

  // Becoming bookable is a consequence of saying who you are, not a switch.
  it('goes bookable only once name AND specialisation are both set', async () => {
    prismaMock.doctor.findUnique.mockResolvedValue(mine);
    await patchMe(patch({ displayName: 'Dr. Aditi Sharma' }));
    expect((prismaMock.doctor.update.mock.calls[0][0].data as Record<string, unknown>).bookable).toBeUndefined();

    prismaMock.doctor.update.mockClear();
    await patchMe(patch({ displayName: 'Dr. Aditi Sharma', specialisation: 'Dentist' }));
    const data = prismaMock.doctor.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.bookable).toBe(true);
    expect(data.profileCompletedAt).toBeInstanceOf(Date);
  });

  it('refuses to blank the name patients hear', async () => {
    prismaMock.doctor.findUnique.mockResolvedValue({ ...mine, displayName: 'Dr. A' });
    await patchMe(patch({ displayName: '   ', specialisation: 'Dentist' }));
    const data = prismaMock.doctor.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.displayName).toBeUndefined();
  });

  it('404s for someone who is not a doctor here', async () => {
    prismaMock.doctor.findUnique.mockResolvedValue(null);
    const res = await patchMe(patch({ displayName: 'Dr. X' }));
    expect(res.status).toBe(404);
  });

  it('is refused for a role without calendar:write_self', async () => {
    ctxMock.ctx.role = 'VIEWER';
    const res = await patchMe(patch({ displayName: 'Dr. X' }));
    expect(res.status).toBe(403);
  });
});

// Staff editing a doctor. Separate from /api/doctors/me: this one takes an id,
// requires member:manage, and may set `bookable` directly — which the doctor
// themselves cannot, because for them it is earned by completing a profile.
describe('PATCH /api/doctors/[id] — staff editing a doctor', () => {
  it('accepts the profile fields, so staff can finish a no-show doctor’s setup', async () => {
    prismaMock.doctor.findFirst.mockResolvedValue({ id: 'd1', orgId: 'o1' });
    prismaMock.doctor.update.mockClear();
    ctxMock.ctx.role = 'OWNER';
    const { PATCH } = await import('@/app/api/doctors/[id]/route');
    await PATCH(
      new Request('http://t/api/doctors/d1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specialisation: 'Dentist', qualifications: 'BDS', bookable: true }),
      }),
      { params: Promise.resolve({ id: 'd1' }) } as never,
    );
    const data = prismaMock.doctor.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.specialisation).toBe('Dentist');
    expect(data.qualifications).toBe('BDS');
    expect(data.bookable).toBe(true);
  });
});
