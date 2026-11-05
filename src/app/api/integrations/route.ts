import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { encryptSecret } from '@/lib/crypto';
import { isIntegrationProvider } from '@/lib/integrations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:read');
  if (denied) return denied;

  const rows = await prisma.integration.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({
    integrations: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      masked: `…${r.lastFour}`,
      enabled: r.enabled,
      createdAt: r.createdAt,
    })),
  });
}

// Add or replace the secret for a provider (one credential per provider per org).
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { provider?: string; secret?: string };
  const provider = body.provider?.trim() ?? '';
  const secret = body.secret?.trim() ?? '';
  if (!isIntegrationProvider(provider)) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  }
  if (secret.length < 8) {
    return NextResponse.json({ error: 'Secret looks too short' }, { status: 400 });
  }

  const row = await prisma.integration.upsert({
    where: { orgId_provider_userId: { orgId: ctx.org.id, provider, userId: '' } },
    update: { secret: encryptSecret(secret), lastFour: secret.slice(-4), enabled: true },
    create: {
      orgId: ctx.org.id,
      provider,
      secret: encryptSecret(secret),
      lastFour: secret.slice(-4),
      createdById: ctx.user.id,
    },
  });
  await audit(ctx, 'integration.saved', { targetType: 'Integration', targetId: row.id, metadata: { provider }, req });
  return NextResponse.json({ id: row.id, provider, masked: `…${row.lastFour}`, enabled: row.enabled }, { status: 201 });
}
