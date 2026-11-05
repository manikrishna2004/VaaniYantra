import Link from 'next/link';
import { Bot, Phone, FileText, Hash } from 'lucide-react';
import { Card, Badge } from '@/components/ui';
import { getLanguage, GEMINI_VOICES } from '@/lib/constants';
import { formatRelativeTime } from '@/lib/utils';

export type AgentCardData = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  language: string;
  direction: string;
  geminiVoice: string | null;
  createdAt: Date;
  _count: { calls: number; knowledgeLinks: number; phoneNumbers: number };
};

export function AgentCard({ agent: a }: { agent: AgentCardData }) {
  const lang = getLanguage(a.language);
  const voice = GEMINI_VOICES.find((g) => g.id === a.geminiVoice)?.label;
  const active = a.status === 'ACTIVE';

  return (
    <Link href={`/agents/${a.id}`} className="group block h-full">
      <Card className="tile-interactive flex h-full flex-col p-5">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/20">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="h-display truncate text-base font-semibold">{a.name}</h3>
            {a.description ? (
              <p className="mt-0.5 line-clamp-1 text-sm text-muted">{a.description}</p>
            ) : (
              <p className="mt-0.5 text-sm text-muted/60">No description</p>
            )}
          </div>
          <Badge tone={active ? 'success' : 'neutral'}>{a.status.toLowerCase()}</Badge>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Badge tone="primary">{lang?.label ?? a.language}</Badge>
          {voice && <Badge tone="neutral">{voice}</Badge>}
          <Badge tone="neutral">{a.direction.toLowerCase()}</Badge>
        </div>

        <div className="mt-auto flex items-center gap-4 border-t border-border pt-3 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{a._count.calls}</span>
          <span className="inline-flex items-center gap-1"><FileText className="h-3.5 w-3.5" />{a._count.knowledgeLinks}</span>
          <span className="inline-flex items-center gap-1"><Hash className="h-3.5 w-3.5" />{a._count.phoneNumbers}</span>
          <span className="ml-auto">{formatRelativeTime(a.createdAt)}</span>
        </div>
      </Card>
    </Link>
  );
}
