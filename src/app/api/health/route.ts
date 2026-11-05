import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/health — liveness + DB check for uptime monitors. 200 when the app
// can reach Postgres, 503 otherwise. Intentionally unauthenticated and
// detail-free (no versions, hostnames, or tenant data).
// The voice-server has its own probe at /health (routed to :8080 by Caddy).
export async function GET() {
  const dbCheck = prisma.$queryRaw`SELECT 1`;
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('db health check timed out')), 3000),
  );
  try {
    await Promise.race([dbCheck, timeout]);
    return NextResponse.json(
      { ok: true, db: 'up', uptimeSec: Math.round(process.uptime()) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, db: 'down' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
