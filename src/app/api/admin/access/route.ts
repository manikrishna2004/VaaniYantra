import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { getAccessAllowlist, inviteOnlyEnabled, setAccessAllowlist, setInviteOnly } from '@/lib/access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Who may create an account on the platform. Super-admin only.
//
// Lives in PlatformConfig rather than in code so opening sign-up to everyone —
// the plan, once there is money to serve them — is a toggle here, not a deploy.

export async function GET() {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const [inviteOnly, allowlist] = await Promise.all([inviteOnlyEnabled(), getAccessAllowlist()]);
  return NextResponse.json({ inviteOnly, allowlist });
}

export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as { inviteOnly?: boolean; allowlist?: string | string[] };

  if (typeof b.inviteOnly === 'boolean') await setInviteOnly(b.inviteOnly);

  // Accepts either a real array or the raw textarea contents, split on commas
  // and newlines. Entries that are neither an address nor an "@domain" are
  // dropped by setAccessAllowlist, and the cleaned list comes back so the
  // founder sees exactly what was stored rather than what they typed.
  let allowlist: string[] | undefined;
  if (b.allowlist !== undefined) {
    const raw = Array.isArray(b.allowlist) ? b.allowlist : String(b.allowlist).split(/[\s,;]+/);
    allowlist = await setAccessAllowlist(raw);
  }

  await audit(ctx, 'platform.access_updated', {
    targetType: 'Platform',
    metadata: {
      ...(typeof b.inviteOnly === 'boolean' ? { inviteOnly: b.inviteOnly } : {}),
      // The addresses themselves are deliberately not logged — an allowlist is
      // a list of prospects' work emails. The count is what an investigation
      // needs; the list itself is one GET away for anyone entitled to see it.
      ...(allowlist ? { allowlistCount: allowlist.length } : {}),
    },
    req,
  });

  const [inviteOnly, list] = await Promise.all([inviteOnlyEnabled(), getAccessAllowlist()]);
  return NextResponse.json({ ok: true, inviteOnly, allowlist: list });
}
