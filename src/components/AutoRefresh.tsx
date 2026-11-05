'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Refreshes the current server component on an interval while `active` is true.
// Used on the call-detail page so a simulated/live call's transcript streams in.
export function AutoRefresh({ active, intervalMs = 2000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}
