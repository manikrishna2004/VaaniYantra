import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sign-up verification codes. These are the whole front door to a clinic's
// dashboard, so the limits are pinned down here — and note they live in the
// DATABASE, because the in-process rate limiter resets on every deploy and
// would otherwise hand an attacker a fresh guessing budget for free.

type Row = {
  id: string;
  uid: string;
  email: string;
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
    emailOtp: {
      findFirst: vi.fn(async (a: any) => {
        const w = a.where;
        return (
          db.rows
            .filter((r) => r.uid === w.uid && (w.consumedAt === null ? r.consumedAt === null : true))
            .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0] ?? null
        );
      }),
      count: vi.fn(async (a: any) => {
        const since = a.where.createdAt?.gte as Date | undefined;
        return db.rows.filter((r) => r.uid === a.where.uid && (!since || r.createdAt >= since)).length;
      }),
      create: vi.fn(async (a: any) => {
        const row: Row = {
          id: `e${++db.seq}`,
          attempts: 0,
          consumedAt: null,
          createdAt: a.data.lastSentAt ?? new Date(),
          ...a.data,
        };
        db.rows.push(row);
        return row;
      }),
      update: vi.fn(async (a: any) => {
        const row = db.rows.find((r) => r.id === a.where.id)!;
        if (a.data.attempts?.increment) row.attempts += a.data.attempts.increment;
        if (a.data.consumedAt !== undefined) row.consumedAt = a.data.consumedAt;
        return row;
      }),
      deleteMany: vi.fn(async (a: any) => {
        const before = db.rows.length;
        const now = a.where.OR[0].expiresAt.lt as Date;
        db.rows = db.rows.filter((r) => !(r.expiresAt < now || r.consumedAt !== null));
        return { count: before - db.rows.length };
      }),
    },
  },
}));

import {
  startEmailOtp,
  verifyEmailOtp,
  purgeExpiredEmailOtps,
  hashCode,
  generateCode,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_MAX_PER_HOUR,
  EMAIL_OTP_RESEND_COOLDOWN_MS,
  EMAIL_OTP_TTL_MS,
} from '@/lib/auth/email-otp';

const UID = 'firebase-uid-1';
const EMAIL = 'doctor@clinic.com';

beforeEach(() => {
  db.rows = [];
  db.seq = 0;
});

describe('code generation', () => {
  it('is always six digits', () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });
});

describe('hashing', () => {
  it('binds the code to the account, so a row cannot be replayed elsewhere', () => {
    const a = hashCode('123456', UID, EMAIL);
    expect(hashCode('123456', 'other-uid', EMAIL)).not.toBe(a);
    expect(hashCode('123456', UID, 'someone@else.com')).not.toBe(a);
    expect(hashCode('654321', UID, EMAIL)).not.toBe(a);
  });

  it('ignores the case of the address', () => {
    expect(hashCode('123456', UID, 'Doctor@Clinic.com')).toBe(hashCode('123456', UID, EMAIL));
  });

  it('never stores the code itself', async () => {
    const started = await startEmailOtp({ uid: UID, email: EMAIL });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(db.rows[0].codeHash).not.toContain(started.code);
  });
});

describe('start', () => {
  it('refuses a second code inside the cooldown', async () => {
    const now = new Date();
    expect((await startEmailOtp({ uid: UID, email: EMAIL, now })).ok).toBe(true);

    const soon = new Date(now.getTime() + EMAIL_OTP_RESEND_COOLDOWN_MS - 1000);
    const second = await startEmailOtp({ uid: UID, email: EMAIL, now: soon });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.retryAfterSec).toBeGreaterThan(0);
  });

  it('allows a resend once the cooldown passes', async () => {
    const now = new Date();
    await startEmailOtp({ uid: UID, email: EMAIL, now });
    const later = new Date(now.getTime() + EMAIL_OTP_RESEND_COOLDOWN_MS + 1000);
    expect((await startEmailOtp({ uid: UID, email: EMAIL, now: later })).ok).toBe(true);
  });

  it('caps codes per hour, so we cannot be turned into a mailbomb', async () => {
    let t = Date.now();
    for (let i = 0; i < EMAIL_OTP_MAX_PER_HOUR; i++) {
      expect((await startEmailOtp({ uid: UID, email: EMAIL, now: new Date(t) })).ok).toBe(true);
      t += EMAIL_OTP_RESEND_COOLDOWN_MS + 1000;
    }
    const over = await startEmailOtp({ uid: UID, email: EMAIL, now: new Date(t) });
    expect(over.ok).toBe(false);
  });
});

describe('verify', () => {
  async function issue(now = new Date()) {
    const started = await startEmailOtp({ uid: UID, email: EMAIL, now });
    if (!started.ok) throw new Error('expected a code');
    return started.code;
  }

  it('accepts the right code', async () => {
    const code = await issue();
    expect(await verifyEmailOtp({ uid: UID, email: EMAIL, code })).toEqual({ ok: true });
  });

  it('consumes the code, so it is good exactly once', async () => {
    const code = await issue();
    await verifyEmailOtp({ uid: UID, email: EMAIL, code });
    const replay = await verifyEmailOtp({ uid: UID, email: EMAIL, code });
    expect(replay).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a code issued for a different account', async () => {
    const code = await issue();
    expect(await verifyEmailOtp({ uid: 'someone-else', email: EMAIL, code })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects an expired code', async () => {
    const now = new Date();
    const code = await issue(now);
    const late = new Date(now.getTime() + EMAIL_OTP_TTL_MS + 1000);
    expect(await verifyEmailOtp({ uid: UID, email: EMAIL, code, now: late })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('burns the code after too many wrong guesses', async () => {
    const code = await issue();
    for (let i = 0; i < EMAIL_OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyEmailOtp({ uid: UID, email: EMAIL, code: '000000' })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    // Even the CORRECT code is refused now — the budget is spent, and it is
    // counted in the database so a restart does not refill it.
    expect(await verifyEmailOtp({ uid: UID, email: EMAIL, code })).toEqual({
      ok: false,
      reason: 'too_many',
    });
  });
});

describe('purge', () => {
  it('drops spent and expired codes', async () => {
    const now = new Date();
    const code = await issueFor(now);
    await verifyEmailOtp({ uid: UID, email: EMAIL, code });
    await startEmailOtp({
      uid: 'uid-2',
      email: 'b@c.com',
      now: new Date(now.getTime() - EMAIL_OTP_TTL_MS - 1000),
    });

    const removed = await purgeExpiredEmailOtps(now);
    expect(removed).toBe(2);
    expect(db.rows).toHaveLength(0);
  });

  async function issueFor(now: Date) {
    const started = await startEmailOtp({ uid: UID, email: EMAIL, now });
    if (!started.ok) throw new Error('expected a code');
    return started.code;
  }
});
