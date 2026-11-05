import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1-3: the follow-up chat answers with the agent assigned to the number the
// caller messaged — not whichever agent was edited most recently.

const state = vi.hoisted(() => ({
  numbers: [] as Array<{ e164: string; agent: any }>,
  recentAgent: null as any,
  generated: '',
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    organization: { findUnique: vi.fn(async () => ({ whatsappChatAddon: true })) },
    phoneNumber: { findMany: vi.fn(async () => state.numbers) },
    agent: { findFirst: vi.fn(async () => state.recentAgent) },
    whatsappTurn: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 2 })),
    },
  },
}));
vi.mock('@/lib/adapters/llm', () => ({
  getLlmProvider: () => ({
    generate: vi.fn(async (opts: any) => {
      state.generated = opts.systemInstruction as string;
      return 'Sure — we open at 9am.';
    }),
  }),
}));
vi.mock('@/lib/rag/retrieve', () => ({
  retrieveForAgent: vi.fn(async () => []),
  formatKnowledgeBlock: () => '',
}));
vi.mock('@/lib/connectors', () => ({ sendWhatsApp: vi.fn(async () => true) }));

import { handleInboundWhatsApp } from '@/lib/whatsapp-chat';

const clinicAgent = { id: 'clinic', status: 'ACTIVE', systemPrompt: 'CLINIC PROMPT', language: 'en-IN' };
const salonAgent = { id: 'salon', status: 'ACTIVE', systemPrompt: 'SALON PROMPT', language: 'en-IN' };

describe('handleInboundWhatsApp agent resolution', () => {
  beforeEach(() => {
    state.numbers = [
      { e164: '+911111111111', agent: clinicAgent },
      { e164: '+912222222222', agent: salonAgent },
    ];
    // The "most recently updated" agent is the WRONG one on purpose.
    state.recentAgent = salonAgent;
    state.generated = '';
  });

  it("answers with the messaged number's agent", async () => {
    const reply = await handleInboundWhatsApp({
      orgId: 'o1',
      from: 'whatsapp:+919876543210',
      text: 'When do you open?',
      toNumber: 'whatsapp:+911111111111',
    });
    expect(reply).toBeTruthy();
    expect(state.generated).toContain('CLINIC PROMPT');
  });

  it('falls back to the most recent active agent when the number is unknown', async () => {
    const reply = await handleInboundWhatsApp({
      orgId: 'o1',
      from: '+919876543210',
      text: 'Hi',
      toNumber: '+919999999999',
    });
    expect(reply).toBeTruthy();
    expect(state.generated).toContain('SALON PROMPT');
  });
});
