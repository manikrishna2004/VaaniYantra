import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { prisma } from '@/lib/db';
import { listOrgRows, parseOrgPeriod } from '@/lib/admin-orgs';
import { apiContext } from '@/lib/auth/api';
import {
  isSuperAdmin,
  getPlatformStats,
  getPlanOverrides,
  getPlatformConfig,
  getLiveConfig,
  getGeminiModel,
  getBaseSystemPrompt,
  getCallGuidance,
  DEFAULT_CALL_GUIDANCE,
  SECRET_KEYS,
} from '@/lib/platform';
import { getEffectivePlans } from '@/lib/billing/catalogue';
import { getCashfreeConfig, isCashfreeConfigured, isLiveMode, checkoutMode } from '@/lib/cashfree';
import { getMetaConfig, isMetaConfigured } from '@/lib/whatsapp-cloud';
import { getWhatsappChatAddonPrice } from '@/lib/platform';
import { whatsappEnabled } from '@/lib/flags';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Founder dashboard data. Super-admin only (SUPERADMIN_EMAILS).
export async function GET(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Usage window for the org table. Plan/status/number filters are applied in
  // the browser (instant, and the data is already here); only the period needs
  // the server, because it changes what is counted rather than what is shown.
  const period = parseOrgPeriod(new URL(req.url).searchParams.get('period'));

  const [stats, orgs, plans, overrides, geminiKey, cashfreeCfg, metaCfg, chatAddonPrice, liveCfg, geminiModel, basePrompt, callGuidance] = await Promise.all([
    getPlatformStats(),
    listOrgRows(period),
    getEffectivePlans(),
    getPlanOverrides(),
    getPlatformConfig(SECRET_KEYS.geminiApiKey),
    getCashfreeConfig(),
    getMetaConfig(),
    getWhatsappChatAddonPrice(),
    getLiveConfig(),
    getGeminiModel(),
    getBaseSystemPrompt(),
    getCallGuidance(),
  ]);

  return NextResponse.json({
    stats,
    orgs,
    period,
    plans,
    overrides,
    secrets: {
      geminiSet: Boolean(geminiKey),
      geminiHint: geminiKey ? `${geminiKey.slice(0, 6)}…${geminiKey.slice(-4)}` : null,
    },
    cashfree: {
      configured: isCashfreeConfigured(cashfreeCfg),
      appId: cashfreeCfg.appId ?? '',
      live: isLiveMode(cashfreeCfg),
      secretSet: Boolean(cashfreeCfg.secretKey),
      environment: cashfreeCfg.environment,
      subscriptionsEnabled: cashfreeCfg.subscriptionsEnabled,
      internationalEnabled: cashfreeCfg.internationalEnabled,
      mode: checkoutMode(cashfreeCfg),
    },
    whatsapp: {
      featureEnabled: whatsappEnabled(),
      configured: isMetaConfigured(metaCfg),
      appId: metaCfg.appId ?? '',
      secretSet: Boolean(metaCfg.appSecret),
      configId: metaCfg.configId ?? '',
      verifySet: Boolean(metaCfg.verifyToken),
      graphVersion: metaCfg.graphVersion,
      chatAddonPriceInr: chatAddonPrice,
      wabaId: metaCfg.wabaId ?? '',
      systemTokenSet: Boolean(metaCfg.systemUserToken),
      defaultPhoneNumberId: metaCfg.defaultPhoneNumberId ?? '',
    },
    config: {
      liveModel: liveCfg.model,
      liveVoice: liveCfg.voice,
      liveSilenceMs: liveCfg.silenceMs,
      liveTemperature: liveCfg.temperature,
      typingSound: liveCfg.typingSound,
      geminiModel,
      systemPromptBase: basePrompt,
      systemPromptDefault: DEFAULT_SYSTEM_PROMPT,
      callGuidance,
      callGuidanceDefault: DEFAULT_CALL_GUIDANCE,
    },
  });
}
