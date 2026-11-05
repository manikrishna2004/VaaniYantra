import { describe, it, expect, vi } from 'vitest';
import {
  validateConfig,
  assertConfigOrThrow,
  reportConfig,
  boolEnv,
  intEnv,
} from '@/lib/config/env';

describe('boolEnv / intEnv', () => {
  it('boolEnv only treats exactly "true" as true', () => {
    expect(boolEnv('true')).toBe(true);
    expect(boolEnv('false')).toBe(false);
    expect(boolEnv('1')).toBe(false);
    expect(boolEnv(undefined)).toBe(false);
  });
  it('intEnv parses positive ints with fallback', () => {
    expect(intEnv('8080', 3000)).toBe(8080);
    expect(intEnv(undefined, 3000)).toBe(3000);
    expect(intEnv('0', 3000)).toBe(3000);
    expect(intEnv('-5', 3000)).toBe(3000);
    expect(intEnv('abc', 3000)).toBe(3000);
  });
});

describe('validateConfig', () => {
  const prodOk = {
    NODE_ENV: 'production',
    SECRET_ENC_KEY: 'a-strong-random-key-value-1234567890',
    DATABASE_URL: 'postgresql://u:p@host:5432/db',
    PUBLIC_BASE_URL: 'https://vaaniyantra.com',
    GEMINI_API_KEY: 'k',
  };

  it('reports no problems for a valid prod config', () => {
    expect(validateConfig(prodOk)).toEqual([]);
  });

  it('refuses META_PASSWORD in every environment', () => {
    // An account password in env is pure liability — no code reads it. The
    // tripwire is error-level in dev too: a laptop leaks a .env as readily as a
    // VM does, so "only fatal in production" would miss where it was written.
    for (const env of [prodOk, { NODE_ENV: 'development' }]) {
      const p = validateConfig({ ...env, META_PASSWORD: 'hunter2' });
      const hit = p.find((x) => x.key === 'META_PASSWORD');
      expect(hit?.level).toBe('error');
    }
  });

  it('says nothing about META_PASSWORD when it is absent', () => {
    expect(validateConfig(prodOk).some((p) => p.key === 'META_PASSWORD')).toBe(false);
  });

  it('makes a set META_PASSWORD fatal via assertConfigOrThrow', () => {
    expect(() => assertConfigOrThrow({ ...prodOk, META_PASSWORD: 'hunter2' })).toThrow(
      /META_PASSWORD/,
    );
  });

  it('flags missing SECRET_ENC_KEY as error in prod', () => {
    const p = validateConfig({ ...prodOk, SECRET_ENC_KEY: undefined });
    expect(p.find((x) => x.key === 'SECRET_ENC_KEY')?.level).toBe('error');
  });

  it('flags missing SECRET_ENC_KEY as only a warn in dev', () => {
    const p = validateConfig({ NODE_ENV: 'development' });
    expect(p.find((x) => x.key === 'SECRET_ENC_KEY')?.level).toBe('warn');
  });

  it('warns on a weak encryption key', () => {
    const p = validateConfig({ ...prodOk, SECRET_ENC_KEY: 'short' });
    expect(p.find((x) => x.key === 'SECRET_ENC_KEY')?.level).toBe('warn');
  });

  it('errors on missing DATABASE_URL and PUBLIC_BASE_URL in prod', () => {
    const p = validateConfig({ ...prodOk, DATABASE_URL: undefined, PUBLIC_BASE_URL: undefined, APP_BASE_URL: undefined });
    expect(p.find((x) => x.key === 'DATABASE_URL')?.level).toBe('error');
    expect(p.find((x) => x.key === 'PUBLIC_BASE_URL')?.level).toBe('error');
  });

  it('warns on SQLite in production', () => {
    const p = validateConfig({ ...prodOk, DATABASE_URL: 'file:./dev.db' });
    expect(p.find((x) => x.key === 'DATABASE_URL' && x.level === 'warn')).toBeTruthy();
  });

  it('accepts APP_BASE_URL as a substitute for PUBLIC_BASE_URL', () => {
    const p = validateConfig({ ...prodOk, PUBLIC_BASE_URL: undefined, APP_BASE_URL: 'https://vaaniyantra.com' });
    expect(p.find((x) => x.key === 'PUBLIC_BASE_URL')).toBeUndefined();
  });
});

describe('assertConfigOrThrow', () => {
  it('throws when an error-level problem exists', () => {
    expect(() => assertConfigOrThrow({ NODE_ENV: 'production' })).toThrow(/Invalid configuration/);
  });
  it('does not throw for a valid config', () => {
    expect(() =>
      assertConfigOrThrow({
        NODE_ENV: 'production',
        SECRET_ENC_KEY: 'a-strong-random-key-value-1234567890',
        DATABASE_URL: 'postgresql://u:p@host/db',
        PUBLIC_BASE_URL: 'https://x.com',
        GEMINI_API_KEY: 'k',
      }),
    ).not.toThrow();
  });
});

describe('reportConfig', () => {
  it('logs errors + warns and returns false when unhealthy', () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const healthy = reportConfig(log, { NODE_ENV: 'production' });
    expect(healthy).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
  it('returns true for a healthy config', () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const healthy = reportConfig(log, {
      NODE_ENV: 'production',
      SECRET_ENC_KEY: 'a-strong-random-key-value-1234567890',
      DATABASE_URL: 'postgresql://u:p@host/db',
      PUBLIC_BASE_URL: 'https://x.com',
      GEMINI_API_KEY: 'k',
    });
    expect(healthy).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });
});
