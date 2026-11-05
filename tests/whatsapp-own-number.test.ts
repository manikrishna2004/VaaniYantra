import { describe, it, expect, vi, beforeEach } from 'vitest';

// Own-brand WhatsApp numbers, connected through Meta Embedded Signup.
//
// The platform's shared sender remains the default and the fallback. A clinic
// that connects its own number must OVERRIDE it — the whole point is that
// patients see the clinic's identity — but a failed own-brand send must still
// fall through to the shared sender rather than dropping the message. Both
// halves matter: get the precedence wrong and connecting a number changes
// nothing; get the fallback wrong and connecting one makes delivery worse.
//
// The template invariant at the bottom guards the thing that fails silently:
// definitions we create in a customer's WABA must have exactly as many
// placeholders as the senders pass parameters, or Meta rejects every send with
// a generic error long after anyone remembers touching this file.

const state = vi.hoisted(() => ({
  ownConfig: null as Record<string, unknown> | null,
  platformSender: null as Record<string, unknown> | null,
  textResults: [] as boolean[],
  templateResults: [] as boolean[],
  textCalls: [] as Array<{ phoneNumberId: string; accessToken?: string }>,
  templateCalls: [] as Array<{ phoneNumberId: string; accessToken?: string }>,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    integration: {
      findFirst: vi.fn(async ({ where }: any) =>
        where?.provider === 'whatsapp_cloud' && state.ownConfig ? { secret: 'enc', orgId: where.orgId } : null,
      ),
      findMany: vi.fn(async () => []),
    },
    phoneNumber: { findMany: vi.fn(async () => []) },
    contact: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock('@/lib/crypto', () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: () => JSON.stringify(state.ownConfig),
}));

vi.mock('@/lib/calendar', () => ({ getCalendarConfig: vi.fn(async () => null) }));
vi.mock('@/lib/google-oauth', () => ({ refreshAccessToken: vi.fn() }));
vi.mock('@/lib/flags', () => ({ whatsappEnabled: () => true }));

vi.mock('@/lib/whatsapp-cloud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp-cloud')>()),
  getMetaConfig: vi.fn(async () => ({
    appId: 'app',
    appSecret: 'sec',
    configId: 'cfg',
    verifyToken: 'vt',
    graphVersion: 'v21.0',
    wabaId: 'platform-waba',
    systemUserToken: 'platform-token',
    defaultPhoneNumberId: 'platform-number',
  })),
  getPlatformDefaultCloudConfig: vi.fn(() => state.platformSender),
  sendCloudText: vi.fn(async (_cfg: any, wa: any) => {
    state.textCalls.push({ phoneNumberId: wa.phoneNumberId, accessToken: wa.accessToken });
    return state.textResults.shift() ?? false;
  }),
  sendCloudTemplate: vi.fn(async (_cfg: any, wa: any) => {
    state.templateCalls.push({ phoneNumberId: wa.phoneNumberId, accessToken: wa.accessToken });
    return state.templateResults.shift() ?? false;
  }),
}));

import { sendWhatsApp, sendWhatsAppTemplate, sendConfirmation } from '@/lib/connectors';
import {
  WA_TEMPLATE_DEFINITIONS,
  apptConfirmationTemplate,
  apptConfirmationPortalTemplate,
  apptReminderTemplate,
  apptRescheduledTemplate,
  apptCancelledTemplate,
  ownerAlertTemplate,
  enquiryReceivedTemplate,
  otpTemplate,
} from '@/lib/whatsapp-templates';

const OWN = { wabaId: 'own-waba', phoneNumberId: 'own-number', accessToken: 'own-token' };
const PLATFORM = { wabaId: 'platform-waba', phoneNumberId: 'platform-number', platform: true };

beforeEach(() => {
  state.ownConfig = null;
  state.platformSender = PLATFORM;
  state.textResults = [];
  state.templateResults = [];
  state.textCalls = [];
  state.templateCalls = [];
});

describe('sendWhatsApp sender precedence', () => {
  it('uses the shared platform sender when the org has not connected a number', async () => {
    state.textResults = [true];
    expect(await sendWhatsApp('org1', '+919876543210', 'hi')).toBe(true);
    expect(state.textCalls).toEqual([{ phoneNumberId: 'platform-number', accessToken: undefined }]);
  });

  it('prefers the org’s own number over the shared sender', async () => {
    state.ownConfig = OWN;
    state.textResults = [true];
    expect(await sendWhatsApp('org1', '+919876543210', 'hi')).toBe(true);
    // Own number only — the platform sender must not also be tried.
    expect(state.textCalls).toEqual([{ phoneNumberId: 'own-number', accessToken: 'own-token' }]);
  });

  it('falls back to the shared sender when the own-brand send fails', async () => {
    state.ownConfig = OWN;
    state.textResults = [false, true];
    expect(await sendWhatsApp('org1', '+919876543210', 'hi')).toBe(true);
    expect(state.textCalls.map((c) => c.phoneNumberId)).toEqual(['own-number', 'platform-number']);
  });

  it('reports failure when both senders reject', async () => {
    state.ownConfig = OWN;
    state.textResults = [false, false];
    expect(await sendWhatsApp('org1', '+919876543210', 'hi')).toBe(false);
  });

  it('still works for an org with an own number when no platform sender is configured', async () => {
    state.ownConfig = OWN;
    state.platformSender = null;
    state.textResults = [true];
    expect(await sendWhatsApp('org1', '+919876543210', 'hi')).toBe(true);
  });
});

