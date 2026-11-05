import { prisma } from '@/lib/db';
import { deliverOutcome } from '@/lib/connectors/outcomes';
import { CONCEPT_LABELS, type RedFlag } from '@/lib/portal/red-flags';

// Telling the clinic that one of their patients just described an emergency.
//
// Channel-neutral: the patient chatbot and the WhatsApp follow-up chat both
// land here. It takes plain ids rather than a Portal/Contact pair so a channel
// that has neither (WhatsApp knows only an org and a phone number) can still
// raise the same alert, throttled on the same counter.
//
// Best-effort by construction: the patient has already been shown 108/112 by the
// time this runs, so nothing here may throw, block, or delay that reply.

/**
 * One alert per patient per half hour.
 *
 * THROTTLE THE ALERT, NOT THE DETECTOR. The detector is deliberately tuned for
 * recall, so a chatty pattern will fire repeatedly. If that turns into a stream
 * of notifications the clinic mutes the channel — and a cheap false positive has
 * been converted into an expensive one, because the next real alert is muted
 * too. The patient still gets the emergency reply every single time; only the
 * clinic's notification is rate-limited.
 */
const ALERT_WINDOW_MS = 30 * 60 * 1000;

/** Safety valve against one bad pattern spamming a clinic for a whole day. */
const ALERT_DAILY_CAP = 40;

/** How each channel reads in the clinic's own alert. */
const CHANNEL_PHRASE: Record<'chatbot' | 'whatsapp' | 'voice', string> = {
  chatbot: 'in your patient chatbot',
  whatsapp: 'in your WhatsApp chat',
  voice: 'on a call with your AI receptionist',
};

export async function alertEmergency(input: {
  orgId: string;
  workspaceId: string;
  /** Which surface the patient reached us on — for the log line only. */
  channel: 'chatbot' | 'whatsapp' | 'voice';
  /** Portal slug, WhatsApp id or call id, so the log line can be traced back. */
  ref: string;
  patientName: string | null;
  patientPhone: string | null;
  /** The clinic, as shown to the clinic in its own alert. */
  businessName: string;
  /** Agent to deliver through; null falls back to a bare Outcome row. */
  agentId: string | null;
  text: string;
  flag: RedFlag;
}): Promise<void> {
  try {
    const label = CONCEPT_LABELS[input.flag.concept];
    const now = new Date();

    // Always log, even when the alert itself is throttled or impossible — this
    // is the record that the tripwire fired.
    console.warn(
      `[emergency] ${label} from ${input.patientPhone ?? 'unknown'} via ${input.channel} ${input.ref} (matched: ${input.flag.matched})`,
    );

    const [recent, todayCount] = await Promise.all([
      prisma.outcome.findFirst({
        where: {
          orgId: input.orgId,
          type: EMERGENCY_OUTCOME_TYPE,
          callerNumber: input.patientPhone,
          createdAt: { gte: new Date(now.getTime() - ALERT_WINDOW_MS) },
        },
        select: { id: true },
      }),
      prisma.outcome.count({
        where: {
          orgId: input.orgId,
          type: EMERGENCY_OUTCOME_TYPE,
          createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
    if (recent || todayCount >= ALERT_DAILY_CAP) return;

    const fields = {
      // WhatsApp knows a number, not a name — the clinic still needs the row.
      patient: input.patientName ?? 'Unknown',
      concern: label,
      message: input.text.slice(0, 300),
    };

    // deliverOutcome needs a non-null Agent (it reads agentType) but the
    // linked agent is optional on both channels — a chatbot with no agent
    // would 500 here, which is the last place we want an unhandled throw. Fall
    // back to writing the Outcome directly so the Updates feed still shows it.
    const agent = input.agentId
      ? await prisma.agent.findUnique({ where: { id: input.agentId } })
      : null;

    if (!agent) {
      await prisma.outcome.create({
        data: {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          type: EMERGENCY_OUTCOME_TYPE,
          fields,
          callerName: input.patientName,
          callerNumber: input.patientPhone,
        },
      });
      return;
    }

    await deliverOutcome({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      agent,
      type: EMERGENCY_OUTCOME_TYPE,
      fields,
      callerName: input.patientName,
      callerNumber: input.patientPhone,
      businessName: input.businessName,
      // MANDATORY. deliverOutcome would otherwise render the agent's caller
      // template — "Hi {{name}}, thanks for getting in touch, we've noted your
      // request" — and text it to someone reporting chest pain.
      notifyCaller: false,
      ownerBody:
        `URGENT — ${input.patientName ?? 'A patient'} just reported ${label} ${CHANNEL_PHRASE[input.channel]}. ` +
        `They have been told to call 108/112. Please follow up now. Contact: ${input.patientPhone ?? 'unknown'}.`,
    });
  } catch (err) {
    // Never let alerting break the patient's reply.
    console.error('[emergency] alert failed', err);
  }
}

/** The Outcome type used for these, so the Updates feed can style them. */
export const EMERGENCY_OUTCOME_TYPE = 'emergency';
