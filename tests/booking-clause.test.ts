import { describe, it, expect } from 'vitest';
import { bookingClause, composeSystemInstruction, type PromptParts } from '@/lib/voice/prompt';

// The appointment-booking guidance is the largest single block a booking agent
// carries, and the system instruction sits OUTSIDE the context-window
// compression — so every character here is re-sent and re-billed on every turn
// of the call. It used to be appended by live.ts after the composer had run,
// which is also why it never showed up in the admin "exact prompt" preview.
//
// Two things are pinned here. The concise form has to stay short, or the saving
// evaporates. The long form has to stay byte-for-byte what it was, because an
// agent pinned to the original path through LIVE_COST_OPT_OUT_AGENT_IDS must
// keep behaving exactly as it did. The real-estate demo used to be pinned there
// by its own Gemini key; it now takes the concise form like every other agent.

const nowInTz = 'Monday, 31 August 2026 at 6:20 pm';
const todayIso = '2026-08-31';
const timezone = 'Asia/Kolkata';
const at = (concise: boolean) => bookingClause({ nowInTz, todayIso, timezone, concise });

// Copied from the block live.ts appended before this moved into the composer.
const ORIGINAL =
  `\n\nTODAY: It is currently ${nowInTz} (${timezone}). Today's date is ${todayIso}. ` +
  'Work out every date the caller mentions from this, and never ask them what today is.' +
  '\n\nAPPOINTMENT BOOKING: You can manage real appointments. To BOOK: call check_availability for open times, ' +
  'passing the date argument whenever the caller names a day AND the time argument whenever they name an hour. ' +
  'If they asked for a specific time, the reply tells you whether that exact time is free: when ' +
  'requestedTimeAvailable is true, offer THAT time back to them rather than reading out a list — they ' +
  'already told you what they wanted. When it is false, say that time is taken and offer the nearest ' +
  'ones it returned. If the caller has NOT named a time, do not read out a list of slot times — tell them ' +
  'the hours the clinic is open that day, which comes back as hours.label, and ask what time would suit ' +
  'them. Only offer specific times when they say they have no preference. If it returns no slots for that date, say that day ' +
  'is full and offer to check another — never quietly read out times from a different day. Otherwise ' +
  'read out one or two options, then once the caller picks one call book_appointment with the exact startISO it ' +
  'returned and the caller’s name. To RESCHEDULE or CANCEL: call find_appointment to get the caller’s booking and ' +
  'its appointmentId, then call reschedule_appointment (with a new startISO from check_availability) or ' +
  'cancel_appointment. Always confirm the result back to the caller. Never invent or guess times — only offer what ' +
  'check_availability returns. After booking, a confirmation is sent to the caller automatically as a ' +
  'WhatsApp message' +
  ' — tell them to expect it there. Never say it will be emailed.';

describe('bookingClause', () => {
  it('is empty when the booking tools are not registered', () => {
    expect(bookingClause(null)).toBe('');
    expect(bookingClause(undefined)).toBe('');
  });

  it('leaves an opted-out agent byte-for-byte what it was', () => {
    expect(at(false)).toBe(ORIGINAL);
  });

  it('saves ~270 tokens per turn on the optimised path', () => {
    // Measured against the whole block would understate it: the TODAY preamble
    // is ~200 chars and is common to both, because the model genuinely has no
    // clock. It is the APPOINTMENT section that shrinks.
    const saved = at(false).length - at(true).length;
    expect(saved).toBeGreaterThan(1000); // ~270 tokens, re-billed every turn
    expect(at(true).length).toBeLessThan(700);
  });

  it('keeps the rules that cannot move to a tool result', () => {
    const concise = at(true);
    expect(concise).toContain(todayIso); // the model has no clock
    expect(concise).toMatch(/never invent/i); // never offer a time it did not return
    expect(concise).toMatch(/WhatsApp/); // and never promise an email
    expect(concise).toContain('find_appointment'); // reschedule/cancel still reachable
  });

  it('points the model at the guidance that now travels on the result', () => {
    // The slot-reading mechanics (requestedTimeAvailable, hours.label, "don't
    // read out a list") moved onto check_availability's `say` field, where they
    // are paid for once per lookup instead of once per turn.
    expect(at(true)).toContain('`say`');
    expect(at(true)).not.toContain('hours.label');
  });
});

describe('composeSystemInstruction', () => {
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

  it('adds nothing when the agent cannot book', () => {
    expect(composeSystemInstruction(parts())).toBe(composeSystemInstruction(parts({ booking: null })));
  });

  it('appends the block last, exactly where live.ts used to put it', () => {
    const composed = composeSystemInstruction(
      parts({ booking: { nowInTz, todayIso, timezone, concise: false } }),
    );
    expect(composed).toBe(composeSystemInstruction(parts()) + ORIGINAL);
    expect(composed.endsWith('Never say it will be emailed.')).toBe(true);
  });
});
