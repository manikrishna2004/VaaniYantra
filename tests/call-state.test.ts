import { describe, it, expect } from 'vitest';
import {
  emptyCallState,
  updateFromTool,
  stateLine,
  restateAfterCompression,
} from '@/lib/voice/call-state';

// The backend's copy of what the caller has said, so that a compression costs
// the conversation its transcript but not its facts.
//
// The window is no longer tightened aggressively — the trigger counts the system
// instruction, so a low value fires in the first minute and restarts the call
// (see restateAfterCompression below). But compression still happens on a long
// call, and when it does this is what the model gets handed back: the facts,
// captured from tool traffic that already flows, rendered short enough that
// re-stating them cannot cost more than the compression saved.

describe('updateFromTool', () => {
  it('records what the caller asked for, even though check_availability only reports what is free', () => {
    // The requested date/time exists nowhere else: the response says which slots
    // are open, never which one they wanted.
    const s = updateFromTool(emptyCallState(), 'check_availability', { date: '2026-09-02', time: '16:00' }, {
      ok: true,
      requestedTimeAvailable: false,
      slots: [{ startISO: '2026-09-02T10:00:00+05:30', label: '10:00 am' }],
    });
    expect(s.requestedDate).toBe('2026-09-02');
    expect(s.requestedTime).toBe('16:00');
  });

  it('keeps the caller name from a booking, and what they were booked into', () => {
    const s = updateFromTool(emptyCallState(), 'book_appointment', { startISO: 'x', customerName: 'Rahul' }, {
      ok: true, booked: true, appointmentId: 'appt_1', when: 'Tue 2 Sep, 4:00 pm',
    });
    expect(s.customerName).toBe('Rahul');
    expect(s.appointmentId).toBe('appt_1');
    expect(s.selectedSlotLabel).toBe('Tue 2 Sep, 4:00 pm');
  });

  it('still records the name when the booking itself failed', () => {
    // The slot was taken, but the caller did give their name — asking again
    // because the write failed is exactly the behaviour this guards against.
    const s = updateFromTool(emptyCallState(), 'book_appointment', { startISO: 'x', customerName: 'Rahul' }, {
      ok: false, error: 'That slot was just taken. Offer another time.',
    });
    expect(s.customerName).toBe('Rahul');
    expect(s.appointmentId).toBeUndefined();
  });

  it('forgets a cancelled appointment', () => {
    // Leaving it behind is how an agent ends up confirming a booking that no
    // longer exists.
    const booked = updateFromTool(emptyCallState(), 'book_appointment', { startISO: 'x', customerName: 'Rahul' }, {
      ok: true, booked: true, appointmentId: 'appt_1', when: 'Tue 2 Sep, 4:00 pm',
    });
    const cancelled = updateFromTool(booked, 'cancel_appointment', { appointmentId: 'appt_1' }, {
      ok: true, cancelled: true, when: 'Tue 2 Sep, 4:00 pm',
    });
    expect(cancelled.appointmentId).toBeUndefined();
    expect(cancelled.selectedSlotLabel).toBeUndefined();
    expect(cancelled.customerName).toBe('Rahul'); // they are still the same caller
  });

  it('takes owner-defined captures from record_outcome, and finds the name among them', () => {
    const s = updateFromTool(emptyCallState(), 'record_outcome', {
      name: 'Priya', reason: 'tooth pain', preferredTime: 'evenings',
    }, { ok: true, recorded: true });
    expect(s.customerName).toBe('Priya');
    expect(s.details).toEqual({ name: 'Priya', reason: 'tooth pain', preferredTime: 'evenings' });
  });

  it('does not mutate the state it was given', () => {
    const before = emptyCallState();
    updateFromTool(before, 'check_availability', { date: '2026-09-02' }, { ok: true });
    expect(before).toEqual({});
  });

  it('ignores a tool it knows nothing about', () => {
    expect(updateFromTool(emptyCallState(), 'end_call', {}, { ok: true })).toEqual({});
  });
});

describe('stateLine', () => {
  it('is empty when nothing is known, so nothing is sent', () => {
    expect(stateLine(emptyCallState())).toBe('');
  });

  it('states the facts and tells the model not to ask again', () => {
    const line = stateLine({ customerName: 'Rahul', requestedDate: '2026-09-02', requestedTime: '16:00' });
    expect(line).toContain('Rahul');
    expect(line).toContain('2026-09-02 at 16:00');
    expect(line).toMatch(/do not ask/i);
  });

  it('says an appointment is booked only once there is an id for it', () => {
    expect(stateLine({ selectedSlotLabel: 'Tue 4pm' })).toContain('under discussion');
    expect(stateLine({ selectedSlotLabel: 'Tue 4pm', appointmentId: 'a1' })).toContain('booked');
  });

  it('does not say the name twice when it also arrived as a capture', () => {
    const line = stateLine({ customerName: 'Priya', details: { name: 'Priya', reason: 'tooth pain' } });
    expect(line.match(/Priya/g)).toHaveLength(1);
    expect(line).toContain('tooth pain');
  });

  it('stays short — it is re-sent on every compression', () => {
    // A state line that grew unbounded would be re-billed exactly like the
    // context it was introduced to replace.
    const line = stateLine({
      customerName: 'A'.repeat(200),
      details: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, 'x'.repeat(100)])),
    });
    expect(line.length).toBeLessThanOrEqual(320);
  });
});

describe('restateAfterCompression', () => {
  // Regression guard for a live incident: with the trigger set below the size of
  // the system instruction, compression fired ~50s into a real customer call.
  // The conversation was discarded; the instruction — which ends "Begin the call
  // by greeting the caller" — survived. So the bot greeted the caller a second
  // time and started over.

  it('tells the model not to greet again, even when nothing is known yet', () => {
    // The empty-state case is the one that broke: at 50 seconds no tool had run,
    // so there were no facts to send, and an earlier version sent nothing at all.
    const msg = restateAfterCompression(emptyCallState());
    expect(msg).not.toBe('');
    expect(msg).toMatch(/do not greet/i);
    expect(msg).toMatch(/already under way/i);
  });

  it('carries the facts as well, once there are any', () => {
    const msg = restateAfterCompression({ customerName: 'Rahul', requestedDate: '2026-09-02' });
    expect(msg).toMatch(/do not greet/i);
    expect(msg).toContain('Rahul');
    expect(msg).toContain('2026-09-02');
  });

  it('stays cheap — it is re-sent on every compression', () => {
    const msg = restateAfterCompression({
      customerName: 'A'.repeat(200),
      details: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, 'x'.repeat(100)])),
    });
    expect(msg.length).toBeLessThan(600);
  });
});
