import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase/admin';
import { createSession, clearSession } from '@/lib/auth/session';
import { provisionUser } from '@/lib/auth/provision';
import { checkPlatformAccess } from '@/lib/access';

// firebase-admin needs the Node runtime (not Edge).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Exchange a freshly-minted Firebase ID token for an httpOnly session cookie,
// and provision the Postgres user + organization + workspace on first login.
export async function POST(req: Request) {
  let idToken: string | undefined;
  // Set by the sign-up form when the acceptance box was ticked. Only meaningful
  // on the request that creates the org; ignored otherwise, because acceptance
  // is taken once from the party that signs up, not re-taken on every sign-in.
  let acceptedTerms = false;
  try {
    ({ idToken, acceptedTerms = false } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!idToken) return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });

  try {
    const decoded = await adminAuth.verifyIdToken(idToken);

    // THE GATE. An email/password account whose address has never been proved
    // gets no session — not here, not on sign-in, not on "Continue as you".
    //
    // This is the check that makes verification mean anything. The code flow in
    // /api/auth/verify-email is only the way to satisfy it; without this line a
    // user could skip it entirely by creating the account and then signing in,
    // since the password alone was enough to mint a valid ID token.
    //
    // Scoped to the password provider deliberately. Google (and any future
    // federated provider) has already verified the address with its own
    // out-of-band challenge, and its tokens carry email_verified: true — making
    // those users sit through a second code would add no assurance.
    const provider = (decoded.firebase as { sign_in_provider?: string } | undefined)
      ?.sign_in_provider;
    if (provider === 'password' && decoded.email_verified !== true) {
      // 403 with a machine-readable code: the sign-in and sign-up forms both
      // read this to send the user to the code step instead of showing a dead
      // end. Someone who abandons sign-up half-way must be able to finish.
      return NextResponse.json(
        { error: 'Please verify your email address to continue.', code: 'email_unverified' },
        { status: 403 },
      );
    }

    // THE SECOND GATE: is this address allowed on the platform at all?
    //
    // Ahead of createSession and provisionUser on purpose. Sign-up is closed
    // while invite-only is on, and provisioning is the step that would create
    // an organisation and a workspace for a stranger — refusing after it would
    // leave exactly the tenant we declined to make.
    //
    // A distinct `code` so the forms can tell this apart from the verification
    // gate above: one means "finish verifying", the other means "you are not
    // let in", and showing the wrong one sends people round a loop they cannot
    // complete.
    const access = await checkPlatformAccess(decoded.email);
    if (!access.allowed) {
      return NextResponse.json({ error: access.message, code: 'invite_only' }, { status: 403 });
    }

    await createSession(idToken);
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    await provisionUser(
      {
        uid: decoded.uid,
        email: decoded.email ?? null,
        name: (decoded.name as string | undefined) ?? null,
        picture: (decoded.picture as string | undefined) ?? null,
      },
      acceptedTerms === true ? { ip } : undefined,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[auth/session] failed', err);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
  }
}

export async function DELETE() {
  await clearSession();
  return NextResponse.json({ ok: true });
}
