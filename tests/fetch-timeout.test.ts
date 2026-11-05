import { describe, it, expect, vi } from 'vitest';
import { fetchWithTimeout, isRetryableStatus, type FetchDeps } from '@/lib/net/fetch';

function res(status: number): Response {
  return new Response('', { status });
}

const noWaitDeps = (fetchImpl: FetchDeps['fetch']): FetchDeps => ({
  fetch: fetchImpl,
  sleep: () => Promise.resolve(),
  random: () => 0,
});

describe('isRetryableStatus', () => {
  it('retries 429 and 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('fetchWithTimeout', () => {
  it('returns the response on success without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200));
    const r = await fetchWithTimeout('https://x', { retries: 3 }, noWaitDeps(fetchImpl));
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 4xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(400));
    const r = await fetchWithTimeout('https://x', { retries: 3 }, noWaitDeps(fetchImpl));
    expect(r.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries transient 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const r = await fetchWithTimeout('https://x', { retries: 2 }, noWaitDeps(fetchImpl));
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries network errors then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(res(200));
    const r = await fetchWithTimeout('https://x', { retries: 1 }, noWaitDeps(fetchImpl));
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up and throws after exhausting retries on persistent network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('down'));
    await expect(
      fetchWithTimeout('https://x', { retries: 1 }, noWaitDeps(fetchImpl)),
    ).rejects.toThrow();
    // initial + 1 retry + final re-issue
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('passes an abort signal so a hung request can time out', async () => {
    let sawSignal = false;
    const fetchImpl = vi.fn().mockImplementation((_u: unknown, init: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return Promise.resolve(res(200));
    });
    await fetchWithTimeout('https://x', { timeoutMs: 10 }, noWaitDeps(fetchImpl));
    expect(sawSignal).toBe(true);
  });
});
