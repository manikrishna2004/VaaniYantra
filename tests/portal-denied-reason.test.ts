import { describe, it, expect, vi, beforeEach } from 'vitest';

// Opening the clinic's bare public link is a normal thing to do — it is the
// address the clinic itself copies and shares. It must not be reported as a
// broken or expired link, which sends people chasing a problem that isn't
// there. Only a credential that was actually presented and refused earns that.

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined, session: null as any }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'vy_portal' && state.cookie ? { value: state.cookie } : undefined) }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    appointment: { findMany: vi.fn(async () => []) },
    portalChatTurn: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock('@/lib/portal/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/portal/session')>('@/lib/portal/session');
  return { ...actual, currentPortalSession: vi.fn(async () => state.session) };
});
vi.mock('@/lib/patients', () => ({
  getPatientProvider: vi.fn(async () => ({
    listPatientVisits: vi.fn(async () => ({ status: 'empty' })),
  })),
  visitsOrEmpty: (r: any) => (r.status === 'ok' ? r.visits : []),
}));

import { GET } from '@/app/api/portal/[slug]/me/route';

const params = Promise.resolve({ slug: 'smile-care-dental' });

describe('GET /api/portal/[slug]/me — denial reasons', () => {
  beforeEach(() => {
    state.cookie = undefined;
    state.session = null;
  });

  it('reports "anonymous" when no credential was presented at all', async () => {
    const res = await GET(new Request('http://x'), { params });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('anonymous');
  });

  it('reports "rejected" when a cookie was presented but refused', async () => {
    // e.g. staff reissued the link, so the one on this phone is now dead.
    state.cookie = 'stale-token';
    const res = await GET(new Request('http://x'), { params });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('rejected');
  });

  it('returns the patient payload once signed in', async () => {
    state.cookie = 'good-token';
    state.session = {
      portal: { id: 'p1', name: 'Smile Care Dental', greeting: null, allowRecords: true, allowDownloads: true },
      contact: { id: 'c1', orgId: 'o1', name: 'Ravi Kumar', phone: '+919876543210' },
    };
    const res = await GET(new Request('http://x'), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contact.name).toBe('Ravi Kumar');
    // The reason field is a denial-only concern and must not leak into success.
    expect(body.reason).toBeUndefined();
  });
});
