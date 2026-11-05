import { NextResponse } from 'next/server';
import { apiContext, deny } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { setHubspotToken, disconnectHubspot, verifyHubspotToken } from '@/lib/connectors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Connect HubSpot by saving a Private App access token. On completed calls we
// upsert the caller as a Contact and attach a call Note (see lib/crm.ts).
export async function POST(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = body.token?.trim() ?? '';
  if (token.length < 20) {
    return NextResponse.json(
      { error: 'Enter your HubSpot Private App access token (Settings → Integrations → Private Apps).' },
      { status: 400 },
    );
  }

  const check = await verifyHubspotToken(token);
  if (check.status === 401 || check.status === 403) {
    return NextResponse.json(
      { error: 'HubSpot rejected this token. Make sure the Private App has CRM contacts scopes.' },
      { status: 400 },
    );
  }
  if (!check.ok) {
    return NextResponse.json({ error: `Could not verify with HubSpot (${check.status}).` }, { status: 400 });
  }

  await setHubspotToken(ctx.org.id, ctx.user.id, token);
  await audit(ctx, 'connector.hubspot_set', { targetType: 'Integration', req });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'integration:manage');
  if (denied) return denied;

  await disconnectHubspot(ctx.org.id);
  await audit(ctx, 'connector.hubspot_removed', { targetType: 'Integration', req });
  return NextResponse.json({ ok: true });
}
