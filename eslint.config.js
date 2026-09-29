import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Hranice sim/prezentácia (CLAUDE.md, tvrdé pravidlá 1 a 3; ARCHITECTURE §2).
// Bez type-info (projectService) — pravidlá fungujú aj pre `--stdin` súbory, ktoré na disku neexistujú.
const presentationPatterns = [
  { group: ['pixi.js', 'pixi.js/*'], message: 'src/sim je čistý TS — žiadny Pixi (ARCHITECTURE §2).' },
  { group: ['react', 'react/*', 'react-dom', 'react-dom/*'], message: 'src/sim je čistý TS — žiadny React (ARCHITECTURE §2).' },
  { group: ['@render', '@render/*'], message: 'src/sim nesmie importovať z src/render.' },
  { group: ['@ui', '@ui/*'], message: 'src/sim nesmie importovať z src/ui.' },
  { group: ['@app', '@app/*'], message: 'src/sim nesmie importovať z src/app.' },
  {
    group: ['**/src/render', '**/src/render/**', '../**/render', '../**/render/**'],
    message: 'src/sim nesmie importovať z src/render (ani relatívnou cestou).',
  },
  {
    group: ['**/src/ui', '**/src/ui/**', '../**/ui', '../**/ui/**'],
    message: 'src/sim nesmie importovať z src/ui (ani relatívnou cestou).',
  },
  {
    group: ['**/src/app', '**/src/app/**', '../**/app', '../**/app/**'],
    message: 'src/sim nesmie importovať z src/app (ani relatívnou cestou).',
  },
];

export default defineConfig([
  {
    ignores: [
      '.claude/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
      'tests/e2e/__screenshots__/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/sim/**'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['*.{js,ts}', 'tools/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Sim core: bez DOM/Pixi/React a bez nedeterminizmu (Math.random, Date.now, performance.now).
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: presentationPatterns }],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/sim nesmie používať DOM (window).' },
        { name: 'document', message: 'src/sim nesmie používať DOM (document).' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Nedeterminizmus — použi Rng (xoshiro128**).' },
        { object: 'Date', property: 'now', message: 'Nedeterminizmus — použi SimClock.' },
        { object: 'performance', property: 'now', message: 'Nedeterminizmus — použi SimClock.' },
      ],
    },
  },
]);
