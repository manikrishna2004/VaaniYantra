// Public privacy policy — required by Meta App Review / Google OAuth / app stores,
// and by the DPDP Act 2023 and the IT Act SPDI Rules. Served at /privacy. Keep
// this URL stable: it is registered in the Meta app's Basic settings.
//
// ⚠ EVERY FACTUAL CLAIM ON THIS PAGE IS TRACEABLE TO CODE. It is written against
// what the system actually does, not what we would like it to do — a privacy
// notice that overstates practice is itself a violation. If you change what the
// product does with personal data, change this page in the same commit. The
// known gaps between this page and an ideal posture are tracked, deliberately,
// in COMPLIANCE_GAPS.md rather than papered over here.

import Link from 'next/link';

export const metadata = {
  title: 'Privacy Policy',
  description:
    'How VaaniYantra handles personal and health data for clinics and their patients, under the DPDP Act 2023.',
};

const UPDATED = 'August 27, 2026';

// TODO(founder): a Grievance Officer must be named to satisfy DPDP s.13 and
// Rule 5(9) of the SPDI Rules. Replace the placeholder with a real person and a
// monitored address before this page is relied on in a hospital contract.
const GRIEVANCE_OFFICER = {
  name: 'Baliji Manikanta',
  title: 'Grievance Officer',
  email: 'info@vaaniyantra.com',
};

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-2 text-lg font-medium text-ink">{children}</h2>;
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>

      <section className="mt-8 space-y-5 text-sm leading-relaxed text-ink-soft">
        <p>
          VaaniYantra provides AI receptionists that answer calls and messages for clinics and hospitals. Because
          that work touches patients&rsquo; medical information, this policy is deliberately specific about what we
          hold, where it goes, and what we can and cannot do on request.
        </p>

        <H>Who is responsible for what</H>
        <p>
          Two different relationships run through this service, and the distinction decides who you should approach.
        </p>
        <p>
          <strong>For patient data, the clinic is the Data Fiduciary and we are a Data Processor.</strong> The clinic
          decides which patients to record, what to record about them, and why. We act on the clinic&rsquo;s
          instructions. If you are a patient and want your records corrected or erased, ask the clinic — they control
          the record. If you approach us directly we will route your request to them and support them in answering it.
        </p>
        <p>
          <strong>For the clinic&rsquo;s own account, we are the Data Fiduciary.</strong> Staff names and email
          addresses, billing details, invoices and audit logs are ours to answer for, and you can raise those with us
          directly.
        </p>

        <H>What we hold</H>
        <p>
          <strong>Clinic staff accounts</strong> — name, email address, the organisation you belong to, your role, and
          sign-in identity (handled by Google Firebase Authentication; we never see your password).
        </p>
        <p>
          <strong>Billing details</strong> — business name, address, GSTIN where supplied, contact email and phone, and
          the invoices we are required to issue. Card details are handled by our payment gateway and never reach us.
        </p>
        <p>
          <strong>Patient records the clinic keeps here</strong> — name, mobile number, email, date of birth, sex, the
          clinic&rsquo;s own patient number, and household links where a clinic registers a dependant against a
          guardian&rsquo;s phone number.
        </p>
        <p>
          <strong>Health data</strong> — consultations and their diagnosis, prescriptions (both free text and
          structured medicine lines), advice, follow-up dates, clinicians&rsquo; private notes, recorded allergies, and
          documents the clinic uploads such as prescription scans, reports and discharge summaries. Under the SPDI
          Rules this is sensitive personal data and we treat it as the most restricted category we hold.
        </p>
        <p>
          <strong>Calls and messages</strong> — caller and recipient numbers, time and duration, a full transcript of
          what was said, an AI-generated summary, sentiment and topics, information the agent collected during the
          call, and messages exchanged in the patient chatbot or on WhatsApp. Where your telephony provider records a
          call, we store the link it gives us; the audio itself stays in that provider&rsquo;s account.
        </p>
        <p>
          <strong>Access records</strong> — an audit log of actions taken in the clinic&rsquo;s account, including the
          acting user and their IP address, and sign-in records for the patient portal including IP address and
          browser.
        </p>

        <H>Why we hold it</H>
        <p>
          To answer calls and messages as the clinic&rsquo;s agent, book and remind patients of appointments, show the
          clinic its call history and reports, let a patient read their own prescriptions, bill for the service,
          support customers, and keep the service secure. We do not sell personal data. We do not use patients&rsquo;
          conversations to advertise to them, and we do not use clinic or patient data to train AI models.
        </p>

        <H>Where your data is processed — including outside India</H>
        <p>
          <strong>Our servers and database are hosted with Google Cloud in the United States</strong> (region
          us-east1), and our encrypted nightly backups are stored in the same region. Several services we depend on —
          Google&rsquo;s speech and language models, and some telephony and messaging carriers — are reached on global
          endpoints that may process data outside India.
        </p>
        <p>
          This means that a patient&rsquo;s call audio, transcript and the records the clinic keeps here are processed
          outside India. If your clinic has a data-localisation requirement, tell us before you onboard so we can be
          clear about whether we can meet it. We would rather lose the sale than misdescribe this.
        </p>
        <p>
          The full list of third parties, what each receives and where it processes, is on our{' '}
          <Link href="/subprocessors" className="text-primary underline">
            sub-processor page
          </Link>
          .
        </p>

        <H>What we send to AI providers</H>
        <p>
          The service is built on Google&rsquo;s Gemini models. During a phone call the caller&rsquo;s audio is
          streamed to Google in real time so the agent can hear and answer. Afterwards the transcript is sent for
          summarising.
        </p>
        <p>
          In the patient chatbot, so the assistant can answer questions about a patient&rsquo;s own treatment, we
          include that patient&rsquo;s name, age, sex, recorded allergies and released visit history — including
          prescriptions — in the request to the model. Their date of birth is deliberately withheld from it. If a
          clinic is not comfortable with medical details reaching a model provider, the chatbot should not be enabled.
        </p>

        {/* Google's OAuth verification checklist requires five specific
            disclosures about Google user data, each stated plainly: what is
            accessed, how it is used, what is shared and with whom, how it is
            protected, and how long it is kept. They were spread across the
            sections above in terms of OUR data model; a reviewer — and a clinic
            owner deciding whether to connect their calendar — needs them in one
            place, about GOOGLE's data specifically. */}
        <H>Google user data</H>
        <p>
          A clinic may connect its Google account so the agent can book into a real calendar. This section covers that
          connection specifically, and applies only to clinics that choose to make it.
        </p>
        <p>
          <strong>What we access.</strong> With the clinic&rsquo;s consent we request three Google Calendar
          permissions and no others: the list of calendars on the account, so the clinic can choose which one to book
          into; free/busy times on that calendar, so the agent only offers slots that are genuinely free; and the
          ability to create, update and delete calendar events. We never request access to Gmail, Drive, Contacts or
          any other Google service, and we cannot read the contents of existing calendar entries — free/busy returns
          only busy time ranges, not titles, guests or notes.
        </p>
        <p>
          <strong>How we use it.</strong> Solely to run the booking feature the clinic switched on: reading
          availability to offer real appointment times, and writing, moving or cancelling the appointment events the
          agent books. We do not use Google user data for advertising, profiling, credit or lending decisions, resale,
          or any purpose other than providing these user-facing features. We do not use it to develop, improve or
          train any AI or machine-learning model, and we do not send it to a third party that would.
        </p>
        <p>
          <strong>What we share.</strong> Google user data is not sold and not shared with data brokers or
          advertisers. It reaches only the infrastructure providers needed to operate the feature: our hosting
          provider (Google Cloud), and — where the clinic has separately connected one — a destination the clinic
          itself chose, such as its own CRM or webhook endpoint, on the clinic&rsquo;s instruction. It is not shared
          with other clinics on the platform; each connection is scoped to the organisation that made it.
        </p>
        <p>
          <strong>How we protect it.</strong> The Google refresh token is encrypted at rest (AES-256-GCM) with a key
          held outside the database, and is never returned to a browser or exposed through our API. All traffic to
          Google is over TLS. Access is scoped per organisation, so one clinic&rsquo;s connection cannot be used to
          read or write another&rsquo;s calendar.
        </p>
        <p>
          <strong>How long we keep it, and how to remove it.</strong> The token is held only while the connection is
          active. Disconnecting Google Calendar in the dashboard deletes it immediately, and the clinic may also
          revoke our access at any time from their{' '}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            Google account permissions page
          </a>
          , which takes effect at once and needs nothing from us. Calendar events we created remain on the
          clinic&rsquo;s own calendar, under their control, and can be deleted there. Deleting the organisation
          removes the stored connection along with everything else we hold for it.
        </p>
        <p>
          Our use of information received from Google APIs adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>

        <H>Sharing</H>
        <p>
          We share data only with the providers needed to run the service, each under their own terms — hosting and AI
          (Google), telephony (Twilio, Plivo or Exotel, depending on the number), messaging (Meta/WhatsApp), and
          payments (Cashfree). Messages we send a patient — appointment confirmations, reminders, reschedules,
          cancellations and portal sign-in codes — all go over WhatsApp, so their content reaches Meta and not the
          telephony carrier. We no longer send SMS. Where a clinic connects an optional integration such as Google Calendar, a CRM, or
          its own webhook endpoint, data flows to that destination on the clinic&rsquo;s instruction and under the
          clinic&rsquo;s responsibility. We may disclose data where the law requires it.
        </p>

        <H>How long we keep it</H>
        <p>
          <strong>Call content:</strong> clinic owners can set a retention window, after which transcripts, summaries,
          sentiment and collected data are purged automatically. <strong>This is off by default</strong> — until a
          clinic sets a window, call content is kept indefinitely. Purging clears the recording link we hold; audio
          stored by your telephony provider must be deleted with that provider.
        </p>
        <p>
          <strong>Clinical records:</strong> patient records, consultations, prescriptions, allergies and uploaded
          documents are not deleted on a timer. They are medical records, and the clinic decides when they go.
        </p>
        <p>
          <strong>Everything else:</strong> account, billing and audit records are kept for as long as the account is
          open, and invoices for the period tax law requires. Patient portal sign-in codes and expired sessions are
          purged continuously.
        </p>

        <H>Your rights</H>
        <p>
          Under the DPDP Act you may ask for access to your personal data, correction of it, erasure, and information
          about who we have shared it with; you may nominate someone to exercise those rights on your behalf; and you
          may complain to us and then to the Data Protection Board.
        </p>
        <p>
          Two limits we would rather state than hide. First, if you are a <strong>patient</strong>, the clinic holds
          your record and decides on erasure — we act on their instruction. Second, we do not yet offer a
          self-service export of everything we hold about you; access requests are fulfilled by our team, by hand,
          within 30 days. We are building both properly rather than claiming them prematurely.
        </p>

        <H>Children&rsquo;s data</H>
        <p>
          Clinics treat children, and a clinic may register a child as a dependant on a guardian&rsquo;s mobile
          number. Where they do, that child&rsquo;s medical record sits here on the same basis as any other.
        </p>
        <p>
          We do not verify a patient&rsquo;s age and we do not collect parental consent — the clinic holds the
          relationship with the family and is responsible for the lawful basis, including any consent required for a
          child under the DPDP Act. Anyone who verifies the guardian&rsquo;s mobile number with a one-time code can
          reach the records of the household members registered on it. Clinics should keep that in mind before
          registering a dependant, and can block portal access for any patient at any time.
        </p>

        <H>Security</H>
        <p>
          Traffic is encrypted in transit. Provider credentials and uploaded patient documents are encrypted in the
          database with AES-256-GCM under a key held outside it. Access is controlled by role, isolated per
          organisation, and administrative actions are written to an audit log. A patient reaches records only after
          verifying their mobile number with a one-time code, and a diagnosis stays hidden from them until a clinician
          releases it.
        </p>
        <p>
          To be precise about the limit: other clinical text — diagnoses, typed prescriptions, allergies, call
          transcripts and chat messages — is stored in the database without a second layer of application-level
          encryption, protected by access control, network isolation and encrypted backups. Our{' '}
          <Link href="/security" className="text-primary underline">
            security page
          </Link>{' '}
          describes the controls in more detail.
        </p>

        <H>If something goes wrong</H>
        <p>
          If a breach affects personal data we hold, we will notify the affected clinic without undue delay, with what
          we know and what we are doing, and report to the Data Protection Board of India as the DPDP Act requires.
          Where we are the processor, the clinic decides how its patients are told, and we will give them what they
          need to do it.
        </p>

        <H>Grievance Officer</H>
        <p>
          If you are unhappy with how we have handled your data, contact our Grievance Officer. We will acknowledge
          within 7 days and respond substantively within 30.
        </p>
        <p className="rounded-lg border border-border bg-surface-2 p-4">
          <strong>{GRIEVANCE_OFFICER.name}</strong>, {GRIEVANCE_OFFICER.title}
          <br />
          <a className="underline" href={`mailto:${GRIEVANCE_OFFICER.email}`}>
            {GRIEVANCE_OFFICER.email}
          </a>
          <br />
          Postal address and registered details are on our{' '}
          <Link href="/contact" className="text-primary underline">
            contact page
          </Link>
          .
        </p>
        <p>
          If we do not resolve it, you may complain to the Data Protection Board of India.
        </p>

        <H>Changes</H>
        <p>
          We will update this page when the service changes and move the date at the top. Where a change materially
          affects how we handle patient data, we will tell customers directly rather than relying on you noticing.
        </p>

        <H>Contact</H>
        <p>
          General questions:{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>
          . Clinics: our{' '}
          <Link href="/dpa" className="text-primary underline">
            Data Processing Addendum
          </Link>{' '}
          sets out our obligations as your processor.
        </p>
      </section>
    </main>
  );
}
