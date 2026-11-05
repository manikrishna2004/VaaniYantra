// Meta-approved WhatsApp message templates for proactive (business-initiated)
// notifications — booking confirmations, owner alerts, reminders.
//
// WHY: a phone call never opens a WhatsApp customer-service window, so any
// message the platform sends afterwards is "business-initiated" and Meta ONLY
// delivers it as a pre-approved template. Free text is rejected. These
// descriptors carry the template `name`, `lang`, and the ORDERED parameter list
// that fills the template's {{1}}, {{2}}, … placeholders.
//
// IMPORTANT: the `name`, `lang`, and parameter ORDER below MUST exactly match
// the templates you create + get approved in WhatsApp Manager, or Meta rejects
// the send. Create each template with the suggested body shown above its
// builder, in the Utility category. WhatsApp template parameters CANNOT contain
// newlines, tabs, or 4+ consecutive spaces — the `p()` helper collapses these.

export type WaTemplate = {
  name: string;
  lang: string;
  params: string[];
  /**
   * Set only by authentication templates. Meta's copy-code button is a URL
   * button whose parameter is the code AGAIN — the body parameter fills the
   * message text, this one fills what the button copies to the clipboard. Omit
   * it and Meta rejects the send for a missing button component.
   */
  otpCode?: string;
};

// Collapse whitespace so a value is a valid single-line template parameter.
const p = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

// The language code your approved templates use. WhatsApp is picky: this must be
// the exact locale you selected when creating the template (e.g. "en_US", "en").
export const WA_TEMPLATE_LANG = 'en_US';

// ── Confirmation → the customer ─────────────────────────────────────────────
//
// Named appointment_confirmation because a template's name is fixed once
// created, but it is no longer only about appointments: the same four slots now
// carry an enquiry acknowledgement (see enquiryReceivedTemplate below). Keeping
// ONE approved utility template for "we have your thing, here are the details"
// was a deliberate choice — the alternative is a second template and a second
// review queue for every flow that ever needs to confirm anything.
//
// The cost is in the wording. "is confirmed on {{4}}" could not survive, because
// an enquiry has no time to be confirmed on, so the sentence loosened to a
// dash-separated detail that both flows can fill. A booking still reads
// correctly; it just states the time rather than promising it.
//
// {{3}} is the thing ("appointment for Cleaning", "enquiry"), {{4}} its detail
// (the time, or where the caller's project is). Both are composed by the sender
// functions, never by a caller, so neither can arrive empty — which Meta
// rejects outright.
//
// Create in WhatsApp Manager (Utility), body EXACTLY:
//   Hi {{1}}, {{2}} has confirmed your {{3}} — {{4}}. Thank you!
// Sample values: {{1}} Rahul  {{2}} Smilecare Dental  {{3}} appointment for Cleaning  {{4}} Fri, Jul 25, 3:00 PM
export function apptConfirmationTemplate(a: {
  name?: string | null;
  business?: string | null;
  service?: string | null;
  when?: string | null;
}): WaTemplate {
  return {
    name: 'appointment_confirmation',
    lang: WA_TEMPLATE_LANG,
    params: [p(a.name) || 'there', p(a.business), p(a.service) || 'your appointment', p(a.when)],
  };
}

// ── Appointment confirmation carrying the patient-portal link ───────────────
// The same confirmation, plus the clinic's chatbot address, where the patient
// can later re-read their prescription and ask questions. The link carries no
// secret — they sign in there with a code sent to this same number.
//
// This is a SEPARATE template rather than a fifth parameter on the one above,
// because an approved template cannot gain a placeholder — editing it sends it
// back for review and confirmations would stop until Meta re-approves. Ship
// this one alongside; sendConfirmation prefers it and silently falls back to
// `appointment_confirmation` until this is approved.
//
// Create in WhatsApp Manager (Utility), body EXACTLY:
//   Hi {{1}}, your appointment with {{2}} for {{3}} is confirmed on {{4}}. View your records and ask us anything here: {{5}} — see you soon!
// Sample values: {{1}} Rahul  {{2}} Smilecare Dental  {{3}} Cleaning  {{4}} Fri, Jul 25, 3:00 PM  {{5}} https://vaaniyantra.com/c/smilecare
export function apptConfirmationPortalTemplate(a: {
  name?: string | null;
  business?: string | null;
  service?: string | null;
  when?: string | null;
  portal?: string | null;
}): WaTemplate {
  return {
    name: 'appointment_confirmation_portal',
    lang: WA_TEMPLATE_LANG,
    params: [
      p(a.name) || 'there',
      p(a.business),
      p(a.service) || 'your appointment',
      p(a.when),
      p(a.portal),
    ],
  };
}

