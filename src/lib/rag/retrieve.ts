import { prisma } from '@/lib/db';
import { cosineSimilarity, embed } from './embeddings';
import { agentGeminiKey } from '@/lib/agent-gemini';

export type RetrievedChunk = {
  content: string;
  score: number;
  documentId: string;
};

// Retrieve the top-K most relevant chunks across the documents linked to an
// agent. Uses in-memory cosine similarity over stored embeddings — fine for the
// MVP's document volume; swap to pgvector / a vector DB for scale.
export async function retrieveForAgent(
  agentId: string,
  query: string,
  topK = 4,
): Promise<RetrievedChunk[]> {
  const links = await prisma.agentKnowledge.findMany({
    where: { agentId },
    select: { documentId: true },
  });
  // An agent with its own Gemini key embeds its queries with that key too, so a
  // demo agent never touches the platform key on any leg of a call.
  const own = await prisma.agent
    .findUnique({ where: { id: agentId }, select: { geminiApiKey: true } })
    .catch(() => null);
  const documentIds = links.map((l) => l.documentId);
  if (documentIds.length === 0) return [];

  const chunks = await prisma.documentChunk.findMany({
    where: { documentId: { in: documentIds } },
    select: { content: true, embedding: true, documentId: true },
  });
  if (chunks.length === 0) return [];

  const queryVec = await embed(query, agentGeminiKey(own));

  const scored = chunks
    .map((c) => {
      const vec = parseEmbedding(c.embedding);
      return {
        content: c.content,
        documentId: c.documentId,
        score: vec ? cosineSimilarity(queryVec, vec) : 0,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    // Drop near-zero matches so we don't inject noise into the prompt.
    .filter((c) => c.score > 0.05);

  return scored;
}

// Embeddings are persisted as a JSON-encoded number[] string.
function parseEmbedding(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? (arr as number[]) : null;
  } catch {
    return null;
  }
}

// Format retrieved chunks as a compact "Knowledge:" block appended to the
// agent's system instruction.
export function formatKnowledgeBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  const body = chunks
    .map((c, i) => `[${i + 1}] ${c.content}`)
    .join('\n\n')
    .slice(0, 4000);
  return `\n\nUse the following knowledge base to answer the caller. Only state facts supported by it; if it doesn't cover the question, say you'll follow up.\n\nKnowledge:\n${body}`;
}
