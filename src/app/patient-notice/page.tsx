// Patient notice wording, for clinics to give their own patients. Served at
// /patient-notice and linked from the sign-up acceptance and from /dpa §4.
//
// WHY THIS PAGE EXISTS. Our whole data-protection position is that the clinic is
// the Data Fiduciary and we are its Processor. Under /dpa §4 the clinic owes its
// patients notice — that an AI handles their calls, and that data is processed
// by our providers including outside India. Clinics will not write that
// themselves. If they never give notice, the fiduciary/processor split is
// paper-thin, so handing them ready wording is what makes it real.
//
// ⚠ Same rule as every other legal page: no claim without a code path. This
// describes what the software does today — 100% of calls transcribed, sentiment
// and topics derived, records readable in the patient chatbot after OTP
// verification, keyword-based emergency redirect. If the product changes, change
// this in the same commit.

import Link from 'next/link';

export const metadata = {
  title: 'Patient notice wording',
  description:
    'Ready-to-use wording clinics can give their patients about the AI assistant that answers their calls and messages.',
};

const UPDATED = 'August 27, 2026';

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-2 text-lg font-medium text-ink">{children}</h2>;
}

// The notices themselves. Kept as plain strings rather than JSX so the copy
// blocks render as something a clinic can select and paste without picking up
// markup, and so the wording lives in one place per variant.
const SHORT_NOTICE = `We use an AI assistant to answer calls and messages at this practice.

Calls to this number are answered by an AI assistant. Calls and messages are recorded and written down so we have an accurate record, and are handled by our technology providers, including outside India. The assistant books appointments and answers general questions — it is not a doctor and does not give medical advice. In an emergency, hang up and call your nearest hospital or emergency number. Ask at any time to speak to a person, or to have your information corrected or removed.`;

const FULL_NOTICE = `How we use an AI assistant

To answer your calls and messages more quickly, this practice uses an AI assistant provided by VaaniYantra.

What it does. It answers our phone and our WhatsApp number, books and reschedules appointments, sends reminders, and answers general questions about the practice. If you use the patient chatbot we may give you, it can also tell you about your own prescriptions, advice and visit history after you confirm your identity with a one-time code we send you on WhatsApp.

What is recorded. Calls and messages are recorded and transcribed so we have an accurate record of what was said. This happens on every call. We also keep your name, mobile number, date of birth and the clinical records our doctors write for you.

Who else sees it. Your information is handled by our technology providers so the service can work — including AI, telephone, messaging and hosting providers. Some of them process data outside India. It is not sold, not used for advertising, and not used to train AI models.

What it is not. The assistant is not a doctor. It does not diagnose, does not give medical advice, and must not be relied on in an emergency. If you have a medical emergency, hang up and call your nearest hospital or emergency number.

Your choices. You can ask to speak to a member of staff instead of the assistant at any time. You can ask us to correct or delete your information, or to stop your access to the patient chatbot. Contact us at [PRACTICE PHONE / EMAIL] and we will help.`;

const SPOKEN_LINE = `Just so you know, our phone is answered by an AI assistant and the call is recorded. If you'd rather speak to a person, tell it at any time and it'll put you through.`;

function CopyBlock({ text }: { text: string }) {
  return (
    <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-4 font-sans text-sm leading-relaxed text-ink">
      {text}
    </pre>
  );
}

export default function PatientNoticePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Patient notice wording</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>

      <section className="mt-8 space-y-5 text-sm leading-relaxed text-ink-soft">
        <p>
          This page is for our customers, not for patients. Under our{' '}
          <Link href="/dpa" className="text-primary underline">
            Data Processing Addendum
          </Link>{' '}
          your practice is the Data Fiduciary for your patients&rsquo; data and is responsible for telling them how it
          is handled. Below is wording you can use, so that obligation is a five-minute job rather than a legal
          project.
        </p>
        <p className="rounded-lg border border-border bg-surface-2 p-4">
          <strong>Please actually display one of these.</strong> If your patients are never told that an AI answers
          your phone and that calls are recorded, the arrangement between us does not hold up — for you or for us.
          Displaying it costs nothing and is the single most useful thing you can do for your own compliance.
        </p>

        <H>1. Short notice — reception desk, intake form, appointment message</H>
        <p>
          The minimum. Put it where a patient sees it before or while they call: a card at reception, a line on your
          registration form, the footer of your website&rsquo;s contact page.
        </p>
        <CopyBlock text={SHORT_NOTICE} />

        <H>2. Full notice — website page or patient information sheet</H>
        <p>
          Use this where you have room, and link to it from your website. Replace the bracketed placeholder with your
          own contact details before you publish it.
        </p>
        <CopyBlock text={FULL_NOTICE} />

        <H>3. Spoken line — for your staff</H>
        <p>
          When a patient rings your practice directly and staff transfer them, or when you introduce the service to a
          regular patient, this is enough.
        </p>
        <CopyBlock text={SPOKEN_LINE} />

        <H>Where to put it</H>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>A printed card at the reception desk, facing the patient.</li>
          <li>Your patient registration or intake form, above the signature line.</li>
          <li>Your practice website, on the contact or appointments page.</li>
          <li>Your Google Business profile description, if you have one.</li>
          <li>
            If you register a family member as a dependant on someone else&rsquo;s mobile number, tell the guardian
            that anyone who can receive a code on that number will be able to see the records of everyone registered
            on it.
          </li>
        </ul>

        <H>Children</H>
        <p>
          If you register patients under 18, the consent needed for a child&rsquo;s data is yours to obtain and record
          — we do not verify a patient&rsquo;s age. Add a line to your registration form capturing the
          guardian&rsquo;s consent, and keep it with your records.
        </p>

        <H>Two things to get right</H>
        <p>
          <strong>Do not describe the assistant as a doctor, a nurse, or as giving medical advice</strong>, in this
          notice or in your marketing. It books, reminds, and answers questions about your practice and a
          patient&rsquo;s own released records. It is instructed to redirect anyone describing an emergency, but that
          is a keyword backstop and not triage — never present it as a safety mechanism.
        </p>
        <p>
          <strong>Keep it accurate as you change settings.</strong> If you turn the patient chatbot off, drop that
          sentence. If you enable WhatsApp, keep it in.
        </p>

        <H>Questions</H>
        <p>
          If your own legal adviser wants detail on what we hold and where it goes, point them at our{' '}
          <Link href="/privacy" className="text-primary underline">
            Privacy Policy
          </Link>
          ,{' '}
          <Link href="/dpa" className="text-primary underline">
            DPA
          </Link>{' '}
          and{' '}
          <Link href="/subprocessors" className="text-primary underline">
            sub-processor list
          </Link>
          , or write to{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>
          .
        </p>
        <p className="text-xs text-muted">
          This wording is provided as a practical starting point and is not legal advice. Your own adviser should
          confirm it is right for your practice.
        </p>
      </section>
    </main>
  );
}