// ── Appointment reminder → the customer ─────────────────────────────────────
// Create in WhatsApp Manager (Utility), body EXACTLY:
//   Reminder: your appointment with {{1}} for {{2}} is on {{3}}. See you soon!
// Sample values: {{1}} Smilecare Dental  {{2}} Cleaning  {{3}} Fri, Jul 25, 3:00 PM
export function apptReminderTemplate(a: {
  business?: string | null;
  service?: string | null;
  when?: string | null;
}): WaTemplate {
  return {
    name: 'appointment_reminder',
    lang: WA_TEMPLATE_LANG,
    params: [p(a.business) || 'us', p(a.service) || 'your appointment', p(a.when)],
  };
}

// ── Appointment moved → the customer ────────────────────────────────────────
// Reschedules previously sent free text, which Meta rejects for a
// business-initiated message — so every WhatsApp clinic's "moved to" notice
// silently degraded to SMS. This is that message as an approved template.
//
// Create in WhatsApp Manager (Utility), body EXACTLY:
//   Hi {{1}}, your appointment with {{2}} for {{3}} has been moved to {{4}}. See you then!
// Sample values: {{1}} Rahul  {{2}} Smilecare Dental  {{3}} Cleaning  {{4}} Fri, Jul 25, 3:00 PM
export function apptRescheduledTemplate(a: {
  name?: string | null;
  business?: string | null;
  service?: string | null;
  when?: string | null;
}): WaTemplate {
  return {
    name: 'appointment_rescheduled',
    lang: WA_TEMPLATE_LANG,
    params: [
      p(a.name) || 'there',
      p(a.business) || 'us',
      p(a.service) || 'your appointment',
      p(a.when),
    ],
  };
}

// ── Appointment cancelled → the customer ────────────────────────────────────
// Same story as the reschedule above: free text, so WhatsApp clinics fell back
// to SMS for every cancellation.
//
// The business name is carried even though the old SMS text omitted it. On the
// shared platform sender the message does not arrive from the clinic's own
// number, so without it the patient is told an appointment is cancelled with no
// indication of which clinic means it.
//
// Create in WhatsApp Manager (Utility), body EXACTLY:
//   Hi {{1}}, your appointment with {{2}} for {{3}} on {{4}} has been cancelled. Contact us to book a new time.
// Sample values: {{1}} Rahul  {{2}} Smilecare Dental  {{3}} Cleaning  {{4}} Fri, Jul 25, 3:00 PM
export function apptCancelledTemplate(a: {
  name?: string | null;
  business?: string | null;
  service?: string | null;
  when?: string | null;
}): WaTemplate {
  return {
    name: 'appointment_cancelled',
    lang: WA_TEMPLATE_LANG,
    params: [
      p(a.name) || 'there',
      p(a.business) || 'us',
      p(a.service) || 'your appointment',
      p(a.when),
    ],
  };
}

// ── Sign-in code → the patient ──────────────────────────────────────────────
// AUTHENTICATION category, whose format Meta FIXES: it generates the body text
// itself from `add_security_recommendation`, and accepts exactly one parameter —
// the code. There is no room for a business name, which is why this takes only
// the code now. The rendered message reads:
//   <CODE> is your verification code. For your security, do not share this code.
//   This code expires in 5 minutes.        [ Copy code ]
//
// `business` is still accepted and ignored, so the two call sites did not have
// to change in lockstep with this and an old caller cannot silently pass a value
// into a slot that no longer exists.
export function otpTemplate(a: { code: string; business?: string | null }): WaTemplate {
  const code = p(a.code);
  return {
    name: 'patient_signin_code',
    lang: WA_TEMPLATE_LANG,
    params: [code],
    otpCode: code,
  };
}

