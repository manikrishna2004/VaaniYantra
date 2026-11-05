import { describe, it, expect } from 'vitest';
import { matchDoctor, type BookableDoctor } from '@/lib/doctors';
import { bookingTools, readBookingConfig } from '@/lib/connectors/booking';

// The doctor list is now authoritative — it decides who the agent offers and who
// a booking is attributed to. These pin the matching precedence, which used to
// live in booking.ts as `matchExpert` over free text on the agent.

const doc = (over: Partial<BookableDoctor>): BookableDoctor => ({
  id: 'd1',
  displayName: 'Dr. Aditi Sharma',
  specialisation: null,
  timezone: null,
  userId: null,
  calendarId: null,
  ...over,
});

const aditi = doc({ id: 'd1', displayName: 'Dr. Aditi Sharma', specialisation: 'Dentist' });
const rao = doc({ id: 'd2', displayName: 'Dr. Rao', specialisation: 'Cardiologist' });
const mehta = doc({ id: 'd3', displayName: 'Dr. Mehta', specialisation: 'Dentist' });

describe('matchDoctor — names', () => {
  it('prefers an exact name over a substring of another', () => {
    expect(matchDoctor([aditi, rao], 'dr. rao').doctor?.id).toBe('d2');
  });

  it('matches a surname the caller gives on its own', () => {
    expect(matchDoctor([aditi, rao], 'sharma').doctor?.id).toBe('d1');
  });

  // The caller says more than we stored — "Doctor Rao please" contains "Dr. Rao"
  // only loosely, so the match runs both ways, as matchExpert did.
  it('matches when the spoken name contains the stored one', () => {
    expect(matchDoctor([rao], 'Dr. Rao please').doctor?.id).toBe('d2');
  });

  it('returns nothing for a name the clinic does not have', () => {
    expect(matchDoctor([aditi, rao], 'Dr. Nobody')).toEqual({});
  });

  it('returns nothing when the caller named nobody', () => {
    expect(matchDoctor([aditi], '')).toEqual({});
    expect(matchDoctor([aditi], undefined)).toEqual({});
  });
});

describe('matchDoctor — specialisation', () => {
  it('routes a caller who asks for a trade rather than a person', () => {
    expect(matchDoctor([aditi, rao], 'dentist').doctor?.id).toBe('d1');
  });

  // The point of returning choices instead of a doctor: being assigned one of
  // three dentists at random is worse than being asked which.
  it('asks which one when several share the specialisation', () => {
    const m = matchDoctor([aditi, rao, mehta], 'dentist');
    expect(m.doctor).toBeUndefined();
    expect(m.choices?.map((d) => d.id)).toEqual(['d1', 'd3']);
  });

  it('lets a name win over a specialisation someone else holds', () => {
    expect(matchDoctor([aditi, rao, mehta], 'Mehta').doctor?.id).toBe('d3');
  });

  it('ignores doctors with no specialisation set', () => {
    expect(matchDoctor([doc({ id: 'd9', specialisation: null })], 'dentist')).toEqual({});
  });
});

describe('bookingTools describes the doctors it was given', () => {
  const cfg = readBookingConfig({ bookingConfig: { enabled: true }, businessHours: {} } as never);

  it('names each doctor with their specialisation', () => {
    const tools = bookingTools(cfg, [aditi, rao]);
    const check = tools.find((t) => t.declaration.name === 'check_availability')!;
    expect(check.declaration.description).toContain('Dr. Aditi Sharma (Dentist)');
    expect(check.declaration.description).toContain('Dr. Rao (Cardiologist)');
  });

  it('falls back to the bare name when there is no specialisation', () => {
    const tools = bookingTools(cfg, [doc({ displayName: 'Dr. Solo' })]);
    const check = tools.find((t) => t.declaration.name === 'check_availability')!;
    expect(check.declaration.description).toContain('Dr. Solo');
    expect(check.declaration.description).not.toContain('(');
  });

  // A clinic with nobody set up still books — it just cannot offer a choice.
  it('offers no doctor parameter at all when the list is empty', () => {
    for (const tool of bookingTools(cfg, [])) {
      const props = (tool.declaration.parameters as { properties?: Record<string, unknown> })?.properties ?? {};
      expect(Object.keys(props)).not.toContain('expert');
    }
  });
});
