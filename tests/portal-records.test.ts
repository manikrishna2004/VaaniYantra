import { describe, it, expect } from 'vitest';
import { formatRecordsBlock } from '@/lib/patients';
import type { PatientVisit, VisitsResult } from '@/lib/patients/types';
import { encryptBytes, decryptBytes } from '@/lib/crypto';

// The records block is the entire basis for what the chatbot tells a patient
// about their own treatment, so what does and does not appear in it matters
// more than anything else in the portal.

function visit(over: Partial<PatientVisit> = {}): PatientVisit {
  return {
    id: 'v1',
    visitedAt: new Date('2026-07-14T09:30:00Z'),
    expertName: 'Dr. Rao',
    service: 'Root canal',
    diagnosis: 'Irreversible pulpitis, 36',
    prescription: 'Amoxicillin 500mg — 1-0-1, 5 days',
    advice: 'Warm salt rinse twice a day',
    followUpAt: null,
    documents: [],
    ...over,
  };
}

/** The formatter takes a result now, so the three outcomes stay distinguishable. */
const ok = (visits: PatientVisit[]): VisitsResult => ({ status: 'ok', visits });

describe('formatRecordsBlock', () => {
  it('includes the clinical detail the patient asks about', () => {
    const block = formatRecordsBlock(ok([visit()]), 'Asia/Kolkata');
    expect(block).toContain('Amoxicillin 500mg — 1-0-1, 5 days');
    expect(block).toContain('Dr. Rao');
    expect(block).toContain('Irreversible pulpitis');
    expect(block).toContain('Warm salt rinse');
  });

  it('renders dates in the clinic timezone, not UTC', () => {
    // 09:30 UTC is already the 14th in Kolkata; a naive UTC render of a late
    // evening IST visit would show the patient the wrong day.
    const block = formatRecordsBlock(ok([visit({ visitedAt: new Date('2026-07-14T20:00:00Z') })]), 'Asia/Kolkata');
    expect(block).toContain('15 Jul 2026');
  });

  it('tells the model where attachments live rather than inventing content', () => {
    const block = formatRecordsBlock(
      ok([visit({ documents: [{ id: 'd1', name: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: 100 }] })]),
      'Asia/Kolkata',
    );
    expect(block).toContain('scan.pdf');
    expect(block).toContain('Records tab');
  });

  it('says so explicitly when there is no history', () => {
    // An empty block would leave the model free to improvise a prescription.
    expect(formatRecordsBlock({ status: 'empty' })).toContain('No visit records');
  });

  it('is bounded so one chatty patient cannot blow the context window', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      visit({ id: `v${i}`, prescription: 'x'.repeat(500) }),
    );
    expect(formatRecordsBlock(ok(many)).length).toBeLessThan(6200);
  });
});

describe('formatRecordsBlock — unavailable is not empty', () => {
  // The whole point of the seam: once records can come from a clinic's own
  // system, a timeout must never be presented to the model as "this patient
  // has nothing prescribed". That answer would be confidently wrong about
  // someone's medication.
  const block = formatRecordsBlock({ status: 'unavailable', reason: 'upstream timeout' });

  it('marks the records as unavailable', () => {
    expect(block).toContain('UNAVAILABLE');
  });

  it('never claims the patient has no records', () => {
    expect(block).not.toContain('No visit records');
    expect(block).toMatch(/Do NOT say they have no records/i);
  });

  it('tells the model not to guess a prescription', () => {
    expect(block).toMatch(/do not guess/i);
  });

  it('is visibly different from the empty case', () => {
    expect(block).not.toBe(formatRecordsBlock({ status: 'empty' }));
  });
});

describe('binary secret encryption', () => {
  it('round-trips a file', () => {
    const plain = Buffer.from('%PDF-1.7\nprescription bytes\x00\xff');
    expect(decryptBytes(encryptBytes(plain)).equals(plain)).toBe(true);
  });

  it('produces different ciphertext each time (fresh IV)', () => {
    const plain = Buffer.from('same input');
    expect(encryptBytes(plain).equals(encryptBytes(plain))).toBe(false);
  });

  it('refuses tampered ciphertext instead of returning garbage', () => {
    const enc = encryptBytes(Buffer.from('prescription'));
    enc[enc.length - 1] ^= 0xff;
    expect(() => decryptBytes(enc)).toThrow();
  });

  it('rejects a truncated blob', () => {
    expect(() => decryptBytes(Buffer.alloc(4))).toThrow(/malformed/);
  });
});

describe('formatRecordsBlock — structured medicines', () => {
  it('gives the model the structured lines and DROPS the free text', () => {
    // The whole safety argument for structured prescriptions: the chatbot must
    // never see two versions of a script and pick one.
    const block = formatRecordsBlock(
      ok([
        visit({
          prescription: 'amox 500 TDS x 7 days',
          items: [{ drug: 'Amoxicillin', strength: '500 mg', frequency: 'bd', durationDays: 5 }],
        }),
      ]),
      'Asia/Kolkata',
    );
    expect(block).toContain('Amoxicillin 500 mg');
    expect(block).toContain('twice a day (BD)');
    expect(block).toContain('for 5 days');
    expect(block).not.toContain('TDS');
    expect(block).not.toContain('7 days');
  });

  it('instructs the model not to alter a dose', () => {
    const block = formatRecordsBlock(ok([visit({ items: [{ drug: 'Metformin', frequency: 'bd' }] })]));
    expect(block).toMatch(/exactly as written/i);
    expect(block).toMatch(/Do NOT change a dose/i);
  });

  it('still shows legacy free text when a visit has no structured items', () => {
    const block = formatRecordsBlock(ok([visit({ items: [] })]), 'Asia/Kolkata');
    expect(block).toContain('Amoxicillin 500mg — 1-0-1, 5 days');
  });

  it('keeps the diagnosis hold intact alongside structured medicines', () => {
    // A held diagnosis plus a visible drug list is the exact combination that
    // invites the model to reason backwards from the medicine.
    const block = formatRecordsBlock(
      ok([
        visit({
          diagnosis: null,
          diagnosisPending: true,
          items: [{ drug: 'Amoxicillin', strength: '500 mg', frequency: 'bd' }],
        }),
      ]),
    );
    expect(block).toContain('NOT YET RELEASED');
    expect(block).toMatch(/Do NOT infer or guess a diagnosis from the medicines/i);
    expect(block).toContain('Amoxicillin 500 mg');
  });
});
