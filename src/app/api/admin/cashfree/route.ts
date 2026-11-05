import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin, setPlatformConfig } from '@/lib/platform';
import { CASHFREE_KEYS } from '@/lib/cashfree';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Save Cashfree config (super-admin). The secret key is stored encrypted; app
// ID, environment, and the Subscriptions switch are plain config. A blank
// secret keeps the existing value so the form can be re-saved without it.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    appId?: string;
    secretKey?: string;
    environment?: string;
    subscriptionsEnabled?: boolean;
    internationalEnabled?: boolean;
  };

  const ops: Promise<void>[] = [];
  if (body.appId !== undefined) {
    ops.push(setPlatformConfig(CASHFREE_KEYS.appId, body.appId.trim(), false));
  }
  if (body.secretKey?.trim()) {
    ops.push(setPlatformConfig(CASHFREE_KEYS.secretKey, body.secretKey.trim(), true));
  }
  if (body.environment !== undefined) {
    const env = body.environment === 'production' ? 'production' : 'sandbox';
    ops.push(setPlatformConfig(CASHFREE_KEYS.environment, env, false));
  }
  if (body.subscriptionsEnabled !== undefined) {
    ops.push(setPlatformConfig(CASHFREE_KEYS.subscriptions, body.subscriptionsEnabled ? '1' : '0', false));
  }
  if (body.internationalEnabled !== undefined) {
    ops.push(setPlatformConfig(CASHFREE_KEYS.international, body.internationalEnabled ? '1' : '0', false));
  }

  await Promise.all(ops);
  await audit(ctx, 'platform.cashfree_configured', { targetType: 'Platform', req });
  return NextResponse.json({ ok: true });
}
