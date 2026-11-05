import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin, setPlatformConfig, CONFIG_KEYS } from '@/lib/platform';
import { META_KEYS } from '@/lib/whatsapp-cloud';
import { whatsappEnabled } from '@/lib/flags';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Save the platform's Meta (WhatsApp Cloud API / Embedded Signup) app config —
// super-admin only. App secret + verify token are stored encrypted; app id,
// config id, and graph version are plain. Blank secret fields are left as-is.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  if (!whatsappEnabled()) return NextResponse.json({ error: 'WhatsApp is not available.' }, { status: 404 });
  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    appId?: string;
    appSecret?: string;
    configId?: string;
    verifyToken?: string;
    graphVersion?: string;
    chatAddonPriceInr?: string | number;
    wabaId?: string;
    systemUserToken?: string;
    defaultPhoneNumberId?: string;
  };

  const ops: Promise<void>[] = [];
  if (body.chatAddonPriceInr !== undefined) {
    const n = Math.max(0, Math.round(Number(body.chatAddonPriceInr) || 0));
    ops.push(setPlatformConfig(CONFIG_KEYS.whatsappChatAddonPriceInr, String(n), false));
  }
  if (body.appId !== undefined) ops.push(setPlatformConfig(META_KEYS.appId, body.appId.trim(), false));
  if (body.configId !== undefined) ops.push(setPlatformConfig(META_KEYS.configId, body.configId.trim(), false));
  if (body.graphVersion !== undefined) ops.push(setPlatformConfig(META_KEYS.graphVersion, body.graphVersion.trim(), false));
  if (body.appSecret?.trim()) ops.push(setPlatformConfig(META_KEYS.appSecret, body.appSecret.trim(), true));
  if (body.verifyToken?.trim()) ops.push(setPlatformConfig(META_KEYS.verifyToken, body.verifyToken.trim(), true));
  if (body.wabaId !== undefined) ops.push(setPlatformConfig(META_KEYS.wabaId, body.wabaId.trim(), false));
  if (body.systemUserToken?.trim()) ops.push(setPlatformConfig(META_KEYS.systemUserToken, body.systemUserToken.trim(), true));
  if (body.defaultPhoneNumberId !== undefined)
    ops.push(setPlatformConfig(META_KEYS.defaultPhoneNumberId, body.defaultPhoneNumberId.trim(), false));

  await Promise.all(ops);
  await audit(ctx, 'platform.whatsapp_configured', { targetType: 'Platform', req });
  return NextResponse.json({ ok: true });
}
