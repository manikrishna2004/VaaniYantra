import type { Agent } from '@prisma/client';
import { prisma } from '@/lib/db';
import { VERTICAL_TEMPLATES, type OutcomeCapture, type AgentVertical } from '@/lib/constants';
import { sendConfirmation } from '@/lib/connectors';
import { ownerAlertTemplate, enquiryReceivedTemplate, summariseFields } from '@/lib/whatsapp-templates';
import { whatsappEnabled } from '@/lib/flags';
import type { ConnectorTool, CallToolContext } from '@/lib/connectors/tools';

// The generic outcome engine — the backbone behind owner notifications and the
// in-app Updates feed. An agent captures a result (appointment request /
// enquiry / callback / …) and deliverOutcome() fans it out: persist it, message
// the patient, alert the owner(s). What is captured and what the messages say
// come from the agent's outcomeConfig, seeded per practice type
// (VERTICAL_TEMPLATES).
//
// Outcomes used to also be appended to a monthly Google Sheet. That is gone
// along with the rest of the Drive integration — getting the data out is now a
// CSV download from Reports, which needs no Google account and no extra scope.

export type OutcomeConfig = {
  type: string;
  captures: OutcomeCapture[];
  callerTemplate: string;
  ownerTemplate: string;
  ownerNumbers: string[];
  deliver: { whatsapp: boolean; inApp: boolean };
};

function verticalKey(agent: Agent): AgentVertical {
  const t = (agent.agentType ?? '') as string;
  return (t in VERTICAL_TEMPLATES ? t : 'other') as AgentVertical;
}

// The agent's effective outcome config: the vertical preset with any
// owner-edited overrides (Agent.outcomeConfig) applied.
export function readOutcomeConfig(agent: Agent): OutcomeConfig {
  const preset = VERTICAL_TEMPLATES[verticalKey(agent)].outcome;
  const raw = (agent.outcomeConfig ?? {}) as Record<string, unknown>;

  const captures: OutcomeCapture[] = Array.isArray(raw.captures) && raw.captures.length
    ? (raw.captures as unknown[])
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          const key = String(o.key ?? '').trim();
          return { key, label: String(o.label ?? key).trim() || key, required: o.required === true };
        })
        .filter((c) => c.key)
    : preset.captures;

  const deliverRaw = (raw.deliver ?? {}) as Record<string, unknown>;
  const ownerNumbers = Array.isArray(raw.ownerNumbers)
    ? (raw.ownerNumbers as unknown[]).map((n) => String(n).trim()).filter(Boolean)
    : [];

  return {
    type: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : preset.type,
    captures,
    callerTemplate: typeof raw.callerTemplate === 'string' ? raw.callerTemplate : preset.callerTemplate,
    ownerTemplate: typeof raw.ownerTemplate === 'string' ? raw.ownerTemplate : preset.ownerTemplate,
    ownerNumbers,
    deliver: {
      // Owner alert over WhatsApp (default on) — forced off (→ SMS) while the
      // WhatsApp feature flag is disabled.
      whatsapp: whatsappEnabled() && deliverRaw.whatsapp !== false,
      inApp: deliverRaw.inApp !== false, // in-app feed (default on)
      // `sheet` is deliberately not read. Agents saved before the Drive removal
      // still carry it in their stored JSON; unparsed, it is simply inert.
    },
  };
}

// Substitute {{key}} from `vars`, collapse the whitespace/punctuation left by
// any empty values. Same convention as renderConfirmation in booking.ts.
export function renderTemplate(tmpl: string, vars: Record<string, string>): string {
  const filled = tmpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
  return filled
    .replace(/\(\s*[:,]?\s*\)/g, '') // drop "()" / "( : )" left by empties
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

// What to read back to the caller in their confirmation: everything they gave
// us EXCEPT their own name, which they know and which already opens the
// message. For a PARE enquiry that is "Kokapet, Hyderabad, 500751" — the part
// worth checking is right, and the part a wrong pincode shows up in.
//
// Owner-defined keys, so the name match is best-effort, exactly as it is in
// call-state.ts. Getting it wrong only repeats the name; it cannot leak
// anything the caller did not just say out loud.
const CALLER_NAME_KEYS = new Set(['name', 'callername', 'customername', 'patientname', 'fullname']);

// Fields the agent fills in for the BUSINESS, which must never be read back to
// the caller. A lead's stage and B2B/B2C classification are internal routing
// values the agent decides from how the call went — the sales team acts on
// them, and "Details: Hyderabad, B2C, Cold" arriving on a customer's phone is
// at best baffling and at worst insulting. They still reach the owner, whose
// alert is built from summariseFields() rather than this.
//
// Normalised the same way as the name keys below, so "lead_type" and "leadType"
// both land here.
const INTERNAL_KEYS = new Set(['stage', 'leadtype', 'leadstage', 'crmstage']);

export function callerDetail(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([k, v]) => {
      if (typeof v !== 'string' || !v.trim()) return false;
      const key = k.toLowerCase().replace(/[^a-z]/g, '');
      return !CALLER_NAME_KEYS.has(key) && !INTERNAL_KEYS.has(key);
    })
    .map(([, v]) => v.trim().replace(/\s+/g, ' '))
    .join(', ');
}

