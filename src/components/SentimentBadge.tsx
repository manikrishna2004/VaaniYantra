import { Badge } from '@/components/ui';

const MAP: Record<string, { tone: 'success' | 'neutral' | 'danger'; label: string }> = {
  POSITIVE: { tone: 'success', label: 'Positive' },
  NEUTRAL: { tone: 'neutral', label: 'Neutral' },
  NEGATIVE: { tone: 'danger', label: 'Negative' },
};

export function SentimentBadge({ sentiment }: { sentiment?: string | null }) {
  if (!sentiment) return null;
  const m = MAP[sentiment] ?? MAP.NEUTRAL;
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
