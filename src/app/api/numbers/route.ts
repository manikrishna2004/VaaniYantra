import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { deny } from '@/lib/auth/api';
import { phoneNumberInputSchema } from '@/lib/validation';
import { getTelephonyProvider, type TelephonyProvider } from '@/lib/adapters/telephony';
import {
  resolveProvisioningAccount,
  providerForAccount,
  resolveExotelAccount,
  resolvePlivoAccount,
  providerForPlivoAccount,
} from '@/lib/telephony-accounts';

export const dynamic = 'force-dynamic';

// Point a freshly added Twilio number's voice webhook at our platform straight
// away, so the user never has to do a manual "point webhook" step — Twilio just
// works once an agent is assigned. Best-effort: on failure we leave
// webhookConfigured=false and the manual button in Settings remains as a repair.
// Per-provider public webhook paths on the voice-server. Plivo posts its own
// answer/status/hangup document format, so it gets its own path segment.
function webhookUrls(providerName: string) {
  const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000';
  const seg = providerName === 'plivo' ? 'plivo' : 'twilio';
  return {
    voiceUrl: `${base}/api/telephony/${seg}/voice`,
    statusUrl: `${base}/api/telephony/${seg}/status`,
  };
}

async function autoConfigureWebhook(
  numberId: string,
  providerSid: string | null,
  provider: TelephonyProvider,
) {
  if (!provider.usesAnswerWebhook || !providerSid) return;
  try {
    await provider.configureNumberWebhook(providerSid, webhookUrls(provider.name));
    await prisma.phoneNumber.update({ where: { id: numberId }, data: { webhookConfigured: true } });
  } catch {
    /* leave webhookConfigured=false; Settings still offers a manual re-point */
  }
}

const refresh = (id: string) => prisma.phoneNumber.findUnique({ where: { id } });

export async function GET() {
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:read');
  if (denied) return denied;
  const { workspace } = ctx;
  const numbers = await prisma.phoneNumber.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: 'desc' },
    include: { agent: { select: { id: true, name: true } }, _count: { select: { calls: true } } },
  });

  // Per-number analytics: completed count, last call time, avg duration.
  const stats = await prisma.call.groupBy({
    by: ['phoneNumberId'],
    where: { workspaceId: workspace.id, phoneNumberId: { not: null } },
    _count: { _all: true },
    _max: { createdAt: true },
    _avg: { durationSec: true },
  });
  const completed = await prisma.call.groupBy({
    by: ['phoneNumberId'],
    where: { workspaceId: workspace.id, phoneNumberId: { not: null }, status: 'COMPLETED' },
    _count: { _all: true },
  });
  const byId = new Map(stats.map((s) => [s.phoneNumberId, s]));
  const completedById = new Map(completed.map((s) => [s.phoneNumberId, s._count._all]));

  const withStats = numbers.map((n) => ({
    ...n,
    stats: {
      total: byId.get(n.id)?._count._all ?? 0,
      completed: completedById.get(n.id) ?? 0,
      lastCallAt: byId.get(n.id)?._max.createdAt ?? null,
      avgDurationSec: Math.round(byId.get(n.id)?._avg.durationSec ?? 0),
    },
  }));
  return NextResponse.json(withStats);
}

// Buying numbers on a customer's behalf is not something we offer: the product
// is bring-your-own-carrier, so a number is always purchased in the customer's
// own Twilio/Plivo console and imported here. A POST with no e164 used to mean
// "provision one for me" and would spend the connected account's balance, so it
// is refused rather than silently ignored.
const NO_BUY_MESSAGE =
  'Buy the number in your own Twilio or Plivo console, then import it here.';

