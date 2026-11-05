import { describe, it, expect, vi, beforeEach } from 'vitest';

// Which clinic should answer an inbound WhatsApp message?
//
// The platform runs ONE shared sender for every business, so the recipient
// phone-number id identifies US, not the clinic the patient meant. Routing used
// to match that id against a snapshot stored on each org's Integration row,
// which was wrong twice over:
//
//   1. The snapshot went stale. Outbound builds the sender fresh from platform
//      config every send; inbound compared against a frozen copy, so when the
//      real number replaced the Meta sandbox one, every inbound message stopped
//      resolving and was silently dropped. That is this bug, in production,
//      unnoticed from 2026-07-25 until 2026-08-03.
//   2. It cannot disambiguate. Every org on the shared sender would match the
//      same id, so the first row won — routing one clinic's patients into
//      another clinic's workspace as soon as there is a second tenant.
//
// The fix routes shared-sender traffic by the PATIENT's number instead, and
// refuses to guess when that is ambiguous. Delivering a medical conversation to
// the wrong clinic is worse than delivering it nowhere.

const SHARED_PHONE_NUMBER_ID = '1234786513047967';

const state = vi.hoisted(() => ({
  contacts: [] as { orgId: string; phone: string }[],
  integrations: [] as { orgId: string; enabled: boolean; cfg: Record<string, unknown> }[],
  defaultPhoneNumberId: '1234786513047967' as string | undefined,
}));

const prismaMock = vi.hoisted(() => ({
  contact: {
    findMany: vi.fn(async ({ where, distinct }: any) => {
      const wanted: string[] = where?.phone?.in ?? [];
      const hits = state.contacts.filter((c) => wanted.includes(c.phone));
      if (distinct?.includes('orgId')) {
        const seen = new Set<string>();
        return hits.filter((c) => (seen.has(c.orgId) ? false : (seen.add(c.orgId), true)));
      }
      return hits;
    }),
  },
  integration: {
    findMany: vi.fn(async ({ where }: any) =>
      state.integrations
        .filter((i) => (where?.enabled === undefined ? true : i.enabled === where.enabled))
        .map((i) => ({ orgId: i.orgId, secret: JSON.stringify(i.cfg), enabled: i.enabled })),
    ),
  },
  phoneNumber: { findMany: vi.fn(async () => []) },
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/crypto', () => ({
  // The fixture stores plain JSON in `secret`; decrypt is the identity here.
  decryptSecret: (s: string) => s,
  encryptSecret: (s: string) => s,
}));
vi.mock('@/lib/whatsapp-cloud', () => ({
  getMetaConfig: vi.fn(async () => ({
    defaultPhoneNumberId: state.defaultPhoneNumberId,
    wabaId: 'waba_live',
    graphVersion: 'v21.0',
  })),
  getPlatformDefaultCloudConfig: vi.fn(),
  sendCloudText: vi.fn(),
  sendCloudTemplate: vi.fn(),
}));
vi.mock('@/lib/calendar', () => ({ getCalendarConfig: vi.fn() }));
vi.mock('@/lib/google-oauth', () => ({ refreshAccessToken: vi.fn() }));
vi.mock('@/lib/flags', () => ({ whatsappEnabled: () => true }));

import { resolveInboundWhatsappOrg } from '@/lib/connectors';

const inbound = (from: string, phoneNumberId = SHARED_PHONE_NUMBER_ID) =>
  resolveInboundWhatsappOrg({ phoneNumberId, from });

beforeEach(() => {
  vi.clearAllMocks();
  state.contacts = [];
  state.integrations = [];
  state.defaultPhoneNumberId = SHARED_PHONE_NUMBER_ID;
});

