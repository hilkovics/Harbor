import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Hranica sim/prezentácia (CLAUDE.md, tvrdé pravidlá 1 a 3; ARCHITECTURE §2).
// Vrstva 1 je kompilátor (src/sim/tsconfig.json: lib ES2023, types []) — chytá DOM/Node globály.
// Vrstva 2 je tento súbor: importy ako ALLOWLIST + zákaz obchvatov nedeterminizmu.
// Bez type-info (projectService) — pravidlá fungujú aj pre `--stdin` súbory, ktoré na disku neexistujú.
// V src/sim sú povolené LEN súbory `.ts` (okrem tsconfig.json); iné prípony (.tsx/.js/.mjs/…) by unikli
// pravidlám, preto ich existenciu zakazuje test tests/tools/sim-boundary.test.ts (T00-17).
const SIM_FILES = ['src/sim/**/*.ts'];

// Globály, ktoré sim nesmie používať: DOM, Node, časovače, nedeterministický čas/náhoda.
// Kompilátor (lib ES2023, types []) ich chytá tiež; toto dáva jasnú správu a chytá aj globály, ktoré ES2023 lib
// pozná, ale sú nedeterministické alebo obchádzajú zákazy (Intl, WeakRef, FinalizationRegistry, SharedArrayBuffer,
// Atomics; eval/Function = vyhodnotenie kódu).
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
  'eval',
  'Function',
  'Intl',
  'WeakRef',
  'FinalizationRegistry',
  'SharedArrayBuffer',
  'Atomics',
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
    files: [`src/sim/${'*/'.repeat(depth)}*.ts`],
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
      // Triple-slash direktívy (`/// <reference lib="dom" />`) by vrátili DOM/Node typy späť do sim.
      '@typescript-eslint/triple-slash-reference': ['error', { lib: 'never', path: 'never', types: 'never' }],
      // Vyhodnotenie kódu z reťazca obchádza všetky statické zákazy.
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      'no-restricted-globals': [
        'error',
        ...SIM_FORBIDDEN_GLOBALS.map((name) => ({
          name,
          message: `src/sim nesmie používať globál \`${name}\` (DOM/Node/čas/eval/Intl…; pravidlá 1 a 3, ARCHITECTURE §2).`,
        })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Nedeterminizmus — použi Rng (xoshiro128**).' },
        { object: 'Date', property: 'now', message: 'Nedeterminizmus — použi SimClock.' },
        { object: 'performance', property: 'now', message: 'Nedeterminizmus — použi SimClock.' },
        // Locale-závislé API (výsledok závisí od prostredia, nie od seedu) — akýkoľvek objekt.
        { property: 'localeCompare', message: 'Nedeterminizmus (locale) — porovnávaj cez `<`/`>` alebo explicitný komparátor.' },
        { property: 'toLocaleString', message: 'Nedeterminizmus (locale) — formátovanie patrí do prezentácie (src/ui).' },
        { property: 'toLocaleDateString', message: 'Nedeterminizmus (locale) — formátovanie patrí do prezentácie (src/ui).' },
        { property: 'toLocaleTimeString', message: 'Nedeterminizmus (locale) — formátovanie patrí do prezentácie (src/ui).' },
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
        // Ambientné deklarácie: `declare global`, `declare const fetch: any` a pod. vrátia zakázané globály späť.
        {
          selector: 'TSModuleDeclaration[global=true]',
          message: '`declare global` rozširuje globálny scope a obchádza zákazy globálov (pravidlá 1 a 3, ARCHITECTURE §2).',
        },
        {
          selector: 'TSModuleDeclaration[declare=true]',
          message: 'Ambientné `declare module/namespace` je v src/sim zakázané (pravidlá 1 a 3, ARCHITECTURE §2).',
        },
        {
          selector: 'VariableDeclaration[declare=true]',
          message: 'Ambientné `declare const/let/var` vyrába falošný globál — v src/sim zakázané (pravidlá 1 a 3).',
        },
        {
          // Iba `declare function`; preťaženia funkcií (signatúry bez tela, `declare` = false) ostávajú povolené.
          selector: 'TSDeclareFunction[declare=true]',
          message: 'Ambientné `declare function` je v src/sim zakázané (pravidlá 1 a 3, ARCHITECTURE §2).',
        },
        {
          selector: 'ClassDeclaration[declare=true]',
          message: 'Ambientné `declare class` je v src/sim zakázané (pravidlá 1 a 3, ARCHITECTURE §2).',
        },
        // Vyhodnotenie kódu cez konštruktor funkcie: `(() => 0).constructor('return this')()`.
        {
          selector: "MemberExpression[property.name='constructor']",
          message: 'Prístup ku `.constructor` umožňuje získať `Function` a vyhodnotiť kód — v src/sim zakázané (pravidlo 3).',
        },
        // Aliasy: `const m = Math; m.random()`, `Reflect.construct(Date, [])`, `Object(Date)`, `getOwnPropertyDescriptor(Math, …)`.
        // Povolené ostáva `Math.max/imul/…` (Math ako objekt člena), `Date` ako typ a `Date.UTC(…)`.
        {
          selector: "Identifier[name='Math']:not(MemberExpression > Identifier.object)",
          message: '`Math` sa smie používať len ako `Math.<člen>` — alias obchádza zákaz `Math.random` (pravidlo 3).',
        },
        {
          selector:
            "Identifier[name='Date']:not(TSTypeReference > Identifier, MemberExpression[property.name='UTC'] > Identifier.object, MemberExpression > Identifier.property, Property > Identifier.key)",
          message: '`Date` je v src/sim povolený len ako typ a `Date.UTC(…)` — alias/konštrukcia obchádza zákaz (pravidlo 3), čas dáva SimClock.',
        },
      ],
    },
  },
]);
