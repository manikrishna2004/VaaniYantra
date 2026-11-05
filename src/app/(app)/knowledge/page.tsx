import { PageHeader } from '@/components/ui';
import { KnowledgeManager } from '@/components/KnowledgeManager';

export const dynamic = 'force-dynamic';

export default function KnowledgePage() {
  return (
    <>
      <PageHeader
        title="Knowledge Base"
        subtitle="Upload documents your agents can answer from. Files are chunked and embedded for retrieval."
      />
      <KnowledgeManager />
    </>
  );
}
