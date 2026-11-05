import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cross-tenant foreign-key injection.
//
// Several routes scope the *parent* row they load but then write a foreign key
// straight out of the request body without checking that it, too, belongs to
// the caller. The parent check passes, so the request looks legitimate, and the
// tenant ends up holding a reference to another org's row.
//
// This matters more than a normal validation gap because both foreign keys are
// read back on the serving path: agent knowledge is retrieved into the prompt
// on every call and chat, and a phone number's agent decides who answers it.
//
// The fixture below is deliberately two-tenant: workspace w1 is the caller,
// w2 is the victim. Every id ending in `-w2` is a row the caller must never be
// able to name.

const WS = 'w1';

const rows = vi.hoisted(() => ({
  documents: [
    { id: 'doc-w1', workspaceId: 'w1' },
    { id: 'doc-w2', workspaceId: 'w2' },
  ],
  agents: [
    { id: 'agent-w1', workspaceId: 'w1', name: 'Mine' },
    { id: 'agent-w2', workspaceId: 'w2', name: 'Theirs' },
  ],
  numbers: [{ id: 'num-w1', workspaceId: 'w1', agentId: null }],
}));

// A Prisma stand-in that actually honours the `where` scope, so a route that
// forgets to scope is caught rather than accidentally passing against a mock
// that returns whatever it is asked for.
const matches = (row: any, where: any) =>
  Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as any)) return (v as any).in.includes(row[k]);
    return row[k] === v;
  });

const prismaMock = vi.hoisted(() => ({
  document: {
    findMany: vi.fn(async ({ where }: any) => rows.documents.filter((d) => matches(d, where))),
  },
  agent: {
    findFirst: vi.fn(async ({ where }: any) => rows.agents.find((a) => matches(a, where)) ?? null),
    findMany: vi.fn(async ({ where }: any) => rows.agents.filter((a) => matches(a, where))),
    create: vi.fn(async () => ({ id: 'new-agent', name: 'Reception' })),
    update: vi.fn(async () => ({ id: 'agent-w1', name: 'Reception' })),
  },
  agentKnowledge: {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
  },
  phoneNumber: {
    findFirst: vi.fn(async ({ where }: any) => rows.numbers.find((n) => matches(n, where)) ?? null),
    update: vi.fn(async () => ({ id: 'num-w1' })),
    count: vi.fn(async () => 0),
  },
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/auth/context', () => ({
  requireWorkspace: vi.fn(async () => ({
    user: { id: 'u1', email: 'o@example.com' },
    org: { id: 'o1', name: 'Org' },
    workspace: { id: WS, name: 'WS' },
    role: 'OWNER',
  })),
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/billing/catalogue', () => ({
  checkCreateAllowed: vi.fn(async () => ({ allowed: true, limit: 10, current: 0, plan: { name: 'Free' } })),
  limitMessage: vi.fn(() => 'limit'),
}));

