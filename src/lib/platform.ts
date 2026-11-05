import { prisma } from '@/lib/db';
import { encryptSecret, decryptSecret } from '@/lib/crypto';

// Platform-level (super-admin / founder) controls. A single global admin —
// defined by the SUPERADMIN_EMAILS env — manages cross-tenant settings: rotatable
// secrets (the platform Gemini key) and config (plan price/limit overrides).

export function superAdminEmails(): string[] {
  return (process.env.SUPERADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isSuperAdmin(email: string | null | undefined): boolean {
  return Boolean(email) && superAdminEmails().includes(email!.toLowerCase());
}

// ── Config store ────────────────────────────────────────────────────────────

export async function getPlatformConfig(key: string): Promise<string | null> {
  const row = await prisma.platformConfig.findUnique({ where: { key } });
  if (!row) return null;
  if (row.isSecret) {
    try {
      return decryptSecret(row.value);
    } catch {
      return null;
    }
  }
  return row.value;
}

export async function setPlatformConfig(key: string, value: string, isSecret = false): Promise<void> {
  const stored = isSecret ? encryptSecret(value) : value;
  await prisma.platformConfig.upsert({
    where: { key },
    update: { value: stored, isSecret },
    create: { key, value: stored, isSecret },
  });
  if (key === SECRET_KEYS.geminiApiKey) invalidateGeminiCache();
}

export async function deletePlatformConfig(key: string): Promise<void> {
  await prisma.platformConfig.deleteMany({ where: { key } });
  if (key === SECRET_KEYS.geminiApiKey) invalidateGeminiCache();
}

// Known config keys.
export const SECRET_KEYS = {
  geminiApiKey: 'gemini_api_key',
} as const;
export const CONFIG_KEYS = {
  planOverrides: 'plan_overrides',
  whatsappChatAddonPriceInr: 'whatsapp_chat_addon_price_inr',
} as const;

// Flat monthly price (₹) of the WhatsApp follow-up chat add-on, founder-set in
// /admin. 0/unset = not yet priced (owners can't enable it).
export async function getWhatsappChatAddonPrice(): Promise<number> {
  const raw = await getPlatformConfig(CONFIG_KEYS.whatsappChatAddonPriceInr);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Gemini key resolver (platform secret > env), cached to avoid per-call DB hits.
let _geminiCache: { key: string | undefined; at: number } = { key: undefined, at: 0 };
function invalidateGeminiCache() {
  _geminiCache = { key: undefined, at: 0 };
}

export async function getGeminiApiKey(): Promise<string | undefined> {
  const now = Date.now();
  if (_geminiCache.at && now - _geminiCache.at < 60_000) return _geminiCache.key;
  let key = process.env.GEMINI_API_KEY;
  try {
    const db = await getPlatformConfig(SECRET_KEYS.geminiApiKey);
    if (db) key = db;
  } catch {
    /* fall back to env */
  }
  _geminiCache = { key, at: now };
  return key;
}

// ── Plan price/limit overrides (founder-editable pricing) ───────────────────

export type PlanOverride = {
  priceMonthly?: number;
  pricePerMinute?: number;
  overagePerMinute?: number;
  limits?: Partial<{
    agents: number;
    workspaces: number;
    callMinutesPerMonth: number;
    knowledgeDocs: number;
  }>;
};

export async function getPlanOverrides(): Promise<Record<string, PlanOverride>> {
  const raw = await getPlatformConfig(CONFIG_KEYS.planOverrides);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, PlanOverride>;
  } catch {
    return {};
  }
}

export async function setPlanOverrides(overrides: Record<string, PlanOverride>): Promise<void> {
  await setPlatformConfig(CONFIG_KEYS.planOverrides, JSON.stringify(overrides), false);
}

// ── Tunable runtime config (#10): editable from the admin dashboard, falls
// back to env. Non-secret. Cached to avoid per-call DB hits. ───────────────────
export const TUNABLE_KEYS = {
  liveModel: 'gemini_live_model',
  liveVoice: 'gemini_live_voice',
  liveSilenceMs: 'gemini_live_silence_ms',
  liveTemperature: 'gemini_live_temperature',
  geminiModel: 'gemini_model',
  systemPromptBase: 'system_prompt_base',
  callGuidance: 'live_call_guidance',
  typingSound: 'live_typing_sound',
  liveCompressionTriggerTokens: 'gemini_live_compression_trigger_tokens',
  liveCompressionTargetTokens: 'gemini_live_compression_target_tokens',
  livePrefixPaddingMs: 'gemini_live_prefix_padding_ms',
  liveStartSensitivity: 'gemini_live_start_sensitivity',
} as const;

// Default spoken-call guidance appended to every agent's system prompt. This is
// the wording that turns a generic prompt into a phone-call persona; the founder
// can override it from the admin dashboard to tune every agent at once.
export const DEFAULT_CALL_GUIDANCE =
  'This is a live phone call. Speak in short, natural, spoken sentences.';

// The same instruction with the brevity made explicit, used on the
// cost-optimised path. Spoken audio is the most expensive thing the model
// produces — four times the price of the audio coming in — so a habit of
// restating the caller's request before answering it is a line on the bill, not
// just a tic. It is also how people actually want to be spoken to on a phone.
export const BRIEF_CALL_GUIDANCE =
  'This is a live phone call. Speak in short, natural, spoken sentences — one or two per reply. ' +
  'Ask one question at a time. Do not restate what the caller just told you, do not summarise the ' +
  'conversation, and do not read records out verbatim: say the part that answers them. Give a longer ' +
  'answer only when they ask for one.';

let _cfgCache: { at: number; map: Record<string, string> } = { at: 0, map: {} };
export function invalidateTunableCache() {
  _cfgCache = { at: 0, map: {} };
}

async function loadTunables(): Promise<Record<string, string>> {
  if (_cfgCache.at && Date.now() - _cfgCache.at < 60_000) return _cfgCache.map;
  const map: Record<string, string> = {};
  try {
    const rows = await prisma.platformConfig.findMany({ where: { key: { in: Object.values(TUNABLE_KEYS) } } });
    for (const r of rows) if (!r.isSecret) map[r.key] = r.value;
  } catch {
    /* fall back to env */
  }
  _cfgCache = { at: Date.now(), map };
  return map;
}

export async function getLiveConfig(): Promise<{
  model: string;
  voice: string;
  silenceMs: number;
  temperature: number;
  typingSound: boolean;
  compressionTriggerTokens: number;
  compressionTargetTokens: number;
  prefixPaddingMs: number;
  startSensitivity: 'HIGH' | 'LOW';
}> {
  const m = await loadTunables();
  return {
    model: m[TUNABLE_KEYS.liveModel] || process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest',
    voice: m[TUNABLE_KEYS.liveVoice] || process.env.GEMINI_LIVE_VOICE || 'Aoede',
    silenceMs: Number(m[TUNABLE_KEYS.liveSilenceMs] || process.env.GEMINI_LIVE_SILENCE_MS || 450),
    temperature: Number(m[TUNABLE_KEYS.liveTemperature] || process.env.GEMINI_LIVE_TEMPERATURE || 0.8),
    // Default OFF — only plays when an admin explicitly enables it.
    typingSound: (m[TUNABLE_KEYS.typingSound] || process.env.GEMINI_LIVE_TYPING_SOUND || 'off') === 'on',
    // Context window compression. Live re-processes the whole session window on
    // every turn, so on a long call the input bill grows with the number of
    // turns — compression caps that by sliding the window once it passes the
    // trigger, keeping the most recent "target" tokens.
    //
    // TRIGGERTOKENS COUNTS THE SYSTEM INSTRUCTION AND TOOL DECLARATIONS, not
    // just the conversation. This was learned the hard way: the trigger was set
    // to 4000 on the theory that the instruction sat outside the window, but a
    // booking agent's fixed prefix is already ~3-4k tokens, so compression fired
    // within the first minute of every call. The conversation was discarded
    // while the instruction — which ends "Begin the call by greeting the
    // caller" — survived, so the agent greeted again from scratch about 50
    // seconds in, on a live customer call.
    //
    // So the trigger must clear the fixed prefix by however much conversation
    // you intend to keep. Budget ~1,000 audio tokens per minute of call on top
    // of a ~4,000-token prefix: 16000 leaves room for roughly ten minutes before
    // it ever fires, which comfortably covers the five minutes of continuous
    // context a call is expected to hold. Set it to 0 to switch compression off.
    //
    // Cost note: because of that, compression does almost nothing for a typical
    // sub-ten-minute call. The saving on those comes from the SIZE of the
    // re-billed prefix, not from the window — see composeSystemInstruction and
    // the knowledge_search tool.
    compressionTriggerTokens: Number(
      m[TUNABLE_KEYS.liveCompressionTriggerTokens] || process.env.GEMINI_LIVE_COMPRESSION_TRIGGER_TOKENS || 16000,
    ),
    compressionTargetTokens: Number(
      m[TUNABLE_KEYS.liveCompressionTargetTokens] || process.env.GEMINI_LIVE_COMPRESSION_TARGET_TOKENS || 8000,
    ),
    // How much audio before a detected speech start is kept. 50ms with HIGH
    // start-sensitivity opens a turn on almost anything — line noise, a cough,
    // the agent's own voice echoing back off an uncancelled analog leg — and
    // every spurious turn re-bills the whole window. 150ms is still responsive
    // and needs the energy to persist before it commits.
    prefixPaddingMs: Number(
      m[TUNABLE_KEYS.livePrefixPaddingMs] || process.env.GEMINI_LIVE_PREFIX_PADDING_MS || 150,
    ),
    startSensitivity:
      (m[TUNABLE_KEYS.liveStartSensitivity] || process.env.GEMINI_LIVE_START_SENSITIVITY) === 'LOW'
        ? 'LOW'
        : 'HIGH',
  };
}

/**
 * Spoken-call guidance for an agent. `concise` only picks a different built-in
 * default — an admin who has written their own wording still wins, on every
 * path, which is the whole point of the tunable.
 */
export async function getCallGuidance(concise = false): Promise<string> {
  const m = await loadTunables();
  return (
    m[TUNABLE_KEYS.callGuidance] ||
    process.env.LIVE_CALL_GUIDANCE ||
    (concise ? BRIEF_CALL_GUIDANCE : DEFAULT_CALL_GUIDANCE)
  );
}

export async function getGeminiModel(): Promise<string> {
  const m = await loadTunables();
  return m[TUNABLE_KEYS.geminiModel] || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

export async function getBaseSystemPrompt(): Promise<string | null> {
  const m = await loadTunables();
  return m[TUNABLE_KEYS.systemPromptBase] || null;
}

export async function getTunables(): Promise<Record<string, string>> {
  return { ...(await loadTunables()) };
}

export async function setTunables(updates: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (!Object.values(TUNABLE_KEYS).includes(key as any)) continue;
    await setPlatformConfig(key, value, false);
  }
  invalidateTunableCache();
}

// ── Platform stats (cross-tenant overview) ──────────────────────────────────

export async function getPlatformStats() {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [orgs, users, workspaces, agents, callsThisMonth, minutesAgg, byPlan] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.agent.count(),
    prisma.call.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.call.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { durationSec: true } }),
    prisma.organization.groupBy({ by: ['plan'], _count: { _all: true } }),
  ]);
  return {
    orgs,
    users,
    workspaces,
    agents,
    callsThisMonth,
    minutesThisMonth: Math.round((minutesAgg._sum.durationSec ?? 0) / 60),
    byPlan: byPlan.map((p) => ({ plan: p.plan, count: p._count._all })),
  };
}
