import type { MetadataRoute } from 'next';

// Index the public marketing + docs pages; keep the authed app, APIs and
// invite links out of search engines.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/dashboard',
          '/agents',
          '/calls',
          '/appointments',
          '/knowledge',
          '/numbers',
          '/connectors',
          '/settings',
          '/team',
          '/reports',
          '/live',
          '/admin',
          '/invite/',
          '/patients',
          '/chatbot',
          // Patient chatbots. Never indexable: the pages are per-patient and
          // the links carry a bearer token.
          '/c/',
        ],
      },
    ],
    sitemap: 'https://vaaniyantra.com/sitemap.xml',
  };
}
