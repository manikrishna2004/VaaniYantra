import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { listTwilioAccounts, connectTwilioAccount } from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// #1: list the workspace's connected Twilio accounts (no secrets returned).
export async function GET() {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:read');
  if (denied) return denied;
  return NextResponse.json({ accounts: await listTwilioAccounts(ctx.workspace.id) });
}

// Connect a new Twilio account (BYO credentials). Verified against Twilio, then
// stored with the auth token encrypted at rest.
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  const b = (await req.json().catch(() => ({}))) as Record<string, string>;
  if (!b.accountSid || !b.authToken) {
    return NextResponse.json({ error: 'accountSid and authToken are required.' }, { status: 400 });
  }
  const result = await connectTwilioAccount(
    ctx.workspace.id,
    { label: b.label ?? '', accountSid: b.accountSid, authToken: b.authToken },
    ctx.user.id,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await audit(ctx, 'twilio.account_connected', { targetType: 'TwilioAccount', req });
  return NextResponse.json({ ok: true });
}
