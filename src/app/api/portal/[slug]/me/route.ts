import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { currentPortalSession, PORTAL_COOKIE } from '@/lib/portal/session';
import { getPatientProvider, visitsOrEmpty } from '@/lib/patients';
import { appointmentScope } from '@/lib/patients/household';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Everything the patient's own view needs: who they are, their visit records,
// and their upcoming appointments. Records come from patientVisits(), the one
// query that enforces "shared only, no internal notes".
export async function GET(_req: Request, props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const session = await currentPortalSession(slug);
  if (!session) {
    // Tell the client WHY, so it can distinguish "you have not signed in yet"
    // from "your session was rejected" (expired, revoked, or for another
    // clinic). The cookie is httpOnly, so only the server can tell these apart.
    // `reason` leaks nothing: it says whether a session was presented, never
    // whether any particular patient exists.
    const jar = await cookies();
    const presented = !!jar.get(PORTAL_COOKIE)?.value;
    return NextResponse.json(
      { error: 'Not signed in', reason: presented ? 'rejected' : 'anonymous' },
      { status: 401 },
    );
  }

  const { portal, contact } = session;
  const provider = await getPatientProvider(contact.orgId);
  const [visitsResult, appointments, recentTurns] = await Promise.all([
    portal.allowRecords
      ? provider.listPatientVisits(contact.id)
      : Promise.resolve({ status: 'empty' as const }),
    prisma.appointment.findMany({
      where: {
        ...(await appointmentScope(contact)),
        status: 'CONFIRMED',
        startAt: { gte: new Date() },
      },
      orderBy: { startAt: 'asc' },
      take: 5,
      select: { id: true, service: true, expertName: true, startAt: true, timezone: true },
    }),
    // Replayed so a returning patient sees the conversation they left, rather
    // than an empty box that makes it look like nothing was ever answered.
    prisma.portalChatTurn.findMany({
      where: { contactId: contact.id, portalId: portal.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { role: true, text: true, createdAt: true },
    }),
  ]);

  return NextResponse.json({
    portal: {
      name: portal.name,
      greeting: portal.greeting,
      allowRecords: portal.allowRecords,
      allowDownloads: portal.allowDownloads,
    },
    contact: { name: contact.name },
    visits: visitsOrEmpty(visitsResult),
    // Surfaced so the Records tab can say "we can't reach your records right
    // now" rather than showing the same empty state as a patient who genuinely
    // has none — the same distinction the chatbot prompt makes.
    recordsUnavailable: visitsResult.status === 'unavailable',
    appointments,
    history: recentTurns.reverse(),
  });
}
