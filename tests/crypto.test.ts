import { describe, it, expect, afterEach, vi } from 'vitest';

// crypto.ts derives its key at module load, so each scenario needs a fresh
// module registry with the env staged first.

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('crypto secrets-at-rest', () => {
  it('round-trips a secret', async () => {
    process.env.SECRET_ENC_KEY = 'test-key-for-unit-tests';
    vi.resetModules();
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto');
    const cipher = encryptSecret('twilio-token-123');
    expect(cipher).not.toContain('twilio-token-123');
    expect(decryptSecret(cipher)).toBe('twilio-token-123');
  });

  it('throws on first use in production without SECRET_ENC_KEY', async () => {
    delete process.env.SECRET_ENC_KEY;
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    // Importing stays safe (next build collects page data without secrets)…
    const { encryptSecret } = await import('@/lib/crypto');
    // …but actually touching a secret must hard-fail.
    expect(() => encryptSecret('x')).toThrow(/SECRET_ENC_KEY/);
  });

  it('falls back to the dev key outside production', async () => {
    delete process.env.SECRET_ENC_KEY;
    vi.stubEnv('NODE_ENV', 'test');
    vi.resetModules();
    const { encryptSecret, decryptSecret } = await import('@/lib/crypto');
    expect(decryptSecret(encryptSecret('x'))).toBe('x');
  });
});
