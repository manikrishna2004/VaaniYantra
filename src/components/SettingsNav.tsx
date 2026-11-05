'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border">
      {items.map((it) => {
        const active = pathname === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm transition',
              active
                ? 'border-primary text-ink'
                : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
