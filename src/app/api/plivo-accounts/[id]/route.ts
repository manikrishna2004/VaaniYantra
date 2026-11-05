import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { deletePlivoAccount, setDefaultPlivoAccount } from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Set a connected Plivo account as the default for new imports.
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  const b = (await req.json().catch(() => ({}))) as { isDefault?: boolean };
  if (b.isDefault) await setDefaultPlivoAccount(ctx.workspace.id, params.id);
  await audit(ctx, 'plivo.account_updated', { targetType: 'PlivoAccount', targetId: params.id, req });
  return NextResponse.json({ ok: true });
}

// Disconnect a Plivo account. Numbers keep their record (plivoAccountId is
// nulled) but lose management credentials until re-connected.
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  await deletePlivoAccount(ctx.workspace.id, params.id);
  await audit(ctx, 'plivo.account_disconnected', { targetType: 'PlivoAccount', targetId: params.id, req });
  return NextResponse.json({ ok: true });
}
