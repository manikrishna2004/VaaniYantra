import { describe, it, expect } from 'vitest';
import { agentInputSchema } from '@/lib/validation';

// P1-6: owner alert numbers are validated + normalized to E.164 so alerts
// can't silently vanish to a typo.

function agentWithOwnerNumbers(ownerNumbers: string[]) {
  return {
    name: 'A',
    systemPrompt: 'x',
    language: 'en-IN',
    voice: 'v',
    direction: 'BOTH',
    outcomeConfig: { ownerNumbers },
  };
}

describe('agentInputSchema ownerNumbers', () => {
  it('accepts and normalizes valid numbers', () => {
    const parsed = agentInputSchema.safeParse(agentWithOwnerNumbers(['+919876543210', '9346012345']));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.outcomeConfig?.ownerNumbers).toEqual(['+919876543210', '+919346012345']);
    }
  });

  it('rejects garbage entries', () => {
    const parsed = agentInputSchema.safeParse(agentWithOwnerNumbers(['not-a-number']));
    expect(parsed.success).toBe(false);
  });

  it('rejects too-short numbers', () => {
    const parsed = agentInputSchema.safeParse(agentWithOwnerNumbers(['12345']));
    expect(parsed.success).toBe(false);
  });

  it('accepts an empty list', () => {
    const parsed = agentInputSchema.safeParse(agentWithOwnerNumbers([]));
    expect(parsed.success).toBe(true);
  });
});
