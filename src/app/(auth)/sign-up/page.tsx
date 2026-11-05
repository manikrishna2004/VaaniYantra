import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Mail } from 'lucide-react';
import { getSessionUser } from '@/lib/auth/session';
import { inviteOnlyEnabled } from '@/lib/access';
import { SignUpForm } from './SignUpForm';

export const dynamic = 'force-dynamic';

// Server wrapper around the sign-up form. Two jobs: send an already-signed-in
// visitor into the app, and decide whether open sign-up is available at all.
//
// While the platform is invite-only the form is not rendered. The API refuses
// these accounts anyway (see src/lib/access.ts), but showing a form that will
// always fail is a worse refusal than not showing one: the person fills it in,
// gets an error at the last step, and never learns what to do instead.
//
// The one exception is someone arriving from an invitation link. `?next=` then
// points at /invite/<token>, that token IS the permission, and the invitee must
// be able to create the account the invitation is waiting for.

function safeNext(next: string | string[] | undefined): string | null {
  const n = Array.isArray(next) ? next[0] : next;
  return n && n.startsWith('/') && !n.startsWith('//') ? n : null;
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const user = await getSessionUser();
  const next = safeNext((await searchParams).next);
  if (user) redirect(next ?? '/dashboard');

  const fromInvite = Boolean(next?.startsWith('/invite/'));
  if (fromInvite || !(await inviteOnlyEnabled())) return <SignUpForm />;

  return (
    <div className="rounded-2xl border border-border bg-surface p-7">
      <div className="mb-6 flex items-center gap-2.5">
        <img src="/logo.png" alt="VaaniYantra" className="h-9 w-auto" />
        <div className="h-display text-lg font-semibold">VaaniYantra</div>
      </div>
      <h1 className="h-display text-2xl font-semibold">Invite only, for now</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        We&rsquo;re onboarding clinics one at a time so every setup gets our attention. Tell us how your
        practice takes calls and what you want the agent to do, and we&rsquo;ll get you a login.
      </p>

      <Link
        href="/contact"
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-on-primary transition hover:bg-primary-hover"
      >
        <Mail className="h-4 w-4" /> Tell us what you need
      </Link>

      <p className="mt-5 text-center text-sm text-muted">
        Been invited? Open the link in your invitation email, or{' '}
        <Link href="/sign-in" className="text-ink underline-offset-2 hover:underline">
          sign in
        </Link>
        .
      </p>
    </div>
  );
}
