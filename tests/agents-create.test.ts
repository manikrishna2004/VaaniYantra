import { describe, it, expect, vi } from 'vitest';

// P1-1: an agent can be created with zero connected phone numbers (the number
// is only needed to go live). We stub auth/db/billing and drive the real route.

vi.mock('@/lib/auth/context', () => ({
  requireWorkspace: vi.fn(async () => ({
    user: { id: 'u1', email: 'o@example.com' },
    org: { id: 'o1', name: 'Org' },
    workspace: { id: 'w1', name: 'WS' },
    role: 'OWNER',
  })),
}));

const createdAgent = { id: 'a1', name: 'Reception' };
const prismaMock = vi.hoisted(() => ({
  agent: { create: vi.fn(async () => ({ id: 'a1', name: 'Reception' })), findMany: vi.fn(async () => []) },
  phoneNumber: { count: vi.fn(async () => 0) },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/billing/catalogue', () => ({
  checkCreateAllowed: vi.fn(async () => ({ allowed: true, limit: 10, current: 0, plan: { name: 'Free' } })),
  limitMessage: vi.fn(() => 'limit'),
}));

import { POST } from '@/app/api/agents/route';

function agentBody() {
  return {
    name: 'Reception',
    systemPrompt: 'You are a helpful receptionist.',
    language: 'en-IN',
    voice: 'en-IN-Neural2-A',
    direction: 'BOTH',
  };
}

describe('POST /api/agents', () => {
  it('creates an agent even with zero connected phone numbers', async () => {
    const res = await POST(
      new Request('http://test/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentBody()),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(createdAgent.id);
    expect(prismaMock.agent.create).toHaveBeenCalled();
  });

  it('400s on malformed JSON instead of crashing', async () => {
    const res = await POST(
      new Request('http://test/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on invalid input (missing name)', async () => {
    const { name: _n, ...rest } = agentBody();
    const res = await POST(
      new Request('http://test/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rest),
      }),
    );
    expect(res.status).toBe(400);
  });
});
