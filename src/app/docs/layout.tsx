import Link from 'next/link';

// Public documentation section (readable signed-out). Rendered inside the root
// layout; provides its own header + centered content column.
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-display text-lg font-semibold text-ink">
            VaaniYantra
          </Link>
          <nav className="flex items-center gap-5 text-sm text-muted">
            <Link href="/docs" className="hover:text-ink">Docs</Link>
            <Link href="/dashboard" className="hover:text-ink">Dashboard</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
    </div>
  );
}
