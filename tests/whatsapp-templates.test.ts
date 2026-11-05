import { describe, it, expect } from 'vitest';
import {
  apptConfirmationTemplate,
  apptRescheduledTemplate,
  apptCancelledTemplate,
  enquiryReceivedTemplate,
  WA_TEMPLATE_DEFINITIONS,
  WA_TEMPLATE_LANG,
} from '@/lib/whatsapp-templates';

// Behaviour of the two descriptors themselves. The body/placeholder/example
// invariants they share with every other template are owned by the guard in
// whatsapp-own-number.test.ts, which both are now registered with.

const defFor = (name: string) => WA_TEMPLATE_DEFINITIONS.find((d) => d.name === name);

describe('appointment_rescheduled', () => {
  it('fills name, business, service and the new time in that order', () => {
    const t = apptRescheduledTemplate({
      name: 'Rahul',
      business: 'Smilecare Dental',
      service: 'Cleaning',
      when: 'Fri, Jul 25, 3:00 PM',
    });
    expect(t.name).toBe('appointment_rescheduled');
    expect(t.lang).toBe(WA_TEMPLATE_LANG);
    expect(t.params).toEqual(['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM']);
  });

  it('never emits an empty parameter when the caller has no name or business', () => {
    const t = apptRescheduledTemplate({ when: 'Fri, Jul 25, 3:00 PM' });
    expect(t.params.slice(0, 3)).toEqual(['there', 'us', 'your appointment']);
  });

  it('is provisionable, and its body takes exactly its parameter count', () => {
    const def = defFor('appointment_rescheduled');
    expect(def?.category).toBe('UTILITY');
    expect(def!.example).toHaveLength(4);
  });
});

describe('appointment_cancelled', () => {
  it('carries the business name so a shared-sender message says who it is from', () => {
    const t = apptCancelledTemplate({
      name: 'Rahul',
      business: 'Smilecare Dental',
      service: 'Cleaning',
      when: 'Fri, Jul 25, 3:00 PM',
    });
    expect(t.params).toEqual(['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM']);
  });

  it('collapses whitespace — a template parameter cannot contain newlines', () => {
    const t = apptCancelledTemplate({ name: 'Ravi\n Kumar', service: 'Root   canal', when: 'x' });
    expect(t.params[0]).toBe('Ravi Kumar');
    expect(t.params[2]).toBe('Root canal');
  });
});
describe('enquiry_registered', () => {
  it('fills the caller, what it was, who with, and the details — in that order', () => {
    // Meta reads parameters by POSITION against the body's placeholders, so the
    // order here is the body's order, not a natural-sounding one.
    const t = enquiryReceivedTemplate({
      name: 'Srikanth', business: 'PARE India', type: 'enquiry', detail: 'Kokapet, Hyderabad, 500751',
    });
    expect(t.name).toBe('enquiry_registered');
    expect(t.lang).toBe(WA_TEMPLATE_LANG);
    expect(t.params).toEqual(['Srikanth', 'enquiry', 'PARE India', 'Kokapet, Hyderabad, 500751']);
  });

  it('never emits an empty parameter', () => {
    // The caller can decline a name, an outcome can be delivered with no
    // business name, and an enquiry can carry no detail at all. Meta rejects the
    // whole send on one empty parameter, so every slot needs a fallback.
    expect(enquiryReceivedTemplate({}).params).toEqual([
      'there', 'enquiry', 'us', 'the details you gave us',
    ]);
  });

  it('reads as a record of something that happened, not as a pitch', () => {
    // LOAD-BEARING. Meta re-categorises from content: the first version said
    // "thanks for your interest in {{2}} … our team will contact you shortly"
    // and was filed as MARKETING despite being submitted as UTILITY. Marketing
    // is capped per user and never free, so it failed with 131049 and 131042
    // while every real UTILITY template on the same WABA delivered.
    const def = defFor('enquiry_registered');
    expect(def?.category).toBe('UTILITY');
    expect(def!.body).toMatch(/has been registered/);
    expect(def!.body).not.toMatch(/thanks for your interest/i);
    expect(def!.example).toHaveLength(4);
  });
});

describe('appointment_confirmation', () => {
  it('is unchanged — the clinics depend on it and it delivers', () => {
    // It was briefly generalised to carry enquiries too. That was the wrong
    // trade: it weakened a working booking confirmation, put live clinic
    // messaging into review, and would not have fixed delivery anyway, because
    // the real fault was the enquiry template's CATEGORY.
    const t = apptConfirmationTemplate({
      name: 'Rahul', business: 'Smilecare Dental', service: 'Cleaning', when: 'Fri, Jul 25, 3:00 PM',
    });
    expect(t.params).toEqual(['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM']);
    expect(defFor('appointment_confirmation')!.body).toContain('is confirmed on');
  });
});
