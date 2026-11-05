import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { clientIp } from '@/lib/rate-limit';
import { verifyDeployRequest } from '@/lib/deploy/deploy-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/deploy/v1/heartbeat — "I am up, and this is what I am running."
//
// Authenticated by deployment signature, never by an ApiKey: a leaked customer
// key must not be able to speak as a deployment, and the two credentials are
// deliberately verified by different code paths so that widening one cannot
// widen the other.
//
// The version reported here is the whole point of tagging images immutably. A
// client's box saying "vaaniyantra/runtime:2026.09.02+a1b2c3d" is an answer;
// one saying "latest" is not.
export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await verifyDeployRequest(req, raw);
  if (auth instanceof NextResponse) return auth;

  let body: { version?: unknown; error?: unknown } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const version = typeof body.version === 'string' ? body.version.slice(0, 200) : null;
  // Whatever the install last failed at, kept as one line. It is the only
  // window we have into a box we cannot log into.
  const lastError = typeof body.error === 'string' ? body.error.slice(0, 500) : null;

  await prisma.deployment.update({
    where: { id: auth.deployment.id },
    data: {
      lastSeenAt: new Date(),
      lastIp: clientIp(req),
      ...(version ? { version } : {}),
      lastError,
    },
  });

  return NextResponse.json({
    ok: true,
    // The install checks its own clock against ours: signing fails at 300s of
    // skew, and "your clock is wrong" is a far better diagnosis than a stream
    // of 401s.
    serverTime: Math.floor(Date.now() / 1000),
    status: auth.deployment.status,
    entitled: auth.deployment.entitlementRevokedAt === null && auth.deployment.status === 'ACTIVE',
  });
}
