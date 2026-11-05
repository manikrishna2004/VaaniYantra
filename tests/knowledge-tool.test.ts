import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '@prisma/client';

// Business knowledge moved out of the system instruction and into a tool.
//
// It used to be ~1,000 tokens of retrieved text pinned to the system
// instruction, which sits OUTSIDE the context-window compression and is
// therefore re-sent and re-billed on every turn of the call — whether or not the
// caller ever asked a question it could answer. Worse, it was retrieved against
// `agent.description`, because at connect time nobody has asked anything yet.
//
// As a tool it costs ~90 tokens of declaration, runs against what the caller
// actually said, and its result lands in the compressible window.

const prismaMock = vi.hoisted(() => ({
  agentKnowledge: { count: vi.fn(async (_args: unknown) => 0) },
}));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const retrieveMock = vi.hoisted(() => vi.fn(async (_id: string, _q: string, _k: number) => [] as any[]));
vi.mock('@/lib/rag/retrieve', () => ({ retrieveForAgent: retrieveMock }));

import { knowledgeTool, agentHasKnowledge } from '@/lib/connectors/knowledge';
import { getCallConnectorTools } from '@/lib/connectors/tools';

const agent = { id: 'agent_1', name: 'Sunrise Clinic' } as unknown as Agent;
const ctx = { orgId: 'org_1', callId: 'call_1', customerNumber: '+919000000000', agent };

beforeEach(() => {
  prismaMock.agentKnowledge.count.mockResolvedValue(0);
  retrieveMock.mockResolvedValue([]);
  delete process.env.LIVE_COST_OPT_OUT_AGENT_IDS;
});
afterEach(() => vi.clearAllMocks());

describe('knowledge_search declaration', () => {
  it('asks for the caller’s own words, not a keyword', () => {
    const d = knowledgeTool().declaration;
    expect(d.name).toBe('knowledge_search');
    expect(d.parameters?.required).toEqual(['query']);
    expect(d.parameters?.properties.query.description).toMatch(/own words/i);
  });

  it('stays small — the declaration is re-billed every turn, like the block it replaced', () => {
    expect(JSON.stringify(knowledgeTool().declaration).length).toBeLessThan(600);
  });
});

describe('knowledge_search handler', () => {
  it('searches on what the caller asked, and keeps only a couple of chunks', () => {
    return knowledgeTool()
      .handler({ query: 'do you do root canals on a Sunday' }, ctx as any)
      .then(() => {
        expect(retrieveMock).toHaveBeenCalledWith('agent_1', 'do you do root canals on a Sunday', 2);
      });
  });

  it('reports a miss explicitly rather than returning nothing', async () => {
    // A silent empty result is what invites the model to invent an answer.
    const res = await knowledgeTool().handler({ query: 'parking' }, ctx as any);
    expect(res.found).toBe(false);
    expect(String(res.message)).toMatch(/follow up/i);
  });

  it('caps each answer, because the result sits in the billed window', async () => {
    // No sentence boundary anywhere in it, so the hard cap stands.
    retrieveMock.mockResolvedValue([{ content: 'x'.repeat(5000), documentId: 'd1', score: 1 }]);
    const res = await knowledgeTool().handler({ query: 'hours' }, ctx as any);
    expect((res.answers as string[])[0]).toHaveLength(600);
  });

  it('never cuts an answer mid-number', async () => {
    // chunkText targets 900 characters, so a retrieved chunk is routinely longer
    // than the cap — and the thing sitting at the cut is a price. "1.25 crore"
    // sliced one character early is "1.2", which the model reads out as a fact
    // it was given. That is an invented price arriving through the one path
    // that exists to prevent them.
    const filler = 'The clubhouse has a gym and a pool. '.repeat(16); // ~576 chars
    retrieveMock.mockResolvedValue([
      { content: `${filler}The 3 BHK is priced at 1.25 crore.`, documentId: 'd1', score: 1 },
    ]);
    const res = await knowledgeTool().handler({ query: 'what does the 3 bhk cost' }, ctx as any);
    const answer = (res.answers as string[])[0];
    expect(answer.endsWith('.')).toBe(true);
    expect(answer).not.toMatch(/\d+\.\d?$/); // no half-written number at the end
  });

  it('leaves a short answer exactly as it is', async () => {
    retrieveMock.mockResolvedValue([{ content: 'Open 9:30 am to 7 pm.', documentId: 'd1', score: 1 }]);
    const res = await knowledgeTool().handler({ query: 'hours' }, ctx as any);
    expect((res.answers as string[])[0]).toBe('Open 9:30 am to 7 pm.');
  });

  it('tells the model to follow up rather than guess when the lookup fails', async () => {
    retrieveMock.mockRejectedValue(new Error('db down'));
    const res = await knowledgeTool().handler({ query: 'hours' }, ctx as any);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/rather than guessing/i);
  });

  it('does not search on an empty query', async () => {
    const res = await knowledgeTool().handler({ query: '   ' }, ctx as any);
    expect(res.found).toBe(false);
    expect(retrieveMock).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('is left out entirely when the agent has no documents', async () => {
    // An unusable tool is still tokens on every turn, and a model that can see a
    // search tool will eventually call it.
    prismaMock.agentKnowledge.count.mockResolvedValue(0);
    const tools = await getCallConnectorTools(ctx as any);
    expect(tools.map((t) => t.declaration.name)).not.toContain('knowledge_search');
  });

  it('is registered alongside the outcome tool when the agent has documents', async () => {
    prismaMock.agentKnowledge.count.mockResolvedValue(3);
    const tools = await getCallConnectorTools(ctx as any);
    const names = tools.map((t) => t.declaration.name);
    expect(names).toContain('knowledge_search');
    // Additive: it answers questions, it does not save anything, so it does not
    // overlap the "save this" tool the way booking and record_outcome do.
    expect(names).toContain('record_outcome');
  });

  it('is withheld from an opted-out agent, which still gets its knowledge inlined', async () => {
    prismaMock.agentKnowledge.count.mockResolvedValue(3);
    process.env.LIVE_COST_OPT_OUT_AGENT_IDS = 'agent_1';
    const tools = await getCallConnectorTools(ctx as any);
    expect(tools.map((t) => t.declaration.name)).not.toContain('knowledge_search');
  });

  it('does not even ask the database about an opted-out agent', async () => {
    process.env.LIVE_COST_OPT_OUT_AGENT_IDS = 'agent_1';
    await getCallConnectorTools(ctx as any);
    expect(prismaMock.agentKnowledge.count).not.toHaveBeenCalled();
  });
});

describe('agentHasKnowledge', () => {
  it('degrades to "no knowledge" if the check itself fails', async () => {
    // Better a call with no knowledge tool than a call that never connects.
    prismaMock.agentKnowledge.count.mockRejectedValue(new Error('db down'));
    expect(await agentHasKnowledge('agent_1')).toBe(false);
  });
});
