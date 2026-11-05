import type { Metadata } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import './globals.css';
import { INDIAN_LANGUAGE_COUNT } from '@/lib/constants';

// Body font: Inter (neutral, legible). Display font: Space Grotesk (distinctive
// technical grotesk) for headings + metrics — a clear two-font system.
const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const display = Space_Grotesk({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display' });

const SITE_URL = 'https://vaaniyantra.com';
const TITLE = 'VaaniYantra — AI Automations Agency';
const DESCRIPTION =
  `We build AI voice agents and back-office automations for one business at a time, then host, meter and support them — in our cloud or inside yours. Healthcare, real estate, restaurants, education, interior design, and lead screening for any business. ${INDIAN_LANGUAGE_COUNT} Indian languages, billed per minute from a balance you top up.`;

// NOTE: the Open Graph image is NOT declared here. It comes from the file
// convention at src/app/opengraph-image.tsx, which Next renders to a 1200x630
// card and injects as og:image / twitter:image automatically. Declaring
// openGraph.images in this object would override that route — leave it alone.

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: '%s — VaaniYantra',
  },
  description: DESCRIPTION,
  applicationName: 'VaaniYantra',
  // Broadened off the clinic-only set when the product became an agency. The
  // healthcare terms stay — they are the only ones this domain has ever ranked
  // for, and healthcare is still one of the six verticals we sell.
  keywords: [
    'AI automation agency',
    'AI voice agent for business',
    'AI call answering service India',
    'AI receptionist for clinics',
    'AI call answering for real estate',
    'AI phone agent for restaurants',
    'AI lead qualification',
    'AI appointment booking',
    'Hinglish voice bot',
    'Tanglish voice bot',
    'AI phone agent Indian languages',
    'Twilio Exotel AI agent',
  ],
  category: 'technology',
  alternates: { canonical: './' },
  verification: {
    // Google Search Console. Optional and env-driven: DNS TXT verification is
    // preferred (it does not wait on a ~1h build), so this is the fallback for
    // verifying by HTML tag. Unset = the tag is simply omitted.
    google: process.env.GOOGLE_SITE_VERIFICATION,
    // Meta Business Manager domain verification (WhatsApp Tech Provider).
    other: { 'facebook-domain-verification': ['4kzfh5pwlr3mh7537agptc8712fzwm'] },
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'VaaniYantra',
    title: TITLE,
    description: DESCRIPTION,
    locale: 'en_IN',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
