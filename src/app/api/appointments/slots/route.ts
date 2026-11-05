import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiContext, deny } from '@/lib/auth/api';
import { findOpenSlots, readBookingConfig } from '@/lib/connectors/booking';
import { listBookableDoctors } from '@/lib/doctors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Open appointment slots, for the front desk's booking form.
 *
 * Deliberately the same findOpenSlots() the phone agent and the patient chatbot
 * call. Three channels reading availability three different ways is how a
 * clinic ends up double-booking a doctor.
 */
export async function GET(req: Request) {
  const { ctx, error } = await apiContext();
  if (error) return error;
  const denied = deny(ctx, 'call:read');
  if (denied) return denied;

  const params = new URL(req.url).searchParams;
  const agentId = params.get('agentId') ?? undefined;
  const date = params.get('date') ?? undefined;
  const expert = params.get('expert') ?? undefined;

  const agents = agentId
    ? await prisma.agent.findMany({ where: { id: agentId, workspaceId: ctx.workspace.id } })
    : await prisma.agent.findMany({ where: { workspaceId: ctx.workspace.id }, orderBy: { createdAt: 'asc' } });

  const agent = agents.find((a) => readBookingConfig(a).enabled);
  if (!agent) {
    return NextResponse.json(
      { ok: false, error: 'No agent has appointment booking enabled.', slots: [], experts: [] },
      { status: 200 },
    );
  }

  const cfg = readBookingConfig(agent);
  const result = await findOpenSlots(cfg, ctx.org.id, { date, expert });

  return NextResponse.json({
    ...result,
    agentId: agent.id,
    // The form needs to know who can be booked and what the visit is called.
    // Doctors come from the Doctor table now, not from the agent's config.
    experts: (await listBookableDoctors(ctx.org.id)).map((d) => d.displayName),
    serviceName: cfg.serviceName,
    timezone: cfg.timezone,
  });
}