export type DeliverOutcomeInput = {
  orgId: string;
  workspaceId: string;
  agent: Agent;
  callId?: string | null;
  type?: string;
  fields: Record<string, string>;
  callerName?: string | null;
  callerNumber?: string | null;
  businessName?: string | null;
  notifyCaller?: boolean; // default true; false when the caller was already messaged
  columns?: OutcomeCapture[]; // sheet columns (default = config captures)
  /**
   * Override the owner's message body.
   *
   * The agent's `ownerTemplate` is appointment-shaped ("New appointment request
   * — …"), which is wrong for anything urgent. The emergency tripwire uses this
   * so the alert says what it must, while still getting Outcome persistence,
   * the Updates feed and owner-number resolution for free.
   */
  ownerBody?: string;
};

// Persist + fan out one captured outcome. Always records the Outcome (feed
// source); messaging/sheet are best-effort and never block.
export async function deliverOutcome(input: DeliverOutcomeInput): Promise<{ outcomeId: string }> {
  const cfg = readOutcomeConfig(input.agent);
  const type = input.type || cfg.type;
  const vars: Record<string, string> = {
    ...input.fields,
    business: input.businessName || '',
    caller: input.callerName || input.fields.name || '',
    callerNumber: input.callerNumber || '',
  };

  const outcome = await prisma.outcome.create({
    data: {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      agentId: input.agent.id,
      callId: input.callId ?? null,
      vertical: (input.agent.agentType ?? null) as string | null,
      type,
      fields: input.fields,
      callerName: input.callerName ?? null,
      callerNumber: input.callerNumber ?? null,
    },
  });

  // Caller message (unless already messaged elsewhere, e.g. booking confirmation).
  if ((input.notifyCaller ?? true) && input.callerNumber && cfg.callerTemplate.trim()) {
    const body = renderTemplate(cfg.callerTemplate, vars);
    // This used to go as the org's OWN free text, which Meta will not accept
    // business-initiated — a phone call opens no customer-service window, so it
    // only landed if the caller happened to have messaged us in the last 24
    // hours, and there is no SMS underneath to catch it. In practice the agent
    // promised a WhatsApp and none arrived.
    //
    // enquiry_received is that message as an approved template, so it delivers.
    // `body` is still the org's wording and is still what the failure log shows;
    // it is what the owner edits and sees in the dashboard, and the template is
    // the fixed shape Meta will actually carry.
    const callerTmpl = enquiryReceivedTemplate({
      name: input.callerName || input.fields.name,
      business: input.businessName,
      type,
      detail: callerDetail(input.fields),
    });
    if (body) void sendConfirmation(input.orgId, input.callerNumber, body, callerTmpl);
  }

  // Owner alert(s) — WhatsApp via an approved template (business-initiated).
  // `cfg.deliver.whatsapp` used to pick between WhatsApp and SMS; with SMS gone
  // it is simply whether the owner is alerted on WhatsApp at all.
  if (cfg.ownerNumbers.length && (input.ownerBody?.trim() || cfg.ownerTemplate.trim())) {
    const body = input.ownerBody?.trim() || renderTemplate(cfg.ownerTemplate, vars);
    const ownerTmpl = ownerAlertTemplate({ type, business: input.businessName, summary: summariseFields(input.fields) });
    if (body) {
      for (const num of cfg.ownerNumbers) {
        if (cfg.deliver.whatsapp) void sendConfirmation(input.orgId, num, body, ownerTmpl);
      }
    }
  }

  return { outcomeId: outcome.id };
}

// The generic mid-call capture tool, built from the agent's capture fields.
// Exposed by getCallConnectorTools when the agent isn't using calendar booking
// (booking has its own tools that also route through deliverOutcome).
export function outcomeTool(
  agent: Agent,
  opts: { businessName?: string | null } = {},
): ConnectorTool {
  const cfg = readOutcomeConfig(agent);
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const c of cfg.captures) properties[c.key] = { type: 'STRING', description: c.label };
  const required = cfg.captures.filter((c) => c.required).map((c) => c.key);

  return {
    declaration: {
      name: 'record_outcome',
      description:
        `Save the caller's ${cfg.type} and notify the business, once you have collected their details ` +
        `(${cfg.captures.map((c) => c.label).join(', ')}). Ask for the required details before calling this.`,
      parameters: {
        type: 'OBJECT',
        properties,
        ...(required.length ? { required } : {}),
      },
    },
    handler: async (args, ctx: CallToolContext) => {
      const fields: Record<string, string> = {};
      for (const c of cfg.captures) {
        const v = args[c.key];
        if (typeof v === 'string' && v.trim()) fields[c.key] = v.trim();
      }
      const missing = required.filter((k) => !fields[k]);
      if (missing.length) {
        return { ok: false, error: `Still need: ${missing.join(', ')}. Ask the caller before saving.` };
      }
      await deliverOutcome({
        orgId: ctx.orgId,
        workspaceId: ctx.agent.workspaceId,
        agent: ctx.agent,
        callId: ctx.callId,
        type: cfg.type,
        fields,
        callerName: fields.name || null,
        callerNumber: ctx.customerNumber,
        businessName: opts.businessName,
      });
      return { ok: true, recorded: true, message: 'Details saved and the business has been notified.' };
    },
  };
}
