import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { deleteExotelAccount, setDefaultExotelAccount } from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Set a connected Exotel account as the default for new imports.
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  const b = (await req.json().catch(() => ({}))) as { isDefault?: boolean };
  if (b.isDefault) await setDefaultExotelAccount(ctx.workspace.id, params.id);
  await audit(ctx, 'exotel.account_updated', { targetType: 'ExotelAccount', targetId: params.id, req });
  return NextResponse.json({ ok: true });
}

// Disconnect an Exotel account. Numbers keep their record (exotelAccountId is
// nulled) but lose management credentials until re-connected.
export async function DELETE(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;

  await deleteExotelAccount(ctx.workspace.id, params.id);
  await audit(ctx, 'exotel.account_disconnected', { targetType: 'ExotelAccount', targetId: params.id, req });
  return NextResponse.json({ ok: true });
}
