import Link from 'next/link';
import { Button } from '@/components/ui';

export const metadata = { title: 'Page not found', robots: { index: false } };

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="text-5xl font-semibold text-ink">404</div>
      <p className="mt-2 text-muted">This page could not be found.</p>
      <Link href="/dashboard" className="mt-6">
        <Button>Back to dashboard</Button>
      </Link>
    </div>
  );
}
