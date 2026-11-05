// Public security & trust page — the page enterprise procurement teams look
// for. Documents the real security posture of the platform; keep in sync with
// what is actually deployed.

import Link from 'next/link';

export const metadata = {
  title: 'Security',
  description: 'How VaaniYantra protects your data: encryption, access control, backups, and data retention.',
};

const UPDATED = 'July 18, 2026';

export default function SecurityPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Security at VaaniYantra</h1>
      <p className="mt-2 text-sm text-muted">Last updated: {UPDATED}</p>

      <section className="mt-8 space-y-6 text-sm leading-relaxed text-ink-soft">
        <p>
          Businesses trust VaaniYantra with their customer calls. This page describes the controls we run in
          production today. Questions, vulnerability reports, or security questionnaires:{' '}
          <Link href="/contact" className="text-primary underline">
            contact us
          </Link>
          .
        </p>

        <h2 className="text-lg font-medium text-ink">Encryption</h2>
        <p>
          All traffic is served over TLS (HTTPS/WSS). Provider credentials and integration secrets — telephony
          auth tokens, OAuth refresh tokens, API keys you connect — are encrypted at rest with AES-256-GCM, as are
          the patient documents you upload: prescription scans, reports and discharge summaries, encrypted under a
          key that is not stored in the database. Platform API keys are stored only as salted hashes and shown once
          at creation.
        </p>
        <p>
          Being precise about the boundary: other clinical text — diagnoses, typed prescriptions, allergies, call
          transcripts and chat messages — is held without that second layer of application-level encryption, and is
          protected by access control, per-organisation isolation, network restrictions and encrypted backups. We
          would rather you knew that from us than found it in an audit.
        </p>

        <h2 className="text-lg font-medium text-ink">Access control</h2>
        <p>
          Every workspace is isolated per organization. Role-based access control (Owner, Admin, Member, Viewer)
          is enforced on every page and API route. Sign-in uses Firebase Authentication (email/password or
          Google). Administrative actions — agent changes, member changes, key management, data purges — are
          recorded in an audit log visible to your admins.
        </p>

        <h2 className="text-lg font-medium text-ink">Data retention &amp; deletion</h2>
        <p>
          You control how long call content lives. Organization owners can set a retention window (in days), after
          which call transcripts, summaries, sentiment and extracted data are purged automatically. Retention is
          off by default — until you set a window, call content is kept indefinitely.
        </p>
        <p>
          Two limits worth knowing. Purging clears the link to a call recording held by your telephony provider,
          but the audio itself lives in that provider&rsquo;s account and must be deleted there. And the retention
          window applies to call content only — patient records, prescriptions and uploaded documents are clinical
          records and are never purged on a timer.
        </p>
        <p>
          You can delete individual knowledge documents, agents, consultations and connections from the dashboard
          at any time. Account closure and other deletion requests are handled by our team —{' '}
          <Link href="/data-deletion" className="text-primary underline">
            data deletion instructions
          </Link>
          .
        </p>

        <h2 className="text-lg font-medium text-ink">Recording and transcription</h2>
        <p>
          Every call is transcribed so you have a record of what was said. Call <em>recording</em> is a function of
          your telephony provider rather than this platform: where your provider records a call, we store the link
          it gives us, and the audio remains in your provider account.
        </p>
        <p>
          Agents can be configured to announce at the start of a call that it may be recorded. This is delivered as
          an instruction to the agent rather than a fixed pre-recorded message, so treat it as an aid to meeting
          your consent obligations rather than a guarantee — where the law requires a specific disclosure, verify it
          on your own calls.
        </p>

        <h2 className="text-lg font-medium text-ink">Reliability</h2>
        <p>
          Infrastructure runs on Google Cloud with independent uptime monitoring and alerting on both the web
          application and the realtime voice service. Databases are backed up nightly to separate cloud storage
          with automatic lifecycle management. Current availability is published on our{' '}
          <Link href="/status" className="text-primary underline">
            status page
          </Link>
          .
        </p>

        <h2 className="text-lg font-medium text-ink">API security</h2>
        <p>
          The public API authenticates with per-organization keys and is rate-limited. Outbound webhooks are
          signed (HMAC-SHA256) so your systems can verify authenticity. Inbound telephony webhooks are verified
          against provider signatures to reject spoofed requests.
        </p>

        <h2 className="text-lg font-medium text-ink">Subprocessors</h2>
        <p>
          We rely on a small set of infrastructure providers to deliver the service: Google Cloud (hosting, AI
          models, speech), Firebase (authentication), Twilio and Exotel (telephony, bring-your-own accounts
          supported), Meta (WhatsApp messaging), and Cashfree (payments). Each processes only the data needed for
          its function.
        </p>

        <h2 className="text-lg font-medium text-ink">Responsible disclosure</h2>
        <p>
          If you believe you have found a vulnerability, please{' '}
          <Link href="/contact" className="text-primary underline">
            report it to us
          </Link>{' '}
          with reproduction details. We investigate every report and will acknowledge within two business days.
        </p>
      </section>
    </main>
  );
}
