// Data deletion instructions — the URL registered in the Meta app's Basic
// settings ("User data deletion → Data deletion instructions URL").

export const metadata = {
  title: 'Data Deletion',
  description: 'How to delete your data from VaaniYantra.',
};

export default function DataDeletionPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">Data Deletion Instructions</h1>

      <section className="mt-8 space-y-6 text-sm leading-relaxed text-ink-soft">
        <p>You can delete your data from VaaniYantra in any of these ways:</p>
        <p>
          <strong>1. From the dashboard</strong> — sign in and delete individual agents, knowledge documents, phone
          numbers, consultations, whole patient records, or connected services (including disconnecting WhatsApp,
          which removes the stored WhatsApp Business Account connection and token). Deleting a patient is available
          to Admin and Owner roles.
        </p>
        <p>
          <strong>2. By email, for anything else</strong> — closing your account or erasing your organization
          entirely are handled by our team rather than a self-service button.
          Send a request to{' '}
          <a className="underline" href="mailto:info@vaaniyantra.com">
            info@vaaniyantra.com
          </a>{' '}
          from the email address on your account. We acknowledge within 7 days and complete deletion within 30 days,
          then confirm what was removed. Records we are required to keep for tax or legal reasons — invoices, for
          example — are retained for the statutory period and no longer.
        </p>
        <p>
          If you interacted with a business&rsquo;s agent as a customer (by phone or WhatsApp), contact that business
          to request deletion, or email us and we will route the request to the business that controls the data.
        </p>
      </section>
    </main>
  );
}
