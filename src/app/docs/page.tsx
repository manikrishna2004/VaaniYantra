import Link from 'next/link';
import { BookOpen, Code2, Plug } from 'lucide-react';

// Root layout's title template appends "— VaaniYantra".
export const metadata = {
  title: 'Documentation',
  description:
    'Guides for using and building on VaaniYantra — create AI voice agents, connect Twilio or Exotel numbers, manage knowledge and appointments, and integrate via the REST API and webhooks.',
};

const GUIDES = [
  {
    href: '/docs/user-guide',
    icon: BookOpen,
    title: 'User Guide',
    desc: 'Get started, create AI agents, connect phone numbers (Twilio & Exotel), knowledge base, connectors, appointments, and billing.',
  },
  {
    href: '/docs/developer-guide',
    icon: Code2,
    title: 'Developer Guide',
    desc: 'The public REST API, API-key authentication, webhooks, plus architecture, local development, and deployment.',
  },
  {
    href: '/docs/integration-guide',
    icon: Plug,
    title: 'Integration Guide',
    desc: 'Connect an existing clinic or hospital system: push patients and prescriptions in, receive bookings back as signed events. Keep the software you already run.',
  },
];

export default function DocsIndex() {
  return (
    <div>
      <h1 className="font-display text-3xl font-semibold text-ink">Documentation</h1>
      <p className="mt-2 text-muted">Guides for using and building on VaaniYantra.</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {GUIDES.map((g) => (
          <Link
            key={g.href}
            href={g.href}
            className="group rounded-2xl border border-border bg-surface p-6 transition hover:border-primary/60"
          >
            <g.icon className="h-6 w-6 text-primary" />
            <h2 className="mt-3 text-lg font-semibold text-ink">{g.title}</h2>
            <p className="mt-1 text-sm text-muted">{g.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
