import { describe, it, expect, vi, beforeEach } from 'vitest';

// Google Calendar is an optional per-doctor MIRROR, not a prerequisite for
// booking. VaaniYantra owns the calendar.
//
// It used to be a hard dependency, and the failure was silent in the worst way:
// getCallConnectorTools gated the whole booking tool set on
// hasAnyCalendarConnection(orgId), so a clinic with no Google account never saw
// the tools at all. The agent fell back to taking a message and had no idea it
// could have booked. The patient chatbot was worse — its gate withheld the
// read-only my_appointments too, so a patient could not even see a booking the
// clinic had already made for them.
//
// These tests pin the tools being offered with NO calendar connected.

const agent = vi.hoisted(() => ({
  id: 'a1',
  name: 'Ramya',
  bookingConfig: { enabled: true },
  businessHours: {},
})) as any;

// The tool builder now asks the Doctor table who is bookable. Empty is the
// interesting case here: a clinic with no doctors set up must still get the
// booking tools, just without a doctor to choose between.
vi.mock('@/lib/db', () => ({ prisma: { doctor: { findMany: async () => [] } } }));

// If either module still reaches for a calendar connection, this throws and the
// test fails loudly rather than quietly passing for the wrong reason.
vi.mock('@/lib/calendar', () => ({
  hasAnyCalendarConnection: vi.fn(async () => {
    throw new Error('booking must not depend on a Google connection');
  }),
  resolveDoctorCalendar: vi.fn(async () => null),
  freeBusy: vi.fn(async () => []),
  computeOpenSlots: vi.fn(() => []),
  createEvent: vi.fn(async () => ({ id: 'evt' })),
  patchEvent: vi.fn(async () => undefined),
}));

import { getCallConnectorTools } from '@/lib/connectors/tools';

beforeEach(() => vi.clearAllMocks());

describe('the phone agent, with no Google connection', () => {
  it('is still given the booking tools', async () => {
    const tools = await getCallConnectorTools({ orgId: 'org1', agent } as any);
    const names = tools.map((t) => t.declaration.name);

    expect(names).toContain('check_availability');
    expect(names).toContain('book_appointment');
    expect(names).toContain('reschedule_appointment');
    expect(names).toContain('cancel_appointment');
  });

  it('does not also expose record_outcome, which would duplicate booking', async () => {
    const tools = await getCallConnectorTools({ orgId: 'org1', agent } as any);
    expect(tools.map((t) => t.declaration.name)).not.toContain('record_outcome');
  });

  // With nobody set up, the agent must not offer a doctor at all — rather than
  // offering an empty list, or naming somebody the clinic has retired.
  it('omits the doctor parameter entirely when no doctors are bookable', async () => {
    const tools = await getCallConnectorTools({ orgId: 'org1', agent } as any);
    for (const name of ['check_availability', 'book_appointment']) {
      const tool = tools.find((t) => t.declaration.name === name)!;
      const props = (tool.declaration.parameters as any)?.properties ?? {};
      expect(Object.keys(props), `${name} params`).not.toContain('expert');
      expect(tool.declaration.description).not.toContain('Available doctors');
    }
  });

  it('falls back to record_outcome only when booking is switched OFF', async () => {
    const offAgent = { ...agent, bookingConfig: { enabled: false } };
    const tools = await getCallConnectorTools({ orgId: 'org1', agent: offAgent } as any);
    const names = tools.map((t) => t.declaration.name);

    expect(names).toContain('record_outcome');
    expect(names).not.toContain('book_appointment');
  });
});
