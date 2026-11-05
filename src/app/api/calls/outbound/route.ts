import { NextResponse } from 'next/server';
import { requireWorkspace } from '@/lib/auth/context';
import { hasPermission } from '@/lib/auth/permissions';
import { outboundCallSchema, readJson } from '@/lib/validation';
import { placeOutboundCall } from '@/lib/calls/place-outbound';

export const dynamic = 'force-dynamic';

// Initiate an outbound call from the dashboard (session auth). Delegates the
// actual placement to the shared placeOutboundCall helper (also used by the
// public API).
export async function POST(req: Request) {
  const { workspace, org, role } = await requireWorkspace();
  if (!hasPermission(role, 'call:write')) {
    return NextResponse.json({ error: 'Forbidden: requires call:write' }, { status: 403 });
  }

  const json = await readJson(req);
  if (json === null) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const parsed = outboundCallSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { agentId, to, fromNumberId } = parsed.data;

  const result = await placeOutboundCall({
    orgId: org.id,
    workspaceId: workspace.id,
    agentId,
    to,
    fromNumberId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    result.simulated ? { ...result.call, simulated: true } : result.call,
    { status: 201 },
  );
}
