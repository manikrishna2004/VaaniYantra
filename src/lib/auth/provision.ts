// First-login provisioning: ensure a Postgres User exists for the Firebase
// identity, and that they belong to at least one Organization with a default
// Workspace (as OWNER). Idempotent.
import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { LEGAL_VERSION, LEGAL_DOCUMENTS } from '@/lib/legal';
import { DEFAULT_NEW_ORG_PLAN } from '@/lib/billing/catalogue';
import type { SessionUser } from './session';

// Passed from the sign-up form when the user ticked the acceptance box. Absent
// on sign-in, and absent when an invited member joins an existing org — in both
// cases the org's acceptance was already recorded (or was never ours to take).
export type LegalAcceptance = { ip: string | null };

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org'
  );
}

async function uniqueOrgSlug(base: string): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? root : `${root}-${i}`;
    const existing = await prisma.organization.findUnique({ where: { slug } });
    if (!existing) return slug;
  }
  return `${root}-${Date.now().toString(36)}`;
}

export async function provisionUser(fb: SessionUser, accepted?: LegalAcceptance) {
  const email = fb.email ?? `${fb.uid}@users.vaaniyantra.com`;

  // Upsert the user by firebaseUid (or adopt a pre-existing row with this email).
  let user = await prisma.user.findFirst({
    where: { OR: [{ firebaseUid: fb.uid }, { email }] },
  });
  if (!user) {
    user = await prisma.user.create({
      data: { firebaseUid: fb.uid, email, name: fb.name, imageUrl: fb.picture },
    });
  } else if (user.firebaseUid !== fb.uid) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        firebaseUid: fb.uid,
        name: user.name ?? fb.name,
        imageUrl: user.imageUrl ?? fb.picture,
      },
    });
  }

  // Ensure the user has an organization + default workspace.
  const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (!membership) {
    const base = fb.name || email.split('@')[0] || 'My';
    const org = await prisma.organization.create({
      data: {
        name: `${base}'s Organization`,
        slug: await uniqueOrgSlug(base),
        // Set explicitly rather than left to the schema default, which is still
        // `free` — a 15-minute trial that no longer exists as a product. Sign-up
        // is invite-only, so every org created here is one we chose to serve,
        // and it starts on the pay-per-minute rate.
        plan: DEFAULT_NEW_ORG_PLAN,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
        workspaces: { create: { name: 'Default', slug: 'default' } },
        // Only stamped when the caller actually passed acceptance. An org
        // created by any other route (an invite flow, a seed script) is left
        // null rather than assumed — see the schema note against these columns.
        ...(accepted
          ? {
              termsAcceptedAt: new Date(),
              termsVersion: LEGAL_VERSION,
              termsAcceptedByUserId: user.id,
              termsAcceptedIp: accepted.ip,
            }
          : {}),
      },
      include: { workspaces: true },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { activeWorkspaceId: org.workspaces[0]?.id },
    });

    // Also recorded as an event, not just as state. The columns answer "does
    // this org's acceptance exist?"; the audit row survives the columns being
    // later edited, and is where an investigation would actually look.
    if (accepted) {
      await writeAudit({
        orgId: org.id,
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'org.terms_accepted',
        targetType: 'Organization',
        targetId: org.id,
        metadata: { version: LEGAL_VERSION, documents: LEGAL_DOCUMENTS, source: 'sign-up' },
        ip: accepted.ip,
      });
    }
  }

  return user;
}