describe('sendWhatsAppTemplate sender precedence', () => {
  const tmpl = apptReminderTemplate({ business: 'Smilecare', service: 'Cleaning', when: 'Fri 3pm' });

  it('prefers the org’s own number', async () => {
    state.ownConfig = OWN;
    state.templateResults = [true];
    expect(await sendWhatsAppTemplate('org1', '+919876543210', tmpl)).toBe(true);
    expect(state.templateCalls).toEqual([{ phoneNumberId: 'own-number', accessToken: 'own-token' }]);
  });

  // The realistic case for a just-connected clinic: its templates are still in
  // Meta review, so its own sends are rejected. The confirmation must still go
  // out rather than waiting on review.
  it('falls back to the shared sender while the own WABA’s templates are pending', async () => {
    state.ownConfig = OWN;
    state.templateResults = [false, true];
    expect(await sendWhatsAppTemplate('org1', '+919876543210', tmpl)).toBe(true);
    expect(state.templateCalls.map((c) => c.phoneNumberId)).toEqual(['own-number', 'platform-number']);
  });

  it('returns false when neither sender delivers, so the caller falls back to SMS', async () => {
    state.ownConfig = OWN;
    state.templateResults = [false, false];
    expect(await sendWhatsAppTemplate('org1', '+919876543210', tmpl)).toBe(false);
  });
});

describe('provisionable template definitions match their senders', () => {
  // Highest {{n}} in a body = how many parameters Meta will expect.
  const placeholders = (body: string) =>
    Math.max(0, ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));

  const senders: Record<string, string[]> = {
    appointment_confirmation: apptConfirmationTemplate({ name: 'a', business: 'b', service: 'c', when: 'd' }).params,
    appointment_confirmation_portal: apptConfirmationPortalTemplate({
      name: 'a', business: 'b', service: 'c', when: 'd', portal: 'e',
    }).params,
    appointment_reminder: apptReminderTemplate({ business: 'a', service: 'b', when: 'c' }).params,
    appointment_rescheduled: apptRescheduledTemplate({ name: 'a', business: 'b', service: 'c', when: 'd' }).params,
    appointment_cancelled: apptCancelledTemplate({ name: 'a', business: 'b', service: 'c', when: 'd' }).params,
    owner_alert: ownerAlertTemplate({ type: 'a', business: 'b', summary: 'c' }).params,
    enquiry_registered: enquiryReceivedTemplate({ name: 'a', type: 'b', business: 'c', detail: 'd' }).params,
    patient_signin_code: otpTemplate({ code: '482913' }).params,
  };

  // Meta composes an AUTHENTICATION body itself, so there is no body of ours to
  // count placeholders in — the checks below that read `def.body` only apply to
  // the templates we actually write.
  const authored = WA_TEMPLATE_DEFINITIONS.filter((d) => d.category !== 'AUTHENTICATION');

  it.each(WA_TEMPLATE_DEFINITIONS.map((d) => [d.name, d] as const))(
    '%s has one placeholder per sender parameter, and a matching example',
    (name, def) => {
      const params = senders[name];
      expect(params, `no sender descriptor covers ${name}`).toBeDefined();
      if (def.category === 'AUTHENTICATION') {
        // Meta's fixed format takes exactly one parameter: the code.
        expect(params).toHaveLength(1);
        return;
      }
      expect(placeholders(def.body)).toBe(params.length);
      // Meta requires an example value per placeholder or rejects creation.
      expect(def.example).toHaveLength(params.length);
    },
  );

  // The copy-code button is a URL button whose parameter repeats the code.
  // Without it Meta rejects the send for a missing button component — the exact
  // "approved but never delivers" failure this template was held back over.
  it('carries the code again as the OTP button parameter', () => {
    expect(otpTemplate({ code: '482913' }).otpCode).toBe('482913');
  });

  it('has placeholders numbered 1..n with no gaps', () => {
    for (const def of authored) {
      const nums = [...def.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(new Set(nums).size).toBe(nums.length);
      expect([...nums].sort((a, b) => a - b)).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
    }
  });

  // Meta rejects a Utility body that ends with a variable — a rule we only
  // discovered by having a template rejected, and which is easy to reintroduce.
  it('never ends a body with a placeholder', () => {
    for (const def of authored) {
      expect(def.body.trim().endsWith('}}'), `${def.name} ends with a variable`).toBe(false);
    }
  });
});

describe('sendConfirmation falls back to free text', () => {
  // A template that Meta refuses — not yet approved, rejected, or absent from
  // this WABA — used to end the attempt. Free text is not a substitute (Meta
  // will not carry it business-initiated) but it DOES deliver inside an open 24h
  // customer-service window, and that case was being thrown away.
  const tmpl = { name: 'appointment_confirmation', lang: 'en_US', params: ['Rahul', 'PARE India', 'enquiry', 'x'] };

  beforeEach(() => {
    state.platformSender = PLATFORM;
  });

  it('does not send free text when the template is accepted', async () => {
    state.templateResults = [true];
    expect(await sendConfirmation('org1', '+919876543210', 'body', tmpl)).toBe(true);
    expect(state.textCalls).toEqual([]);
  });

  it('tries free text once every template has been refused', async () => {
    state.templateResults = [false];
    state.textResults = [true];
    expect(await sendConfirmation('org1', '+919876543210', 'body', tmpl)).toBe(true);
    expect(state.templateCalls).toHaveLength(1);
    expect(state.textCalls).toHaveLength(1);
  });

  it('reports failure when the window is closed too', async () => {
    // Outside a 24h window the free-text attempt fails exactly as the template
    // did, so this adds an attempt and never a message Meta would have refused.
    state.templateResults = [false];
    state.textResults = [false];
    expect(await sendConfirmation('org1', '+919876543210', 'body', tmpl)).toBe(false);
  });

  it('still takes the plain free-text path when no template is passed', async () => {
    state.textResults = [true];
    expect(await sendConfirmation('org1', '+919876543210', 'body')).toBe(true);
    expect(state.templateCalls).toEqual([]);
  });
});
