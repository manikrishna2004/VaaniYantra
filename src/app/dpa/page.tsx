// Data Processing Addendum. Served at /dpa, incorporated into /terms by
// reference, and the document a hospital's procurement team will actually read.
//
// ⚠ The security section describes controls AS IMPLEMENTED, including what is
// NOT encrypted. That is deliberate: a DPA is a contract, and promising a
// control we do not have would be a breach of it on day one. If you strengthen
// the implementation, strengthen this section — not before.

import Link from 'next/link';

export const metadata = {
  title: 'Data Processing Addendum',
  description:
    'Our obligations as a data processor when we handle patient data on behalf of a clinic or hospital.',
};

const UPDATED = 'August 3, 2026';

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-2 text-lg font-medium text-ink">{children}</h2>;
}

export default function DpaPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Data Processing Addendum</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>

      <section className="mt-8 space-y-5 text-sm leading-relaxed text-ink-soft">
        <p>
          This Addendum applies whenever we process personal data about your patients on your behalf. It forms part
          of our{' '}
          <Link href="/terms" className="text-primary underline">
            Terms of Service
          </Link>{' '}
          and takes precedence over them on data protection. It is written to be read, not to be survived; where a
          control is weaker than you would like, it says so plainly so you can decide with your eyes open.
        </p>

        <H>1. Roles</H>
        <p>
          For patient data, <strong>you are the Data Fiduciary and we are your Data Processor</strong> under the
          Digital Personal Data Protection Act 2023. You decide which patients are recorded, what is recorded, and
          why. We process only to provide the service.
        </p>
        <p>
          For your own account — staff identities, billing, invoices and audit records — we act as Data Fiduciary and
          our{' '}
          <Link href="/privacy" className="text-primary underline">
            Privacy Policy
          </Link>{' '}
          governs.
        </p>

        <H>2. Scope of processing</H>
        <p>
          <strong>Subject matter:</strong> providing an AI receptionist, appointment booking and a patient records
          portal. <strong>Duration:</strong> for as long as your subscription is active, plus the deletion period in
          section 8. <strong>Data subjects:</strong> your patients, their guardians and dependants, and people who
          call or message you. <strong>Categories:</strong> contact details, date of birth and sex, appointment
          history, call and message content including transcripts, and health data — diagnoses, prescriptions,
          allergies, clinical notes and uploaded documents.
        </p>

        <H>3. Our obligations</H>
        <p>
          We will: process patient data only to provide the service and on your documented instructions, including
          your configuration of it; not sell it, and not use it to train AI models; keep it confidential and limit
          access to personnel who need it; assist you with your patients&rsquo; requests as set out in section 6;
          notify you of a breach as set out in section 7; and delete or return data as set out in section 8.
        </p>
        <p>
          If we believe an instruction from you breaches the law, we will tell you rather than quietly comply.
        </p>

        <H>4. Your obligations</H>
        <p>
          You will: hold a lawful basis for the data you put into the service and for our processing of it; give your
          patients the notice the law requires, including that an AI agent handles their calls and messages and that
          their data is processed by our providers, some outside India; obtain any consent required, including for a
          child; keep your own access controls sound, including who on your staff can see records; and answer your
          patients&rsquo; requests, with our help.
        </p>
        <p>
          So that the notice obligation is not left abstract, we publish wording you can use:{' '}
          <Link href="/patient-notice" className="text-primary underline">
            patient notice wording
          </Link>
          .
        </p>

        <H>5. Security measures, as implemented</H>
        <p>
          <strong>In place:</strong> encryption in transit; provider credentials and uploaded patient documents
          encrypted at rest with AES-256-GCM under a key held outside the database; per-organisation isolation;
          role-based access control on every route; an audit log of administrative and clinical write actions;
          patient portal access only after one-time-code verification of the patient&rsquo;s mobile number, with rate
          limits and hashed codes; clinician-controlled release of a diagnosis, with private clinical notes never
          exposed on a patient-facing path; the ability to revoke a patient&rsquo;s portal access immediately;
          encrypted nightly database backups; and monitored uptime alerting.
        </p>
        <p>
          <strong>Limits you should know before signing:</strong>
        </p>
        <p>
          Clinical free text — diagnoses, typed prescriptions, allergies, call transcripts and chat messages — is
          stored without a second, application-level layer of encryption. It is protected by access control, network
          isolation and encrypted backups.
        </p>
        <p>
          Data is hosted in the <strong>United States</strong>, and our AI and most carrier providers are reached on
          global endpoints. We do not currently offer India-resident processing.
        </p>
        <p>
          Reads of a patient record are audited, as are searches of your patient list, bulk CSV exports, and write
          actions. There is no customer-managed encryption key, no SSO/SAML, and no independent security
          certification such as ISO 27001 or SOC 2.
        </p>

        <H>6. Assisting with data-principal requests</H>
        <p>
          If a patient contacts us directly we will not act on their record ourselves — we will route the request to
          you, because you control it. On your written request we will help you locate, correct, export or delete a
          patient&rsquo;s data.
        </p>
        <p>
          Deleting a single patient is now a self-service action in your dashboard, available to Admin and Owner
          roles. It removes that person&rsquo;s record, consultations, prescriptions, allergies and attachments and
          ends their chatbot access; your appointment history is kept with their name, number and patient number
          removed. Call logs are not covered by it &mdash; those are governed by the retention window in section 8.
        </p>
        <p>
          Honestly stated: producing a <em>complete export</em> of everything held about one person is still
          performed by our team rather than a button in the dashboard, within 30 days of your request. Plan your own
          response times accordingly.
        </p>

        <H>7. Breach notification</H>
        <p>
          If we become aware of a personal data breach affecting your data, we will notify you without undue delay
          and in any case within <strong>72 hours</strong>, with what happened, the categories and approximate volume
          affected, the likely consequences, and what we are doing. We will report to the Data Protection Board of
          India as required of us. As Data Fiduciary, deciding whether and how to inform your patients is yours, and
          we will give you what you need.
        </p>

        <H>8. Deletion and return</H>
        <p>
          You can delete agents, knowledge documents, consultations and connections yourself at any time, and set a
          retention window after which call transcripts and analysis are purged automatically. That window is off
          unless you set it.
        </p>
        <p>
          On termination, we will delete your organisation&rsquo;s data within <strong>30 days</strong> of your
          written request, except records we must keep by law, such as invoices, for the statutory period. Before you
          close the account, export what you need — reports and patient lists export as CSV, and clinical records are
          available through the API.
        </p>

        <H>9. Sub-processors</H>
        <p>
          You authorise the sub-processors listed on our{' '}
          <Link href="/subprocessors" className="text-primary underline">
            sub-processor page
          </Link>
          , which names what each receives and where it processes. We remain responsible for their performance. We
          will update that page before a new sub-processor begins handling customer data and notify you of material
          additions; if you object, your remedy is to stop using the affected feature or to terminate.
        </p>

        <H>10. Cross-border transfer</H>
        <p>
          You acknowledge that providing the service involves processing patient data outside India, as described in
          section 5 and on the sub-processor page. You confirm you have the lawful basis for that transfer and have
          told your patients about it.
        </p>

        <H>11. Audit</H>
        <p>
          On reasonable written notice, no more than once a year, we will answer a security questionnaire and provide
          the documentation we hold. We do not currently hold a third-party audit report, and we will not claim
          otherwise. On-site audits are by agreement.
        </p>

        <H>12. Signing this</H>
        <p>
          This Addendum applies automatically to every customer processing patient data — you do not need to sign it
          for it to bind us. If your procurement process needs a countersigned copy, or terms specific to your
          institution, write to{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>{' '}
          and we will work through it.
        </p>
        <p>
          Questions about how we handle data, or a complaint, go to the Grievance Officer named in our{' '}
          <Link href="/privacy" className="text-primary underline">
            Privacy Policy
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
