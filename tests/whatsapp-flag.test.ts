import { describe, it, expect, beforeEach } from 'vitest';
import { whatsappEnabled } from '@/lib/flags';
import { messagingClause } from '@/lib/voice/prompt';
import { readBookingConfig } from '@/lib/connectors/booking';
import { readOutcomeConfig } from '@/lib/connectors/outcomes';
import type { Agent } from '@prisma/client';

// The WhatsApp→SMS migration contract: while WHATSAPP_ENABLED is not "true",
// every channel resolution lands on SMS, and the prompt never promises WhatsApp.

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    workspaceId: 'w1',
    userId: null,
    name: 'Test',
    description: null,
    systemPrompt: 'x',
    greeting: null,
    language: 'en-IN',
    voice: 'v',
    languageMode: 'single',
    voiceProvider: 'google',
    voiceStages: null,
    geminiVoice: 'Aoede',
    agentType: 'healthcare',
    industryLabel: null,
    endCallInstructions: null,
    direction: 'BOTH',
    status: 'ACTIVE',
    maxCallSeconds: 600,
    temperature: 0.6,
    businessHours: null,
    afterHoursMessage: null,
    fallbackMessage: null,
    transferEnabled: false,
    transferNumber: null,
    transferMessage: null,
    transferTriggers: null,
    variables: null,
    bookingConfig: null,
    outcomeConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Agent;
}

describe('WHATSAPP_ENABLED flag', () => {
  beforeEach(() => {
    delete process.env.WHATSAPP_ENABLED;
  });

  it('defaults to off', () => {
    expect(whatsappEnabled()).toBe(false);
  });

  it('only "true" enables it', () => {
    process.env.WHATSAPP_ENABLED = '1';
    expect(whatsappEnabled()).toBe(false);
    process.env.WHATSAPP_ENABLED = 'true';
    expect(whatsappEnabled()).toBe(true);
  });
});

describe('channel resolution while WhatsApp is disabled', () => {
  beforeEach(() => {
    delete process.env.WHATSAPP_ENABLED;
  });

  it('outcome owner alerts never use whatsapp while disabled', () => {
    const agent = fakeAgent({ outcomeConfig: { deliver: { whatsapp: true } } as any });
    expect(readOutcomeConfig(agent).deliver.whatsapp).toBe(false);
  });

  it('outcome owner alerts may use whatsapp when the flag is on', () => {
    process.env.WHATSAPP_ENABLED = 'true';
    const agent = fakeAgent({ outcomeConfig: { deliver: { whatsapp: true } } as any });
    expect(readOutcomeConfig(agent).deliver.whatsapp).toBe(true);
  });
});

describe('prompt messaging clause', () => {
  beforeEach(() => {
    delete process.env.WHATSAPP_ENABLED;
  });

  it('mentions only SMS while WhatsApp is disabled', () => {
    const clause = messagingClause();
    expect(clause).toContain('SMS text message');
    expect(clause).not.toContain('WhatsApp');
  });

  it('mentions WhatsApp when enabled', () => {
    process.env.WHATSAPP_ENABLED = 'true';
    expect(messagingClause()).toContain('WhatsApp');
  });
});
