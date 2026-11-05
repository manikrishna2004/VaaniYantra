import { describe, it, expect, vi, beforeEach } from 'vitest';

// P1-5: a call where nothing was said finalizes as FAILED with zero duration
// (not billed); a real conversation is COMPLETED with its wall-clock duration.

const state = vi.hoisted(() => ({
  turnCount: 0,
  updates: [] as any[],
  events: [] as string[],
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    transcriptTurn: { count: vi.fn(async () => state.turnCount) },
    call: {
      update: vi.fn(async (args: any) => {
        state.updates.push(args);
        return {};
      }),
    },
  },
}));
vi.mock('@/lib/voice/conversation', () => ({ summarizeCall: vi.fn(async () => 'summary') }));
vi.mock('@/lib/webhooks', () => ({
  dispatchCallEvent: vi.fn(async (_id: string, ev: string) => {
    state.events.push(ev);
  }),
}));
vi.mock('@/lib/crm', () => ({ pushCallToCrm: vi.fn(async () => {}) }));

import { finalizeCallRecord } from '@/lib/voice/finalize';

describe('finalizeCallRecord', () => {
  beforeEach(() => {
    state.turnCount = 0;
    state.updates = [];
    state.events = [];
  });

  it('marks empty calls FAILED with zero duration and fires call.failed', async () => {
    state.turnCount = 0;
    const result = await finalizeCallRecord('c1', 45000);
    expect(result).toBe('failed');
    const data = state.updates[0].data;
    expect(data.status).toBe('FAILED');
    expect(data.durationSec).toBe(0);
    expect(data.endedReason).toBe('no_conversation');
    expect(state.events).toContain('call.failed');
  });

  it('marks real conversations COMPLETED with the elapsed duration', async () => {
    state.turnCount = 5;
    const result = await finalizeCallRecord('c1', 61000);
    expect(result).toBe('completed');
    const data = state.updates[0].data;
    expect(data.status).toBe('COMPLETED');
    expect(data.durationSec).toBe(61);
    expect(data.summary).toBe('summary');
    expect(state.events).toContain('call.completed');
  });
});
