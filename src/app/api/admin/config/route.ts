import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin, setTunables, TUNABLE_KEYS } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// #10: save tunable runtime config + the base system prompt. Super-admin only.
export async function POST(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  const updates: Record<string, string> = {};
  const map: Record<string, string> = {
    liveModel: TUNABLE_KEYS.liveModel,
    liveVoice: TUNABLE_KEYS.liveVoice,
    liveSilenceMs: TUNABLE_KEYS.liveSilenceMs,
    liveTemperature: TUNABLE_KEYS.liveTemperature,
    geminiModel: TUNABLE_KEYS.geminiModel,
    systemPromptBase: TUNABLE_KEYS.systemPromptBase,
    callGuidance: TUNABLE_KEYS.callGuidance,
    typingSound: TUNABLE_KEYS.typingSound,
    // Cost control: tunable live so the compression window can be widened
    // straight away if agents start forgetting things said early in a call.
    liveCompressionTriggerTokens: TUNABLE_KEYS.liveCompressionTriggerTokens,
    liveCompressionTargetTokens: TUNABLE_KEYS.liveCompressionTargetTokens,
  };
  for (const [field, key] of Object.entries(map)) {
    const v = b[field];
    if (v !== undefined && v !== null && String(v).trim() !== '') updates[key] = String(v).trim();
  }

  await setTunables(updates);
  await audit(ctx, 'platform.config_updated', { targetType: 'Platform', req });
  return NextResponse.json({ ok: true });
}
