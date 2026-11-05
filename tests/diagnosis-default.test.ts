import { describe, it, expect, vi, beforeEach } from 'vitest';

// The two ways a visit record gets written default the diagnosis hold in
// OPPOSITE directions:
//
//   in-app form  -> HELD    (the doctor opts in to releasing)
//   v1 push API  -> RELEASED (the integrator opts out)
//
// That looks like a bug and is not. A push clinic's own PMS/HIS is the system
// of record and has already decided what its patients may see; defaulting to
// withheld would, on the day the feature ships, silently retract the diagnosis
// from every patient of every integrated clinic. Meanwhile a doctor typing into
// our form has made no such decision yet, so we hold.
//
// It is exactly the kind of asymmetry a later refactor "tidies up" into a
// single default and breaks one of the two clinics' expectations, so both
// directions are pinned here.

const prismaMock = vi.hoisted(() => ({
  contact: {
    findFirst: vi.fn(async () => ({ id: 'c1', orgId: 'o1', workspaceId: 'w1' })),
  },
  visitRecord: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => ({ id: 'v1', ...data })),
    update: vi.fn(async ({ data }: any) => ({ id: 'v1', ...data })),
  },
  visitAttachment: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  $transaction: vi.fn(async (fn: any) => (typeof fn === 'function' ? fn(prismaMock) : Promise.all(fn))),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/api/v1', () => ({
  requireApiAuth: vi.fn(async () => ({ orgId: 'o1', keyId: 'k1' })),
  paging: () => ({ take: 25, skip: 0, limit: 25, offset: 0 }),
  unauthorized: vi.fn(),
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

import { POST as pushVisit } from '@/app/api/v1/patients/[id]/visits/route';

const push = (body: unknown) =>
  pushVisit(
    new Request('http://test/api/v1/patients/c1/visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: 'Bearer ck_live_x' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'c1' }) },
  );

/** The data actually handed to Prisma for the created visit. */
const createdData = () => prismaMock.visitRecord.create.mock.calls.at(-1)?.[0]?.data;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v1 push API releases the diagnosis by default', () => {
  it('stamps diagnosisSharedAt when the field is omitted', async () => {
    const res = await push({ diagnosis: 'Acute pharyngitis' });

    expect(res.status).toBeLessThan(300);
    expect(createdData()?.diagnosisSharedAt).toBeInstanceOf(Date);
  });

  it('holds it when the integrator explicitly passes false', async () => {
    await push({ diagnosis: 'Suspected malignancy', diagnosisShared: false });

    expect(createdData()?.diagnosisSharedAt).toBeNull();
  });

  it('treats any value other than false as released', async () => {
    // Deliberately not truthiness: only an explicit `false` holds, so an
    // integrator sending nothing, null or true all publish.
    for (const value of [undefined, true, null]) {
      vi.clearAllMocks();
      await push({ diagnosis: 'Migraine', diagnosisShared: value });
      expect(createdData()?.diagnosisSharedAt, String(value)).toBeInstanceOf(Date);
    }
  });

  it('backdates the release to the visit date when one is supplied', async () => {
    await push({ diagnosis: 'Migraine', visitedAt: '2026-06-01T09:00:00Z' });

    expect(createdData()?.diagnosisSharedAt?.toISOString()).toBe('2026-06-01T09:00:00.000Z');
  });

  it('marks the record as belonging to the integrator’s system', async () => {
    await push({ diagnosis: 'Migraine' });

    // The staff UI keys off this to stop someone editing a record the clinic's
    // own system will overwrite on the next push.
    expect(createdData()?.source).toBe('push');
  });

  it('refuses a visit with no clinical content at all', async () => {
    const res = await push({ expertName: 'Dr Rao' });

    expect(res.status).toBe(400);
    expect(prismaMock.visitRecord.create).not.toHaveBeenCalled();
  });
});
