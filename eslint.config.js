import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Hranica sim/prezentácia (CLAUDE.md, tvrdé pravidlá 1 a 3; ARCHITECTURE §2).
// Vrstva 1 je kompilátor (src/sim/tsconfig.json: lib ES2023, types []) — chytá DOM/Node globály.
// Vrstva 2 je tento súbor: importy ako ALLOWLIST + zákaz obchvatov nedeterminizmu.
// Bez type-info (projectService) — pravidlá fungujú aj pre `--stdin` súbory, ktoré na disku neexistujú.
const SIM_FILES = ['src/sim/**/*.{ts,tsx,mts,cts,js,mjs}'];

// Globály, ktoré sim nesmie používať: DOM, Node, časovače, nedeterministický čas/náhoda.
// Kompilátor (lib ES2023, types []) ich chytá v .ts; toto pokrýva aj .js/.mjs a dáva jasnú správu.
const SIM_FORBIDDEN_GLOBALS = [
  'window',
  'document',
  'self',
  'navigator',
  'localStorage',
  'sessionStorage',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'process',
  'crypto',
  'performance',
  'console',
  'structuredClone',
  'require',
];

// Konkrétne správy pre najčastejšie porušenia (idú pred allowlistom, aby hlásenie bolo výstižné).
const presentationPatterns = [
  { group: ['pixi.js', 'pixi.js/*'], message: 'src/sim je čistý TS — žiadny Pixi (ARCHITECTURE §2).' },
  { group: ['react', 'react/*', 'react-dom', 'react-dom/*'], message: 'src/sim je čistý TS — žiadny React (ARCHITECTURE §2).' },
  { group: ['@render', '@render/*'], message: 'src/sim nesmie importovať z src/render.' },
  { group: ['@ui', '@ui/*'], message: 'src/sim nesmie importovať z src/ui.' },
  { group: ['@app', '@app/*'], message: 'src/sim nesmie importovať z src/app.' },
];

// Segment cesty: neprázdny, bez `/`, a nie `.` ani `..` (traverzia sa v strede cesty nepripúšťa).
const SEG = '(?!\\.{1,2}(?:/|$))[^/]+';
const PATH = `${SEG}(?:/${SEG})*`;

// Regex na import, ktorý NIE JE povolený (negatívny lookahead nad celým reťazcom = allowlist).
// Povolené: `@sim/…`, `@data/…` a relatívne cesty, ktoré s `maxUps` krokmi `../` neopustia src/sim.
// `maxUps` = hĺbka súboru pod src/sim (src/sim/x.ts = 0, src/sim/core/x.ts = 1, …); ESLint regex nepozná
// polohu súboru, preto sa pravidlo generuje pre každú hĺbku zvlášť (viď `simBoundaryBlocks`).
function disallowedImportRegex(maxUps) {
  const allowed = [`@sim/${PATH}`, `@data/${PATH}`, `\\./${PATH}`, '\\.'];
  if (maxUps > 0) {
    allowed.push(`(?:\\.\\./){1,${maxUps}}${PATH}`); // ../x, ../../x (najviac maxUps krokov)
    allowed.push(`\\.\\.(?:/\\.\\.){0,${maxUps - 1}}`); // .., ../.. (index rodiča)
  }
  return `^(?!(?:${allowed.join('|')})$)`;
}

const simImportRule = (maxUps) => [
  'error',
  {
    patterns: [
      ...presentationPatterns,
      {
        regex: disallowedImportRegex(maxUps),
        caseSensitive: true,
        message:
          'src/sim smie importovať len `@sim/…`, `@data/…` a relatívne cesty, ktoré neopustia src/sim ' +
          '(žiadne npm balíky ani `node:*`, ARCHITECTURE §2).',
      },
    ],
  },
];

// Súbor v hĺbke > MAX_SIM_DEPTH dostane MAX_SIM_DEPTH krokov `../` — nikdy nemôže opustiť src/sim,
// len sa z hlbokých modulov musí na vzdialenejšie súbory odkazovať cez `@sim/…`.
const MAX_SIM_DEPTH = 5;

// Základný blok (najmenej prísny, pre najhlbšie súbory) + prísnejšie bloky pre hĺbky 0…MAX_SIM_DEPTH-1
// (neskorší blok prepíše pravidlo). `*/` v glob-e nikdy nepresahuje hranicu adresára → zhoda je presne na hĺbku.
const simBoundaryBlocks = [
  { files: SIM_FILES, rules: { 'no-restricted-imports': simImportRule(MAX_SIM_DEPTH) } },
  ...Array.from({ length: MAX_SIM_DEPTH }, (_, depth) => ({
    files: [`src/sim/${'*/'.repeat(depth)}*.{ts,tsx,mts,cts,js,mjs}`],
    rules: { 'no-restricted-imports': simImportRule(depth) },
  })),
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
  ...simBoundaryBlocks,
  {
    // Sim core: bez DOM/Node/Pixi/React a bez nedeterminizmu (Math.random, Date, performance.now).
    files: SIM_FILES,
    rules: {
      'no-restricted-globals': [
        'error',
        ...SIM_FORBIDDEN_GLOBALS.map((name) => ({
          name,
          message: `src/sim nesmie používať globál \`${name}\` (DOM/Node/čas; pravidlá 1 a 3, ARCHITECTURE §2).`,
        })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Nedeterminizmus — použi Rng (xoshiro128**).' },
        { object: 'Date', property: 'now', message: 'Nedeterminizmus — použi SimClock.' },
        { object: 'performance', property: 'now', message: 'Nedeterminizmus — použi SimClock.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Nedeterminizmus (pravidlo 3) — `new Date(…)` je v src/sim zakázané, čas dáva SimClock.',
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: 'Nedeterminizmus (pravidlo 3) — `Date(…)` je v src/sim zakázané, čas dáva SimClock.',
        },
        {
          // Širšie než len `globalThis.x` — zachytí aj alias `const g = globalThis`.
          selector: "Identifier[name='globalThis']",
          message: '`globalThis` obchádza zákazy globálov a nedeterminizmu (pravidlo 3, ARCHITECTURE §2).',
        },
        {
          selector: 'ImportExpression',
          message: 'Dynamický `import()` obchádza allowlist importov — v src/sim použi statický `import` (ARCHITECTURE §2).',
        },
        {
          selector: 'TSImportType',
          message: 'Typový import `import("…")` obchádza allowlist importov — použi `import type` (ARCHITECTURE §2).',
        },
        {
          selector: 'TSImportEqualsDeclaration[moduleReference.type="TSExternalModuleReference"]',
          message: '`import x = require("…")` obchádza allowlist importov — použi štandardný `import` (ARCHITECTURE §2).',
        },
      ],
    },
  },
]);
