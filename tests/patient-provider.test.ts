import { describe, it, expect, vi, beforeEach } from 'vitest';

// The seam that lets one chatbot sit on top of either our records or the
// clinic's own. What matters here is that capability differences are real —
// a provider that says it can't write must actually refuse — and that a
// failure to read is never dressed up as an empty history.

const state = vi.hoisted(() => ({
  org: { patientProvider: 'native', patientProviderConfig: null } as any,
  visitRows: [] as any[],
  throwOnFind: false,
  created: [] as any[],
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    organization: { findUnique: vi.fn(async () => state.org) },
    contact: { findUnique: vi.fn(async () => ({ orgId: 'o1', workspaceId: 'w1' })) },
    visitRecord: {
      findMany: vi.fn(async () => {
        if (state.throwOnFind) throw new Error('connection refused');
        return state.visitRows;
      }),
      create: vi.fn(async ({ data }: any) => {
        state.created.push(data);
        return { id: 'visit_new' };
      }),
    },
    visitDocument: { findFirst: vi.fn(async () => null) },
  },
}));

import { getPatientProvider, clearPatientProviderCache } from '@/lib/patients';

describe('provider resolution', () => {
  beforeEach(() => {
    clearPatientProviderCache();
    state.org = { patientProvider: 'native', patientProviderConfig: null };
    state.visitRows = [];
    state.throwOnFind = false;
    state.created = [];
  });

  it('defaults to native — we are the system of record', async () => {
    const p = await getPatientProvider('o1');
    expect(p.kind).toBe('native');
    expect(p.capabilities.canWriteRecords).toBe(true);
    expect(p.capabilities.systemOfRecord).toBe('VaaniYantra');
  });

  it('closes our write surface when the clinic owns the records', async () => {
    state.org = { patientProvider: 'push', patientProviderConfig: { systemName: 'Practo Ray' } };
    const p = await getPatientProvider('o1');
    expect(p.kind).toBe('push');
    expect(p.capabilities.canWriteRecords).toBe(false);
    expect(p.capabilities.canWriteDocuments).toBe(false);
    // Named, so the staff screen can say where to go instead.
    expect(p.capabilities.systemOfRecord).toBe('Practo Ray');
  });

  it('keeps appointment writes ours even when integrated', async () => {
    // Booking is driven by our calendar and Appointment table; an integrated
    // clinic receives bookings as write-back events rather than losing them.
    state.org = { patientProvider: 'push', patientProviderConfig: null };
    const p = await getPatientProvider('o1');
    expect(p.capabilities.canWriteAppointments).toBe(true);
  });

  it('still reads records in push mode — the mirror is the read path', async () => {
    state.org = { patientProvider: 'push', patientProviderConfig: null };
    state.visitRows = [{ id: 'v1', documents: [] }];
    const p = await getPatientProvider('o1');
    const res = await p.listPatientVisits('c1');
    expect(res.status).toBe('ok');
  });

  it('refuses a write it declared it cannot do', async () => {
    state.org = { patientProvider: 'push', patientProviderConfig: { systemName: 'Halemind' } };
    const p = await getPatientProvider('o1');
    const res = await p.createVisit('c1', { prescription: 'Amoxicillin 500mg' });
    expect('error' in res).toBe(true);
    expect((res as { error: string }).error).toContain('Halemind');
    // And nothing was written.
    expect(state.created).toHaveLength(0);
  });

  it('falls back to a working mode when the provider is unimplemented', async () => {
    // An org mis-set to "fhir" must degrade to showing what it has, not 500 on
    // every patient screen.
    state.org = { patientProvider: 'fhir', patientProviderConfig: null };
    const p = await getPatientProvider('o1');
    expect(p.capabilities.canWriteRecords).toBe(false);
    await expect(p.listPatientVisits('c1')).resolves.toBeTruthy();
  });

  it('falls back to native when the org row cannot be read', async () => {
    state.org = null;
    const p = await getPatientProvider('o1');
    expect(p.kind).toBe('native');
  });

  it('honours a provider switch once the cache is cleared', async () => {
    expect((await getPatientProvider('o1')).kind).toBe('native');
    state.org = { patientProvider: 'push', patientProviderConfig: null };
    // Still cached — a switch must not silently take 30s to apply, which is why
    // the admin route clears this explicitly.
    expect((await getPatientProvider('o1')).kind).toBe('native');
    clearPatientProviderCache('o1');
    expect((await getPatientProvider('o1')).kind).toBe('push');
  });
});

describe('read failures are never reported as "no records"', () => {
  beforeEach(() => {
    clearPatientProviderCache();
    state.org = { patientProvider: 'native', patientProviderConfig: null };
    state.throwOnFind = true;
  });

  it('returns unavailable, not empty, when the store errors', async () => {
    const p = await getPatientProvider('o1');
    const res = await p.listPatientVisits('c1');
    expect(res.status).toBe('unavailable');
  });

  it('does the same for the staff view', async () => {
    const p = await getPatientProvider('o1');
    const res = await p.listStaffVisits('c1');
    expect(res.status).toBe('unavailable');
  });

  it('distinguishes a genuinely empty history', async () => {
    state.throwOnFind = false;
    state.visitRows = [];
    const p = await getPatientProvider('o1');
    expect((await p.listPatientVisits('c1')).status).toBe('empty');
  });
});

describe('native writes', () => {
  beforeEach(() => {
    clearPatientProviderCache();
    state.org = { patientProvider: 'native', patientProviderConfig: null };
    state.created = [];
    state.throwOnFind = false;
  });

  it('stamps the source so staff UI knows who owns the record', async () => {
    const p = await getPatientProvider('o1');
    await p.createVisit('c1', { prescription: 'Amoxicillin 500mg' });
    expect(state.created[0].source).toBe('native');
  });

  it('shares with the patient by default — filing a record is the point', async () => {
    const p = await getPatientProvider('o1');
    await p.createVisit('c1', { prescription: 'x' });
    expect(state.created[0].sharedWithContact).toBe(true);
  });

  it('lets staff hold a record back explicitly', async () => {
    const p = await getPatientProvider('o1');
    await p.createVisit('c1', { prescription: 'x', sharedWithContact: false });
    expect(state.created[0].sharedWithContact).toBe(false);
  });
});
