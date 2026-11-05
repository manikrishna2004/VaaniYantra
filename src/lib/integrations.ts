import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';

// Catalogue of supported integration providers. `key` is the canonical id stored
// in Integration.provider and used as the OrgCredentials field name.
export const INTEGRATION_PROVIDERS = [
  { key: 'deepgram', label: 'Deepgram', hint: 'Speech-to-text + Aura voices.' },
  { key: 'elevenlabs', label: 'ElevenLabs', hint: 'Premium multilingual TTS voices.' },
  { key: 'gemini', label: 'Gemini', hint: 'Google Gemini API key for the LLM / expressive TTS.' },
  { key: 'googleCloud', label: 'Google Cloud', hint: 'Google Cloud Speech / Text-to-Speech API key.' },
  { key: 'hubspot', label: 'HubSpot', hint: 'CRM — push a contact + call note when calls complete (Private App token).' },
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number]['key'];

export function isIntegrationProvider(v: string): v is IntegrationProvider {
  return INTEGRATION_PROVIDERS.some((p) => p.key === v);
}

export type OrgCredentials = Partial<Record<IntegrationProvider, string>>;

// Resolve an org's enabled integration secrets (decrypted). Best-effort: a bad
// ciphertext for one provider is skipped rather than failing the whole call.
export async function getOrgCredentials(orgId: string | null | undefined): Promise<OrgCredentials> {
  if (!orgId) return {};
  const rows = await prisma.integration.findMany({ where: { orgId, enabled: true } });
  const creds: OrgCredentials = {};
  for (const r of rows) {
    if (!isIntegrationProvider(r.provider)) continue;
    try {
      creds[r.provider] = decryptSecret(r.secret);
    } catch {
      /* skip undecryptable secret */
    }
  }
  return creds;
}
