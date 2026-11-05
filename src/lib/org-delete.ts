import { prisma } from '@/lib/db';

// Deleting an organisation — tenant offboarding.
//
// `prisma.organization.delete` alone does NOT do this. Most of the schema
// cascades correctly from Organization or from Workspace, but five tables are
// reachable by neither and survive it, still holding patient names, phone
// numbers and full call transcripts:
//
//   Call            workspaceId is onDelete: SetNull, so calls outlive their
//                   workspace by design (billing history must survive a
//                   workspace being removed). Call carries no orgId at all, so
//                   once the workspace row is gone there is nothing left to
//                   attribute them by — they have to go FIRST, while the
//                   workspace ids are still resolvable.
//   TranscriptTurn  cascades from Call, so it is handled by deleting Call —
//                   but only if Call is actually deleted rather than orphaned.
//   Appointment     orgId and workspaceId are plain Strings with no FK.
//   Outcome         same.
//   WhatsappTurn    same — no FK of any kind.
//   PortalOtp       same.
//
// This is why the manual offboarding process in /dpa §8 was incomplete: someone
// following it would delete the org, see the tenant disappear from the app, and
// leave all of the above behind believing the data was gone.
//
// Everything else — Contact and the whole clinical tree beneath it, Portal,
// Agent, PhoneNumber, Document, AuditLog, billing rows — is reached by the
// cascades already in the schema and is deliberately not repeated here.

export interface OrgDeletionCounts {
  calls: number;
  transcriptTurns: number;
  appointments: number;
  outcomes: number;
  whatsappTurns: number;
  portalOtps: number;
  contacts: number;
  visitRecords: number;
  workspaces: number;
  auditLogs: number;
}

export interface OrgDeletionReport {
  orgId: string;
  orgName: string;
  applied: boolean;
  counts: OrgDeletionCounts;
}

/**
 * Count everything that a deletion would remove, without removing any of it.
 * Used as the dry run, and as the "are you sure" figures before an apply.
 */
export async function countOrgData(orgId: string): Promise<OrgDeletionReport | null> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true },
  });
  if (!org) return null;

  const workspaces = await prisma.workspace.findMany({ where: { orgId }, select: { id: true } });
  const workspaceIds = workspaces.map((w) => w.id);

  const [calls, transcriptTurns, appointments, outcomes, whatsappTurns, portalOtps, contacts, visitRecords, auditLogs] =
    await Promise.all([
      prisma.call.count({ where: { workspaceId: { in: workspaceIds } } }),
      prisma.transcriptTurn.count({ where: { call: { workspaceId: { in: workspaceIds } } } }),
      prisma.appointment.count({ where: { orgId } }),
      prisma.outcome.count({ where: { orgId } }),
      prisma.whatsappTurn.count({ where: { orgId } }),
      prisma.portalOtp.count({ where: { orgId } }),
      prisma.contact.count({ where: { orgId } }),
      prisma.visitRecord.count({ where: { orgId } }),
      prisma.auditLog.count({ where: { orgId } }),
    ]);

  return {
    orgId: org.id,
    orgName: org.name,
    applied: false,
    counts: {
      calls,
      transcriptTurns,
      appointments,
      outcomes,
      whatsappTurns,
      portalOtps,
      contacts,
      visitRecords,
      workspaces: workspaceIds.length,
      auditLogs,
    },
  };
}

/**
 * Delete an organisation and everything belonging to it. Irreversible.
 *
 * One transaction, so a failure part-way leaves the tenant whole rather than
 * half-erased. Order matters: the unparented tables are swept while their org
 * and workspace ids still resolve, and the Organization row goes last so its
 * cascades fire on a database that is already clean of the rows they cannot
 * reach.
 */
export async function deleteOrganization(orgId: string): Promise<OrgDeletionReport | null> {
  const report = await countOrgData(orgId);
  if (!report) return null;

  const workspaces = await prisma.workspace.findMany({ where: { orgId }, select: { id: true } });
  const workspaceIds = workspaces.map((w) => w.id);

  await prisma.$transaction(
    async (tx) => {
      // Calls first, while workspaceId still points somewhere. TranscriptTurn
      // cascades from Call — deleting the parent is what collects the turns,
      // and doing it in this order is the difference between the transcripts
      // going and the transcripts being orphaned forever.
      await tx.call.deleteMany({ where: { workspaceId: { in: workspaceIds } } });

      // No FK on any of these four; they would simply be left behind.
      await tx.appointment.deleteMany({ where: { orgId } });
      await tx.outcome.deleteMany({ where: { orgId } });
      await tx.whatsappTurn.deleteMany({ where: { orgId } });
      await tx.portalOtp.deleteMany({ where: { orgId } });

      // Last. Cascades Workspace, Contact (and the clinical tree), Portal,
      // Membership, ApiKey, AuditLog, Invoice, Integration and the rest.
      await tx.organization.delete({ where: { id: orgId } });
    },
    // A busy hospital's data does not delete inside the default 5s interactive
    // transaction budget, and a timeout here would roll back a half-hour job.
    { timeout: 120_000, maxWait: 10_000 },
  );

  return { ...report, applied: true };
}
