import { describe, it, expect, vi, beforeEach } from 'vitest';

// Holding a diagnosis is only real if it holds on EVERY patient-facing path.
// Redaction in listPatientVisits is one of them; the chatbot prompt is the
// other, and the prompt has an extra job — stopping the model working backwards
// from the prescription to the diagnosis the doctor withheld.

const db = vi.hoisted(() => ({ rows: [] as any[] }));

vi.mock('@/lib/db', () => ({
  prisma: {
    visitRecord: { findMany: vi.fn(async () => db.rows) },
    contact: { findUnique: vi.fn(async () => ({ orgId: 'org-A', workspaceId: 'w1' })) },
    organization: { findUnique: vi.fn(async () => ({ patientProvider: 'native', patientProviderConfig: null })) },
  },
}));
vi.mock('@/lib/crypto', () => ({ encryptBytes: (b: Buffer) => b, decryptBytes: (b: Buffer) => b }));
vi.mock('@/lib/adapters/llm', () => ({ getLlmProvider: () => ({}) }));

const { NativePatientProvider } = await import('@/lib/patients/native');
const { formatRecordsBlock } = await import('@/lib/patients');

function visit(over: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    visitedAt: new Date('2026-07-01T00:00:00Z'),
    expertName: 'Dr Mehta',
    service: 'consultation',
    diagnosis: 'Suspected lymphoma — for biopsy',
    prescription: 'Prednisolone 20mg OD',
    advice: 'Rest',
    followUpAt: null,
    diagnosisSharedAt: null,
    documents: [],
    ...over,
  };
}

const provider = new NativePatientProvider('native');

beforeEach(() => {
  db.rows = [];
});

describe('listPatientVisits redaction', () => {
  it('withholds an unreleased diagnosis from the patient', async () => {
    db.rows = [visit()];
    const res = await provider.listPatientVisits('c1');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.visits[0].diagnosis).toBeNull();
    expect(res.visits[0].diagnosisPending).toBe(true);
    // The prescription is NOT withheld — only the diagnosis waits.
    expect(res.visits[0].prescription).toBe('Prednisolone 20mg OD');
  });

  it('shows it once released', async () => {
    db.rows = [visit({ diagnosisSharedAt: new Date('2026-07-02T00:00:00Z') })];
    const res = await provider.listPatientVisits('c1');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.visits[0].diagnosis).toContain('lymphoma');
    expect(res.visits[0].diagnosisPending).toBe(false);
  });

  it('never leaks the raw text on the patient path', async () => {
    db.rows = [visit()];
    const res = await provider.listPatientVisits('c1');
    expect(JSON.stringify(res)).not.toContain('lymphoma');
  });

  it('does not flag a visit that simply has no diagnosis', async () => {
    db.rows = [visit({ diagnosis: null })];
    const res = await provider.listPatientVisits('c1');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.visits[0].diagnosisPending).toBe(false);
  });
});

describe('listStaffVisits', () => {
  it('always shows the diagnosis — the hold is about the patient, not the clinic', async () => {
    db.rows = [visit()];
    const res = await provider.listStaffVisits('c1');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.visits[0].diagnosis).toContain('lymphoma');
    expect(res.visits[0].diagnosisPending).toBe(true);
  });
});

describe('formatRecordsBlock', () => {
  it('tells the model not to infer a held diagnosis from the medicines', async () => {
    db.rows = [visit()];
    const res = await provider.listPatientVisits('c1');
    const block = formatRecordsBlock(res);
    expect(block).not.toContain('lymphoma');
    expect(block).toContain('NOT YET RELEASED');
    expect(block).toContain('Do NOT infer or guess a diagnosis from the medicines');
  });

  it('prints a released diagnosis normally', async () => {
    db.rows = [visit({ diagnosisSharedAt: new Date() })];
    const res = await provider.listPatientVisits('c1');
    const block = formatRecordsBlock(res);
    expect(block).toContain('Diagnosis: Suspected lymphoma');
    expect(block).not.toContain('NOT YET RELEASED');
  });
});
