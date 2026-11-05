import { requireWorkspace } from '@/lib/auth/context';
import { isSuperAdmin } from '@/lib/platform';
import { LEGAL_VERSION } from '@/lib/legal';
import { Sidebar } from '@/components/Sidebar';
import { SessionRefresher } from '@/components/SessionRefresher';
import { FeedbackProvider } from '@/components/Feedback';
import { TermsAcceptanceBanner } from '@/components/TermsAcceptanceBanner';
import { canSignIn, suspendedMessage } from '@/lib/org-status';

// Authenticated app shell. requireWorkspace() redirects to /sign-in when there
// is no valid session, so every page under (app) is guaranteed a context.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireWorkspace();
  // Only the OWNER can bind the practice, so only the OWNER is asked. Null means
  // no acceptance was ever recorded (an org predating the sign-up box); a
  // different value means the documents have materially moved since.
  const needsAcceptance = ctx.role === 'OWNER' && ctx.org.termsVersion !== LEGAL_VERSION;

  // A DEACTIVATED org gets a plain notice instead of the dashboard. Deliberately
  // not a redirect to /sign-in: they ARE signed in, and bouncing them there
  // would loop and tell them nothing about why.
  if (!canSignIn(ctx.org.status)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6">
        <div className="max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-tile">
          <h1 className="font-display text-xl font-semibold text-ink">{ctx.org.name}</h1>
          <p className="mt-3 text-sm text-ink-soft">{suspendedMessage(ctx.org.status, ctx.org.statusReason)}</p>
          <p className="mt-4 text-xs text-muted">
            Your data has not been deleted. Contact us at{' '}
            <a href="mailto:support@vaaniyantra.com" className="text-primary underline">
              support@vaaniyantra.com
            </a>{' '}
            to restore access.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen">
      <SessionRefresher />
      <Sidebar
        user={ctx.user}
        org={{ name: ctx.org.name }}
        workspace={{ name: ctx.workspace.name }}
        role={ctx.role}
        isSuperAdmin={isSuperAdmin(ctx.user.email)}
      />
      <main className="flex-1 min-w-0 pt-14 lg:pt-0 lg:pl-64">
        <div className="mx-auto max-w-6xl px-5 py-8 lg:px-10 animate-in">
          {needsAcceptance && <TermsAcceptanceBanner firstTime={ctx.org.termsVersion === null} />}
          <FeedbackProvider>{children}</FeedbackProvider>
        </div>
      </main>
    </div>
  );
}
