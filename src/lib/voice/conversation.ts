import { prisma } from '@/lib/db';
import { getLlmProvider, type ChatMessage } from '@/lib/adapters/llm';
import { retrieveForAgent, formatKnowledgeBlock } from '@/lib/rag/retrieve';
import { languageStyleInstruction } from '@/lib/constants';
import { applyVariables, fallbackInstruction } from '@/lib/agent-behavior';
import type { Agent } from '@prisma/client';

// Core conversational turn — shared by the realtime voice-server and the mock
// simulator. Given the agent, the conversation so far, and the latest caller
// utterance, it: (1) retrieves relevant knowledge, (2) streams a reply from the
// LLM, (3) returns the full reply text. Callers handle TTS + persistence.

export type TurnInput = {
  agent: Agent;
  history: ChatMessage[]; // prior turns, role "user" = caller, "model" = agent
  callerText: string;
  // Effective language for this call. Differs from agent.language when the agent
  // uses "auto" language picking (resolved from the caller's location).
  language?: string;
};

export async function generateAgentTurn(
  input: TurnInput,
  onDelta?: (delta: string) => void,
): Promise<string> {
  const { agent, history, callerText } = input;
  const language = input.language ?? agent.language;

  // 1. RAG: pull knowledge relevant to what the caller just said.
  const chunks = await retrieveForAgent(agent.id, callerText, 4);
  const knowledge = formatKnowledgeBlock(chunks);

  const systemInstruction =
    applyVariables(agent.systemPrompt, agent.variables) +
    knowledge +
    languageStyleInstruction(agent.languageMode, language) +
    fallbackInstruction(agent.fallbackMessage);

  // 2. Stream the reply so TTS can begin before generation finishes.
  const llm = getLlmProvider();
  const messages: ChatMessage[] = [...history, { role: 'user', text: callerText }];

  let full = '';
  for await (const delta of llm.stream({
    systemInstruction,
    history: messages,
    temperature: agent.temperature,
    languageCode: language,
    maxOutputTokens: 256,
  })) {
    full += delta;
    onDelta?.(delta);
  }
  return full.trim();
}

// Low-latency variant for live calls: streams the reply and invokes onSentence
// the moment each sentence is complete, so TTS/playback can start while the
// model is still generating the rest. Returns the full reply text.
export async function generateAgentTurnStreaming(
  input: TurnInput,
  onSentence: (sentence: string) => Promise<void> | void,
  // Cooperative cancellation — checked between deltas. Returns true to abort
  // (e.g. the caller interrupted / barged in).
  shouldStop?: () => boolean,
): Promise<string> {
  const { agent, history, callerText } = input;
  const language = input.language ?? agent.language;

  const chunks = await retrieveForAgent(agent.id, callerText, 4);
  const knowledge = formatKnowledgeBlock(chunks);
  // Force short, speakable replies — this is a phone call, not a chat.
  const voiceStyle =
    '\n\nThis is a live phone call. Reply in one or two short, natural spoken sentences. No lists, markdown, code, or emojis.';
  const systemInstruction =
    applyVariables(agent.systemPrompt, agent.variables) +
    knowledge +
    voiceStyle +
    languageStyleInstruction(agent.languageMode, language) +
    fallbackInstruction(agent.fallbackMessage);

  const llm = getLlmProvider();
  const messages: ChatMessage[] = [...history, { role: 'user', text: callerText }];

  let full = '';
  let buf = '';
  const flush = async (s: string) => {
    const t = s.trim();
    if (t) await onSentence(t);
  };

  for await (const delta of llm.stream({
    systemInstruction,
    history: messages,
    temperature: agent.temperature,
    languageCode: language,
    maxOutputTokens: 200,
  })) {
    if (shouldStop?.()) return full.trim(); // caller interrupted — stop generating
    full += delta;
    buf += delta;
    // Emit complete sentences as soon as a terminator appears.
    let idx = sentenceEnd(buf);
    while (idx !== -1) {
      await flush(buf.slice(0, idx + 1));
      buf = buf.slice(idx + 1);
      idx = sentenceEnd(buf);
    }
  }
  if (shouldStop?.()) return full.trim();
  await flush(buf); // remainder
  return full.trim();
}

