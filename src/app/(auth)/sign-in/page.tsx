import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { SignInForm } from './SignInForm';

// Server component wrapper whose only job is to send an already-signed-in user
// straight to the app. Clicking "Sign in" in the header while signed in should
// land on the dashboard, not on a form asking who you are.
//
// ⚠ The verification MUST happen here, not in middleware. Middleware runs on the
// Edge runtime where firebase-admin cannot verify a signature, so it can only
// decode `exp` — and a cookie that merely *looks* live (tampered, revoked, or
// issued by a previous Firebase project) would bounce /sign-in → /dashboard,
// fail real verification there, and bounce back, forever, with the sign-in page
// unreachable. See the note in src/middleware.ts, which deliberately declines to
// do this. getSessionUser() verifies the token properly, so a bad cookie falls
// through to the form instead of looping.
//
// Only a *verified* session redirects. A Firebase session persisted in the
// browser without a valid cookie is handled by SignInForm as an explicit
// choice — never an automatic sign-in.

function safeNext(next: string | string[] | undefined): string {
  const n = Array.isArray(next) ? next[0] : next;
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard'; // role-corrected by the dashboard guard
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const user = await getSessionUser();
  if (user) redirect(safeNext((await searchParams).next));

  return <SignInForm />;
}
