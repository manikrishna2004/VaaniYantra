import { Reveal } from '@/components/landing/motion';

/**
 * Shared furniture for the landing page's eleven sections.
 *
 * Exists so section headings are not hand-rolled eleven times with slightly
 * different margins — which is how a page ends up looking almost-aligned. Kept
 * server-rendered (no 'use client') so the copy stays in the HTML for SEO.
 */

export function SectionHead({
  eyebrow,
  title,
  lead,
  center = false,
}: {
  eyebrow?: string;
  title: string;
  lead?: string;
  center?: boolean;
}) {
  return (
    <Reveal className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      {eyebrow && (
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">{eyebrow}</p>
      )}
      <h2 className="h-display mt-2 text-3xl font-semibold sm:text-4xl">{title}</h2>
      {lead && <p className="mt-3 text-ink-soft">{lead}</p>}
    </Reveal>
  );
}

/**
 * A full-bleed alternating band.
 *
 * `tone="raised"` is the tinted stripe used to separate adjacent sections. With
 * a light palette the page is otherwise one continuous sheet and every section
 * boundary disappears — this is what gives the page rhythm.
 */
export function Band({
  id,
  tone = 'plain',
  children,
  className = '',
}: {
  id?: string;
  tone?: 'plain' | 'raised';
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`${id ? 'scroll-mt-20 ' : ''}${
        tone === 'raised' ? 'border-y border-border bg-surface-2/60' : ''
      } ${className}`}
    >
      <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8">{children}</div>
    </section>
  );
}

/** A plain feature tile — the page's most repeated unit. */
export function Tile({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="tile-interactive h-full rounded-2xl border border-border bg-surface p-5 shadow-tile">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/20">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{children}</p>
    </div>
  );
}
