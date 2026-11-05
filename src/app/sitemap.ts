import type { MetadataRoute } from 'next';
import { solutionSlugs } from '@/lib/verticals/solutions';

const BASE = 'https://vaaniyantra.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },

    // Marketing pages. Ranked above the docs and well above the legal pages:
    // until these existed the whole domain had exactly one page that answered a
    // question anyone types into a search engine, and 8 of the 14 URLs here were
    // legal boilerplate.
    //
    // Derived from the solutions table rather than listed by hand — a seventh
    // industry should appear here by existing, not by someone remembering to
    // add a line. The two old hand-built clinic pages are gone from this list
    // because they now 308 to /solutions/healthcare (see next.config.js), and a
    // sitemap that lists a redirect is telling search engines to re-crawl a
    // page that no longer exists.
    { url: `${BASE}/solutions`, lastModified: now, changeFrequency: 'monthly', priority: 0.9 },
    ...solutionSlugs().map((slug) => ({
      url: `${BASE}/solutions/${slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),
    { url: `${BASE}/languages`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },

    // The Starter Kit is the one page on this domain a developer searches for
    // by name rather than by problem, and the only one sold to strangers who
    // never speak to us — so it ranks with the solutions pages, not the docs.
    { url: `${BASE}/kit`, lastModified: now, changeFrequency: 'monthly', priority: 0.9 },

    { url: `${BASE}/docs`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${BASE}/docs/user-guide`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${BASE}/docs/developer-guide`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    // The only way in while sign-up is invite-only, and the target of every CTA
    // on the site — so it now ranks above the sign-up page it replaced.
    { url: `${BASE}/contact`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${BASE}/sign-in`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/security`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/refunds`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/dpa`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/subprocessors`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE}/patient-notice`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
