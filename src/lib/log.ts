// Structured, level-filtered logger with automatic secret redaction.
//
// Audit F-6.1 / F-4.3: the app had 102 ad-hoc `console.*` calls — no levels, no
// correlation ids, and several logged provider error bodies that can contain
// tokens. This gives a single leveled logger that (a) filters by LOG_LEVEL,
// (b) emits one structured JSON line per event (greppable in `pm2 logs`),
// (c) redacts anything that looks like a secret, and (d) supports child loggers
// carrying context (callId/orgId/provider) so a call can be traced end-to-end.
//
// Adoption is incremental: existing console.* still works; new/changed code uses
// `log` or a child. Nothing here throws.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function thresholdFor(env: Record<string, string | undefined>): number {
  const explicit = env.LOG_LEVEL as LogLevel | undefined;
  if (explicit && explicit in ORDER) return ORDER[explicit];
  return env.NODE_ENV === 'production' ? ORDER.info : ORDER.debug;
}

// Keys whose values are always masked, regardless of content.
const SECRET_KEY_RE =
  /(pass(word)?|secret|token|authorization|auth[_-]?token|access[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|cookie|session)/i;

// Value shapes that look like credentials even under an innocuous key.
const SECRET_VALUE_RES: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i, // Authorization: Bearer xxx
  /\bEAA[A-Za-z0-9]{20,}/, // Meta long-lived tokens
  /\bSK[a-z0-9]{20,}/i, // stripe-like
  /\bAC[0-9a-f]{28,}/i, // twilio account sid (semi-sensitive)
];

const MASK = '[redacted]';

/** Redact secrets from an arbitrary value (objects, arrays, strings). Pure. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRET_VALUE_RES) out = out.replace(re, MASK);
    return out;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? MASK : redact(v, seen, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(ctx: Record<string, unknown>): Logger;
}

type Sink = (level: LogLevel, line: string) => void;

const defaultSink: Sink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function createLogger(
  base: Record<string, unknown> = {},
  opts: { env?: Record<string, string | undefined>; sink?: Sink } = {},
): Logger {
  const env = opts.env ?? process.env;
  const sink = opts.sink ?? defaultSink;
  const threshold = thresholdFor(env);

  function emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>) {
    if (ORDER[level] < threshold) return;
    const merged = { ...base, ...(ctx ?? {}) };
    const record = {
      t: new Date().toISOString(),
      level,
      msg,
      ...(redact(merged) as Record<string, unknown>),
    };
    sink(level, JSON.stringify(record));
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (ctx) => createLogger({ ...base, ...ctx }, opts),
  };
}

export const log = createLogger();
