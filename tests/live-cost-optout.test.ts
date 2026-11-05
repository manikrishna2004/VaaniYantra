import { describe, it, expect, afterEach } from 'vitest';
import { costOptimized } from '@/lib/flags';

// Which agents the cost work is allowed to change.
//
// It started life protecting the real-estate demo, which was excluded on the
// grounds that it bills its own Gemini key. That exclusion is gone: the demo's
// key is our money too, a demo minute is the most expensive minute we buy, and
// the path carries the leaked-session and watchdog fixes as well as the cost
// ones. What is left is one explicit list, for pinning a named agent to the old
// behaviour while something is looked at.

const ORIGINAL = process.env.LIVE_COST_OPT_OUT_AGENT_IDS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LIVE_COST_OPT_OUT_AGENT_IDS;
  else process.env.LIVE_COST_OPT_OUT_AGENT_IDS = ORIGINAL;
});

describe('costOptimized', () => {
  it('optimises an ordinary agent', () => {
    delete process.env.LIVE_COST_OPT_OUT_AGENT_IDS;
    expect(costOptimized({ id: 'agent_1' })).toBe(true);
    expect(costOptimized({ id: 'agent_1', geminiApiKey: null })).toBe(true);
  });

  it('optimises an agent on its own Gemini key too', () => {
    // Whose key pays no longer decides which path a call takes. The demo agent
    // carries one (stored encrypted, so any non-empty value means "set") and it
    // takes the same path as every customer agent.
    delete process.env.LIVE_COST_OPT_OUT_AGENT_IDS;
    expect(costOptimized({ id: 'agent_1', geminiApiKey: 'enc:whatever' })).toBe(true);
  });

  it('opts out an agent on its own key only when it is named in the list', () => {
    // The escape hatch has to still reach the demo, which is the agent most
    // likely to be pinned back for a look.
    process.env.LIVE_COST_OPT_OUT_AGENT_IDS = 'agent_demo';
    expect(costOptimized({ id: 'agent_demo', geminiApiKey: 'enc:whatever' })).toBe(false);
  });

  it('honours the explicit opt-out list', () => {
    process.env.LIVE_COST_OPT_OUT_AGENT_IDS = 'agent_2, agent_3';
    expect(costOptimized({ id: 'agent_2' })).toBe(false);
    expect(costOptimized({ id: 'agent_3' })).toBe(false); // whitespace tolerated
    expect(costOptimized({ id: 'agent_4' })).toBe(true);
  });

  it('treats an empty or unset list as opting nobody out', () => {
    process.env.LIVE_COST_OPT_OUT_AGENT_IDS = '';
    expect(costOptimized({ id: 'agent_1' })).toBe(true);
    process.env.LIVE_COST_OPT_OUT_AGENT_IDS = ',, ,';
    expect(costOptimized({ id: 'agent_1' })).toBe(true);
  });

  it('does not match an id by prefix', () => {
    // 'agent_1' must not opt out 'agent_10'.
    process.env.LIVE_COST_OPT_OUT_AGENT_IDS = 'agent_1';
    expect(costOptimized({ id: 'agent_10' })).toBe(true);
  });

  it('is false for no agent at all, so nothing new runs before we know who we are serving', () => {
    expect(costOptimized(null)).toBe(false);
    expect(costOptimized(undefined)).toBe(false);
  });
});
