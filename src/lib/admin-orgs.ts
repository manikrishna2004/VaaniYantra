import { prisma } from '@/lib/db';
import { monthStart } from '@/lib/billing/catalogue';

// The operator's view of every tenant: who owns it, what it uses, what state it
// is in. Lives here rather than inside the admin route because the CSV export
// needs exactly the same rows — building them twice is how a spreadsheet and a
// screen end up quietly disagreeing about the same customer.
//
// SCOPE, deliberately: organisation-level business data only. No patient names,
// numbers, transcripts or clinical records ever appear here, whatever filters
// are passed. This export is built to be handed to a marketing team, and the
// only safe way to promise that is for the query never to reach patient data at
// all — see /dpa and /subprocessors for why that line matters.

export const ORG_PERIODS = ['month', '7', '30', '90', 'all'] as const;
export type OrgPeriod = (typeof ORG_PERIODS)[number];

export function parseOrgPeriod(v: string | null | undefined): OrgPeriod {
  return (ORG_PERIODS as readonly string[]).includes(v ?? '') ? (v as OrgPeriod) : 'month';
}

/** Start of the usage window, or null for all time. */
export function periodSince(period: OrgPeriod): Date | null {
  if (period === 'all') return null;
  // 'month' is the calendar month billing bills on, so the default column and
  // the customer's own invoice agree. The day ranges are rolling windows.
  if (period === 'month') return monthStart();
  return new Date(Date.now() - Number(period) * 86_400_000);
}

export function periodLabel(period: OrgPeriod): string {
  if (period === 'month') return 'This month';
  if (period === 'all') return 'All time';
  return `Last ${period} days`;
}

export type OrgFilters = {
  plan?: string; // '' / 'all' = any
  status?: string; // '' / 'all' = any
  numbers?: 'all' | 'with' | 'without';
  agents?: 'all' | 'with' | 'without';
};

export type AdminOrgRow = {
  id: string;
  name: string;
  plan: string;
  createdAt: string;
  termsAcceptedAt: string | null;
  termsVersion: string | null;
  ownerEmail: string | null;
  status: string;
  statusReason: string | null;
  statusChangedAt: string | null;
  minutes: number;
  calls: number;
  agents: number;
  phoneNumbers: number;
  _count: { workspaces: number; memberships: number };
};

/**
 * Row-level filters, as ONE pure function so the dashboard and the export apply
 * identical rules. The screen filters in the browser for instant response and
 * the export filters on the server; both call this.
 */
export function matchesOrgFilters(row: AdminOrgRow, f: OrgFilters): boolean {
  if (f.plan && f.plan !== 'all' && row.plan !== f.plan) return false;
  if (f.status && f.status !== 'all' && row.status !== f.status) return false;
  if (f.numbers === 'with' && row.phoneNumbers === 0) return false;
  if (f.numbers === 'without' && row.phoneNumbers > 0) return false;
  if (f.agents === 'with' && row.agents === 0) return false;
  if (f.agents === 'without' && row.agents > 0) return false;
  return true;
}

/** Every organisation, with usage over `period`. Newest first. */
export async function listOrgRows(period: OrgPeriod, take = 200): Promise<AdminOrgRow[]> {
  const orgs = await prisma.organization.findMany({
    select: {
      id: true, name: true, plan: true, createdAt: true, termsAcceptedAt: true, termsVersion: true,
      status: true, statusReason: true, statusChangedAt: true,
      // Enough members to find the OWNER without loading whole teams; the true
      // member count comes from _count below.
      memberships: {
        select: { role: true, user: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
        take: 10,
      },
      workspaces: { select: { id: true } },
      _count: { select: { workspaces: true, memberships: true } },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });

  // Usage, grouped by workspace and folded up here — one query each rather than
  // three per organisation.
  const workspaceIds = orgs.flatMap((o) => o.workspaces.map((w) => w.id));
  const since = periodSince(period);
  const callWhere = {
    workspaceId: { in: workspaceIds },
    ...(since ? { createdAt: { gte: since } } : {}),
  };
  const [usageRows, agentRows, numberRows] = await Promise.all([
    prisma.call.groupBy({
      by: ['workspaceId'],
      where: callWhere,
      _sum: { durationSec: true },
      _count: { _all: true },
    }),
    prisma.agent.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: workspaceIds } }, _count: { _all: true } }),
    prisma.phoneNumber.groupBy({ by: ['workspaceId'], where: { workspaceId: { in: workspaceIds } }, _count: { _all: true } }),
  ]);
  const secByWs = new Map(usageRows.map((r) => [r.workspaceId, r._sum.durationSec ?? 0]));
  const callsByWs = new Map(usageRows.map((r) => [r.workspaceId, r._count._all]));
  const agentsByWs = new Map(agentRows.map((r) => [r.workspaceId, r._count._all]));
  const numbersByWs = new Map(numberRows.map((r) => [r.workspaceId, r._count._all]));
  const sum = (ids: string[], m: Map<string | null, number>) => ids.reduce((n, id) => n + (m.get(id) ?? 0), 0);

  return orgs.map((o) => {
    const ids = o.workspaces.map((w) => w.id);
    const { memberships, workspaces, createdAt, termsAcceptedAt, statusChangedAt, ...rest } = o;
    return {
      ...rest,
      createdAt: createdAt.toISOString(),
      termsAcceptedAt: termsAcceptedAt?.toISOString() ?? null,
      statusChangedAt: statusChangedAt?.toISOString() ?? null,
      // The address the owner actually signs in with. Falls back to the oldest
      // member when an org has no OWNER row, so it is never blank for a real
      // tenant.
      ownerEmail:
        memberships.find((m) => m.role === 'OWNER')?.user.email ?? memberships[0]?.user.email ?? null,
      minutes: Math.round(sum(ids, secByWs) / 60),
      calls: sum(ids, callsByWs),
      agents: sum(ids, agentsByWs),
      phoneNumbers: sum(ids, numbersByWs),
    };
  });
}

/** CSV header + rows for the export. Business data only, by construction. */
export function orgCsv(rows: AdminOrgRow[], period: OrgPeriod): { header: string[]; body: unknown[][] } {
  const header = [
    'Organisation', 'Owner email', 'Status', 'Status reason', 'Plan',
    `Minutes (${periodLabel(period)})`, `Calls (${periodLabel(period)})`,
    'Agents', 'Phone numbers', 'Workspaces', 'Members',
    'Signed up', 'Terms accepted', 'Terms version',
  ];
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
  const body = rows.map((r) => [
    r.name, r.ownerEmail ?? '', r.status, r.statusReason ?? '', r.plan,
    r.minutes, r.calls, r.agents, r.phoneNumbers, r._count.workspaces, r._count.memberships,
    day(r.createdAt), day(r.termsAcceptedAt), r.termsVersion ?? '',
  ]);
  return { header, body };
}
