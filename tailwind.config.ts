import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // ── Yantra — the agency palette ─────────────────────────────────────
        //
        // Replaces "Ward", the clinical teal scheme built when this was only a
        // clinic receptionist. Two things changed and one did not.
        //
        // WHAT CHANGED. The brand is no longer a medical hue. VaaniYantra now
        // sells into six industries, and a teal that read as "clinic" on every
        // surface was quietly narrowing the product. The brand is a deep
        // indigo — far from every semantic hue, and neutral across trades.
        //
        // The palette also gained a SECOND SURFACE SCALE. Marketing runs on the
        // dark ground (`bg-inverse` and friends), the signed-in app stays
        // light. That is not decoration: an agency's public work should look
        // designed, while a dashboard read all day in a bright room should not
        // be a mirror. Same tokens, two scales, one system — and the dark
        // sidebar is deliberately the bridge between them.
        //
        // WHAT DID NOT CHANGE. **Red still means danger.** The semantic trio
        // below is carried over from Ward untouched, and the brand hue may
        // never enter the red end of the spectrum. Clinics are still a paying
        // vertical, so an allergy banner must never compete with a button.
        //
        // Every value is solved against WCAG, not picked by eye. The ratios are
        // recorded so a future edit can check rather than guess.

        // ── The app scale (light) ───────────────────────────────────────────
        bg: '#f4f6fa', // page — off-white with a cool cast; pure white glares
        surface: '#ffffff', // tiles/cards — the contrast IS the tile
        'surface-2': '#eef2f7', // inputs, subtle fills, table stripes
        border: '#dce3ec', // hairline — grouping and separation
        // Boundaries that must be PERCEIVABLE (inputs, selects, focus rings).
        // WCAG 1.4.11 wants 3:1 for UI components; this clears it against the
        // input fill: 3.22:1 on surface-2.
        'border-strong': '#7a8798',
        muted: '#5d6b7d', // secondary/hint text — 4.76:1 on bg
        ink: '#101828', // primary text, a deep blue-black — 16.1:1 on bg
        'ink-soft': '#3d4b5c', // secondary text — 8.9:1 on bg

        // ── The marketing scale (dark) ──────────────────────────────────────
        //
        // Not a dark MODE — there is no toggle and no `dark:` variant. These
        // are the surfaces the public pages are built on, always. Naming them
        // as tokens rather than hardcoding hexes in Landing.tsx is what keeps
        // one palette instead of two.
        'bg-inverse': '#0a0e17', // the marketing ground
        'surface-inverse': '#121826', // panels and cards on that ground
        'surface-inverse-2': '#0d1220', // alternating bands, code wells
        'border-inverse': 'rgba(255,255,255,0.09)', // hairline on dark
        'border-inverse-strong': 'rgba(255,255,255,0.18)', // outline buttons
        'ink-inverse': '#eef1f7', // primary text on dark — 17.2:1
        'ink-inverse-soft': '#b6c0d0', // lede and body copy — 11.0:1
        'muted-inverse': '#97a3b8', // eyebrows, captions — 7.4:1

        primary: {
          DEFAULT: '#4b3fce', // deep indigo — confident, and nowhere near red
          hover: '#3a2fa8', // darkens on hover, as light-mode UIs should
          soft: 'rgba(75,63,206,0.10)', // active nav + selected states
          // The brand is too dark to read on the marketing ground, so the dark
          // scale gets its own tint rather than a second brand: 6.2:1 on
          // bg-inverse, against 1.4:1 for the base indigo, which would be
          // invisible. Use this ANYWHERE the ground is bg-inverse.
          'on-dark': '#8b7fff',
        },
        // White on the indigo fill scores 7.9:1 — well past AA, with room to
        // spare so the brand can shift a little without breaking.
        'on-primary': '#ffffff',
        accent: '#4b3fce', // aligned to primary; still exactly one accent

        // ── Semantics. These are NOT decorative, and they are unchanged. ────
        // red   = allergy, emergency, cancelled, failed
        // amber = not recorded, needs attention, held, low balance
        // green = confirmed, normal, released, healthy
        // Nothing else may claim red, which is the point of the brand hue.
        danger: '#c5352b', // 5.31:1 on white
        warning: '#b45309', // 5.07:1 on white
        success: '#067647', // 5.69:1 on white

        // ── Per-vertical accents ────────────────────────────────────────────
        //
        // One token per industry, set on the body of each /solutions/[vertical]
        // page. Six identities out of zero new components — a vertical page is
        // the shared layout with a different accent, never a fork of it.
        //
        // Chosen for hue separation from red and from each other, all at
        // comparable lightness so no vertical shouts louder than another. Each
        // pair is <hue> for the light app scale (>= 4.5:1 on surface) and
        // <hue>-dark for the marketing ground (>= 4.5:1 on bg-inverse).
        vertical: {
          healthcare: '#0c6f6a', // the old brand, now one vertical among six
          'healthcare-dark': '#3fbfb8',
          realestate: '#1d5fb8',
          'realestate-dark': '#6fa8ff',
          restaurant: '#8e2f6b',
          'restaurant-dark': '#f2789f',
          education: '#5b3fa8',
          'education-dark': '#a68bff',
          interior: '#4a6b1f',
          'interior-dark': '#9dc361',
          leadscreening: '#0f6b7a',
          'leadscreening-dark': '#4fc3dd',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'sans-serif'],
      },
      // A fixed display scale. Headings were previously ad-hoc — text-2xl here,
      // text-[28px] there, text-xl elsewhere — so pages had no shared rhythm.
      // Each step pairs a size with the line-height and tracking it wants at
      // that size: tighter as the type gets larger.
      fontSize: {
        'display-xl': ['3.25rem', { lineHeight: '1.04', letterSpacing: '-0.03em' }],
        'display-lg': ['2.5rem', { lineHeight: '1.08', letterSpacing: '-0.025em' }],
        'display-md': ['1.75rem', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        'display-sm': ['1.25rem', { lineHeight: '1.25', letterSpacing: '-0.015em' }],
        // Uppercase section labels; needs positive tracking to stay readable.
        eyebrow: ['0.6875rem', { lineHeight: '1', letterSpacing: '0.08em' }],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.25rem',
      },
      // Tile elevation. Two steps only — resting and raised — because a light
      // clinical UI reads best as a flat plane of tiles, and every extra
      // elevation level is another chance for two surfaces to disagree about
      // which is on top. Tinted with the ink hue rather than pure black so the
      // shadow belongs to the palette instead of greying it.
      boxShadow: {
        tile: '0 1px 2px 0 rgba(15,30,43,0.04), 0 1px 3px 0 rgba(15,30,43,0.06)',
        'tile-raised': '0 4px 12px -2px rgba(15,30,43,0.10), 0 2px 6px -2px rgba(15,30,43,0.06)',
      },
      // One motion vocabulary instead of per-component guesses. The standard
      // curve settles quickly without the sluggish tail of ease-in-out.
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '180ms',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
    },
  },
  plugins: [typography],
};

export default config;
