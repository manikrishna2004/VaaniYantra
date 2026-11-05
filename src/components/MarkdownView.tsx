'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';

// Cross-links in the .md files point at sibling files; map them to app routes.
const LINK_MAP: Record<string, string> = {
  './USER_GUIDE.md': '/docs/user-guide',
  './DEVELOPER_GUIDE.md': '/docs/developer-guide',
  './README.md': '/docs',
  './docs/USER_GUIDE.md': '/docs/user-guide',
  './docs/DEVELOPER_GUIDE.md': '/docs/developer-guide',
};

export function MarkdownView({ content }: { content: string }) {
  return (
    // NOT prose-invert. That variant hard-codes near-white body text for a dark
    // background, and it survived the move to the light "Ward" palette — so the
    // docs rendered white-on-off-white and were effectively unreadable. Every
    // colour below is pinned to a palette token instead of Typography's default
    // greys, so the text follows the theme rather than a leftover assumption.
    <article
      className="prose max-w-none
        prose-headings:font-display prose-headings:scroll-mt-24 prose-headings:text-ink
        prose-p:text-ink-soft prose-li:text-ink-soft prose-td:text-ink-soft
        prose-a:text-primary prose-a:no-underline hover:prose-a:underline
        prose-strong:text-ink
        prose-code:rounded prose-code:bg-surface-2 prose-code:px-1.5 prose-code:py-0.5
        prose-code:text-ink prose-code:before:content-[''] prose-code:after:content-['']
        prose-pre:border prose-pre:border-border prose-pre:bg-surface-2 prose-pre:text-ink
        prose-blockquote:border-l-border prose-blockquote:text-muted
        prose-th:text-ink prose-thead:border-border prose-tr:border-border
        prose-hr:border-border"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const mapped = href && LINK_MAP[href] ? LINK_MAP[href] : href ?? '#';
            const internal = mapped.startsWith('/') || mapped.startsWith('#');
            return internal ? (
              <Link href={mapped}>{children}</Link>
            ) : (
              <a href={mapped} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
