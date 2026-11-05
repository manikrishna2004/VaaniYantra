import { getPlatformConfig } from '@/lib/platform';
import { OmniDimensionProvider } from '@/lib/adapters/voice-platform/omnidimension';
import { MockVoicePlatform } from '@/lib/adapters/voice-platform/mock';
import type { VoicePlatformProvider } from '@/lib/adapters/voice-platform/types';

export * from '@/lib/adapters/voice-platform/types';
export { MockVoicePlatform } from '@/lib/adapters/voice-platform/mock';
export { OmniDimensionProvider, parseTimeOfCall } from '@/lib/adapters/voice-platform/omnidimension';

// Which voice platform we resell. Same factory shape as
// src/lib/adapters/telephony/index.ts — one place that picks an implementation,
// so nothing downstream branches on the provider.

/** PlatformConfig keys. The reseller key is a secret and is stored encrypted. */
export const VOICE_PLATFORM_KEYS = {
  apiKey: 'omnidimension_api_key',
  baseUrl: 'omnidimension_base_url',
} as const;

/** For tests and local dev, so no one needs live reseller credentials to work. */
export function mockVoicePlatformEnabled(): boolean {
  return process.env.USE_MOCK_VOICE_PLATFORM === 'true';
}

/**
 * The configured provider, or null when there is nothing to talk to.
 *
 * Null rather than a throw: reselling is off by default, and every caller
 * (the reconciler, the ops-health check, the spend-cap sync) has to cope with
 * "not configured" as a normal state rather than an error, or the platform
 * alarms constantly until the first reseller account exists.
 */
export async function getVoicePlatform(): Promise<VoicePlatformProvider | null> {
  if (mockVoicePlatformEnabled()) return new MockVoicePlatform();

  const [apiKey, baseUrl] = await Promise.all([
    getPlatformConfig(VOICE_PLATFORM_KEYS.apiKey),
    getPlatformConfig(VOICE_PLATFORM_KEYS.baseUrl),
  ]);
  if (!apiKey) return null;

  return new OmniDimensionProvider({ apiKey, baseUrl: baseUrl ?? undefined });
}
