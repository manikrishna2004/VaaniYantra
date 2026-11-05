// Phase B — appointment reminder dispatcher. Runs as a background tick inside
// the long-lived voice-server. Each pass it sends WhatsApp reminders for
// upcoming CONFIRMED appointments: one ~a day before and one ~an hour before,
// each sent at most once (idempotent via remind24Sent / remind1Sent flags).

import { prisma } from '@/lib/db';
import { sendConfirmation } from '@/lib/connectors';
import { apptReminderTemplate } from '@/lib/whatsapp-templates';
import { setPlatformConfig, getPlatformConfig } from '@/lib/platform';

const TICK_MS = parseInt(process.env.REMINDER_TICK_MS || '300000', 10); // 5 min

// Liveness marker, same idea as retention's. A throw inside a tick is caught and
// the interval keeps running, which means a *persistent* failure sends zero
// reminders for every org indefinitely while looking exactly like an idle
// system. Every completed pass stamps this; check-job-freshness.sh alerts when
// it goes stale.
export const LAST_TICK_KEY = 'reminders.lastTickAt';

/** ISO timestamp of the last completed reminder pass, or null if never. */
export async function lastReminderTickAt(): Promise<string | null> {
  return getPlatformConfig(LAST_TICK_KEY);
}
const DAY_MS = 24 * 3600 * 1000;
const TWO_H_MS = 2 * 3600 * 1000;
const NINETY_MIN_MS = 90 * 60 * 1000;

let started = false;
let ticking = false;

export function startReminderDispatcher(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    tickReminders().catch((err) => console.error('[reminders] tick error', err));
  }, TICK_MS);
  console.log(`[reminders] dispatcher started (tick ${TICK_MS}ms)`);
}

function fmt(date: Date, tz?: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Take the right to send one reminder, returning whether we got it.
 *
 * The conditional update is what makes this safe to lose: `false` means either
 * the write failed or somebody else already claimed it, and in both cases not
 * sending is the correct move.
 */
async function claim(appointmentId: string, flag: 'remind24Sent' | 'remind1Sent'): Promise<boolean> {
  try {
    const res = await prisma.appointment.updateMany({
      where: { id: appointmentId, [flag]: false },
      data: { [flag]: true },
    });
    return res.count === 1;
  } catch (err) {
    console.error('[reminders] could not claim', flag, 'for', appointmentId, '— skipping the send', err);
    return false;
  }
}

export async function tickReminders(now = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = await prisma.appointment.findMany({
      where: {
        status: 'CONFIRMED',
        startAt: { gt: now, lte: new Date(now.getTime() + DAY_MS) },
        OR: [{ remind24Sent: false }, { remind1Sent: false }],
      },
      orderBy: { startAt: 'asc' },
      take: 200,
    });

    // Business name for the WhatsApp `appointment_reminder` template ({{1}}),
    // resolved once per org rather than per appointment.
    const orgNames = new Map(
      (
        await prisma.organization.findMany({
          where: { id: { in: [...new Set(due.map((a) => a.orgId))] } },
          select: { id: true, name: true },
        })
      ).map((o) => [o.id, o.name]),
    );

    for (const a of due) {
     try {
      const msUntil = a.startAt.getTime() - now.getTime();
      const when = fmt(a.startAt, a.timezone);
      const withExpert = a.expertName ? ` with ${a.expertName}` : '';
      // WhatsApp reminders must go out as the approved template; the free-text
      // body stays as the SMS fallback.
      const tmpl = apptReminderTemplate({
        business: orgNames.get(a.orgId),
        service: `${a.service}${withExpert}`,
        when,
      });

      // Claim BEFORE sending, and let a failed claim skip the send.
      //
      // This used to send first and then write the flag with `.catch(() => {})`.
      // Under the DB pressure that makes that write fail, the row stays in the
      // due set and the next tick sends the same reminder again — the patient
      // gets it repeatedly and the clinic is billed per Meta template each time.
      // Both orderings can lose, so this picks which: a missed reminder is
      // better than a duplicate one, and a miss is visible in the log below.

      // Day-ahead reminder. If the appointment is already within 2h (booked
      // last-minute), skip the send but still mark it so the 1h one covers it.
      if (!a.remind24Sent && msUntil <= DAY_MS) {
        if (await claim(a.id, 'remind24Sent')) {
          if (msUntil > TWO_H_MS && a.customerNumber) {
            await sendConfirmation(a.orgId, a.customerNumber, `Reminder: your ${a.service}${withExpert} is coming up on ${when}.`, tmpl);
          }
        }
      }

      // Hour-ahead reminder.
      if (!a.remind1Sent && msUntil <= NINETY_MIN_MS) {
        if (await claim(a.id, 'remind1Sent')) {
          if (a.customerNumber) {
            await sendConfirmation(a.orgId, a.customerNumber, `Reminder: your ${a.service}${withExpert} is at ${when}. See you soon!`, tmpl);
          }
        }
      }
     } catch (err) {
      // One appointment must not stop the rest. The batch is ordered by start
      // time and capped at 200, so an appointment that reliably throws sat at
      // the head of every future batch and blocked every later reminder
      // indefinitely.
      console.error('[reminders] appointment', a.id, 'failed', err);
     }
    }

    // Stamped last, so it only advances when a pass actually completed.
    await setPlatformConfig(LAST_TICK_KEY, now.toISOString()).catch((e) =>
      console.error('[reminders] could not stamp last-tick marker', e),
    );
  } finally {
    ticking = false;
  }
}