// Import a number from a connected provider account, or register a manual one.
export async function POST(req: Request) {
  const ctx = await requireWorkspace();
  const denied = deny(ctx, 'number:write');
  if (denied) return denied;
  const { workspace } = ctx;
  const json = await req.json().catch(() => ({}));

  // Exotel branch: connect an existing ExoPhone under a connected Exotel account.
  // Exotel numbers can't be bought via API, so this always requires an e164 (the
  // ExoPhone), which doubles as its providerSid when no separate SID is known.
  if (json.provider === 'exotel') {
    const exotel = await resolveExotelAccount(workspace.id, json.exotelAccountId);
    if (!exotel) {
      return NextResponse.json(
        { error: 'Connect an Exotel account first, then add your ExoPhone.' },
        { status: 400 },
      );
    }
    if (!json.e164) {
      return NextResponse.json({ error: 'Enter your ExoPhone number (E.164).' }, { status: 400 });
    }
    const number = await prisma.phoneNumber.create({
      data: {
        workspaceId: workspace.id,
        e164: json.e164,
        providerSid: json.providerSid || json.e164,
        provider: 'exotel',
        exotelAccountId: exotel.id,
        label: json.label ?? null,
        agentId: json.agentId ?? null,
      },
    });
    // Auto-fill the account's outbound App URL from the ExoPhone's VoiceUrl (the
    // exoml flow) when we know it and haven't stored one yet — so outbound "just
    // works" without the user hunting for the App URL.
    if (json.voiceUrl && !exotel.appUrl) {
      await prisma.exotelAccount
        .update({ where: { id: exotel.id }, data: { appUrl: json.voiceUrl } })
        .catch(() => {});
    }
    return NextResponse.json(number, { status: 201 });
  }

  // Plivo branch: buy a fresh number or import an existing one under a connected
  // Plivo account. Like Twilio, Plivo can buy via API and uses an answer webhook,
  // so the webhook is auto-pointed at the platform straight away.
  if (json.provider === 'plivo') {
    const plivo = await resolvePlivoAccount(workspace.id, json.plivoAccountId);
    if (!plivo) {
      return NextResponse.json({ error: 'Connect a Plivo account first, then add a number.' }, { status: 400 });
    }
    const provider = providerForPlivoAccount(plivo);

    // Import an existing Plivo number.
    if (json.e164 && json.providerSid) {
      const number = await prisma.phoneNumber.create({
        data: {
          workspaceId: workspace.id,
          e164: json.e164,
          providerSid: json.providerSid,
          provider: 'plivo',
          plivoAccountId: plivo.id,
          label: json.label ?? null,
          agentId: json.agentId ?? null,
        },
      });
      await autoConfigureWebhook(number.id, number.providerSid, provider);
      return NextResponse.json(await refresh(number.id), { status: 201 });
    }

    // We do not buy numbers on a customer's behalf — see NO_BUY_MESSAGE.
    if (!json.e164) {
      return NextResponse.json({ error: NO_BUY_MESSAGE }, { status: 400 });
    }

    // Manual add (e164 with no SID) — the E.164 doubles as the Plivo number id.
    const number = await prisma.phoneNumber.create({
      data: {
        workspaceId: workspace.id,
        e164: json.e164,
        providerSid: json.e164.replace(/^\+/, ''),
        provider: 'plivo',
        plivoAccountId: plivo.id,
        label: json.label ?? null,
        agentId: json.agentId ?? null,
      },
    });
    await autoConfigureWebhook(number.id, number.providerSid, provider);
    return NextResponse.json(await refresh(number.id), { status: 201 });
  }

  // #1: a connected customer Twilio account (explicit id, else workspace default)
  // owns numbers provisioned/imported here; otherwise we fall back to env Twilio.
  const account = await resolveProvisioningAccount(workspace.id, json.twilioAccountId);

  // Import an existing provider number (from the "connect existing" list).
  if (json.e164 && json.providerSid) {
    const number = await prisma.phoneNumber.create({
      data: {
        workspaceId: workspace.id,
        e164: json.e164,
        providerSid: json.providerSid,
        provider: account || getTelephonyProvider().name === 'twilio' ? 'twilio' : 'mock', // BYO account or env Twilio
        twilioAccountId: account?.id ?? null,
        label: json.label ?? null,
        agentId: json.agentId ?? null,
      },
    });
    // Auto-point the webhook so the number is ready without a manual step.
    await autoConfigureWebhook(
      number.id,
      number.providerSid,
      account ? providerForAccount(account) : getTelephonyProvider(),
    );
    return NextResponse.json(await refresh(number.id), { status: 201 });
  }

  // We do not buy numbers on a customer's behalf — see NO_BUY_MESSAGE.
  if (!json.e164) {
    return NextResponse.json({ error: NO_BUY_MESSAGE }, { status: 400 });
  }

  const parsed = phoneNumberInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const number = await prisma.phoneNumber.create({
    data: {
      workspaceId: workspace.id,
      e164: parsed.data.e164,
      label: parsed.data.label ?? null,
      agentId: parsed.data.agentId ?? null,
      provider: 'manual',
    },
  });
  return NextResponse.json(number, { status: 201 });
}
