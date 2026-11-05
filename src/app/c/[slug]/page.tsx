import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { prisma } from '@/lib/db';
import { PatientPortal } from '@/components/PatientPortal';

export const dynamic = 'force-dynamic';

// A clinic's patient chatbot, reached from the link in an appointment
// confirmation. Public in the sense that it is outside the dashboard's auth —
// but everything personal behind it needs the patient's bearer token, which the
// client component exchanges for a cookie on arrival.

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const portal = await prisma.portal.findUnique({ where: { slug }, select: { name: true } });
  return {
    // Bare title: the root layout template appends "— VaaniYantra".
    title: portal?.name ?? 'Patient assistant',
    // These pages are per-patient and must never reach a search index.
    robots: { index: false, follow: false },
  };
}

export default async function PortalPage({ params }: Props) {
  const { slug } = await params;
  const portal = await prisma.portal.findUnique({
    where: { slug },
    select: { name: true, greeting: true, enabled: true },
  });
  if (!portal || !portal.enabled) notFound();

  return <PatientPortal slug={slug} name={portal.name} greeting={portal.greeting} />;
}
