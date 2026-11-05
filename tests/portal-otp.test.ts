import { describe, it, expect, vi, beforeEach } from 'vitest';

// One-time codes are the whole front door to a patient's medical records, so
// the limits are pinned down here. Note especially that they live in the
// DATABASE — the in-process rate limiter resets on every deploy, which would
// hand an attacker a fresh budget for free.

type Row = {
  id: string;
  portalId: string;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  lastSentAt: Date;
  createdAt: Date;
};

const db = vi.hoisted(() => ({ rows: [] as Row[], seq: 0 }));

vi.mock('@/lib/db', () => ({
  prisma: {
    portalOtp: {
      findFirst: vi.fn(async (a: any) => {
        const w = a.where;
        const found = db.rows
          .filter(
            (r) =>
              r.portalId === w.portalId &&
              r.phone === w.phone &&
              (w.consumedAt === null ? r.consumedAt === null : true),
          )
          .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
        return found[0] ?? null;
      }),
      count: vi.fn(async (a: any) => {
        const since = a.where.createdAt?.gte as Date | undefined;
        return db.rows.filter(
          (r) => r.portalId === a.where.portalId && r.phone === a.where.phone && (!since || r.createdAt >= since),
        ).length;
      }),
      create: vi.fn(async (a: any) => {
        const row: Row = { id: `o${++db.seq}`, attempts: 0, consumedAt: null, createdAt: new Date(), ...a.data };
        db.rows.push(row);
        return row;
      }),
      update: vi.fn(async (a: any) => {
        const row = db.rows.find((r) => r.id === a.where.id)!;
        if (a.data.attempts?.increment) row.attempts += a.data.attempts.increment;
        if (a.data.consumedAt) row.consumedAt = a.data.consumedAt;
        return row;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

const { startOtp, verifyOtp, generateCode, hashCode, OTP_MAX_ATTEMPTS } = await import('@/lib/portal/otp');

const ARGS = { portalId: 'p1', orgId: 'org-A', phone: '+919876543210' };

beforeEach(() => {
  db.rows = [];
  db.seq = 0;
});

describe('generateCode', () => {
  it('is always six digits, including when the value is small', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });
});

describe('hashCode', () => {
  it('does not store the code itself', () => {
    const hash = hashCode('123456', ARGS.phone, ARGS.portalId);
    expect(hash).not.toContain('123456');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds the code to the phone and the clinic', () => {
    // So a row lifted from one clinic's database can't be replayed at another.
    const base = hashCode('123456', ARGS.phone, ARGS.portalId);
    expect(hashCode('123456', '+919999999999', ARGS.portalId)).not.toBe(base);
    expect(hashCode('123456', ARGS.phone, 'other-portal')).not.toBe(base);
  });
});

describe('startOtp', () => {
  it('issues a code', async () => {
    const res = await startOtp(ARGS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.code).toMatch(/^\d{6}$/);
  });

  it('refuses a second code inside the cooldown', async () => {
    await startOtp(ARGS);
    const again = await startOtp(ARGS);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.retryAfterSec).toBeGreaterThan(0);
  });

  it('caps codes per hour even once the cooldown has passed', async () => {
    const t0 = Date.now();
    // Space them past the 60s cooldown each time.
    for (let i = 0; i < 5; i++) {
      const res = await startOtp({ ...ARGS, now: new Date(t0 + i * 120_000) });
      expect(res.ok).toBe(true);
    }
    const sixth = await startOtp({ ...ARGS, now: new Date(t0 + 5 * 120_000) });
    expect(sixth.ok).toBe(false);
  });

  it('writes a row even for a number with no patient record', async () => {
    // startOtp knows nothing about patients on purpose: the row exists either
    // way so /otp/verify does identical work and cannot be used to discover who
    // is a patient at this clinic.
    const res = await startOtp({ ...ARGS, phone: '+910000000000' });
    expect(res.ok).toBe(true);
    expect(db.rows).toHaveLength(1);
  });
});

describe('verifyOtp', () => {
  async function issue(now = new Date()) {
    const res = await startOtp({ ...ARGS, now });
    if (!res.ok) throw new Error('expected a code');
    return res.code!;
  }

  it('accepts the right code, and returns the row for household selection', async () => {
    const code = await issue();
    const res = await verifyOtp({ ...ARGS, code });
    expect(res.ok).toBe(true);
    // The id lets the caller hang a selection token on this exact code when the
    // number turns out to belong to more than one patient.
    if (res.ok) expect(res.otpId).toBeTruthy();
  });

  it('rejects the wrong code', async () => {
    await issue();
    const res = await verifyOtp({ ...ARGS, code: '000000' });
    expect(res.ok).toBe(false);
  });

  it('cannot be used twice', async () => {
    const code = await issue();
    expect((await verifyOtp({ ...ARGS, code })).ok).toBe(true);
    expect((await verifyOtp({ ...ARGS, code })).ok).toBe(false);
  });

  it('expires', async () => {
    const t0 = new Date();
    const code = await issue(t0);
    const later = new Date(t0.getTime() + 6 * 60_000);
    const res = await verifyOtp({ ...ARGS, code, now: later });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('burns the code after too many wrong guesses — even with the right one', async () => {
    const code = await issue();
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await verifyOtp({ ...ARGS, code: '000000' });
    }
    // The real code is now worthless: 10^6 guesses are not available.
    const res = await verifyOtp({ ...ARGS, code });
    expect(res).toEqual({ ok: false, reason: 'too_many' });
  });

  it('counts attempts in the database, so a restart does not reset them', async () => {
    const code = await issue();
    await verifyOtp({ ...ARGS, code: '000000' });
    await verifyOtp({ ...ARGS, code: '111111' });
    // Persisted on the row, not in process memory.
    expect(db.rows[0].attempts).toBe(2);
  });

  it('rejects a code from a different clinic', async () => {
    const code = await issue();
    const res = await verifyOtp({ portalId: 'other-portal', phone: ARGS.phone, code });
    expect(res.ok).toBe(false);
  });
});
