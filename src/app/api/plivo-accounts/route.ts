import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { listPlivoAccounts, connectPlivoAccount } from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// List the workspace's connected Plivo accounts (no secrets returned).
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:read');
  if (denied) return denied;
  return NextResponse.json({ accounts: await listPlivoAccounts(ctx.workspace.id) });
}

// Connect a new Plivo account (BYO credentials). Verified against Plivo, then
// stored with the Auth Token encrypted at rest.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!b.authId || !b.authToken) {
    return NextResponse.json({ error: 'authId and authToken are required.' }, { status: 400 });
  }
  const result = await connectPlivoAccount(
    ctx.workspace.id,
    { label: b.label ?? '', authId: b.authId, authToken: b.authToken },
    ctx.user.id,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await audit(ctx, 'plivo.account_connected', { targetType: 'PlivoAccount', req });
  return NextResponse.json({ ok: true });
}
