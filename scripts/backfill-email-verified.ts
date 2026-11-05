/**
 * One-off backfill: grandfather existing email/password accounts as verified.
 *
 *   npx tsx scripts/backfill-email-verified.ts          # dry run — prints what it would do
 *   npx tsx scripts/backfill-email-verified.ts --apply  # write
 *
 * ⚠ RUN THIS BEFORE DEPLOYING THE VERIFICATION GATE, NOT AFTER.
 *
 * /api/auth/session now refuses a session to any password-provider account
 * whose address is not verified. Every account created before that shipped is
 * unverified, because there was nothing that could ever set the flag — so
 * without this pass, the deploy signs out every existing customer and refuses
 * to let them back in. They would have a correct password and no way through.
 *
 * What it does NOT do is give anyone a new capability: these accounts already
 * had full, unchallenged access to their dashboards. Marking them verified
 * preserves exactly the access they have today, and confines the new
 * requirement to accounts created from here on.
 *
 * Google accounts are skipped — Firebase already carries emailVerified: true on
 * them, and they are not subject to the gate in any case.
 *
 * Safe to re-run: already-verified users are skipped.
 */
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { initializeApp, getApps, getApp, applicationDefault } from 'firebase-admin/app';

const APPLY = process.argv.includes('--apply');

const projectId =
  process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

const app = getApps().length
  ? getApp()
  : initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth(app);

/** Accounts that can sign in with a password — the only ones the gate touches. */
function hasPasswordProvider(user: UserRecord): boolean {
  return user.providerData.some((p) => p.providerId === 'password');
}

async function main() {
  console.log(APPLY ? '▶ applying' : '▶ dry run (pass --apply to write)');
  console.log(`  project: ${projectId ?? '(from application default credentials)'}`);

  let pageToken: string | undefined;
  let scanned = 0;
  let toFix: UserRecord[] = [];

  do {
    const page = await auth.listUsers(1000, pageToken);
    scanned += page.users.length;
    toFix = toFix.concat(
      page.users.filter((u) => !u.emailVerified && u.email && hasPasswordProvider(u)),
    );
    pageToken = page.pageToken;
  } while (pageToken);

  console.log(`  scanned ${scanned} account(s); ${toFix.length} need the flag set`);

  for (const user of toFix) {
    console.log(`  ${APPLY ? 'verifying' : 'would verify'} ${user.email} (${user.uid})`);
    if (!APPLY) continue;
    try {
      await auth.updateUser(user.uid, { emailVerified: true });
    } catch (err) {
      // Keep going: one bad row (a disabled account, a transient error) must not
      // strand the rest of the customer base outside the product.
      console.error(`  ! failed for ${user.email} (${user.uid})`, err);
    }
  }

  console.log(APPLY ? '✔ done' : '✔ dry run complete — re-run with --apply to write');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
