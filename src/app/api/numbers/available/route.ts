import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { deny } from '@/lib/auth/api';
import { getTelephonyProvider, isMockTelephony } from '@/lib/adapters/telephony';
import {
  resolveProvisioningAccount,
  providerForAccount,
  resolveExotelAccount,
  providerForExotelAccount,
  resolvePlivoAccount,
  providerForPlivoAccount,
} from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';

// List numbers already in the telephony account that haven't been imported into
// any workspace yet — so the user can connect an existing number. Provider-aware:
// `?provider=exotel` lists ExoPhones from the chosen Exotel account; otherwise it
// lists from the chosen (or default) connected Twilio account, falling back to
// env Twilio.
export async function GET(req: Request) {
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:read');
  if (denied) return denied;
  const { workspace } = ctx;
  const url = new URL(req.url);
  const accountId = url.searchParams.get('accountId');
  const providerName = url.searchParams.get('provider');

  const takenSet = async () =>
    new Set((await prisma.phoneNumber.findMany({ select: { e164: true } })).map((n) => n.e164));

  // Exotel branch.
  if (providerName === 'exotel') {
    const account = await resolveExotelAccount(workspace.id, accountId);
    if (!account) {
      return NextResponse.json({ error: 'Connect an Exotel account first.' }, { status: 400 });
    }
    try {
      const accountNumbers = await providerForExotelAccount(account).listAccountNumbers();
      const taken = await takenSet();
      return NextResponse.json({
        mock: false,
        numbers: accountNumbers.filter((n) => !taken.has(n.e164)),
        accountId: account.id,
      });
    } catch (err: any) {
      return NextResponse.json({ error: err?.message ?? 'Failed to list ExoPhones' }, { status: 502 });
    }
  }

  // Plivo branch.
  if (providerName === 'plivo') {
    const account = await resolvePlivoAccount(workspace.id, accountId);
    if (!account) {
      return NextResponse.json({ error: 'Connect a Plivo account first.' }, { status: 400 });
    }
    try {
      const accountNumbers = await providerForPlivoAccount(account).listAccountNumbers();
      const taken = await takenSet();
      return NextResponse.json({
        mock: false,
        numbers: accountNumbers.filter((n) => !taken.has(n.e164)),
        accountId: account.id,
      });
    } catch (err: any) {
      return NextResponse.json({ error: err?.message ?? 'Failed to list Plivo numbers' }, { status: 502 });
    }
  }

  // Twilio (default) branch.
  const account = await resolveProvisioningAccount(workspace.id, accountId);
  // Only the server-env path honours mock mode; a connected account is real Twilio.
  if (!account && isMockTelephony()) {
    return NextResponse.json({ mock: true, numbers: [] });
  }
  try {
    const provider = account ? providerForAccount(account) : getTelephonyProvider();
    const accountNumbers = await provider.listAccountNumbers();
    const taken = await takenSet();
    const numbers = accountNumbers.filter((n) => !taken.has(n.e164));
    return NextResponse.json({ mock: false, numbers, accountId: account?.id ?? null });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Failed to list numbers' }, { status: 502 });
  }
}
