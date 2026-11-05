// Public sub-processor list. Served at /subprocessors, referenced by /privacy
// and /dpa, and asked for in every hospital procurement review.
//
// ⚠ This list must match reality. Each row below was confirmed against the code
// that makes the call — if you add an integration that transmits personal data,
// add it here in the same commit. "Core" means the platform cannot run without
// it; "optional" means a customer connects it deliberately.

import Link from 'next/link';

export const metadata = {
  title: 'Sub-processors',
  description:
    'Every third party that processes personal data on behalf of VaaniYantra customers, what each receives, and where.',
};

const UPDATED = 'August 27, 2026';

type Row = { name: string; purpose: string; data: string; location: string };

const CORE: Row[] = [
  {
    name: 'Google — Gemini & Gemini Live',
    purpose: 'The AI that answers calls and messages, and summarises calls afterwards',
    data:
      'Caller audio in real time during a call; call transcripts; the agent’s instructions and retrieved knowledge-base text. In the patient chatbot: patient name, age, sex, recorded allergies and released visit history including prescriptions.',
    location: 'Global endpoints (may process outside India)',
  },
  {
    name: 'Google Cloud Speech-to-Text & Text-to-Speech',
    purpose: 'Transcribing callers and giving the agent a voice, where the realtime model is not used',
    data: 'Caller audio; the text the agent is about to speak',
    location: 'Global endpoints (may process outside India)',
  },
  {
    name: 'Google Firebase Authentication',
    purpose: 'Sign-in for clinic staff',
    data: 'Staff email address and authentication credentials. Patients never use this — they sign in with a one-time code.',
    location: 'Google, global',
  },
  {
    name: 'Google Cloud Platform',
    purpose: 'Hosting: application servers, the database, and encrypted nightly backups',
    data: 'All data held by the service',
    location: 'United States (us-east1)',
  },
  {
    name: 'Telephony carrier — Twilio, Plivo or Exotel',
    purpose: 'Carrying phone calls. Which one applies depends on the number.',
    data:
      'Caller and recipient phone numbers; call audio in transit. Where the carrier records a call, the audio is held in that carrier’s account, not ours. Carriers no longer carry SMS: appointment messages and patient sign-in codes are sent on WhatsApp instead, and go to Meta rather than to the carrier.',
    location: 'Twilio and Plivo: global (United States). Exotel: India.',
  },
  {
    name: 'Meta — WhatsApp Cloud API',
    purpose:
      'Sending every message this service sends a patient: appointment confirmations, reminders, reschedules, cancellations and patient portal sign-in codes, plus receiving replies',
    data:
      'Patient phone number; message content; template values such as first name, clinic name, service, appointment time and the patient portal link; the one-time code a patient uses to sign in to the portal',
    location: 'Global endpoints',
  },
  {
    name: 'Cashfree Payments',
    purpose: 'Taking subscription payments',
    data: 'Billing name, email and phone of the clinic account. No patient data.',
    location: 'India',
  },
];

const OPTIONAL: Row[] = [
  {
    name: 'Google Calendar',
    purpose: 'Booking appointments into a clinic’s or doctor’s calendar',
    data: 'Patient name, full phone number, the service booked, the doctor’s name, and any notes the agent captured',
    location: 'Global endpoints',
  },
  {
    name: 'HubSpot',
    purpose: 'Pushing completed calls into a clinic’s CRM',
    data: 'Caller phone number and derived contact fields; the AI call summary, sentiment, all collected fields, and a link to the recording',
    location: 'Global endpoints (United States)',
  },
  {
    name: 'Deepgram',
    purpose: 'Alternative speech recognition and voice, where a clinic supplies a key',
    data: 'Caller audio; the text the agent is about to speak',
    location: 'Global endpoints (United States)',
  },
  {
    name: 'ElevenLabs',
    purpose: 'Alternative voice, where a clinic supplies a key',
    data: 'The text the agent is about to speak',
    location: 'Global endpoints (United States)',
  },
  {
    name: 'Email delivery (Resend or your SMTP server)',
    purpose: 'Sending team invitations',
    data: 'Staff email address, inviter name, organisation name. No patient data.',
    location: 'Depends on provider',
  },
  {
    name: 'Endpoints you configure yourself',
    purpose: 'Webhooks and the public API, where a clinic connects its own systems',
    data:
      'Whatever that endpoint is entitled to receive — call details including numbers, transcripts and summaries, appointment details including the patient number, and, through the API, full clinical records. A destination you choose is your responsibility, not ours.',
    location: 'Wherever you send it',
  },
];

function Table({ rows }: { rows: Row[] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-4 font-medium">Provider</th>
            <th className="py-2 pr-4 font-medium">Purpose</th>
            <th className="py-2 pr-4 font-medium">Data it receives</th>
            <th className="py-2 font-medium">Processing location</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-border/60 align-top">
              <td className="py-3 pr-4 font-medium text-ink">{r.name}</td>
              <td className="py-3 pr-4">{r.purpose}</td>
              <td className="py-3 pr-4">{r.data}</td>
              <td className="py-3">{r.location}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SubprocessorsPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Sub-processors</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>

      <section className="mt-8 space-y-5 text-sm leading-relaxed text-ink-soft">
        <p>
          These are the third parties that process personal data on behalf of VaaniYantra customers. It is the list
          referenced by our{' '}
          <Link href="/privacy" className="text-primary underline">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link href="/dpa" className="text-primary underline">
            Data Processing Addendum
          </Link>
          .
        </p>
        <p className="rounded-lg border border-border bg-surface-2 p-4">
          <strong>Processing outside India.</strong> Our servers, database and backups are in the United States, and
          most of the providers below are reached on global endpoints. Patient data handled through this service is
          therefore processed outside India. If that does not work for your practice, tell us before you onboard.
        </p>

        <h2 className="pt-2 text-lg font-medium text-ink">Core — required for the service to work</h2>
        <Table rows={CORE} />

        <h2 className="pt-6 text-lg font-medium text-ink">Optional — only if you connect them</h2>
        <p>
          These are off unless a clinic turns them on. If you do not connect them, no data reaches them.
        </p>
        <Table rows={OPTIONAL} />

        <h2 className="pt-6 text-lg font-medium text-ink">Changes</h2>
        <p>
          We will update this page before a new sub-processor begins handling customer data, and notify customers of
          material additions. If you object to a new sub-processor, contact us — your remedy is to stop using the
          affected feature, or to end your subscription.
        </p>
        <p>
          Questions:{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>
          .
        </p>
      </section>
    </main>
  );
}