// ── Generic outcome alert → the business owner ──────────────────────────────
// Create in WhatsApp Manager (Utility), body EXACTLY:
//   New {{1}} for {{2}}: {{3}}. Log in to see the full details.
// Sample values: {{1}} appointment  {{2}} Smilecare Dental  {{3}} Rahul - Cleaning, Fri Jul 25 3:00 PM
// NOTE the trailing sentence: Meta rejects a template body that ENDS with a
// variable, so every body here must close with literal text.
export function ownerAlertTemplate(a: {
  type?: string | null;
  business?: string | null;
  summary?: string | null;
}): WaTemplate {
  return {
    name: 'owner_alert',
    lang: WA_TEMPLATE_LANG,
    params: [p(a.type) || 'update', p(a.business) || 'your business', p(a.summary)],
  };
}

// ── Enquiry received → the caller ───────────────────────────────────────────
// The "thanks, we have your details, someone will be in touch" message that
// follows a captured lead. It was the org's own callerTemplate text, sent as
// free text — and a phone call opens no customer-service window, so Meta
// rejected it and nothing said so. deliverOutcome logged a dropped message and
// the caller heard the agent promise a WhatsApp that never arrived.
//
// Three fixed parameters, and deliberately none of the captured fields: an
// outcome's fields are named by the owner, so folding them in would risk both an
// empty parameter (which Meta rejects) and whatever the owner happened to call a
// field arriving on the customer's phone. The details go to the owner, who is
// the one who has to act on them.
//
// Create in WhatsApp Manager (Utility), body EXACTLY:
//   Hi {{1}}, thanks for your interest in {{2}}. We have noted your {{3}} and our team will contact you shortly.
// Sample values: {{1}} Rahul  {{2}} PARE India  {{3}} enquiry
export function enquiryReceivedTemplate(a: {
  name?: string | null;
  business?: string | null;
  type?: string | null;
  /** What was captured, already one line — e.g. "Kokapet, Hyderabad, 500751". */
  detail?: string | null;
}): WaTemplate {
  return {
    name: 'enquiry_registered',
    lang: WA_TEMPLATE_LANG,
    // Order follows the body's placeholders, which Meta reads positionally.
    params: [
      p(a.name) || 'there',
      p(a.type) || 'enquiry',
      p(a.business) || 'us',
      // Never empty: an outcome can carry nothing but a name, and Meta rejects
      // the whole send on a blank parameter.
      p(a.detail) || 'the details you gave us',
    ],
  };
}

// Build a one-line owner summary from an outcome's fields (order-preserving,
// skips empties) — safe as a single template parameter.
export function summariseFields(fields: Record<string, string>): string {
  return p(
    Object.values(fields)
      .map((v) => p(v))
      .filter(Boolean)
      .join(' — '),
  );
}

// ── Provisionable definitions (for own-brand WABAs) ─────────────────────────
//
// A business that connects its own number through Embedded Signup gets a WABA
// with NO templates in it, so every proactive message would be rejected until
// somebody created them by hand. As a Meta Tech Provider we can create them on
// the customer's behalf — see createTemplate() in whatsapp-cloud.ts.
//
// These payloads are the SAME bodies documented above each descriptor. Keeping
// them here, next to the senders, is deliberate: a body that drifts from its
// descriptor's parameter order is rejected by Meta at send time with a generic
// error, which is a miserable thing to debug. Change one, change both.
//
// `example.body_text` is required by Meta — reviewers see these sample values.

export type WaTemplateDefinition = {
  name: string;
  language: string;
  category: 'UTILITY' | 'AUTHENTICATION' | 'MARKETING';
  /** Empty for AUTHENTICATION — Meta composes that body itself. */
  body: string;
  example: string[];
  /** AUTHENTICATION only: footer wording, and the copy-code button's label. */
  codeExpirationMinutes?: number;
  otpButtonText?: string;
};

