import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// createEvent's invitation support.
//
// The failure this pins is silent, which is why it is tested at all:
// `sendUpdates` and `conferenceDataVersion` are QUERY parameters, not body
// fields. Put them in the body and Google still returns 200 — the event exists,
// no attendee is ever told, and there is no Meet link. Nothing errors; the
// customer simply never hears about the call they booked.

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/adapters/llm', () => ({ getLlmProvider: () => null }));

import { createEvent } from '@/lib/calendar';

const okJson = { id: 'evt1', htmlLink: 'https://cal/evt1', hangoutLink: 'https://meet/xyz' };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => okJson }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function lastCall() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) };
}

const base = { summary: 'Call', startISO: '2026-09-01T10:00:00.000Z', endISO: '2026-09-01T10:30:00.000Z' };

describe('createEvent — plain event', () => {
  it('sends no attendee or conference parameters when none are asked for', async () => {
    await createEvent('tok', 'primary', base);
    const { url, body } = lastCall();
    expect(url).not.toContain('sendUpdates');
    expect(url).not.toContain('conferenceDataVersion');
    expect(body.attendees).toBeUndefined();
    expect(body.conferenceData).toBeUndefined();
  });
});

describe('createEvent — attendees', () => {
  it('invites the attendee and asks Google to notify them', async () => {
    await createEvent('tok', 'primary', {
      ...base,
      attendees: ['patient@clinic.in'],
      notifyAttendees: true,
    });
    const { url, body } = lastCall();
    expect(body.attendees).toEqual([{ email: 'patient@clinic.in' }]);
    // Without this the invitation is created and silently never sent.
    expect(url).toContain('sendUpdates=all');
  });

  it('does not notify unless asked, even with attendees', async () => {
    await createEvent('tok', 'primary', { ...base, attendees: ['a@b.com'] });
    expect(lastCall().url).toContain('sendUpdates=none');
  });

  it('drops empty addresses rather than sending Google a blank attendee', async () => {
    await createEvent('tok', 'primary', { ...base, attendees: ['', 'real@x.com'] });
    expect(lastCall().body.attendees).toEqual([{ email: 'real@x.com' }]);
  });
});

describe('createEvent — Meet link', () => {
  it('requests a conference and sets the version param that makes it take effect', async () => {
    const out = await createEvent('tok', 'primary', { ...base, addMeet: true });
    const { url, body } = lastCall();
    expect(url).toContain('conferenceDataVersion=1');
    expect(body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' });
    // Google dedupes retries on this, so it must actually be present.
    expect(body.conferenceData.createRequest.requestId).toBeTruthy();
    expect(out.hangoutLink).toBe('https://meet/xyz');
  });
});
