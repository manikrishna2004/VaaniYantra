// The languages page — the differentiator no American voice vendor has.
//
// Every language name and count on this page is RENDERED FROM
// src/lib/constants.ts, never typed by hand. constants.ts:640 carries the scar
// that made that rule: marketing copy had claimed more locales than were ever
// configured, and the counts were moved into code so "marketing text can never
// outrun LANGUAGES again". A page that lists languages is exactly where that
// would happen next.

import Link from 'next/link';
import { LANGUAGES, INDIAN_LANGUAGES, INDIAN_LANGUAGE_COUNT } from '@/lib/constants';

export const metadata = {
  title: 'Languages',
  description: `The languages VaaniYantra answers your clinic's phone in — ${INDIAN_LANGUAGE_COUNT} Indian languages plus the English-and-local mix patients actually speak, picked from the caller's own number with no menu.`,
  alternates: { canonical: '/languages' },
};

export default function LanguagesPage() {
  const otherLocales = LANGUAGES.filter((l) => !l.code.endsWith('-IN'));

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-ink">The languages it answers in</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-soft">
        {INDIAN_LANGUAGE_COUNT} Indian languages and {LANGUAGES.length} locales in total — picked from the
        caller&rsquo;s own number, with no menu and no &ldquo;press 2 for Hindi&rdquo;.
      </p>

      <section className="mt-10 space-y-6 text-sm leading-relaxed text-ink-soft">
        <h2 className="text-lg font-medium text-ink">The hard part was never the answering</h2>
        <p>
          It was the language. Callers in India do not speak one language per sentence. They speak Telugu
          with English medical terms dropped in, or Hindi with an English department name, and they switch
          mid-clause without noticing. Most speech stacks make you pick a locale before the call starts,
          which is a decision nobody can make correctly on the caller&rsquo;s behalf.
        </p>
        <p>
          VaaniYantra detects the language from the number that is ringing and speaks it back, including
          that mix. You can also pin an agent to one language, or run it in a deliberate hybrid mode where
          it always answers in English-plus-local.
        </p>

        <h2 className="text-lg font-medium text-ink">Indian languages</h2>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {INDIAN_LANGUAGES.map((l) => (
            <li key={l.code} className="text-ink">
              {l.label}
              {l.nativeLabel && l.nativeLabel !== l.label ? (
                <span className="ml-2 text-muted">{l.nativeLabel}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <p>
          Each one ships with more than one voice, so a paediatric clinic and a cardiology department do
          not have to sound like the same person.
        </p>

        <h2 className="text-lg font-medium text-ink">Beyond India</h2>
        <p>
          The same engine covers another {otherLocales.length} locales, which is what makes it work for a
          Gulf clinic needing Arabic, Hindi, Malayalam and Tagalog on one line, or a practice that simply
          has patients who do not share a first language.
        </p>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {otherLocales.map((l) => (
            <li key={l.code} className="text-ink">
              {l.label}
            </li>
          ))}
        </ul>

        <h2 className="text-lg font-medium text-ink">What the language setting does not change</h2>
        <p>
          The safety path runs before the model, in every language it supports: a deterministic check for
          chest pain, breathlessness, severe bleeding, overdose, self-harm and stroke signs — including
          transliterated spellings — that stops the conversation and tells the caller to ring 108 or 112.
          It never gives medical advice in any language.
        </p>
      </section>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/solutions/healthcare"
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
        >
          How it answers your clinic&rsquo;s phone
        </Link>
        <Link
          href="/"
          className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-ink hover:bg-surface-2"
        >
          Pricing and how it works
        </Link>
      </div>
    </main>
  );
}
