import { describe, it, expect } from 'vitest';
import { toE164 } from '@/lib/phone';

describe('toE164', () => {
  it('passes through valid E.164', () => {
    expect(toE164('+919876543210')).toBe('+919876543210');
    expect(toE164('+14155550100')).toBe('+14155550100');
  });

  it('strips whatsapp: prefix', () => {
    expect(toE164('whatsapp:+919876543210')).toBe('+919876543210');
  });

  it('assumes +91 for bare 10-digit Indian mobiles', () => {
    expect(toE164('9346012345')).toBe('+919346012345');
    expect(toE164('09346012345')).toBe('+919346012345');
  });

  it('keeps other digit strings with a plus', () => {
    expect(toE164('14155550100')).toBe('+14155550100');
  });

  it('rejects garbage', () => {
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164('12345')).toBeNull();
    expect(toE164('1234567890123456')).toBeNull();
  });
});
