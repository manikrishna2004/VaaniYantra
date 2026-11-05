import { NextResponse } from 'next/server';
import { verifyDeployRequest } from '@/lib/deploy/deploy-auth';
import { recordUsage } from '@/lib/usage/ledger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** One request may not carry more than this. A backlog comes back in batches. */
const MAX_EVENTS = 500;

// POST /api/deploy/v1/telemetry — what a deployment says about its own usage.
//
// ── THE CRUX OF THE WHOLE CLIENT-CLOUD MODE ─────────────────────────────────
//
// This endpoint accepts numbers from a machine we do not control, and it must
// never be able to move money. So the rows it writes carry the metric
// **`voice.minutes.reported`**, which is a DIFFERENT STRING from the
// `voice.minutes` that billing sums. Not a flag on the row, not a source field
// billing is trusted to filter on — a different name in a namespace the biller
// does not read.
//
// That is what makes "the reseller's pull is billing truth" unfalsifiable
// rather than a convention someone could later relax by accident. A client who
// under-reports changes a discrepancy report; they cannot change an invoice.
//
// Everything identifying is taken from the AUTHENTICATED deployment, never from
// the body: the org, the deployment id. A body claiming another org's id is
// simply ignored rather than rejected, because there is nothing to negotiate.
export async function POST(req: Request) {
  const raw = await req.text();
  const auth = await verifyDeployRequest(req, raw);
  if (auth instanceof NextResponse) return auth;

  const orgId = auth.deployment.orgId;
  if (!orgId) {
    // The shared cloud has no single org and does not report to itself this
    // way; its usage is written by the call path directly.
    return NextResponse.json({ error: 'This deployment reports no usage' }, { status: 400 });
  }

  let body: { events?: unknown } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events) return NextResponse.json({ error: 'events[] required' }, { status: 400 });
  if (events.length > MAX_EVENTS) {
    return NextResponse.json({ error: `At most ${MAX_EVENTS} events per request` }, { status: 400 });
  }

  let accepted = 0;
  let duplicates = 0;
  const rejected: string[] = [];

  for (const item of events as Array<Record<string, unknown>>) {
    const externalId = typeof item?.externalId === 'string' ? item.externalId.slice(0, 200) : '';
    const seconds = Number(item?.seconds);
    const occurredAt = new Date(String(item?.occurredAt ?? ''));
    if (!externalId || !Number.isFinite(seconds) || seconds < 0 || Number.isNaN(occurredAt.getTime())) {
      rejected.push(externalId || '(no id)');
      continue;
    }

    const res = await recordUsage({
      orgId,
      metric: 'voice.minutes.reported',
      source: 'client_cloud',
      // Namespaced by deployment: two installs cannot collide on a call id, and
      // a replayed batch converges on one row per record.
      externalId: `${auth.deployment.id}:${externalId}`,
      quantity: Math.round(seconds),
      occurredAt,
      deploymentId: auth.deployment.id,
      raw: item as Record<string, never>,
    });
    if (res.recorded) accepted += 1;
    else duplicates += 1;
  }

  return NextResponse.json({ accepted, duplicates, rejected: rejected.length });
}
