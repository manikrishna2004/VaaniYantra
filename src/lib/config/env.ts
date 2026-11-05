// Centralized environment/config validation.
//
// Problem it solves (audit F-1.1, F-4.6): ~84 scattered `process.env` reads with
// ad-hoc defaults meant a missing/typo'd var failed late and silently (e.g. a
// wrong PUBLIC_BASE_URL points every provider webhook at nothing; a missing
// SECRET_ENC_KEY silently degrades every encrypted feature).
//
// This module does NOT replace the existing reads — it is additive. It gives a
// single place to validate config at boot so misconfiguration is loud and early,
// and typed helpers new code can adopt incrementally.

export type ProblemLevel = 'error' | 'warn';
export interface ConfigProblem {
  key: string;
  level: ProblemLevel;
  message: string;
}

const MIN_ENC_KEY_LEN = 16;

/** Parse a "true"/"false" env flag (anything other than exactly "true" = false). */
export function boolEnv(v: string | undefined): boolean {
  return v === 'true';
}

/** Read a positive-int env var, falling back to `fallback` when unset/invalid. */
export function intEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Validate configuration and return a list of problems. `error` problems are
 * fatal in production; `warn` problems are advisory. Pure + deterministic so it
 * is unit-testable with an injected env.
 */
export function validateConfig(env: Record<string, string | undefined> = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const isProd = env.NODE_ENV === 'production';

  // Secrets-at-rest key.
  const encKey = env.SECRET_ENC_KEY ?? '';
  if (!encKey) {
    problems.push({
      key: 'SECRET_ENC_KEY',
      level: isProd ? 'error' : 'warn',
      message: 'missing — secrets-at-rest encryption uses an insecure default; set a strong key',
    });
  } else if (encKey.length < MIN_ENC_KEY_LEN) {
    problems.push({
      key: 'SECRET_ENC_KEY',
      level: 'warn',
      message: `weak (<${MIN_ENC_KEY_LEN} chars) — use a long random value`,
    });
  }

  // Database.
  if (isProd && !env.DATABASE_URL) {
    problems.push({ key: 'DATABASE_URL', level: 'error', message: 'missing' });
  }
  if (isProd && env.DATABASE_URL?.startsWith('file:')) {
    problems.push({
      key: 'DATABASE_URL',
      level: 'warn',
      message: 'SQLite (file:) in production — use Postgres for concurrency/HA',
    });
  }

  // Public URL — provider webhooks (Twilio/Plivo/Meta) are built from this.
  if (isProd && !env.PUBLIC_BASE_URL && !env.APP_BASE_URL) {
    problems.push({
      key: 'PUBLIC_BASE_URL',
      level: 'error',
      message: 'missing — provider webhooks + media stream URLs will be misrouted',
    });
  }

  // Credentials that must never live in env at all.
  //
  // META_PASSWORD held the founder's personal Facebook account password in
  // cleartext (OPEN_QUESTIONS.md Q1). Nothing in the codebase has ever read it —
  // it is pure liability — so this is a tripwire against it being pasted back in
  // rather than a check on something load-bearing. Error-level in every
  // environment, because a dev machine leaks a `.env` as readily as a VM does.
  if (env.META_PASSWORD) {
    problems.push({
      key: 'META_PASSWORD',
      level: 'error',
      message:
        'account passwords must never be stored in env — no code reads this; delete the line and rotate the password',
    });
  }

  // Realtime pipeline needs a Gemini key (env or platform config). We can only
  // check the env side here; a warn is appropriate (it may live in the DB).
  if (isProd && !env.GEMINI_API_KEY) {
    problems.push({
      key: 'GEMINI_API_KEY',
      level: 'warn',
      message: 'not in env — ensure the platform Gemini key is set in /admin, or calls will fail',
    });
  }

  return problems;
}

/** Throw if any `error`-level problem exists (use at prod boot). */
export function assertConfigOrThrow(env: Record<string, string | undefined> = process.env): void {
  const errors = validateConfig(env).filter((p) => p.level === 'error');
  if (errors.length) {
    throw new Error(
      'Invalid configuration:\n' + errors.map((e) => `  - ${e.key}: ${e.message}`).join('\n'),
    );
  }
}

/**
 * Validate at boot and report via the provided logger. Returns whether config is
 * healthy (no error-level problems). Never throws — the caller decides whether a
 * problem should be fatal (prod voice-server) or just logged.
 */
export function reportConfig(
  log: { error: (msg: string) => void; warn: (msg: string) => void } = console,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const problems = validateConfig(env);
  for (const p of problems) {
    const line = `[config] ${p.key}: ${p.message}`;
    if (p.level === 'error') log.error(line);
    else log.warn(line);
  }
  return problems.every((p) => p.level !== 'error');
}
