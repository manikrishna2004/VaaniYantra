import { PrismaClient } from '@prisma/client';

// Reuse a single PrismaClient across hot-reloads in dev to avoid exhausting
// the connection pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Audit F-3.2: the connection pool used Prisma defaults (num_cpus*2+1). On the
// e2-micro that is ~3–5, which can starve under concurrent calls. Make the pool
// size an explicit, environment-tunable knob (via the Postgres `connection_limit`
// query param). SQLite has no pool, so it's left untouched. Pure + testable.
export function buildDatasourceUrl(
  base: string | undefined = process.env.DATABASE_URL,
  limit: string | undefined = process.env.DATABASE_CONNECTION_LIMIT,
): string | undefined {
  if (!base) return undefined;
  if (base.startsWith('file:')) return base; // SQLite: no connection pool
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return base;
  if (/[?&]connection_limit=/.test(base)) return base; // already set explicitly
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}connection_limit=${Math.floor(n)}`;
}

const datasourceUrl = buildDatasourceUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
