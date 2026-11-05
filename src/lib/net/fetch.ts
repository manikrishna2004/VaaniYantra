// Resilient fetch: timeout + bounded retry with exponential backoff + jitter.
//
// Audit F-2.1/F-2.2: the codebase had 47 `fetch()` calls with no timeout and no
// retry. A hung upstream (provider outage, slow DNS) would block a request — or,
// mid-call, strand the caller — indefinitely; a single transient 5xx would drop
// a confirmation. This wraps fetch with an AbortController deadline and optional
// retry on transient failures (timeouts, network errors, 429, 5xx). 4xx (except
// 429) are returned as-is — retrying a client error is pointless.
//
// Dependency-injected fetch + sleep make it deterministically testable.

export interface RetryFetchOptions extends RequestInit {
  /** Per-attempt deadline. Default 15s. */
  timeoutMs?: number;
  /** Additional attempts after the first. Default 0 (timeout only, no retry). */
  retries?: number;
  /** Base backoff delay; grows ~2^n with jitter. Default 250ms. */
  baseDelayMs?: number;
}

export interface FetchDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const defaultDeps: FetchDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
};

/** Whether an HTTP status is worth retrying (transient server-side / throttle). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RetryFetchOptions = {},
  deps: FetchDeps = defaultDeps,
): Promise<Response> {
  const { timeoutMs = 15_000, retries = 0, baseDelayMs = 250, ...rest } = init;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await deps.fetch(input, { ...rest, signal: controller.signal });
      clearTimeout(timer);
      if (attempt < retries && isRetryableStatus(res.status)) {
        await backoff(deps, baseDelayMs, attempt);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // AbortError (timeout) and network TypeErrors are transient.
      if (attempt < retries) {
        await backoff(deps, baseDelayMs, attempt);
        continue;
      }
      throw err;
    }
  }
  // Only reached if the last iteration retried on a bad status; re-issue once
  // more without retry to surface the final response/error.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await deps.fetch(input, { ...rest, signal: controller.signal });
  } catch (err) {
    throw lastErr ?? err;
  } finally {
    clearTimeout(timer);
  }
}

async function backoff(deps: FetchDeps, base: number, attempt: number): Promise<void> {
  const expo = base * 2 ** attempt;
  const jitter = expo * 0.25 * deps.random();
  await deps.sleep(expo + jitter);
}
