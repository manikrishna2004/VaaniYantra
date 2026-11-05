import { encryptSecret, decryptSecret } from '@/lib/crypto';

// A per-agent Gemini key (Agent.geminiApiKey), stored encrypted.
//
// Only demo/allow-listed accounts can set one (see flags.demoVerticalsAllowed);
// every other agent leaves it null and keeps resolving org integration >
// platform key exactly as before. Two rules make it safe to carry around:
//   • it is encrypted the moment it arrives and decrypted only where a call is
//     about to be made, and
//   • it never leaves the server — API responses carry `hasGeminiKey` instead,
//     because the agent rows are returned to the browser wholesale.

// Decrypt an agent's own key, or undefined when it has none / cannot be read.
// Never throws: a key that fails to decrypt (rotated SECRET_ENC_KEY) must fall
// back to the org/platform key rather than take the call down.
export function agentGeminiKey(
  agent: { geminiApiKey?: string | null } | null | undefined,
): string | undefined {
  if (!agent?.geminiApiKey) return undefined;
  try {
    return decryptSecret(agent.geminiApiKey) || undefined;
  } catch {
    console.error('[agent-gemini] could not decrypt agent Gemini key — falling back');
    return undefined;
  }
}

// Map an inbound form value onto the Prisma field.
//   undefined → leave the stored key alone
//   '' / null → clear it (back to the org/platform key)
//   a value   → encrypt and store
export function geminiKeyUpdate(input: string | null | undefined): { geminiApiKey: string | null } | {} {
  if (input === undefined) return {};
  const trimmed = (input ?? '').trim();
  return { geminiApiKey: trimmed ? encryptSecret(trimmed) : null };
}

// Strip the encrypted key out of anything sent to the client, leaving a flag.
export function withoutGeminiKey<T extends { geminiApiKey?: string | null }>(
  agent: T,
): Omit<T, 'geminiApiKey'> & { hasGeminiKey: boolean } {
  const { geminiApiKey, ...rest } = agent;
  return { ...rest, hasGeminiKey: Boolean(geminiApiKey) };
}
