import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Download one call as a plain-text record: header, summary, full transcript.
//
// This is what the Google Drive integration used to produce automatically as a
// Doc after every call. Making it an on-demand download instead of an automatic
// archive means it needs no Google account, no Drive scope, and no background
// job that can silently fail — and the clinic gets the same artefact.
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx.role, 'call:read')) {
    return NextResponse.json({ error: 'You do not have access to this call.' }, { status: 403 });
  }

  const call = await prisma.call.findFirst({
    where: { id, workspaceId: ctx.workspace.id },
    include: {
      agent: { select: { name: true } },
      transcript: { orderBy: { atMs: 'asc' } },
    },
  });
  if (!call) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const when = call.createdAt.toISOString().slice(0, 16).replace('T', ' ');
  const speaker = (role: string) => (role === 'AGENT' ? 'Agent' : role === 'CALLER' ? 'Caller' : 'System');
  const body =
    `Call record — ${call.agent?.name ?? 'VaaniYantra'}\n` +
    `Date: ${when} UTC\n` +
    `Direction: ${call.direction}\n` +
    `From: ${call.fromNumber}\n` +
    `To: ${call.toNumber}\n` +
    `Duration: ${call.durationSec}s\n` +
    `Status: ${call.status}\n\n` +
    `Summary:\n${call.summary ?? '(no summary)'}\n\n` +
    `Transcript:\n${
      call.transcript.length
        ? call.transcript.map((t) => `${speaker(t.role)}: ${t.text}`).join('\n')
        : '(no transcript)'
    }\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="vaaniyantra-call-${id}.txt"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
