import { describe, it, expect, vi, beforeEach } from 'vitest';

// The portal chat loop: the model may call tools before it answers, and the
// loop has to dispatch them, feed results back, refuse to run forever, and be
// honest about whether anything actually changed.

const state = vi.hoisted(() => ({
  // Scripted model turns, consumed one per round.
  turns: [] as { text: string; calls: { name: string; args: Record<string, unknown> }[] }[],
  systemInstructions: [] as string[],
  historiesSeen: [] as unknown[][],
  generateCalls: 0,
  toolCalls: [] as string[],
  tools: [] as any[],
  visitsResult: { status: 'ok', visits: [] as any[] } as any,
  alerts: [] as any[],
  allergies: [] as any[],
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    agent: { findUnique: vi.fn(async () => ({ id: 'a1', systemPrompt: 'CLINIC PROMPT', language: 'en-IN', workspaceId: 'w1' })) },
    portalChatTurn: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 2 })),
    },
    allergy: { findMany: vi.fn(async () => state.allergies) },
  },
}));

vi.mock('@/lib/adapters/llm', () => ({
  getLlmProvider: () => ({
    generate: vi.fn(async (opts: any) => {
      state.systemInstructions.push(opts.systemInstruction);
      return 'plain answer';
    }),
    generateWithTools: vi.fn(async (opts: any) => {
      state.systemInstructions.push(opts.systemInstruction);
      state.historiesSeen.push([...opts.history]);
      state.generateCalls += 1;
      return state.turns.shift() ?? { text: 'all done', calls: [] };
    }),
  }),
}));

vi.mock('@/lib/rag/retrieve', () => ({
  retrieveForAgent: vi.fn(async () => []),
  formatKnowledgeBlock: () => '',
}));

vi.mock('@/lib/connectors/booking', () => ({
  readBookingConfig: () => ({ enabled: true, businessName: 'Smile Dental', timezone: 'Asia/Kolkata' }),
}));

vi.mock('@/lib/patients', () => ({
  getPatientProvider: vi.fn(async () => ({
    kind: 'native',
    capabilities: { canWriteRecords: true, canWriteAppointments: true, canReadDocuments: true },
    listPatientVisits: vi.fn(async () => state.visitsResult),
  })),
  formatPatientBlock: (c: any) => (c?.sex || c?.dateOfBirth ? `\n\nPatient: ${c.sex ?? ''}.` : ''),
  formatRecordsBlock: (r: any) =>
    r.status === 'unavailable'
      ? '\n\nPatient record:\n(UNAVAILABLE)'
      : `\n\nPatient record:\n${r.status === 'ok' ? r.visits.length : 0} visit(s)`,
}));

vi.mock('@/lib/portal/tools', () => ({
  portalTools: vi.fn(async () => state.tools),
}));

vi.mock('@/lib/portal/emergency-alert', () => ({
  alertEmergency: vi.fn(async (a: unknown) => {
    state.alerts.push(a);
  }),
}));

import { handlePortalMessage } from '@/lib/portal/chat';

const PORTAL = {
  id: 'p1',
  workspaceId: 'w1',
  agentId: 'a1',
  name: 'Smile Dental',
  allowRecords: true,
  allowBooking: true,
} as any;
const CONTACT = { id: 'c1', orgId: 'org-A', name: 'Ravi Kumar', phone: '+919876543210' } as any;

function tool(name: string, result: Record<string, unknown>) {
  return {
    spec: { name, description: name, parameters: { type: 'OBJECT', properties: {} } },
    handler: vi.fn(async () => {
      state.toolCalls.push(name);
      return result;
    }),
  };
}

