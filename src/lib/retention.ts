import { prisma } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { purgeExpiredOtps } from '@/lib/portal/otp';
import { purgeExpiredEmailOtps } from '@/lib/auth/email-otp';
import { purgeExpiredLogins } from '@/lib/portal/contacts';
import { getPlatformConfig, setPlatformConfig } from '@/lib/platform';
import { secretMatches } from '@/lib/cron-auth';

// Enterprise data retention. Orgs may set `dataRetentionDays`; the sweeper
// (a background tick inside the long-lived voice-server, like the reminder
// and campaign dispatchers) then purges call content older than that window:
// transcript turns, recording URL, summary, sentiment, topics and collected
// data. Billing aggregates (duration, status, timestamps, numbers) are kept
// so usage metering and invoices stay correct. Each purge run that removes
// anything is audit-logged per org.
//
// Scope note: this sweeps CALL content only. Patient visit records and their
// attachments (VisitRecord / VisitDocument) are deliberately out of scope — a
// clinic is required to keep those for years, and a retention window set to
// keep call recordings tidy must never quietly shred medical history. Deleting
// them is a staff action on the patient's page.

const TICK_MS = parseInt(process.env.RETENTION_TICK_MS || '21600000', 10); // 6h
const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

// Audit-log retention. Deliberately a fixed platform constant rather than an org
// setting: `AuditLog` is the record of what staff did to patient data, and a
// tenant must not be able to shorten their own trail. 400 days keeps a full year
// of lookback plus room for an investigation that starts late.
export const AUDIT_RETENTION_DAYS = 400;

// Liveness marker. The sweeper used to run only as an in-process interval inside
// the voice-server, so if that one process was down retention silently stopped
// and nothing said so — the same failure mode that already bit the backup cron.
// Every completed run stamps this key; `scripts/check-retention-freshness.sh`
// alerts when it goes stale.
export const LAST_SWEEP_KEY = 'retention.lastSweepAt';

let started = false;
let ticking = false;

/** Bearer secret for the unattended cron caller (scripts/retention-sweep.sh). */
export function retentionCronSecretMatches(provided: string | null | undefined): boolean {
  return secretMatches(provided, process.env.RETENTION_CRON_SECRET);
}

/** ISO timestamp of the last completed sweep, or null if it has never run. */
export async function lastSweepAt(): Promise<string | null> {
  return getPlatformConfig(LAST_SWEEP_KEY);
}

export function startRetentionSweeper(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    tickRetention().catch((err) => console.error('[retention] tick error', err));
  }, TICK_MS);
  console.log(`[retention] sweeper started (tick ${TICK_MS}ms)`);
}

export interface RetentionRunResult {
  /** False when a sweep was already in flight and this call was a no-op. */
  ran: boolean;
  orgsPurged: number;
  callsPurged: number;
  auditRowsPurged: number;
}

export async function tickRetention(now = new Date()): Promise<RetentionRunResult> {
  if (ticking) return { ran: false, orgsPurged: 0, callsPurged: 0, auditRowsPurged: 0 };
  ticking = true;
  let orgsPurged = 0;
  let callsPurged = 0;
  let auditRowsPurged = 0;
  try {
    // Spent sign-in codes and dead patient sessions, for every org. Unlike call
    // retention below this is not an org setting — a consumed one-time code and
    // an expired session have no value to anyone and should not accumulate.
    await Promise.all([
      purgeExpiredOtps(now).catch((e) => console.error('[retention] otp purge failed', e)),
      // Spent sign-up codes. Safe to drop unconditionally: verification lives on
      // the Firebase account once redeemed, never on the row.
      purgeExpiredEmailOtps(now).catch((e) => console.error('[retention] email otp purge failed', e)),
      purgeExpiredLogins(now).catch((e) => console.error('[retention] login purge failed', e)),
    ]);

    // Audit rows past the platform window. Not org-configurable — see
    // AUDIT_RETENTION_DAYS. Failure here must not abort the call-content sweep
    // below, which is the part with a compliance promise attached.
    try {
      const auditCutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 3600 * 1000);
      const purged = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } });
      auditRowsPurged = purged.count;
      if (purged.count > 0) {
        console.log(
          `[retention] purged ${purged.count} audit row(s) older than ${AUDIT_RETENTION_DAYS}d`,
        );
      }
    } catch (e) {
      console.error('[retention] audit purge failed', e);
    }

    const orgs = await prisma.organization.findMany({
      where: { dataRetentionDays: { not: null } },
      select: { id: true, dataRetentionDays: true },
    });

    for (const org of orgs) {
      const days = org.dataRetentionDays!;
      if (!Number.isFinite(days) || days < MIN_RETENTION_DAYS) continue;
      const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000);

      // Calls in this org past the window that still carry purgeable content.
      const calls = await prisma.call.findMany({
        where: {
          workspace: { orgId: org.id },
          createdAt: { lt: cutoff },
          OR: [
            { recordingUrl: { not: null } },
            { summary: { not: null } },
            { transcript: { some: {} } },
          ],
        },
        select: { id: true },
      });
      if (calls.length === 0) continue;

      const ids = calls.map((c) => c.id);
      const turns = await prisma.transcriptTurn.deleteMany({ where: { callId: { in: ids } } });
      await prisma.call.updateMany({
        where: { id: { in: ids } },
        data: {
          recordingUrl: null,
          summary: null,
          sentiment: null,
          sentimentScore: null,
          topics: undefined,
          collectedData: undefined,
        },
      });
      // Prisma updateMany can't set Json columns to DB NULL via undefined —
      // clear them explicitly with JsonNull semantics in a second pass.
      await prisma.$executeRawUnsafe(
        `UPDATE "Call" SET "topics" = NULL, "collectedData" = NULL WHERE "id" = ANY($1)`,
        ids,
      );

      await writeAudit({
        orgId: org.id,
        action: 'data.retention_purge',
        targetType: 'Organization',
        targetId: org.id,
        metadata: { calls: ids.length, transcriptTurns: turns.count, retentionDays: days },
      });
      console.log(
        `[retention] org ${org.id}: purged ${ids.length} call(s), ${turns.count} transcript turn(s) (window ${days}d)`,
      );
      orgsPurged += 1;
      callsPurged += ids.length;
    }

    // Stamp liveness last, so it only advances when a run actually completed.
    // A stale marker is the signal that retention has stopped happening.
    await setPlatformConfig(LAST_SWEEP_KEY, now.toISOString()).catch((e) =>
      console.error('[retention] could not stamp last-sweep marker', e),
    );

    return { ran: true, orgsPurged, callsPurged, auditRowsPurged };
  } finally {
    ticking = false;
  }
}
