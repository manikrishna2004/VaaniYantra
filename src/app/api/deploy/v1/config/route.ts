import { NextResponse } from 'next/server';
import { verifyDeployRequest, ENTITLEMENT_TTL_SEC, MAX_SKEW_SEC } from '@/lib/deploy/deploy-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/deploy/v1/config — what the install needs to know about itself.
//
// ⚠ NOTHING SECRET IS EVER RETURNED HERE, and that is a rule rather than a
// current state of affairs. This response is fetched by a process on a machine
// the client's ops team has root on, so anything in it is, in effect, published
// to that client. The platform reseller credential, the Cashfree keys and the
// cron secrets are named in FORBIDDEN_IN_DEDICATED for the same reason.
//
// It is also how the channel stays OUTBOUND-ONLY: the install polls this rather
// than us pushing config into their network. We never dial in.
export async function GET(req: Request) {
  const auth = await verifyDeployRequest(req, '');
  if (auth instanceof NextResponse) return auth;

  const { deployment } = auth;
  return NextResponse.json({
    deploymentId: deployment.id,
    // The single organisation this install serves. It is also what
    // assertSingleTenantDatabase() checks its database against, so an install
    // pointed at the wrong database can find out from us rather than by
    // serving another clinic's patients.
    orgId: deployment.orgId,
    mode: deployment.mode,
    status: deployment.status,
    serverTime: Math.floor(Date.now() / 1000),
    // How often to come back, and the two windows that decide whether a
    // request is accepted at all.
    heartbeatIntervalSec: 300,
    telemetryIntervalSec: 900,
    entitlementTtlSec: ENTITLEMENT_TTL_SEC,
    maxClockSkewSec: MAX_SKEW_SEC,
  });
}