import { POST as createAgent } from '@/app/api/agents/route';
import { PATCH as patchAgent } from '@/app/api/agents/[id]/route';
import { PATCH as patchNumber } from '@/app/api/numbers/[id]/route';

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const patch = (url: string, body: unknown) =>
  new Request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const agentBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Reception',
  systemPrompt: 'You are a helpful receptionist.',
  language: 'en-IN',
  voice: 'en-IN-Neural2-A',
  direction: 'BOTH',
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/agents — documentIds may not name another org’s document', () => {
  it('rejects a foreign documentId instead of linking it', async () => {
    const res = await createAgent(post('http://test/api/agents', agentBody({ documentIds: ['doc-w2'] })));

    expect(res.status).toBe(400);
    // The agent must not be created at all — a partially-created agent that
    // simply lacks the link would still be a confusing half-success.
    expect(prismaMock.agent.create).not.toHaveBeenCalled();
  });

  it('rejects a mixed list where only one id is foreign', async () => {
    const res = await createAgent(
      post('http://test/api/agents', agentBody({ documentIds: ['doc-w1', 'doc-w2'] })),
    );

    expect(res.status).toBe(400);
    expect(prismaMock.agent.create).not.toHaveBeenCalled();
  });

  it('still accepts the caller’s own documents', async () => {
    const res = await createAgent(post('http://test/api/agents', agentBody({ documentIds: ['doc-w1'] })));

    expect(res.status).toBe(201);
    expect(prismaMock.agent.create).toHaveBeenCalled();
  });

  it('still accepts an agent with no documents at all', async () => {
    const res = await createAgent(post('http://test/api/agents', agentBody()));

    expect(res.status).toBe(201);
    // No ids to check means no reason to query for them.
    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/agents/[id] — same rule on update', () => {
  const params = { params: Promise.resolve({ id: 'agent-w1' }) };

  it('rejects a foreign documentId', async () => {
    const res = await patchAgent(
      patch('http://test/api/agents/agent-w1', { documentIds: ['doc-w2'] }),
      { params: Promise.resolve({ id: 'agent-w1' }) },
    );

    expect(res.status).toBe(400);
  });

  it('does not wipe the existing links when the update is rejected', async () => {
    // The route deletes every existing link before writing the new ones. If the
    // ownership check runs after that, a rejected request still costs the
    // customer their whole knowledge configuration.
    await patchAgent(patch('http://test/api/agents/agent-w1', { documentIds: ['doc-w2'] }), {
      params: Promise.resolve({ id: 'agent-w1' }),
    });

    expect(prismaMock.agentKnowledge.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.agentKnowledge.createMany).not.toHaveBeenCalled();
  });

  it('still accepts the caller’s own documents', async () => {
    const res = await patchAgent(patch('http://test/api/agents/agent-w1', { documentIds: ['doc-w1'] }), params);

    expect(res.status).toBe(200);
    expect(prismaMock.agentKnowledge.createMany).toHaveBeenCalled();
  });

  it('still allows clearing every link with an empty list', async () => {
    const res = await patchAgent(patch('http://test/api/agents/agent-w1', { documentIds: [] }), {
      params: Promise.resolve({ id: 'agent-w1' }),
    });

    expect(res.status).toBe(200);
    expect(prismaMock.agentKnowledge.deleteMany).toHaveBeenCalled();
    expect(prismaMock.agentKnowledge.createMany).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/numbers/[id] — agentId may not name another org’s agent', () => {
  const params = () => ({ params: Promise.resolve({ id: 'num-w1' }) });

  it('rejects a foreign agentId instead of pointing the number at it', async () => {
    // Left unchecked this is worse than a data leak: the victim's persona,
    // system prompt and knowledge would answer the attacker's calls, and the
    // transcript would land in the attacker's workspace.
    const res = await patchNumber(patch('http://test/api/numbers/num-w1', { agentId: 'agent-w2' }), params());

    expect(res.status).toBe(400);
    expect(prismaMock.phoneNumber.update).not.toHaveBeenCalled();
  });

  it('still accepts the caller’s own agent', async () => {
    const res = await patchNumber(patch('http://test/api/numbers/num-w1', { agentId: 'agent-w1' }), params());

    expect(res.status).toBe(200);
    expect(prismaMock.phoneNumber.update).toHaveBeenCalled();
  });

  it('still allows unassigning the agent', async () => {
    const res = await patchNumber(patch('http://test/api/numbers/num-w1', { agentId: '' }), params());

    expect(res.status).toBe(200);
    expect(prismaMock.phoneNumber.update).toHaveBeenCalled();
  });

  it('still 404s on a number belonging to another workspace', async () => {
    const res = await patchNumber(patch('http://test/api/numbers/num-w2', { label: 'x' }), {
      params: Promise.resolve({ id: 'num-w2' }),
    });

    expect(res.status).toBe(404);
  });
});
