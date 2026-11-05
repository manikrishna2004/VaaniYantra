import { prisma } from '@/lib/db';
import { retrieveForAgent } from '@/lib/rag/retrieve';
import type { ConnectorTool } from '@/lib/connectors/tools';

// Business knowledge, as a tool the agent calls — not as text pinned to the
// system instruction.
//
// It used to be the latter: at connect time we retrieved six chunks, capped the
// result at 4,000 characters (~1,000 tokens) and folded it into the system
// instruction. Two things were wrong with that, and they compound.
//
// The cost: the system instruction sits OUTSIDE the context-window compression,
// so it is re-sent and re-billed on every single turn for the length of the
// call. A thousand tokens of knowledge on a thirty-turn call is thirty thousand
// billed input tokens, whether or not the caller ever asked a question it could
// answer.
//
// The accuracy: the retrieval query was `agent.description || agent.name` — the
// agent's own self-description, fixed before the phone even rang. It could not
// be the caller's question, because at connect time nobody had asked one. So we
// were paying, every turn, for whichever chunks happened to look like the
// clinic's own name.
//
// As a tool it costs ~90 tokens of declaration, is retrieved against what the
// caller actually said, and the result lands in the compressible window rather
// than the permanent preamble.

/**
 * Trim a chunk to what can be spoken; the model only needs the fact, not the
 * page. The result lands in the compressible window and is re-billed on every
 * turn until it slides out, so it cannot just be the whole chunk.
 *
 * 600 rather than the chunk size: ingest.chunkText targets 900 characters, so
 * what comes back is routinely longer than anything worth reading down a phone
 * line — but 400 cut a listing in half, which for a demo whose whole promise is
 * "never invent a price" is the wrong side of the trade.
 */
const MAX_ANSWER_CHARS = 600;

/**
 * Cut back to the last sentence or line ending inside the cap.
 *
 * A blind slice() cuts mid-token, and the tokens in these documents are prices:
 * "priced at 1.25 crore" clipped one character early becomes "priced at 1.2",
 * and the model reads that out as a fact it was given. A truncated answer is
 * fine; a truncated NUMBER is an invented price, which is the one thing the
 * grounding rules exist to prevent.
 *
 * Only a boundary in the last third counts — one at character 20 would throw
 * away the whole answer to protect it from a number it never contained — and
 * with no boundary at all the hard cap stands, because a wall of text with no
 * punctuation has nowhere better to stop.
 */
function clip(content: string): string {
  if (content.length <= MAX_ANSWER_CHARS) return content;
  const head = content.slice(0, MAX_ANSWER_CHARS);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('\n'));
  return cut > MAX_ANSWER_CHARS * 0.66 ? head.slice(0, cut + 1) : head;
}

export function knowledgeTool(): ConnectorTool {
  return {
    declaration: {
      name: 'knowledge_search',
      description:
        'Look up facts about this business — services, hours, prices, policies, directions, ' +
        'anything specific to it. Use whenever the caller asks something factual you were not told.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: "The caller's question, in their own words.",
          },
        },
        required: ['query'],
      },
    },
    handler: async (args, ctx) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { ok: true, found: false };
      try {
        // Two chunks, not six: this lands in the context window and is re-billed
        // until it compresses away, so it buys its place per turn it survives.
        const chunks = await retrieveForAgent(ctx.agent.id, query, 2);
        if (!chunks.length) {
          // An explicit miss, phrased so the model says so rather than inventing
          // an answer to fill the silence.
          return { ok: true, found: false, message: 'Nothing on file about that. Offer to follow up.' };
        }
        return { ok: true, found: true, answers: chunks.map((c) => clip(c.content)) };
      } catch (err) {
        console.error('[knowledge] lookup failed', err);
        return { ok: false, error: 'The lookup failed. Offer to follow up rather than guessing.' };
      }
    },
  };
}

/**
 * Whether this agent has anything to search. An agent with no linked documents
 * must not carry the declaration at all — an unusable tool is still tokens on
 * every turn, and a model that can see a search tool will eventually call it.
 */
export async function agentHasKnowledge(agentId: string): Promise<boolean> {
  try {
    return (await prisma.agentKnowledge.count({ where: { agentId } })) > 0;
  } catch (err) {
    console.error('[knowledge] could not check linked documents', err);
    return false;
  }
}
