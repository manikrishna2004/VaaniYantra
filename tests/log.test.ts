import { describe, it, expect, vi } from 'vitest';
import { redact, createLogger } from '@/lib/log';

describe('redact', () => {
  it('masks values under secret-like keys', () => {
    const out = redact({ authToken: 'abc123', apiKey: 'xyz', name: 'Ramya' }) as Record<string, unknown>;
    expect(out.authToken).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.name).toBe('Ramya');
  });

  it('masks nested secrets and arrays', () => {
    const out = redact({ a: { password: 'p' }, list: [{ secret: 's' }, 'ok'] }) as any;
    expect(out.a.password).toBe('[redacted]');
    expect(out.list[0].secret).toBe('[redacted]');
    expect(out.list[1]).toBe('ok');
  });

  it('masks token-shaped values even under innocuous keys', () => {
    const out = redact({ note: 'call used Bearer EAAbiMKLwmeoBSCCZANZCxidXkt82vt' }) as any;
    expect(out.note).toContain('[redacted]');
    expect(out.note).not.toContain('EAAbiMKLwmeo');
  });

  it('handles circular references safely', () => {
    const a: any = { name: 'x' };
    a.self = a;
    const out = redact(a) as any;
    expect(out.name).toBe('x');
    expect(out.self).toBe('[circular]');
  });
});

describe('createLogger', () => {
  it('respects the LOG_LEVEL threshold', () => {
    const lines: string[] = [];
    const log = createLogger({}, { env: { LOG_LEVEL: 'warn' }, sink: (_l, line) => lines.push(line) });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(2);
    expect(lines.join()).toContain('"msg":"w"');
    expect(lines.join()).toContain('"msg":"e"');
  });

  it('emits structured JSON with level, msg, timestamp', () => {
    const lines: string[] = [];
    const log = createLogger({}, { env: { LOG_LEVEL: 'debug' }, sink: (_l, line) => lines.push(line) });
    log.info('hello', { callId: 'c1' });
    const rec = JSON.parse(lines[0]);
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.callId).toBe('c1');
    expect(typeof rec.t).toBe('string');
  });

  it('redacts context and merges child context', () => {
    const lines: string[] = [];
    const log = createLogger({ provider: 'plivo' }, { env: { LOG_LEVEL: 'debug' }, sink: (_l, line) => lines.push(line) });
    const child = log.child({ callId: 'c9' });
    child.error('send failed', { token: 'super-secret' });
    const rec = JSON.parse(lines[0]);
    expect(rec.provider).toBe('plivo');
    expect(rec.callId).toBe('c9');
    expect(rec.token).toBe('[redacted]');
  });
});
