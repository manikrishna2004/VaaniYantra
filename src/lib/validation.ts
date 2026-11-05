import { z } from 'zod';
import { toE164 } from '@/lib/phone';
import { AGENT_TYPES, type AgentVertical } from '@/lib/constants';

// Derived, not hand-copied: the practice-type list used to be duplicated here
// and would silently drift from the catalogue. Retired types stay accepted so
// editing an agent created under one doesn't 400.
const AGENT_TYPE_VALUES = AGENT_TYPES.map((t) => t.value) as [AgentVertical, ...AgentVertical[]];

// Read a JSON request body without letting malformed JSON crash the route to a
// 500 — callers treat null as a 400.
export async function readJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export const agentInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  description: z.string().max(500).optional().nullable(),
  systemPrompt: z.string().min(1, 'A behavior prompt is required').max(8000),
  greeting: z.string().max(1000).optional().nullable(),
  language: z.string().min(2),
  voice: z.string().min(1),
  languageMode: z.enum(['single', 'hybrid', 'auto', 'multi']).optional(),
  // ── v2 agent overhaul ──
  geminiVoice: z.string().max(40).optional(),
  agentType: z.enum(AGENT_TYPE_VALUES).optional(),
  // #9: custom practice-type text, used when agentType = "other".
  industryLabel: z.string().max(120).optional().nullable(),
  endCallInstructions: z.string().max(1000).optional().nullable(),
  // Compliance: announce "this call may be recorded" at the start of calls.
  recordingDisclosure: z.boolean().optional(),
  voiceProvider: z.enum(['google', 'deepgram', 'gemini', 'elevenlabs']).optional(),
  voiceStages: z
    .object({
      greeting: z.object({ voice: z.string(), provider: z.string() }).optional().nullable(),
      closing: z.object({ voice: z.string(), provider: z.string() }).optional().nullable(),
    })
    .optional()
    .nullable(),
  direction: z.enum(['INBOUND', 'OUTBOUND', 'BOTH']),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  maxCallSeconds: z.number().int().min(30).max(3600).optional(),
  temperature: z.number().min(0).max(1).optional(),
  documentIds: z.array(z.string()).optional(),
  // Bring-your-own Gemini key for this agent (demo accounts). '' clears it back
  // to the org/platform key; undefined leaves whatever is stored alone, so a
  // form that never shows the field cannot wipe it.
  geminiApiKey: z.string().max(200).optional().nullable(),

  // ── Phase 1 agent depth ──
  businessHours: z
    .object({
      enabled: z.boolean(),
      timezone: z.string().min(1),
      days: z
        .array(
          z.object({
            open: z.string().regex(/^\d{2}:\d{2}$/),
            close: z.string().regex(/^\d{2}:\d{2}$/),
            closed: z.boolean(),
          }),
        )
        .length(7),
    })
    .optional()
    .nullable(),
  afterHoursMessage: z.string().max(1000).optional().nullable(),
  fallbackMessage: z.string().max(1000).optional().nullable(),
  transferEnabled: z.boolean().optional(),
  transferNumber: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'Use E.164 format, e.g. +919876543210')
    .optional()
    .nullable()
    .or(z.literal('')),
  transferMessage: z.string().max(1000).optional().nullable(),
  transferTriggers: z.string().max(1000).optional().nullable(),
  variables: z
    .array(z.object({ key: z.string().max(80), value: z.string().max(2000) }))
    .max(50)
    .optional()
    .nullable(),

  // ── Phase A connectors: live appointment booking ──
  bookingConfig: z
    .object({
      enabled: z.boolean(),
      calendarId: z.string().max(200).optional().nullable(),
      timezone: z.string().max(80).optional().nullable(),
      serviceName: z.string().max(120).optional().nullable(),
      serviceDurationMin: z.number().int().min(5).max(480).optional(),
      lookaheadDays: z.number().int().min(1).max(365).optional(),
      dailyStart: z.number().int().min(0).max(23).optional(),
      dailyEnd: z.number().int().min(1).max(24).optional(),
      messagingChannel: z.enum(['sms', 'whatsapp']).optional(),
      multiPerSlot: z.boolean().optional(),
      slotCapacity: z.number().int().min(1).max(100).optional(),
      // #5/#8: business/clinic name + a confirmation message template with
      // {{name}} {{service}} {{time}} {{date}} {{business}} {{expert}} variables.
      businessName: z.string().max(120).optional().nullable(),
      confirmationTemplate: z.string().max(600).optional().nullable(),
      // #6: doctors/consultants. Each optionally maps to one calendar in the
      // connected Google account; empty calendarId = shares the default calendar.
      experts: z
        .array(
          z.object({
            name: z.string().max(80),
            calendarId: z.string().max(200).optional().nullable(),
            // The teammate this doctor is; when they have connected their own
            // Google Calendar, their bookings go there instead.
            userId: z.string().max(60).optional().nullable(),
          }),
        )
        .max(30)
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),

  // ── Outcome engine: what the agent captures + owner/caller notifications.
  // Seeded per vertical, owner-editable. See src/lib/connectors/outcomes.ts.
  outcomeConfig: z
    .object({
      type: z.string().max(40).optional().nullable(),
      captures: z
        .array(
          z.object({
            key: z.string().max(40),
            label: z.string().max(80).optional().nullable(),
            required: z.boolean().optional(),
          }),
        )
        .max(20)
        .optional()
        .nullable(),
      callerTemplate: z.string().max(1000).optional().nullable(),
      ownerTemplate: z.string().max(1000).optional().nullable(),
      // Owner alert numbers must be real phone numbers — a typo here means the
      // owner silently never hears about new leads. Normalized to E.164.
      ownerNumbers: z
        .array(
          z
            .string()
            .max(20)
            .refine((v) => toE164(v) !== null, 'Enter a phone number with country code, e.g. +919876543210')
            .transform((v) => toE164(v)!),
        )
        .max(10)
        .optional()
        .nullable(),
      deliver: z
        .object({
          whatsapp: z.boolean().optional(),
          inApp: z.boolean().optional(),
          // `sheet` (the old monthly Google Sheet) is still ACCEPTED so an
          // older client posting a full outcomeConfig isn't rejected — it is
          // simply never read back. See src/lib/connectors/outcomes.ts.
          sheet: z.boolean().optional(),
        })
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
});

export type AgentInput = z.infer<typeof agentInputSchema>;

export const phoneNumberInputSchema = z.object({
  e164: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use E.164 format, e.g. +919876543210'),
  label: z.string().max(120).optional().nullable(),
  agentId: z.string().optional().nullable(),
});

const e164OrEmpty = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use E.164 format, e.g. +919876543210')
  .or(z.literal(''))
  .optional()
  .nullable();

export const phoneNumberUpdateSchema = z.object({
  label: z.string().max(120).optional().nullable(),
  agentId: z.string().optional().nullable(),
  callerIdName: z.string().max(120).optional().nullable(),
  forwardTo: e164OrEmpty,
  inboundEnabled: z.boolean().optional(),
});

export const outboundCallSchema = z.object({
  agentId: z.string().min(1),
  to: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use E.164 format, e.g. +919876543210'),
  fromNumberId: z.string().optional().nullable(),
});

// ── Phase 6: Integrations (webhooks) ──

const webhookSettingsSchema = z.object({
  type: z.enum(['generic', 'slack']).optional(),
  url: z.string().url('Enter a valid https URL').max(2000),
  description: z.string().max(200).optional().nullable(),
  events: z.array(z.enum(['call.completed', 'call.failed'])).min(1, 'Pick at least one event'),
  enabled: z.boolean().optional(),
});

export const webhookCreateSchema = webhookSettingsSchema;
export const webhookUpdateSchema = webhookSettingsSchema.partial();
