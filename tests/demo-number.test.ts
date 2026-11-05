import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isDemoNumber } from '@/lib/demo-agent';

// The demo line swaps out the whole agent: isDemoNumber deciding "yes" replaces
// the owner's system prompt with the VaaniYantra sales persona and drops their
// recording-disclosure setting. A false positive therefore hands a real
// customer's caller the wrong bot entirely, silently.
//
// The original test was `n.endsWith(d) || d.endsWith(n)` — an unbounded suffix
// match in both directions. Anything sharing a tail matched.

const ORIGINAL = process.env.DEMO_NUMBER;

function withDemo(value: string | undefined) {
  if (value === undefined) delete process.env.DEMO_NUMBER;
  else process.env.DEMO_NUMBER = value;
}

beforeEach(() => withDemo(undefined));
afterEach(() => withDemo(ORIGINAL));

describe('isDemoNumber', () => {
  it('matches nothing when no demo number is configured', () => {
    expect(isDemoNumber('+16624394745')).toBe(false);
    expect(isDemoNumber('+12722182154')).toBe(false);
  });

  it('matches the configured line regardless of formatting', () => {
    withDemo('+1 662 439 4745');
    expect(isDemoNumber('+16624394745')).toBe(true);
    expect(isDemoNumber('16624394745')).toBe(true);
    expect(isDemoNumber('+1 (662) 439-4745')).toBe(true);
  });

  it('tolerates a stored number that omits the country code', () => {
    withDemo('6624394745');
    expect(isDemoNumber('+16624394745')).toBe(true);
  });

  it('does not capture an unrelated number on the same platform', () => {
    withDemo('+16624394745');
    // The real agent line from the bug report. It must reach its own agent.
    expect(isDemoNumber('+12722182154')).toBe(false);
  });

  it('refuses to match on a short shared tail', () => {
    // The old bidirectional endsWith() would have matched every one of these.
    withDemo('4745');
    expect(isDemoNumber('+16624394745')).toBe(false);
    expect(isDemoNumber('+919346474745')).toBe(false);
    withDemo('745');
    expect(isDemoNumber('+12722182745')).toBe(false);
  });

  it('does not treat a caller-supplied fragment as the whole demo line', () => {
    withDemo('+16624394745');
    expect(isDemoNumber('4745')).toBe(false);
    expect(isDemoNumber('394745')).toBe(false);
  });

  it('ignores blank and missing input', () => {
    withDemo('+16624394745');
    expect(isDemoNumber(null)).toBe(false);
    expect(isDemoNumber(undefined)).toBe(false);
    expect(isDemoNumber('')).toBe(false);
    expect(isDemoNumber('not-a-number')).toBe(false);
  });

  it('separates two Indian numbers that differ only in the middle', () => {
    withDemo('+919346479620');
    expect(isDemoNumber('+919346479620')).toBe(true);
    expect(isDemoNumber('+919346579620')).toBe(false);
  });
});