describe('shared platform sender — route by the patient', () => {
  it('routes to the one clinic that knows this patient', async () => {
    state.contacts = [{ orgId: 'clinic_a', phone: '+919876543210' }];

    await expect(inbound('919876543210')).resolves.toEqual({ orgId: 'clinic_a', reason: 'patient-match' });
  });

  it('REFUSES to guess when two clinics know the same patient', async () => {
    // A real possibility: one person is a patient at two practices. Guessing
    // would put their medical conversation in front of the wrong clinic.
    state.contacts = [
      { orgId: 'clinic_a', phone: '+919876543210' },
      { orgId: 'clinic_b', phone: '+919876543210' },
    ];

    await expect(inbound('919876543210')).resolves.toEqual({ orgId: null, reason: 'ambiguous' });
  });

  it('returns unknown-sender for a number no clinic has on file', async () => {
    state.contacts = [{ orgId: 'clinic_a', phone: '+919999999999' }];

    await expect(inbound('919876543210')).resolves.toEqual({ orgId: null, reason: 'unknown-sender' });
  });

  it('matches however the provider formats the sender', async () => {
    state.contacts = [{ orgId: 'clinic_a', phone: '+919876543210' }];

    for (const from of ['919876543210', '+919876543210', 'whatsapp:+919876543210', '+91 98765 43210']) {
      await expect(inbound(from), from).resolves.toMatchObject({ orgId: 'clinic_a' });
    }
  });

  it('handles a contact stored without the plus', async () => {
    state.contacts = [{ orgId: 'clinic_a', phone: '919876543210' }];

    await expect(inbound('+919876543210')).resolves.toMatchObject({ orgId: 'clinic_a' });
  });

  it('rejects an empty or junk sender', async () => {
    for (const from of ['', 'whatsapp:', 'not-a-number']) {
      await expect(inbound(from), from).resolves.toEqual({ orgId: null, reason: 'unknown-sender' });
    }
  });

  it('IGNORES a stale snapshot on the integration row', async () => {
    // The regression. This row still carries the old Meta sandbox ids, exactly
    // as production did; the shared-sender path must not consult it at all.
    state.integrations = [
      {
        orgId: 'clinic_a',
        enabled: true,
        cfg: { platform: true, phoneNumberId: '1125502293987688', wabaId: '2570533146740699' },
      },
    ];
    state.contacts = [{ orgId: 'clinic_a', phone: '+919876543210' }];

    await expect(inbound('919876543210')).resolves.toEqual({ orgId: 'clinic_a', reason: 'patient-match' });
  });
});

describe('own-brand number — route by the number that was messaged', () => {
  it('routes on a matching stored phoneNumberId', async () => {
    state.integrations = [
      { orgId: 'clinic_b', enabled: true, cfg: { phoneNumberId: 'own_123', wabaId: 'waba_b' } },
    ];

    await expect(inbound('919876543210', 'own_123')).resolves.toEqual({
      orgId: 'clinic_b',
      reason: 'own-number',
    });
  });

  it('does not route through a disabled integration', async () => {
    state.integrations = [
      { orgId: 'clinic_b', enabled: false, cfg: { phoneNumberId: 'own_123', wabaId: 'waba_b' } },
    ];

    await expect(inbound('919876543210', 'own_123')).resolves.toEqual({
      orgId: null,
      reason: 'unknown-number',
    });
  });

  it('returns unknown-number for a sender we do not recognise at all', async () => {
    await expect(inbound('919876543210', 'someone_elses_number')).resolves.toEqual({
      orgId: null,
      reason: 'unknown-number',
    });
  });

  it('does not fall back to patient matching for an unknown own-brand number', async () => {
    // If we cannot identify the business that was messaged, the patient's own
    // number must not be used to pick one — that is the cross-tenant leak.
    state.contacts = [{ orgId: 'clinic_a', phone: '+919876543210' }];

    await expect(inbound('919876543210', 'unrecognised')).resolves.toEqual({
      orgId: null,
      reason: 'unknown-number',
    });
  });

  it('survives an integration row it cannot decrypt', async () => {
    state.integrations = [
      { orgId: 'broken', enabled: true, cfg: null as any },
      { orgId: 'clinic_b', enabled: true, cfg: { phoneNumberId: 'own_123' } },
    ];

    await expect(inbound('919876543210', 'own_123')).resolves.toMatchObject({ orgId: 'clinic_b' });
  });
});

describe('platform sender not configured', () => {
  it('falls back to stored matching rather than throwing', async () => {
    state.defaultPhoneNumberId = undefined;
    state.integrations = [
      { orgId: 'clinic_b', enabled: true, cfg: { phoneNumberId: SHARED_PHONE_NUMBER_ID } },
    ];

    await expect(inbound('919876543210')).resolves.toEqual({ orgId: 'clinic_b', reason: 'own-number' });
  });
});
