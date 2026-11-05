import { describe, it, expect } from 'vitest';
import { getPlatformDefaultCloudConfig, type MetaConfig } from '@/lib/whatsapp-cloud';
import {
  apptConfirmationTemplate,
  ownerAlertTemplate,
  summariseFields,
  WA_TEMPLATE_LANG,
} from '@/lib/whatsapp-templates';

// The shared-number model: one platform phone number sends every business's
// notifications, and proactive (business-initiated) sends go via approved
// templates whose parameter order must match the code.

function meta(overrides: Partial<MetaConfig> = {}): MetaConfig {
  return {
    appId: 'app',
    appSecret: 'sec',
    configId: 'cfg',
    verifyToken: 'vt',
    graphVersion: 'v21.0',
    wabaId: null,
    systemUserToken: null,
    defaultPhoneNumberId: null,
    ...overrides,
  };
}

describe('getPlatformDefaultCloudConfig', () => {
  it('returns null until WABA + system token + default number are all set', () => {
    expect(getPlatformDefaultCloudConfig(meta())).toBeNull();
    expect(getPlatformDefaultCloudConfig(meta({ wabaId: 'w' }))).toBeNull();
    expect(getPlatformDefaultCloudConfig(meta({ wabaId: 'w', systemUserToken: 't' }))).toBeNull();
  });

  it('builds a platform sender (system-user token) once fully configured', () => {
    const cfg = getPlatformDefaultCloudConfig(meta({ wabaId: 'w1', systemUserToken: 't1', defaultPhoneNumberId: 'p1' }));
    expect(cfg).toEqual({ wabaId: 'w1', phoneNumberId: 'p1', platform: true });
  });
});

describe('proactive notification templates', () => {
  it('appointment confirmation: ordered, single-line params with sensible fallbacks', () => {
    const t = apptConfirmationTemplate({ name: '  Rahul ', business: 'Smilecare Dental', service: 'Cleaning', when: 'Fri Jul 25\n3:00 PM' });
    expect(t.name).toBe('appointment_confirmation');
    expect(t.lang).toBe(WA_TEMPLATE_LANG);
    expect(t.params).toEqual(['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri Jul 25 3:00 PM']); // newline collapsed
  });

  it('appointment confirmation fills defaults for empty name/service', () => {
    const t = apptConfirmationTemplate({ business: 'Clinic' });
    expect(t.params[0]).toBe('there');
    expect(t.params[2]).toBe('your appointment');
  });

  it('owner alert carries type, business, and a single-line summary', () => {
    const t = ownerAlertTemplate({ type: 'appointment', business: 'Smilecare Dental', summary: 'Rahul — Cleaning' });
    expect(t.name).toBe('owner_alert');
    expect(t.params).toEqual(['appointment', 'Smilecare Dental', 'Rahul — Cleaning']);
  });

  it('summariseFields joins non-empty values on one line', () => {
    expect(summariseFields({ name: 'Rahul', service: 'Cleaning', when: 'Fri 3pm', empty: '' })).toBe('Rahul — Cleaning — Fri 3pm');
  });
});
