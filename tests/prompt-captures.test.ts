import { describe, it, expect } from 'vitest';
import { captureClause, practiceClause, composeSystemInstruction, type PromptParts } from '@/lib/voice/prompt';

// Regression guard for the "it never asked my name" bug.
//
// The details an owner ticks in "Messages & Alerts" (outcomeConfig.captures)
// used to reach the model in exactly one place: as parameters on the
// record_outcome tool. src/lib/connectors/tools.ts suppresses that tool whenever
// booking is active, so any agent with bookings switched on was never told to
// collect anything — the configured fields simply never reached the call.
//
// captureClause puts them in the spoken instruction instead, where they survive
// whichever tool set ends up registered.

function parts(overrides: Partial<PromptParts> = {}): PromptParts {
  return {
    basePrompt: null,
    corePrompt: 'You are Ramya, the receptionist for Sunrise Clinic.',
    knowledge: '',
    languageMode: 'hybrid',
    language: 'te-IN',
    fallbackMessage: null,
    callGuidance: 'This is a live phone call. Speak in short, natural, spoken sentences.',
    greeting: 'Namaskaram, Sunrise Clinic.',
    ...overrides,
  };
}

describe('captureClause', () => {
  it('is empty when nothing is configured', () => {
    expect(captureClause(undefined)).toBe('');
    expect(captureClause([])).toBe('');
  });

  it('names required fields and marks them as always asked', () => {
    const s = captureClause([{ key: 'name', label: 'Full name', required: true }]);
    expect(s).toContain('DETAILS TO COLLECT');
    expect(s).toContain('Full name');
    expect(s).toContain('always ask');
  });

  it('separates optional fields from required ones', () => {
    const s = captureClause([
      { key: 'name', label: 'Full name', required: true },
      { key: 'reason', label: 'Reason for visit' },
    ]);
    expect(s).toMatch(/Full name \(always ask\)/);
    expect(s).toMatch(/Reason for visit \(ask if it comes up naturally\)/);
  });

  it('handles an all-optional list without dangling punctuation', () => {
    const s = captureClause([{ key: 'reason', label: 'Reason for visit' }]);
    expect(s).toContain('Reason for visit');
    expect(s).not.toContain('always ask');
    expect(s).not.toContain('; .');
  });

  it('ignores entries with a blank key or label', () => {
    const s = captureClause([
      { key: '', label: 'Ghost', required: true },
      { key: 'blank', label: '   ' },
      { key: 'name', label: 'Full name', required: true },
    ]);
    expect(s).not.toContain('Ghost');
    expect(s).toContain('Full name');
  });

  it('never tells the agent to guess a value it was not given', () => {
    const s = captureClause([{ key: 'name', label: 'Full name', required: true }]);
    expect(s).toContain('Never invent or assume a value');
  });
});

// The practice type drove templates, outcome tagging and a UI label, but never
// reached the model — so picking "Dental Clinic" changed nothing about how the
// agent actually spoke on a call.
describe('practiceClause', () => {
  it('is empty when no practice type is set', () => {
    expect(practiceClause(null)).toBe('');
    expect(practiceClause('')).toBe('');
    expect(practiceClause(undefined)).toBe('');
  });

  it('names the practice type in words the model can use', () => {
    expect(practiceClause('dental')).toContain('Dental Clinic');
    expect(practiceClause('hospital')).toContain('Hospital / Multi-speciality');
  });

  it('prefers the owner-written label when the type is "other"', () => {
    expect(practiceClause('other', 'Veterinary clinic')).toContain('Veterinary clinic');
  });

  it('falls back to the generic label when "other" has no custom text', () => {
    expect(practiceClause('other', '   ')).toContain('Other healthcare provider');
  });

  it('still resolves a retired practice type a live agent may carry', () => {
    expect(practiceClause('salon')).toContain('Salon / Spa');
  });

  it('reaches the composed instruction', () => {
    const text = composeSystemInstruction({
      basePrompt: null,
      corePrompt: 'You are Ramya.',
      knowledge: '',
      languageMode: 'hybrid',
      language: 'te-IN',
      fallbackMessage: null,
      callGuidance: 'This is a live phone call.',
      greeting: 'Namaskaram.',
      agentType: 'dental',
    });
    expect(text).toContain('WHERE YOU WORK');
    expect(text).toContain('Dental Clinic');
  });
});

describe('composeSystemInstruction', () => {
  it('carries the configured captures into the instruction the model receives', () => {
    const text = composeSystemInstruction(
      parts({ captures: [{ key: 'name', label: 'Full name', required: true }] }),
    );
    expect(text).toContain('DETAILS TO COLLECT');
    expect(text).toContain('Full name');
  });

  it('adds nothing when the agent has no captures configured', () => {
    expect(composeSystemInstruction(parts())).not.toContain('DETAILS TO COLLECT');
  });

  it('keeps the agent prompt and the greeting intact alongside the clause', () => {
    const text = composeSystemInstruction(
      parts({ captures: [{ key: 'name', label: 'Full name', required: true }] }),
    );
    expect(text).toContain('You are Ramya, the receptionist for Sunrise Clinic.');
    expect(text).toContain('Namaskaram, Sunrise Clinic.');
  });

  it('states the ask before the end-call rule, so hanging up cannot pre-empt it', () => {
    const text = composeSystemInstruction(
      parts({
        captures: [{ key: 'name', label: 'Full name', required: true }],
        endCallInstructions: 'the caller says goodbye',
      }),
    );
    expect(text.indexOf('DETAILS TO COLLECT')).toBeLessThan(text.indexOf('End the call when'));
  });
});