describe('handlePortalMessage', () => {
  beforeEach(() => {
    state.turns = [];
    state.systemInstructions = [];
    state.historiesSeen = [];
    state.generateCalls = 0;
    state.toolCalls = [];
    state.tools = [];
    state.visitsResult = { status: 'ok', visits: [{ id: 'v1' }] };
    state.alerts = [];
    state.allergies = [];
  });

  // The chatbot must never fill a silent allergy gap with reassurance.
  describe('allergies in the prompt', () => {
    it('tells the model NOT to claim no allergies when none were taken', async () => {
      await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'can I take this with paracetamol?' });
      expect(state.systemInstructions[0]).toContain('NOT RECORDED');
      expect(state.systemInstructions[0]).toContain('Do NOT tell them they have no allergies');
    });

    it('lists recorded allergies', async () => {
      state.allergies = [
        {
          id: 'al1',
          substance: 'Penicillin',
          reaction: 'rash',
          severity: 'severe',
          recordedAt: new Date('2026-06-01'),
          retiredAt: null,
        },
      ];
      await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'what was I prescribed?' });
      expect(state.systemInstructions[0]).toContain('Penicillin');
    });
  });

  // The tripwire is the only patient-safety control here that does not depend
  // on the model, so what matters is that it reaches the patient WITHOUT the
  // model being consulted at all.
  describe('emergency tripwire', () => {
    it('answers an emergency without ever calling the model', async () => {
      const res = await handlePortalMessage({
        portal: PORTAL,
        contact: CONTACT,
        text: 'I have had chest pain since this morning',
      });
      expect(state.generateCalls).toBe(0);
      expect(state.systemInstructions).toHaveLength(0);
      expect(res.reply).toContain('108');
      expect(res.reply).toContain('112');
      expect(res.mutated).toBe(false);
    });

    it('alerts the clinic', async () => {
      await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'saans nahi aa rahi' });
      expect(state.alerts).toHaveLength(1);
      expect(state.alerts[0].flag.concept).toBe('breathlessness');
      // alertEmergency takes plain ids rather than a Portal/Contact pair, so the
      // WhatsApp channel — which has neither — can raise the same alert.
      expect(state.alerts[0].channel).toBe('chatbot');
      expect(state.alerts[0].patientPhone).toBe(CONTACT.phone);
      expect(state.alerts[0].orgId).toBe(CONTACT.orgId);
    });

    it('records the exchange so the clinic can see what was said', async () => {
      const { prisma } = await import('@/lib/db');
      await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'I want to kill myself' });
      // Both turns persisted — an emergency is the one message class that must
      // never be missing from the history.
      expect(prisma.portalChatTurn.createMany).toHaveBeenCalled();
      const arg = (prisma.portalChatTurn.createMany as any).mock.calls.at(-1)[0];
      expect(arg.data).toHaveLength(2);
      expect(arg.data[0].text).toContain('kill myself');
      expect(arg.data[1].text).toContain('108');
    });

    it('leaves an ordinary question alone', async () => {
      const res = await handlePortalMessage({
        portal: PORTAL,
        contact: CONTACT,
        text: 'what time do you open tomorrow?',
      });
      expect(state.generateCalls + state.systemInstructions.length).toBeGreaterThan(0);
      expect(state.alerts).toHaveLength(0);
      expect(res.reply).toBe('plain answer');
    });
  });

  it("answers from the patient's own records", async () => {
    const res = await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'what did the doctor give me?' });
    expect(res.reply).toBe('plain answer');
    const prompt = state.systemInstructions[0];
    expect(prompt).toContain('CLINIC PROMPT');
    expect(prompt).toContain('Patient record:');
    expect(prompt).toContain('Ravi Kumar');
  });

  it('tells the model records are UNAVAILABLE when the source could not be reached', async () => {
    // The integrated case: the clinic's system timed out. The model must not be
    // handed the same prompt it would get for a patient with no history.
    state.visitsResult = { status: 'unavailable', reason: 'upstream timeout' };
    await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'what did the doctor give me?' });
    expect(state.systemInstructions[0]).toContain('UNAVAILABLE');
  });

  it('omits the record block entirely when the clinic turned records off', async () => {
    await handlePortalMessage({
      portal: { ...PORTAL, allowRecords: false },
      contact: CONTACT,
      text: 'hi',
    });
    expect(state.systemInstructions[0]).not.toContain('Patient record:');
  });

  it('tells the model it must not give medical advice', async () => {
    await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'should I double the dose?' });
    expect(state.systemInstructions[0]).toMatch(/not a doctor/i);
  });

  it('runs a tool, feeds the result back, and returns the follow-up answer', async () => {
    state.tools = [tool('check_availability', { ok: true, slots: [] })];
    state.turns = [
      { text: '', calls: [{ name: 'check_availability', args: {} }] },
      { text: 'Nothing free this week.', calls: [] },
    ];

    const res = await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'any slots?' });

    expect(state.toolCalls).toEqual(['check_availability']);
    expect(res.reply).toBe('Nothing free this week.');
    // Round two must see the call and its result, or the model answers blind.
    const second = state.historiesSeen[1] as any[];
    expect(second.some((h) => h.role === 'call' && h.name === 'check_availability')).toBe(true);
    expect(second.some((h) => h.role === 'tool' && h.response.ok === true)).toBe(true);
  });

  it('flags a real change so the UI refreshes, but not a read-only lookup', async () => {
    state.tools = [tool('check_availability', { ok: true, slots: [] })];
    state.turns = [
      { text: '', calls: [{ name: 'check_availability', args: {} }] },
      { text: 'Here you go.', calls: [] },
    ];
    expect((await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'slots?' })).mutated).toBe(false);

    state.toolCalls = [];
    state.tools = [tool('book_appointment', { ok: true, booked: true })];
    state.turns = [
      { text: '', calls: [{ name: 'book_appointment', args: { startISO: 'x' } }] },
      { text: 'Booked!', calls: [] },
    ];
    expect((await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'book it' })).mutated).toBe(true);
  });

  it('stops after the round cap instead of looping forever', async () => {
    state.tools = [tool('check_availability', { ok: true })];
    // A model that only ever calls tools would otherwise spin indefinitely,
    // burning API spend and hammering the calendar.
    state.turns = Array.from({ length: 10 }, () => ({
      text: '',
      calls: [{ name: 'check_availability', args: {} }],
    }));

    const res = await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'slots?' });
    expect(state.generateCalls).toBe(4);
    expect(res.reply).toBeTruthy();
  });

  it('survives a tool that throws', async () => {
    state.tools = [
      {
        spec: { name: 'book_appointment', description: 'b', parameters: { type: 'OBJECT', properties: {} } },
        handler: vi.fn(async () => {
          throw new Error('calendar exploded');
        }),
      },
    ];
    state.turns = [
      { text: '', calls: [{ name: 'book_appointment', args: {} }] },
      { text: 'Sorry, I could not book that.', calls: [] },
    ];

    const res = await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'book' });
    expect(res.reply).toBe('Sorry, I could not book that.');
    expect(res.mutated).toBe(false);
  });

  it('ignores a hallucinated tool name', async () => {
    state.tools = [tool('check_availability', { ok: true })];
    state.turns = [
      { text: '', calls: [{ name: 'delete_all_records', args: {} }] },
      { text: "I can't do that.", calls: [] },
    ];

    const res = await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: 'delete everything' });
    expect(state.toolCalls).toEqual([]);
    expect(res.reply).toBe("I can't do that.");
  });

  it('rejects an empty message without calling the model', async () => {
    const res = await handlePortalMessage({ portal: PORTAL, contact: CONTACT, text: '   ' });
    expect(res.reply).toBe('');
    expect(state.systemInstructions).toHaveLength(0);
  });
});
