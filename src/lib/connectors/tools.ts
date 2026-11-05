import type { Agent } from '@prisma/client';
import { bookingTools, readBookingConfig } from '@/lib/connectors/booking';
import { listBookableDoctors } from '@/lib/doctors';
import { outcomeTool } from '@/lib/connectors/outcomes';
import { knowledgeTool, agentHasKnowledge } from '@/lib/connectors/knowledge';
import { costOptimized } from '@/lib/flags';

// Connector framework (Phase A). A connector contributes "live tools": function
// declarations the voice agent can call mid-call, each with a handler that runs
// against the real external system and returns a result the model speaks back.
//
// getCallConnectorTools() resolves which tools are active for a given call based
// on the agent's config + what the org has connected. live.ts registers the
// declarations with Gemini Live and dispatches tool calls to the handlers.

// A JSON-schema-ish function declaration (matches the Gemini REST shape; passed
// to the SDK as-is). Kept loose on purpose so connectors stay declarative.
export type ToolDeclaration = {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

export type CallToolContext = {
  orgId: string;
  callId: string;
  // The customer's phone number (inbound: caller; outbound: callee).
  customerNumber: string | null;
  agent: Agent;
};

export type ConnectorTool = {
  declaration: ToolDeclaration;
  handler: (args: Record<string, unknown>, ctx: CallToolContext) => Promise<Record<string, unknown>>;
};

// Resolve the live tools available for this call.
export async function getCallConnectorTools(ctx: CallToolContext): Promise<ConnectorTool[]> {
  const tools: ConnectorTool[] = [];

  // Appointment booking — offered whenever the agent has it enabled.
  //
  // This used to ALSO require `hasAnyCalendarConnection(orgId)`, so a clinic
  // with no Google account never even saw the booking tools: the agent silently
  // fell back to taking a message and had no idea it could have booked. That
  // made Google a hard dependency for the core product. VaaniYantra now owns
  // the calendar and Google is an optional per-doctor mirror, so the connection
  // is no longer what decides whether a patient can be booked.
  //
  // Booking routes bookings through deliverOutcome itself, so when it's active
  // we don't also expose the generic record_outcome tool (avoids the model
  // having two overlapping "save this" tools). When booking is off, expose
  // record_outcome so the agent still captures leads/reservations/etc.
  const booking = readBookingConfig(ctx.agent);
  if (booking.enabled) {
    // The doctor list is fetched here rather than inside bookingTools so that
    // stays a pure, testable schema builder. It only feeds the tool
    // DESCRIPTIONS; the handlers re-read the table when they run.
    const doctors = await listBookableDoctors(ctx.orgId);
    if (doctors.length === 0) {
      console.warn('[booking] booking is enabled but this org has no bookable doctors', ctx.orgId);
    }
    tools.push(...bookingTools(booking, doctors));
  } else {
    tools.push(outcomeTool(ctx.agent, { businessName: booking.businessName }));
  }

  // Business knowledge. Additive to whichever set above is active — it answers
  // questions rather than saving anything, so it does not overlap either.
  //
  // Only on the cost-optimised path: an opted-out agent still gets its knowledge
  // folded into the system instruction at connect (see live.ts), and giving it
  // both would mean paying for the same facts twice.
  if (costOptimized(ctx.agent) && (await agentHasKnowledge(ctx.agent.id))) {
    tools.push(knowledgeTool());
  }

  return tools;
}
