// Phase 1 agent-depth helpers: business hours, custom variables, fallback, and
// call-transfer triggers. Pure functions (no DB / no Node-only deps) so they run
// in the voice-server, the Next API, and client components alike.

export type DayWindow = { open: string; close: string; closed: boolean }; // "HH:MM"
export type BusinessHours = {
  enabled: boolean;
  timezone: string; // IANA, e.g. "Asia/Kolkata"
  days: DayWindow[]; // length 7, index = JS getDay() (0=Sun..6=Sat)
};

export type AgentVariable = { key: string; value: string };

// Day labels in JS getDay() order (0=Sun). UI renders Mon-first via DAY_ORDER.
export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun for display

export const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
];

export function defaultBusinessHours(): BusinessHours {
  return {
    enabled: false,
    timezone: 'Asia/Kolkata',
    days: Array.from({ length: 7 }, (_, i) => ({
      open: '09:00',
      close: '18:00',
      closed: i === 0 || i === 6, // Sun & Sat closed by default
    })),
  };
}

// Coerce loosely-typed JSON (from Prisma) into a BusinessHours, or null.
export function asBusinessHours(value: unknown): BusinessHours | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as any;
  if (!Array.isArray(v.days) || v.days.length !== 7) return null;
  return {
    enabled: Boolean(v.enabled),
    timezone: typeof v.timezone === 'string' ? v.timezone : 'UTC',
    days: v.days.map((d: any) => ({
      open: typeof d?.open === 'string' ? d.open : '09:00',
      close: typeof d?.close === 'string' ? d.close : '18:00',
      closed: Boolean(d?.closed),
    })),
  };
}

// Exported because slot generation (src/lib/calendar.ts) needs to read the same
// "HH:MM" windows this file already defines. One parser, so the hours a clinic
// is open for CALLS and the hours it is open for BOOKINGS can never drift apart.
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

// Is `now` within the agent's business hours? Returns true when hours are
// disabled/absent (no restriction). Evaluates in the configured timezone.
export function isWithinBusinessHours(value: unknown, now: Date = new Date()): boolean {
  const bh = asBusinessHours(value);
  if (!bh || !bh.enabled) return true;
  let weekday = now.getDay();
  let minutes = now.getHours() * 60 + now.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: bh.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24;
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    if (idx >= 0) weekday = idx;
    minutes = hour * 60 + minute;
  } catch {
    /* invalid timezone — fall back to server-local time computed above */
  }
  const day = bh.days[weekday];
  if (!day || day.closed) return false;
  return minutes >= minutesOf(day.open) && minutes < minutesOf(day.close);
}

// Replace {{key}} placeholders in text with the agent's variable values.
export function applyVariables(text: string, value: unknown): string {
  if (!text) return text;
  const vars = asVariables(value);
  if (vars.length === 0) return text;
  let out = text;
  for (const { key, value: val } of vars) {
    if (!key) continue;
    const re = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, 'g');
    out = out.replace(re, val ?? '');
  }
  return out;
}

export function asVariables(value: unknown): AgentVariable[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => v && typeof v === 'object' && typeof (v as any).key === 'string')
    .map((v) => ({ key: (v as any).key, value: String((v as any).value ?? '') }));
}

// Prompt addition telling the model what to say when it can't help.
export function fallbackInstruction(fallbackMessage?: string | null): string {
  const f = fallbackMessage?.trim();
  if (!f) return '';
  return `\n\nIf you do not know the answer or cannot handle the caller's request, say: "${f}"`;
}

const DEFAULT_TRANSFER_TRIGGERS = [
  'talk to a human',
  'speak to a human',
  'talk to a person',
  'real person',
  'speak to an agent',
  'talk to an agent',
  'customer service',
  'representative',
  'speak to someone',
];

// Does the caller's utterance ask to be transferred to a human?
export function matchesTransferTrigger(text: string, triggers?: string | null): boolean {
  const hay = text.toLowerCase();
  const phrases = (triggers ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const list = phrases.length ? phrases : DEFAULT_TRANSFER_TRIGGERS;
  return list.some((p) => hay.includes(p));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Multi-voice (per-stage voices) ──────────────────────────────────────────

export type VoiceRef = { voice: string; provider: string };
export type VoiceStages = { greeting?: VoiceRef; closing?: VoiceRef };
export type VoiceStage = 'greeting' | 'main' | 'closing';

export function asVoiceStages(value: unknown): VoiceStages {
  if (!value || typeof value !== 'object') return {};
  const v = value as any;
  const pick = (s: any): VoiceRef | undefined =>
    s && typeof s.voice === 'string' && s.voice
      ? { voice: s.voice, provider: typeof s.provider === 'string' ? s.provider : 'google' }
      : undefined;
  return { greeting: pick(v.greeting), closing: pick(v.closing) };
}

// Resolve the voice + provider to use for a given conversation stage, falling
// back to the agent's main voice when no stage override is configured.
export function voiceForStage(
  agent: { voice: string; voiceProvider: string; voiceStages?: unknown },
  stage: VoiceStage,
): VoiceRef {
  const main: VoiceRef = { voice: agent.voice, provider: agent.voiceProvider };
  if (stage === 'main') return main;
  const stages = asVoiceStages(agent.voiceStages);
  return stages[stage] ?? main;
}

// Heuristic: does this spoken sentence read like a sign-off / closing line?
export function isClosingSentence(text: string): boolean {
  return /\b(goodbye|good-bye|bye now|take care|have a (great|nice|good) (day|evening)|thanks for calling|thank you for calling)\b/i.test(
    text,
  );
}
