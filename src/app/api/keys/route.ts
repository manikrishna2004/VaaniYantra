import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { generateApiKey } from '@/lib/api-keys';
import { API_SCOPES, WILDCARD, normalizeScopes } from '@/lib/api/scopes';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'apikey:read');
  if (denied) return denied;

  const keys = await prisma.apiKey.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      masked: `${k.prefix}…${k.lastFour}`,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      scopes: k.scopes,
      // A key created before scopes were enforced. It currently works on every
      // endpoint, and will stop the day API_SCOPES_STRICT goes on — so the UI
      // has to be able to say so rather than showing an empty list as if that
      // were a deliberate choice.
      legacyUnscoped: k.scopes.length === 0,
    })),
    // Offered to the key editor so the list of grants lives in one place.
    available: API_SCOPES,
  });
}

export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'apikey:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { name?: string; scopes?: unknown };
  const name = body.name?.trim() || 'Default key';

  // Unknown scope strings are dropped rather than rejected, but asking for
  // nothing at all is not the same as asking for everything: a new key with no
  // usable grants would be a key that silently does nothing once strict mode is
  // on. Default it to the wildcard and let the owner narrow it.
  const scopes = body.scopes === undefined ? [WILDCARD] : normalizeScopes(body.scopes);
  if (scopes.length === 0) {
    return NextResponse.json(
      { error: 'scopes must name at least one known scope', available: API_SCOPES },
      { status: 400 },
    );
  }

  const gen = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      orgId: ctx.org.id,
      name,
      hashedKey: gen.hashedKey,
      prefix: gen.prefix,
      lastFour: gen.lastFour,
      scopes,
      createdById: ctx.user.id,
    },
  });
  await audit(ctx, 'apikey.created', { targetType: 'ApiKey', targetId: key.id, metadata: { name, scopes }, req });

  // The plaintext key is returned exactly once.
  return NextResponse.json({ id: key.id, name, scopes, key: gen.full }, { status: 201 });
}
