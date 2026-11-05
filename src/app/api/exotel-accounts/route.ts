import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { listExotelAccounts, connectExotelAccount } from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// List the workspace's connected Exotel accounts (no secrets returned).
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:read');
  if (denied) return denied;
  return NextResponse.json({ accounts: await listExotelAccounts(ctx.workspace.id) });
}

// Connect a new Exotel account (BYO credentials). Verified against Exotel, then
// stored with the API token encrypted at rest.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!b.accountSid || !b.apiKey || !b.apiToken) {
    return NextResponse.json(
      { error: 'accountSid, apiKey and apiToken are required.' },
      { status: 400 },
    );
  }
  const result = await connectExotelAccount(
    ctx.workspace.id,
    {
      label: b.label ?? '',
      accountSid: b.accountSid,
      apiKey: b.apiKey,
      apiToken: b.apiToken,
      subdomain: b.subdomain,
      appUrl: b.appUrl,
    },
    ctx.user.id,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await audit(ctx, 'exotel.account_connected', { targetType: 'ExotelAccount', req });
  return NextResponse.json({ ok: true });
}
