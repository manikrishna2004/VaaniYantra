import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin, setPlatformConfig, deletePlatformConfig, SECRET_KEYS } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Set / rotate the platform Gemini API key (used by the voice + LLM pipelines,
// preferred over the env key). Super-admin only.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { geminiApiKey?: string };
  const key = body.geminiApiKey?.trim();
  if (!key || key.length < 10) {
    return NextResponse.json({ error: 'That key looks too short.' }, { status: 400 });
  }

  await setPlatformConfig(SECRET_KEYS.geminiApiKey, key, true);
  await audit(ctx, 'platform.gemini_key_set', { targetType: 'Platform', metadata: { last4: key.slice(-4) }, req });
  return NextResponse.json({ ok: true, geminiHint: `${key.slice(0, 6)}…${key.slice(-4)}` });
}

export async function DELETE(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  await deletePlatformConfig(SECRET_KEYS.geminiApiKey);
  await audit(ctx, 'platform.gemini_key_cleared', { targetType: 'Platform', req });
  return NextResponse.json({ ok: true });
}
