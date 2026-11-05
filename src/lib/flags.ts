// Platform feature flags (env-driven).

// WhatsApp messaging (all transports: Meta Cloud API, Twilio WA, Exotel WA).
// Default OFF: every message that would have gone over WhatsApp is sent as SMS
// instead, and WhatsApp disappears from the UI/API surface. Set
// WHATSAPP_ENABLED=true to bring the whole WhatsApp stack back.
export function whatsappEnabled(): boolean {
  return process.env.WHATSAPP_ENABLED === 'true';
}

// Demo verticals: practice types that are retired for customers but still
// offered to specific accounts, so a demo agent can be built for an industry we
// no longer sell into (real estate, today) without putting it back in front of
// every clinic. Comma-separated emails in DEMO_VERTICAL_EMAILS; empty = nobody,
// which is what every ordinary deployment should have.
export function demoVerticalsAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.DEMO_VERTICAL_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

// Whether an agent takes the cost-optimised Live path (tight context window,
// knowledge as a tool, backend-held call state, silence gating) or the original
// one.
//
// This used to also exclude any agent carrying its own Gemini key, on the
// reasoning that such an agent bills that key rather than ours, so there was
// nothing to save and only a demo to break. Both halves of that were wrong:
//
//   • The demo's key is still our money, and a demo call is the most expensive
//     minute we buy — we pay for it and no customer is billed for it.
//   • "Nothing to save" was never the only thing the path buys. The abandoned-
//     call check, the media-gap watchdog, the absolute cap and the barge-in fix
//     are all in it, and a leaked session on a demo line bills exactly like a
//     leaked session anywhere else.
//
// So which key pays no longer decides which path a call takes. The explicit
// LIVE_COST_OPT_OUT_AGENT_IDS list is the one remaining way out, for pinning a
// specific agent to the original behaviour while something is investigated.
export function costOptimized(
  agent: { id: string; geminiApiKey?: string | null } | null | undefined,
): boolean {
  if (!agent) return false;
  const optedOut = (process.env.LIVE_COST_OPT_OUT_AGENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return !optedOut.includes(agent.id);
}
