// Embeddings for the knowledge base.
//
// When USE_MOCK_LLM is on (default), a deterministic local embedding is used —
// a lightweight hashed bag-of-words projected into a fixed-size vector. It has
// no external dependency and gives "good enough" semantic-ish retrieval for the
// MVP. With USE_MOCK_LLM=false it uses Google's text-embedding model.

const DIM = 256;

// `apiKey` overrides the platform key for this embedding — used so an agent
// with its own Gemini key (demo accounts) bills that key for retrieval too.
// Ignored unless USE_GOOGLE_EMBEDDINGS=true, where the local embedder runs.
export async function embed(text: string, apiKey?: string): Promise<number[]> {
  // Default to the local embedder — no API/quota dependency, so ingestion always
  // succeeds (the Google embedding API otherwise 429s on a free-tier key and the
  // whole document is marked FAILED with no chunks). Opt into Google embeddings
  // with USE_GOOGLE_EMBEDDINGS=true (paid tier); fall back to local on failure so
  // query/chunk dimensions stay consistent and ingestion never breaks.
  if (process.env.USE_GOOGLE_EMBEDDINGS === 'true') {
    try {
      return await googleEmbed(text, apiKey);
    } catch (err) {
      console.warn('[rag] google embed failed, using local embedder:', (err as Error).message);
    }
  }
  return mockEmbed(text);
}

export async function embedBatch(texts: string[], apiKey?: string): Promise<number[][]> {
  return Promise.all(texts.map((t) => embed(t, apiKey)));
}

// Hash each token into a bucket and accumulate; then L2-normalize.
function mockEmbed(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ൿ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const tok of tokens) {
    const h = hash(tok) % DIM;
    vec[h] += 1;
    // Bigram-ish smear into a second bucket for a bit more signal.
    vec[(h * 31 + 7) % DIM] += 0.5;
  }
  return normalize(vec);
}

async function googleEmbed(text: string, overrideKey?: string): Promise<number[]> {
  const apiKey = overrideKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY required for embeddings when USE_MOCK_LLM=false');
  const model = 'text-embedding-004';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    },
  );
  const data = (await res.json()) as any;
  const values = data?.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error('Google embedding failed: ' + JSON.stringify(data).slice(0, 200));
  }
  return values;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