export const WA_TEMPLATE_DEFINITIONS: WaTemplateDefinition[] = [
  {
    name: 'appointment_confirmation',
    language: WA_TEMPLATE_LANG,
    category: 'UTILITY',
    body: 'Hi {{1}}, your appointment with {{2}} for {{3}} is confirmed on {{4}}. Thank you!',
    example: ['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM'],
  },
  {
    name: 'appointment_confirmation_portal',
    language: WA_TEMPLATE_LANG,
    category: 'UTILITY',
    body: 'Hi {{1}}, your appointment with {{2}} for {{3}} is confirmed on {{4}}. View your records and ask us anything here: {{5}} — see you soon!',
    example: ['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM', 'https://vaaniyantra.com/c/smilecare'],
  },
  {
    name: 'appointment_reminder',
    language: WA_TEMPLATE_LANG,
    category: 'UTILITY',
    body: 'Reminder: your appointment with {{1}} for {{2}} is on {{3}}. See you soon!',
    example: ['Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM'],
  },
  {
    name: 'appointment_rescheduled',
    language: WA_TEMPLATE_LANG,
    category: 'UTILITY',
    body: 'Hi {{1}}, your appointment with {{2}} for {{3}} has been moved to {{4}}. See you then!',
    example: ['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM'],
  },
  {
    name: 'appointment_cancelled',
    language: WA_TEMPLATE_LANG,
    category: 'UTILITY',
    body: 'Hi {{1}}, your appointment with {{2}} for {{3}} on {{4}} has been cancelled. Contact us to book a new time.',
    example: ['Rahul', 'Smilecare Dental', 'Cleaning', 'Fri, Jul 25, 3:00 PM'],
  },
  {
    // Meta generates the body and the footer; we choose only the expiry wording
    // and the button label. `example` is empty because there is no body of ours
    // for a reviewer to see.
    name: 'patient_signin_code',
    language: WA_TEMPLATE_LANG,
    category: 'AUTHENTICATION',
    body: '',
    example: [],
    codeExpirationMinutes: 5,
    otpButtonText: 'Copy code',
  },
  {
    name: 'owner_alert',
    language: WA_TEMPLATE_LANG,
    category: 'UTILITY',
    // Meta rejects a body that ENDS with a variable, hence the closing sentence.
    body: 'New {{1}} for {{2}}: {{3}}. Log in to see the full details.',
    example: ['appointment', 'Smilecare Dental', 'Rahul - Cleaning, Fri Jul 25 3:00 PM'],
  },
  {
    // A NEW NAME, not a reword of enquiry_received. Meta's category is fixed
    // at approval and cannot be edited afterwards — an edit carrying `category`
    // is rejected outright with subcode 3835031, "You cannot update an approved
    // template category", while the same edit without it succeeds and leaves the
    // category exactly as it was. So a template that Meta filed as MARKETING is
    // MARKETING for life, and the only way to get the same message sent as
    // UTILITY is a fresh template whose wording earns it. enquiry_received is
    // left in place, unused: deleting it would lock its name for 30 days.
    name: 'enquiry_registered',
    language: WA_TEMPLATE_LANG,
    category: 'UTILITY',
    // WORDING IS LOAD-BEARING HERE. Meta re-categorises a submitted template
    // from its content, and the first version of this one — "thanks for your
    // interest in {{2}}, we have noted your {{3}} and our team will contact you
    // shortly" — was filed as MARKETING despite being submitted as UTILITY.
    //
    // That is not cosmetic. Marketing messages are subject to a per-user
    // frequency cap, so sends came back 131049 ("not delivered to maintain
    // healthy ecosystem engagement"), and they are never free, so they also hit
    // 131042 on an account with no payment method. Every genuinely-UTILITY
    // template on this WABA delivered throughout.
    //
    // So this reads as a record of something the caller just did, which is what
    // UTILITY means: no "thanks for your interest", no pitch, no adjectives.
    body: 'Hi {{1}}, your {{2}} with {{3}} has been registered. Details: {{4}}. Our team will call you on this number to take it forward.',
    example: ['Srikanth', 'enquiry', 'PARE India', 'Kokapet, Hyderabad, 500751'],
  },
];

// Every template is provisioned now. `patient_signin_code` used to be excluded
// for a good reason: otpTemplate() sent two parameters (code + business) and
// Meta's fixed AUTHENTICATION format accepts exactly one, so creating it would
// have produced a template that is approved but rejects every send. Dropping the
// business name resolved that, so the exclusion list — and the SMS fallback that
// quietly carried every sign-in code because of it — is gone.
