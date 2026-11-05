import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INTERNAL_COST_FIELDS,
  stripInternalCost,
  stripInternalCostAll,
} from '@/lib/calls/redact';

// The llm* columns are what a call cost US to run. Against the per-minute rate
// on the customer's invoice they are the gross margin on that call — and
// /api/calls and /api/calls/[id] return Prisma rows with `include`, so every
// scalar on the model goes out over the wire. Nothing renders them, which is
// how they sat in the JSON unnoticed, readable from devtools by any workspace
// member with call:read.

/** A row shaped the way `include` returns one, cost columns and all. */
function callRow(over: Record<string, unknown> = {}) {
  return {
    id: 'call_1',
    workspaceId: 'ws_1',
    direction: 'INBOUND',
    status: 'COMPLETED',
    fromNumber: '+919000000000',
    toNumber: '+914048956915',
    durationSec: 184,
    summary: 'Booked a cleaning for Tuesday.',
    sentiment: 'positive',
    createdAt: new Date('2026-08-31T10:00:00Z'),
    llmModel: 'gemini-2.5-flash-native-audio-latest',
    llmTurns: 14,
    llmPromptTokens: 210_400,
    llmResponseTokens: 8_900,
    llmAudioInTokens: 198_000,
    llmAudioOutTokens: 8_100,
    llmCostInr: 16.2,
    agent: { id: 'agent_1', name: 'Sunrise Clinic' },
    _count: { transcript: 12 },
    ...over,
  };
}

describe('stripInternalCost', () => {
  it('removes every cost column', () => {
    const out = stripInternalCost(callRow()) as Record<string, unknown>;
    for (const f of INTERNAL_COST_FIELDS) expect(out).not.toHaveProperty(f);
  });

  it('removes the rupee figure specifically — the one that is the margin', () => {
    expect(JSON.stringify(stripInternalCost(callRow()))).not.toContain('16.2');
  });

  it('keeps everything the dashboard actually renders, relations included', () => {
    const out = stripInternalCost(callRow()) as Record<string, unknown>;
    expect(out.id).toBe('call_1');
    expect(out.durationSec).toBe(184);
    expect(out.summary).toBe('Booked a cleaning for Tuesday.');
    expect(out.sentiment).toBe('positive');
    expect(out.agent).toEqual({ id: 'agent_1', name: 'Sunrise Clinic' });
    expect(out._count).toEqual({ transcript: 12 });
  });

  it('does not mutate the row it was given', () => {
    const row = callRow();
    stripInternalCost(row);
    expect(row.llmCostInr).toBe(16.2);
  });

  it('handles a row where the columns are absent or null', () => {
    // Calls placed before the columns shipped read as null, and a `select`ed row
    // may not carry them at all.
    const out = stripInternalCost(callRow({ llmCostInr: null, llmModel: null }));
    expect(out).not.toHaveProperty('llmCostInr');
    expect(stripInternalCost({ id: 'c' })).toEqual({ id: 'c' });
  });

  it('strips a whole list', () => {
    const out = stripInternalCostAll([callRow(), callRow({ id: 'call_2' })]);
    expect(out).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain('llmCostInr');
  });
});

describe('the field list tracks the schema', () => {
  it('covers every llm* column on the Call model', () => {
    // The real risk is not this code, it is the next cost column: stripping is
    // a denylist, so a field added to the schema and forgotten here would start
    // shipping to customers silently. This is what fails when that happens.
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model Call {'));
    const body = model.slice(0, model.indexOf('\n}'));

    const declared = [...body.matchAll(/^\s{2}(llm[A-Za-z0-9]*)\s/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0); // the parse itself still works
    expect(new Set(declared)).toEqual(new Set(INTERNAL_COST_FIELDS));
  });
});
