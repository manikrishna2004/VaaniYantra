import { createHash, randomBytes } from 'crypto';
import { prisma } from '@/lib/db';

const PREFIX = 'ck_live_';

export function generateApiKey() {
  const secret = randomBytes(24).toString('hex');
  const full = PREFIX + secret;
  return {
    full,
    hashedKey: hashApiKey(full),
    prefix: PREFIX,
    lastFour: full.slice(-4),
  };
}

export function hashApiKey(full: string): string {
  return createHash('sha256').update(full).digest('hex');
}

/**
 * Authenticate a request by API key (Authorization: Bearer ck_live_... or
 * x-api-key header). Returns the owning org id and the key's granted scopes,
 * or null. Updates lastUsedAt.
 *
 * `scopes` is read off the row we already fetch — no extra query. It may be
 * missing or empty on keys created before scopes were enforced; deciding what
 * empty MEANS is requireApiAuth's job, not this function's (see
 * src/lib/api/scopes.ts).
 */
export async function authenticateApiKey(
  req: Request,
): Promise<{ orgId: string; keyId: string; scopes: string[] } | null> {
  const headerKey = req.headers.get('x-api-key');
  const auth = req.headers.get('authorization');
  let token = headerKey ?? '';
  if (!token && auth?.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token.startsWith(PREFIX)) return null;

  const key = await prisma.apiKey.findUnique({ where: { hashedKey: hashApiKey(token) } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) return null;

  void prisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { orgId: key.orgId, keyId: key.id, scopes: key.scopes ?? [] };
}
