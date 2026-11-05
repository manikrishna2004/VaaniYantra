import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { audit } from '@/lib/audit';
import { parseRange, rangeSince, parseExportType, toCsv, EXPORT_PERMISSION, type ExportType } from '@/lib/reports';
import { formatAge, formatDateOfBirth, sexLabel } from '@/lib/patients/age';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// CSV export — the way a clinic gets its data out, and the replacement for the
// old Google Drive/Sheets archiving.
//
// Bounded at ROW_CAP per download: this streams from a single query into
// memory, and an unbounded export of a busy hospital would be a self-inflicted
// OOM. The range filter is the intended way to get a full history out in pieces.
const ROW_CAP = 10_000;


export async function GET(req: Request) {
  const ctx = await requireWorkspace();

  const params = new URL(req.url).searchParams;
  const range = parseRange(params.get('range'));
  const type = parseExportType(params.get('type'));
  const since = rangeSince(range);
  const createdAt = since ? { gte: since } : undefined;

  if (!hasPermission(ctx.role, EXPORT_PERMISSION[type])) {
    return NextResponse.json({ error: 'You do not have access to export this data.' }, { status: 403 });
  }

  const { header, rows } = await buildExport(type, ctx.workspace.id, createdAt);

  // Bulk extraction is the highest-value event in the log: one request can carry
  // thousands of patients out of the building. Recorded with what was taken and
  // how much, never the contents.
  await audit(ctx, 'report.exported', {
    targetType: 'Report',
    targetId: type,
    metadata: { type, range, rows: rows.length, capped: rows.length >= ROW_CAP },
    req,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(header, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="vaaniyantra-${type}-${range}-${stamp}.csv"`,
      // Patient data must not sit in a shared cache.
      'Cache-Control': 'private, no-store',
    },
  });
}

async function buildExport(
  type: ExportType,
  workspaceId: string,
  createdAt: { gte: Date } | undefined,
): Promise<{ header: string[]; rows: unknown[][] }> {
  if (type === 'appointments') {
    const rows = await prisma.appointment.findMany({
      where: { workspaceId, ...(createdAt ? { createdAt } : {}) },
      orderBy: { startAt: 'desc' },
      take: ROW_CAP,
    });
    return {
      header: [
        'Booked at',
        'Patient no.',
        'Patient',
        'Phone',
        'Doctor',
        'Service',
        'Starts',
        'Ends',
        'Timezone',
        'Status',
        'Channel',
      ],
      rows: rows.map((a) => [
        a.createdAt.toISOString(),
        a.patientNo ?? '',
        a.customerName,
        a.customerNumber ?? '',
        a.expertName ?? '',
        a.service,
        a.startAt.toISOString(),
        a.endAt.toISOString(),
        a.timezone ?? '',
        a.status,
        a.channel,
      ]),
    };
  }

  if (type === 'patients') {
    // Patients are org-scoped rather than workspace-scoped, but the export is
    // driven from a workspace — scope to the workspace so a member only ever
    // exports the patients the rest of the app already shows them.
    const rows = await prisma.contact.findMany({
      where: { workspaceId, ...(createdAt ? { createdAt } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { visits: true } } },
      take: ROW_CAP,
    });
    return {
      header: [
        'Registered',
        'Patient no.',
        'Name',
        'Date of birth',
        'Age',
        'Sex',
        'Phone',
        'Email',
        'External ID',
        'Visits',
        'Last seen',
      ],
      rows: rows.map((c) => [
        c.createdAt.toISOString(),
        c.uhid ?? '',
        c.name,
        formatDateOfBirth(c.dateOfBirth),
        formatAge(c.dateOfBirth),
        sexLabel(c.sex),
        c.phone,
        c.email ?? '',
        c.externalId ?? '',
        c._count.visits,
        c.lastSeenAt?.toISOString() ?? '',
      ]),
    };
  }

  if (type === 'outcomes') {
    const rows = await prisma.outcome.findMany({
      where: { workspaceId, ...(createdAt ? { createdAt } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { agent: { select: { name: true } } },
      take: ROW_CAP,
    });
    // Captured fields are per-agent and free-form, so the columns can't be
    // fixed up front. Build them from the union of keys actually present, in
    // first-seen order, so every row lines up under a stable header.
    const fieldKeys: string[] = [];
    for (const o of rows) {
      for (const k of Object.keys((o.fields ?? {}) as Record<string, unknown>)) {
        if (!fieldKeys.includes(k)) fieldKeys.push(k);
      }
    }
    return {
      header: ['Captured', 'Type', 'Agent', 'Name', 'Phone', ...fieldKeys],
      rows: rows.map((o) => {
        const fields = (o.fields ?? {}) as Record<string, unknown>;
        return [
          o.createdAt.toISOString(),
          o.type,
          o.agent?.name ?? '',
          o.callerName ?? '',
          o.callerNumber ?? '',
          ...fieldKeys.map((k) => fields[k] ?? ''),
        ];
      }),
    };
  }

  const rows = await prisma.call.findMany({
    where: { workspaceId, ...(createdAt ? { createdAt } : {}) },
    orderBy: { createdAt: 'desc' },
    include: { agent: { select: { name: true } } },
    take: ROW_CAP,
  });
  return {
    header: [
      'Created',
      'Direction',
      'From',
      'To',
      'Agent',
      'Status',
      'Duration (s)',
      'Sentiment',
      'Sentiment score',
      'Topics',
      'Summary',
    ],
    rows: rows.map((c) => [
      c.createdAt.toISOString(),
      c.direction,
      c.fromNumber,
      c.toNumber,
      c.agent?.name ?? '',
      c.status,
      c.durationSec,
      c.sentiment ?? '',
      c.sentimentScore ?? '',
      Array.isArray(c.topics) ? (c.topics as string[]).join('; ') : '',
      c.summary ?? '',
    ]),
  };
}