// Index of the first sentence-terminating char (handles English + Devanagari
// danda). Returns -1 if none.
function sentenceEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '.' || c === '!' || c === '?' || c === '।' || c === '\n') return i;
  }
  return -1;
}

// Persist a single transcript turn to the call.
export async function recordTurn(
  callId: string,
  role: 'CALLER' | 'AGENT' | 'SYSTEM',
  text: string,
  atMs: number,
): Promise<void> {
  await prisma.transcriptTurn.create({
    data: { callId, role, text, atMs },
  });
}

export type CallAnalysis = {
  summary: string;
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  sentimentScore: number; // -1..1
  topics: string[];
};

// Analyze a finished call in a single LLM pass: a 1-2 sentence summary, the
// caller's overall sentiment, and the key topics. Persists the sentiment/topics
// onto the Call and returns the summary (callers persist the summary alongside
// their own status update).
export async function summarizeCall(callId: string): Promise<string> {
  const analysis = await analyzeCall(callId);
  await prisma.call
    .update({
      where: { id: callId },
      data: {
        sentiment: analysis.sentiment,
        sentimentScore: analysis.sentimentScore,
        topics: analysis.topics,
      },
    })
    .catch((err) => console.error('[analysis] persist failed', err));
  return analysis.summary;
}

export async function analyzeCall(callId: string): Promise<CallAnalysis> {
  const turns = await prisma.transcriptTurn.findMany({
    where: { callId },
    orderBy: { atMs: 'asc' },
  });
  if (turns.length === 0) {
    return { summary: 'No conversation recorded.', sentiment: 'NEUTRAL', sentimentScore: 0, topics: [] };
  }

  const transcript = turns
    .map((t) => `${t.role === 'AGENT' ? 'Agent' : t.role === 'CALLER' ? 'Caller' : 'System'}: ${t.text}`)
    .join('\n');

  const llm = getLlmProvider();
  let raw = '';
  try {
    raw = await llm.generate({
      systemInstruction:
        'You analyze finished phone calls. Respond with ONLY a JSON object, no markdown, of the shape ' +
        '{"summary": string (1-2 sentences, caller intent + outcome), ' +
        '"sentiment": "POSITIVE"|"NEUTRAL"|"NEGATIVE" (the CALLER\'s overall sentiment), ' +
        '"sentimentScore": number from -1 to 1, ' +
        '"topics": string[] (up to 5 short topic keywords)}.',
      history: [{ role: 'user', text: `Analyze this call:\n\n${transcript}` }],
      temperature: 0.2,
      maxOutputTokens: 260,
    });
  } catch (err) {
    console.error('[analysis] llm failed', err);
    return { summary: 'Summary unavailable.', sentiment: 'NEUTRAL', sentimentScore: 0, topics: [] };
  }

  return parseAnalysis(raw);
}

function parseAnalysis(raw: string): CallAnalysis {
  const fallback: CallAnalysis = {
    summary: raw.trim().slice(0, 400) || 'Summary unavailable.',
    sentiment: 'NEUTRAL',
    sentimentScore: 0,
    topics: [],
  };
  // Strip markdown fences and isolate the JSON object if the model added prose.
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return fallback;

  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const sentimentRaw = String(obj.sentiment ?? '').toUpperCase();
    const sentiment: CallAnalysis['sentiment'] =
      sentimentRaw === 'POSITIVE' || sentimentRaw === 'NEGATIVE' ? sentimentRaw : 'NEUTRAL';
    let score = Number(obj.sentimentScore);
    if (!Number.isFinite(score)) score = sentiment === 'POSITIVE' ? 0.5 : sentiment === 'NEGATIVE' ? -0.5 : 0;
    score = Math.max(-1, Math.min(1, score));
    const topics = Array.isArray(obj.topics)
      ? obj.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 5)
      : [];
    const summary = String(obj.summary ?? '').trim() || fallback.summary;
    return { summary: summary.slice(0, 600), sentiment, sentimentScore: score, topics };
  } catch {
    return fallback;
  }
}
