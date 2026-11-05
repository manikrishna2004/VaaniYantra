import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { deleteTwilioAccount, setDefaultTwilioAccount } from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// #1: set a connected Twilio account as the default for new provisioning.
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  const b = (await req.json().catch(() => ({}))) as { isDefault?: boolean };
  if (b.isDefault) await setDefaultTwilioAccount(ctx.workspace.id, params.id);
  await audit(ctx, 'twilio.account_updated', { targetType: 'TwilioAccount', targetId: params.id, req });
  return NextResponse.json({ ok: true });
}

// Disconnect a Twilio account. Numbers keep working (twilioAccountId is nulled),
// falling back to the server env Twilio for management operations.
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  await deleteTwilioAccount(ctx.workspace.id, params.id);
  await audit(ctx, 'twilio.account_disconnected', { targetType: 'TwilioAccount', targetId: params.id, req });
  return NextResponse.json({ ok: true });
}
