import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectRedFlag, emergencyReply } from '@/lib/portal/red-flags';

// The emergency tripwire is well built and well tested — but it was wired into
// exactly ONE of the three places a patient can type a symptom at us. The
// patient portal had it; the paid WhatsApp follow-up chat went straight to the
// model. A patient who texts "chest pain, can't breathe" to the clinic's
// WhatsApp number is in the same danger as one who types it into the chatbot,
// and was relying entirely on the system prompt to be reassured rather than
// redirected.
//
// These tests cover the channel wiring and two sharp edges in the reply itself.

const llmGenerate = vi.hoisted(() => vi.fn(async () => 'A friendly model answer about clinic hours.'));
const sendWhatsApp = vi.hoisted(() =>
  vi.fn(async (_orgId: string, _to: string, _body: string) => true),
);

const prismaMock = vi.hoisted(() => ({
  organization: { findUnique: vi.fn(async () => ({ whatsappChatAddon: true })) },
  phoneNumber: { findMany: vi.fn(async () => []) },
  agent: {
    findFirst: vi.fn(async () => ({
      id: 'a1',
      workspaceId: 'w1',
      status: 'ACTIVE',
      systemPrompt: 'You are a clinic receptionist.',
      language: 'en-IN',
    })),
    findUnique: vi.fn(async () => null),
  },
  whatsappTurn: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({ count: 2 })) },
  outcome: {
    findFirst: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    create: vi.fn(async () => ({ id: 'out1' })),
  },
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/adapters/llm', () => ({ getLlmProvider: () => ({ generate: llmGenerate }) }));
vi.mock('@/lib/connectors', () => ({ sendWhatsApp, findOrgIdByCloudPhoneNumberId: vi.fn() }));
vi.mock('@/lib/rag/retrieve', () => ({
  retrieveForAgent: vi.fn(async () => []),
  formatKnowledgeBlock: vi.fn(() => ''),
}));
vi.mock('@/lib/connectors/outcomes', () => ({ deliverOutcome: vi.fn(async () => {}) }));

import { handleInboundWhatsApp } from '@/lib/whatsapp-chat';

const inbound = (text: string) =>
  handleInboundWhatsApp({ orgId: 'o1', from: 'whatsapp:+919876543210', text });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WhatsApp follow-up chat honours the emergency tripwire', () => {
  it('answers chest pain with the emergency numbers instead of asking the model', async () => {
    const reply = await inbound('I have bad chest pain and my left arm hurts');

    expect(reply).toContain('108');
    expect(reply).toContain('112');
    // The whole point: the model must not get the chance to be reassuring.
    expect(llmGenerate).not.toHaveBeenCalled();
  });

  it('still sends that reply to the patient over WhatsApp', async () => {
    await inbound('chest pain');

    expect(sendWhatsApp).toHaveBeenCalledOnce();
    expect(sendWhatsApp.mock.calls[0]?.[2]).toContain('108');
  });

  it('fires on a red flag past the truncation cutoff', async () => {
    // Inbound text is capped at 1000 chars before being handled. Detecting on
    // the truncated copy would mean a symptom mentioned after a long preamble
    // is silently dropped — the one message where losing it matters most.
    const reply = await inbound('hello '.repeat(300) + ' I am having chest pain');

    expect(reply).toContain('108');
    expect(llmGenerate).not.toHaveBeenCalled();
  });

  it('leaves an ordinary question to the model', async () => {
    const reply = await inbound('what time do you open on Saturday?');

    expect(llmGenerate).toHaveBeenCalledOnce();
    expect(reply).toBe('A friendly model answer about clinic hours.');
  });

  it('records the emergency for the clinic to follow up', async () => {
    await inbound('chest pain');

    expect(prismaMock.outcome.create).toHaveBeenCalled();
  });

  it('still answers the patient when recording the alert fails', async () => {
    // The patient has already been told to call 108 by the time the clinic is
    // notified; nothing in the alerting path may take that away.
    prismaMock.outcome.create.mockRejectedValueOnce(new Error('db down'));

    const reply = await inbound('chest pain');

    expect(reply).toContain('108');
  });

  it('does not answer at all when the add-on is off', async () => {
    prismaMock.organization.findUnique.mockResolvedValueOnce({ whatsappChatAddon: false } as any);

    await expect(inbound('chest pain')).resolves.toBeNull();
  });
});

describe('the canned reply is safe in every language', () => {
  it('carries both emergency numbers in English', () => {
    const reply = emergencyReply('Sunrise Dental', 'en-IN');
    expect(reply).toContain('108');
    expect(reply).toContain('112');
    expect(reply).toContain('Sunrise Dental');
  });

  it('carries them in Hindi too', () => {
    const reply = emergencyReply('Sunrise Dental', 'hi-IN');
    expect(reply).toContain('108');
    expect(reply).toContain('112');
  });

  it('falls back to English for a language we have no translation for', () => {
    // There are only two entries in the table but the product sells 29
    // languages. The fallback must still be actionable rather than empty —
    // the digits are what matter and they survive any language.
    for (const lang of ['ta-IN', 'te-IN', 'bn-IN', 'mr-IN', 'ar', 'fr-FR', '', null, undefined]) {
      const reply = emergencyReply('Sunrise Dental', lang);
      expect(reply).toContain('108');
      expect(reply).toContain('112');
      expect(reply.length).toBeGreaterThan(20);
    }
  });

  it('names the clinic generically when it has no name', () => {
    expect(emergencyReply('', 'en-IN')).toContain('the clinic');
  });

  it('does not diagnose — a false positive must not frighten anyone', () => {
    const reply = emergencyReply('Sunrise Dental', 'en-IN').toLowerCase();
    for (const scary of ['heart attack', 'stroke', 'dying', 'you may be having']) {
      expect(reply).not.toContain(scary);
    }
  });
});

describe('detector still behaves at the channel boundary', () => {
  it('detects across the phrasings a WhatsApp user actually types', () => {
    for (const text of ['chest pain', 'CHEST PAIN!!', 'saans nahi aa rahi', 'severe bleeding']) {
      expect(detectRedFlag(text), text).toBeTruthy();
    }
  });

  it('ignores an empty or whitespace message', () => {
    expect(detectRedFlag('')).toBeNull();
    expect(detectRedFlag('   ')).toBeNull();
  });
});
