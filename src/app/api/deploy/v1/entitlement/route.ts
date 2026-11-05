import { NextResponse } from 'next/server';
import {
  verifyDeployRequest,
  deploymentKeySecret,
  mintEntitlement,
  ENTITLEMENT_TTL_SEC,
} from '@/lib/deploy/deploy-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/deploy/v1/entitlement — a one-hour signed statement that this
// deployment may place calls.
//
// ⚠ EVIDENCE, NOT ENFORCEMENT. The install refuses to dial without a live
// token, and a client with root on the box can patch that check out. Nothing
// here pretends otherwise. What it buys is that calls placed after entitlement
// lapses are a provable breach rather than an argument about whose records are
// right — which is the actual failure mode in a mode where we do not own the
// hardware.
//
// Signed with the key that authenticated the request, so the install verifies
// it offline with the secret it already holds. No new key material, and no
// round trip in the call path.
export async function GET(req: Request) {
  const auth = await verifyDeployRequest(req, '');
  if (auth instanceof NextResponse) return auth;

  const { deployment } = auth;
  if (deployment.status !== 'ACTIVE' || deployment.entitlementRevokedAt !== null) {
    // 403 rather than 404: this deployment is known and is being told, in
    // terms it can log, that it is no longer entitled. That message is the
    // point of the mechanism.
    return NextResponse.json(
      {
        error: 'This deployment is not entitled to place calls',
        status: deployment.status,
        revokedAt: deployment.entitlementRevokedAt,
      },
      { status: 403 },
    );
  }

  const secret = await deploymentKeySecret(auth.keyId);
  if (!secret) {
    return NextResponse.json({ error: 'Key unavailable' }, { status: 500 });
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const { token, expiresAt } = mintEntitlement(secret, {
    deploymentId: deployment.id,
    orgId: deployment.orgId,
    issuedAt,
    expiresAt: issuedAt + ENTITLEMENT_TTL_SEC,
  });

  return NextResponse.json({ token, expiresAt, ttlSec: ENTITLEMENT_TTL_SEC });
}
