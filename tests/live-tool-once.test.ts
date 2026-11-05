import { describe, it, expect, vi } from 'vitest';

// A model that asks for the same WRITE twice must not get it twice.
//
// It does ask twice. On a live call the agent saved one caller's enquiry twice,
// 1.5 seconds apart, with byte-identical arguments, and the caller received two
// WhatsApp messages. The system prompt already said "do not call it twice for
// the same caller"; prompts do not enforce.
//
// The dispatcher fires each tool call with `void handleConnectorTool(fc)`, so
// two arriving in one toolCall message run CONCURRENTLY — which is why the
// guard holds the in-flight promise rather than asking the database whether the
// write has already happened. That check would race between the two.

vi.mock('@/lib/voice/tts', () => ({ synthesizeTelephony: vi.fn(async () => Buffer.alloc(0)) }));
vi.mock('@/lib/portal/emergency-alert', () => ({ alertEmergency: vi.fn(), EMERGENCY_OUTCOME_TYPE: 'emergency' }));
vi.mock('@/lib/voice/conversation', () => ({
  recordTurn: vi.fn(async () => {}),
  summarizeCall: vi.fn(async () => {}),
  generateAgentTurn: vi.fn(),
  generateAgentTurnStreaming: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { call: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock('@/lib/rag/retrieve', () => ({
  retrieveForAgent: vi.fn(async () => []),
  formatKnowledgeBlock: vi.fn(() => ''),
}));
vi.mock('@/lib/webhooks', () => ({ dispatchCallEvent: vi.fn() }));
vi.mock('@/lib/crm', () => ({ pushCallToCrm: vi.fn() }));
vi.mock('@/lib/voice/finalize', () => ({ finalizeCallRecord: vi.fn() }));
vi.mock('@/lib/connectors/tools', () => ({ getCallConnectorTools: vi.fn(async () => []) }));
vi.mock('@/lib/telephony-accounts', () => ({ providerForNumberId: vi.fn() }));
vi.mock('@/lib/integrations', () => ({ getOrgCredentials: vi.fn(async () => ({})) }));

import { LiveCallSession } from '@/lib/voice/live';

function makeSession(handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>, toolName = 'record_outcome') {
  const ws = { send: vi.fn(), on: vi.fn(), close: vi.fn() };
  const s = new LiveCallSession(ws as any, 'call_1', 'exotel');
  const priv = s as any;
  priv.agent = { id: 'a1', workspaceId: 'w1', name: 'PARE India' };
  priv.connectorCtx = { orgId: 'o1', customerNumber: '+919346479620' };
  priv.session = { sendToolResponse: vi.fn(), sendClientContent: vi.fn(), close: vi.fn() };
  const spy = vi.fn(handler);
  priv.connectorTools = new Map([[toolName, { declaration: { name: toolName, description: '' }, handler: spy }]]);
  return { priv, spy };
}

const ARGS = { name: 'Nikant', town: 'Kukatpally, Hyderabad', pincode: '500075' };

describe('a write tool runs once per call', () => {
  it('does not save the same enquiry twice', async () => {
    const { priv, spy } = makeSession(async () => ({ ok: true, recorded: true }));
    await priv.handleConnectorTool({ id: '1', name: 'record_outcome', args: ARGS });
    await priv.handleConnectorTool({ id: '2', name: 'record_outcome', args: ARGS });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still answers the duplicate, so the model is not left waiting', async () => {
    const { priv } = makeSession(async () => ({ ok: true, recorded: true }));
    await priv.handleConnectorTool({ id: '1', name: 'record_outcome', args: ARGS });
    await priv.handleConnectorTool({ id: '2', name: 'record_outcome', args: ARGS });
    const sent = priv.session.sendToolResponse.mock.calls.map((c: any[]) => c[0].functionResponses[0]);
    expect(sent).toHaveLength(2);
    expect(sent[1].id).toBe('2'); // the repeat's own id, with the first's result
    expect(sent[1].response).toEqual({ ok: true, recorded: true });
  });

  it('collapses two that arrive at once, which is how they actually arrive', async () => {
    // The dispatcher does not await between function calls in one message.
    let started = 0;
    const { priv, spy } = makeSession(async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, recorded: true };
    });
    await Promise.all([
      priv.handleConnectorTool({ id: '1', name: 'record_outcome', args: ARGS }),
      priv.handleConnectorTool({ id: '2', name: 'record_outcome', args: ARGS }),
    ]);
    expect(started).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('saves one enquiry per call even when the arguments drift', async () => {
    // The shape that actually recurred: the model called again with the town
    // narrowed from "Kokapet, Hyderabad" to "Hyderabad". Different arguments,
    // same caller, same enquiry — and a second WhatsApp. record_outcome records
    // the outcome OF the call, so the call is the unit, not the argument set.
    const { priv, spy } = makeSession(async () => ({ ok: true, recorded: true }));
    await priv.handleConnectorTool({ id: '1', name: 'record_outcome', args: ARGS });
    await priv.handleConnectorTool({ id: '2', name: 'record_outcome', args: { ...ARGS, town: 'Hyderabad' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets a half-collected enquiry be completed and saved', async () => {
    // "Still need: pincode" must not lock the call out of ever saving. The
    // FAILED call releases its key, so the retry runs — this is what keeps the
    // once-per-call rule safe now that drifting arguments no longer excuse it.
    let n = 0;
    const { priv, spy } = makeSession(async () =>
      ++n === 1 ? { ok: false, error: 'Still need: pincode.' } : { ok: true, recorded: true },
    );
    await priv.handleConnectorTool({ id: '1', name: 'record_outcome', args: { name: 'Nikant' } });
    await priv.handleConnectorTool({ id: '2', name: 'record_outcome', args: ARGS });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('still keys other write tools on their arguments', async () => {
    // Rescheduling twice in one call is something a caller may legitimately do.
    const { priv, spy } = makeSession(async () => ({ ok: true, rescheduled: true }), 'reschedule_appointment');
    await priv.handleConnectorTool({ id: '1', name: 'reschedule_appointment', args: { startISO: 'a' } });
    await priv.handleConnectorTool({ id: '2', name: 'reschedule_appointment', args: { startISO: 'b' } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stays retryable after a failure, since a failed write changed nothing', async () => {
    // Otherwise one transient database error is an enquiry that can never be
    // saved for the rest of the call.
    let n = 0;
    const { priv, spy } = makeSession(async () => (++n === 1 ? { ok: false, error: 'db down' } : { ok: true, recorded: true }));
    await priv.handleConnectorTool({ id: '1', name: 'record_outcome', args: ARGS });
    await priv.handleConnectorTool({ id: '2', name: 'record_outcome', args: ARGS });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stays retryable after the handler throws', async () => {
    let n = 0;
    const { priv, spy } = makeSession(async () => {
      if (++n === 1) throw new Error('boom');
      return { ok: true, recorded: true };
    });
    await priv.handleConnectorTool({ id: '1', name: 'record_outcome', args: ARGS });
    await priv.handleConnectorTool({ id: '2', name: 'record_outcome', args: ARGS });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe a read, whose answer can change between two asks', async () => {
    // check_availability twice for the same date must re-check: serving the
    // first reply again would offer slots that have since been taken.
    const { priv, spy } = makeSession(async () => ({ ok: true, slots: [] }), 'check_availability');
    const args = { date: '2026-09-02' };
    await priv.handleConnectorTool({ id: '1', name: 'check_availability', args });
    await priv.handleConnectorTool({ id: '2', name: 'check_availability', args });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
