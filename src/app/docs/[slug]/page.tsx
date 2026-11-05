import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MarkdownView } from '@/components/MarkdownView';

// Read the Markdown at request time (the docs/ folder ships with the app).
export const dynamic = 'force-dynamic';

const DOCS: Record<string, { file: string; title: string; description: string }> = {
  'user-guide': {
    file: 'USER_GUIDE.md',
    title: 'User Guide',
    description:
      'How to set up VaaniYantra: create an AI voice agent, connect a Twilio or Exotel phone number, upload knowledge, enable appointment booking with WhatsApp confirmations, and manage your plan.',
  },
  'developer-guide': {
    file: 'DEVELOPER_GUIDE.md',
    title: 'Developer Guide',
    description:
      'Build on VaaniYantra: public REST API reference, API-key authentication, webhooks, architecture overview, local development and deployment.',
  },
  'integration-guide': {
    file: 'INTEGRATION_GUIDE.md',
    title: 'Integration Guide',
    description:
      'Connect an existing clinic, hospital or practice-management system to VaaniYantra: push patients and consultations over the v1 API, receive bookings back as signed webhook events, and keep the software you already run.',
  },
};

// Root layout's title template appends "— VaaniYantra".
export async function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const entry = DOCS[params.slug];
  if (!entry) return { title: 'Docs' };
  return { title: entry.title, description: entry.description };
}

export default async function DocPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const entry = DOCS[params.slug];
  if (!entry) notFound();

  let content: string;
  try {
    content = fs.readFileSync(path.join(process.cwd(), 'docs', entry.file), 'utf8');
  } catch {
    notFound();
  }

  return (
    <div>
      <Link href="/docs" className="text-sm text-muted transition hover:text-ink">
        ← All docs
      </Link>
      <div className="mt-6">
        <MarkdownView content={content} />
      </div>
    </div>
  );
}
