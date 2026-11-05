import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// ESLint 9 flat config. Replaces .eslintrc.json, which ESLint 9 no longer reads
// — eslint-config-next@16 requires eslint@>=9, so the two moved together.
//
// eslint-config-next/core-web-vitals already exports a flat-config array, so it
// is spread directly rather than wrapped in FlatCompat.
export default [
  {
    // Flat config has no .eslintignore; ignores live here instead.
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts'],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // Carried over from .eslintrc.json: this project uses <img> deliberately
      // in places where next/image's layout behaviour gets in the way.
      '@next/next/no-img-element': 'off',

      // The React 19 compiler rules below arrived with eslint-config-next@16 and
      // fire on pre-existing, working components — they are new opinions, not
      // newly-introduced bugs. Demoted to warnings so they stay visible without
      // blocking a build, and tracked as debt to pay down deliberately rather
      // than in a framework upgrade:
      //
      //   set-state-in-effect (13) — effects that seed state on mount; correct
      //     today, but they cause an extra render pass.
      //   purity (3) — Date.now() read during render (relative "days left"
      //     labels). Non-deterministic renders can mismatch on hydration.
      //   static-components (2) — a component declared inside another, which
      //     remounts its subtree on every parent render.
      //
      // Fixing these means reworking working UI; doing it here would mix
      // behavioural change into a framework migration.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
    },
  },
];
