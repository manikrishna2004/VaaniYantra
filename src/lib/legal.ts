// The published version of our customer-facing legal documents.
//
// Recorded against every organisation that accepts them (Organization.termsVersion),
// so "did this clinic agree, and to what wording?" has an answer that survives
// the documents changing. Without a version, acceptance evidence decays into
// "they agreed to whatever was on the site at the time" — which is exactly the
// question that gets asked in a dispute.
//
// ⚠ BUMP THIS when /terms, /privacy or /dpa change MATERIALLY — new data
// categories, new sub-processor types, changed retention, changed liability, or
// any change to what the clinic is responsible for. Do not bump it for typos or
// formatting: a version change is a claim that the deal moved, and inflating it
// makes existing acceptances look stale for no reason.
//
// Dated to the documents' own "Last updated" line so the two cannot drift.
//
// 2026-08-27 — SMS was removed. This clears the bar above on two counts, so the
// bump is deliberate rather than cosmetic: message content that used to reach
// the telephony carrier (appointment messages AND patient portal sign-in codes)
// now reaches Meta instead, which moves WhatsApp from an optional sub-processor
// to a required one; and TRAI/DLT sender registration stopped being something
// the clinic is responsible for, which is a change to their obligations.
export const LEGAL_VERSION = '2026-08-27';

// What accepting actually covers. Kept here rather than inlined in the signup
// copy so the audit record and the checkbox can never describe different things.
export const LEGAL_DOCUMENTS = ['/terms', '/privacy', '/dpa', '/patient-notice'] as const;
