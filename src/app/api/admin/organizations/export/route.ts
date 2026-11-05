import { NextResponse } from 'next/server';
import { requireSharedDeployment } from '@/lib/deploy/deployment';
import { apiContext } from '@/lib/auth/api';
import { audit } from '@/lib/audit';
import { isSuperAdmin } from '@/lib/platform';
import { toCsv } from '@/lib/reports';
import {
  listOrgRows,
  matchesOrgFilters,
  orgCsv,
  parseOrgPeriod,
  type OrgFilters,
} from '@/lib/admin-orgs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The tenant list as CSV — the thing you hand to marketing or open in a sheet.
//
// Super-admin only, and audited: this is a bulk extraction of the customer
// base, including every owner's email address. That is exactly the request
// worth having a record of, even when it is the founder making it.
//
// What it CANNOT contain is the point: listOrgRows never queries patient data,
// so there is no filter or parameter that would put a patient name, phone
// number or clinical record into a file destined for a marketing team. The
// guarantee is structural rather than a rule someone has to remember.
export async function GET(req: Request) {
  // A dedicated (client-cloud) install has no admin surface. First line of
  // every handler here, and 404 rather than 403 - see requireSharedDeployment.
  const blocked = requireSharedDeployment();
  if (blocked) return blocked;

  const { ctx, error } = await apiContext();
  if (error) return error;
  if (!isSuperAdmin(ctx.user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const period = parseOrgPeriod(params.get('period'));
  const filters: OrgFilters = {
    plan: params.get('plan') ?? 'all',
    status: params.get('status') ?? 'all',
    numbers: (params.get('numbers') as OrgFilters['numbers']) ?? 'all',
    agents: (params.get('agents') as OrgFilters['agents']) ?? 'all',
  };

  // Same builder and same predicate the dashboard uses, so the file matches
  // what was on screen when the button was pressed.
  const rows = (await listOrgRows(period)).filter((r) => matchesOrgFilters(r, filters));
  const { header, body } = orgCsv(rows, period);

  await audit(ctx, 'platform.orgs_exported', {
    targetType: 'Platform',
    metadata: { period, ...filters, rows: rows.length },
    req,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(header, body), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="vaaniyantra-organisations-${period}-${stamp}.csv"`,
      // Customer contact data must not sit in a shared cache.
      'Cache-Control': 'private, no-store',
    },
  });
}
