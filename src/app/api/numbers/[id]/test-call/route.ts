import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { deny } from '@/lib/auth/api';
import { providerForNumber } from '@/lib/telephony-accounts';
import { isValidPhoneNumber } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

// Place a verification call for an Exotel number: Exotel dials the given `to`
// (the user's own mobile) and connects it to the ExoPhone's streaming App, so
// when they answer they hear the assigned agent — confirming the whole flow
// (Voicebot applet → our /exotel WS → agent) is wired correctly.
export async function POST(req: Request, props: Params) {
  const params = await props.params;
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const body = (await req.json().catch(() => ({}))) as { to?: string };
  const to = (body.to || '').trim();
  if (!isValidPhoneNumber(to)) {
    return NextResponse.json(
      { error: 'Enter your mobile number in E.164 format, e.g. +919876543210' },
      { status: 400 },
    );
  }

  const number = await prisma.phoneNumber.findFirst({
    where: { id: params.id, workspaceId: workspace.id },
    include: { exotelAccount: true },
  });
  if (!number) return NextResponse.json({ error: 'Number not found' }, { status: 404 });
  if (number.provider !== 'exotel') {
    return NextResponse.json({ error: 'Test call is only for Exotel numbers.' }, { status: 400 });
  }
  const appUrl = number.exotelAccount?.appUrl;
  if (!appUrl) {
    return NextResponse.json(
      { error: 'No Exotel App URL on this account yet — import the ExoPhone (or set the App URL) first.' },
      { status: 400 },
    );
  }

  try {
    const provider = await providerForNumber(number);
    const result = await provider.placeCall({
      to, // Exotel dials this number...
      from: number.e164, // ...showing the ExoPhone as caller ID
      answerWebhookUrl: appUrl, // ...and connects it to the streaming App
    });
    return NextResponse.json({ ok: true, providerSid: result.providerSid });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Test call failed' }, { status: 502 });
  }
}
