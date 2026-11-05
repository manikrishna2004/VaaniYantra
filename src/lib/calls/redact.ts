// What a Call row carries that the customer must never be handed.
//
// The llm* columns are our COST of running a call — tokens spent and the rupee
// estimate built from them (src/lib/voice/usage.ts). Set against the per-minute
// rate on the invoice, they are the gross margin on every call, per call. The
// dashboard endpoints return `prisma.call.findMany(...)` with `include` rather
// than `select`, which means every scalar on the model goes out over the wire —
// so these shipped to any workspace member with `call:read` from the moment the
// columns were added. Nothing renders them, which is why it went unnoticed:
// they sat in the JSON, readable from devtools.
//
// Stripping, rather than allow-listing, is deliberate. These routes are meant
// to return the whole row, and an allow-list would silently drop any column
// added later — a field that quietly stops reaching the UI is a bug nobody
// reports. The risk of the other direction, a new cost column that nobody
// remembers to strip, is covered by a test that reads schema.prisma and fails
// if this list stops matching it.

export const INTERNAL_COST_FIELDS = [
  'llmModel',
  'llmTurns',
  'llmPromptTokens',
  'llmResponseTokens',
  'llmAudioInTokens',
  'llmAudioOutTokens',
  'llmCostInr',
] as const;

export type InternalCostField = (typeof INTERNAL_COST_FIELDS)[number];

/** One call row, without what it cost us to run. */
export function stripInternalCost<T extends object>(row: T): Omit<T, InternalCostField> {
  const out = { ...row } as Record<string, unknown>;
  for (const f of INTERNAL_COST_FIELDS) delete out[f];
  return out as Omit<T, InternalCostField>;
}

export function stripInternalCostAll<T extends object>(rows: T[]): Omit<T, InternalCostField>[] {
  return rows.map(stripInternalCost);
}
