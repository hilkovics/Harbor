import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Regresný test hranice src/sim (CLAUDE.md, pravidlá 1 a 3; ARCHITECTURE §2; nálezy T00-12 #1, re-review T00-15).
// Vrstva 2 (ESLint) sa testuje cez Node API nad reálnym eslint.config.js. Vrstvu 1 (src/sim/tsconfig.json)
// testuje tests/tools/sim-tsconfig.test.ts (tsc nad fixtúrou) a kontroluje `pnpm typecheck`.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SIM_FILE = 'src/sim/core/probe.ts';

let eslint: ESLint;

/** Vráti ruleId všetkých chýb (severity 2); parse chyba (bez ruleId) zhodí test, aby sonda nepadla „z nesprávneho dôvodu“. */
async function errorRules(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  const errors = result.messages.filter((m) => m.severity === 2);
  const fatal = errors.filter((m) => m.ruleId === null);
  expect(fatal, `parse chyba v sonde: ${fatal.map((m) => m.message).join('; ')}`).toEqual([]);
  return errors.map((m) => m.ruleId as string);
}

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT });
  await eslint.lintText('export const warmup = 1;\n', { filePath: SIM_FILE }); // načíta konfiguráciu a parser
}, 30_000);

interface Violation {
  name: string;
  code: string;
  rule: string;
  file?: string;
}

const VIOLATIONS: Violation[] = [
  // Obchvaty nedeterminizmu (pravidlo 3)
  { name: 'new Date()', code: 'export const a = new Date();', rule: 'no-restricted-syntax' },
  { name: 'new Date(0)', code: 'export const a = new Date(0);', rule: 'no-restricted-syntax' },
  { name: 'Date()', code: 'export const a = Date();', rule: 'no-restricted-syntax' },
  { name: 'Date.now()', code: 'export const a = Date.now();', rule: 'no-restricted-properties' },
  { name: 'Math.random()', code: 'export const a = Math.random();', rule: 'no-restricted-properties' },
  { name: 'performance.now()', code: 'export const a = performance.now();', rule: 'no-restricted-properties' },
  { name: 'globalThis.Math.random()', code: 'export const a = globalThis.Math.random();', rule: 'no-restricted-syntax' },
  { name: 'globalThis.window', code: 'export const a = globalThis.window;', rule: 'no-restricted-syntax' },
  { name: 'alias const g = globalThis', code: 'const g = globalThis;\nexport const a = g;', rule: 'no-restricted-syntax' },
  // DOM / Node globály (pravidlo 1; kompilátor ich chytá tiež, ESLint dáva jasnú správu)
  { name: 'window', code: 'export const a = window;', rule: 'no-restricted-globals' },
  { name: 'document.title', code: 'export const a = document.title;', rule: 'no-restricted-globals' },
  { name: 'self', code: 'export const a = self;', rule: 'no-restricted-globals' },
  { name: 'localStorage', code: 'export const a = localStorage;', rule: 'no-restricted-globals' },
  { name: 'navigator.userAgent', code: 'export const a = navigator.userAgent;', rule: 'no-restricted-globals' },
  { name: 'setTimeout', code: 'setTimeout(() => 0, 1);\nexport const a = 1;', rule: 'no-restricted-globals' },
  { name: 'process.hrtime()', code: 'export const a = process.hrtime();', rule: 'no-restricted-globals' },
  { name: 'crypto.randomUUID()', code: 'export const a = crypto.randomUUID();', rule: 'no-restricted-globals' },
  { name: 'structuredClone', code: 'export const a = structuredClone({});', rule: 'no-restricted-globals' },
  { name: 'console.log', code: 'console.log(1);\nexport const a = 1;', rule: 'no-restricted-globals' },
  // Importy: allowlist
  { name: "import 'node:fs'", code: "import 'node:fs';", rule: 'no-restricted-imports' },
  { name: "import fs from 'node:fs'", code: "import fs from 'node:fs';\nexport const a = fs;", rule: 'no-restricted-imports' },
  { name: "import fs from 'fs'", code: "import fs from 'fs';\nexport const a = fs;", rule: 'no-restricted-imports' },
  { name: "import x from 'lodash'", code: "import x from 'lodash';\nexport const a = x;", rule: 'no-restricted-imports' },
  { name: "import 'lodash/fp'", code: "import x from 'lodash/fp';\nexport const a = x;", rule: 'no-restricted-imports' },
  { name: "import 'react'", code: "import { useState } from 'react';\nexport const a = useState;", rule: 'no-restricted-imports' },
  { name: "import type z 'react'", code: "import type { FC } from 'react';\nexport type A = FC;", rule: 'no-restricted-imports' },
  { name: "import 'pixi.js'", code: "import { Sprite } from 'pixi.js';\nexport const a = Sprite;", rule: 'no-restricted-imports' },
  { name: "import '@render/x'", code: "import '@render/x';", rule: 'no-restricted-imports' },
  { name: "import '@ui/x'", code: "import '@ui/x';", rule: 'no-restricted-imports' },
  { name: "import '@app/x'", code: "import '@app/x';", rule: 'no-restricted-imports' },
  { name: "import '@sim/../render/x'", code: "import '@sim/../render/x';", rule: 'no-restricted-imports' },
  { name: "import '@data/../src/x'", code: "import '@data/../src/x';", rule: 'no-restricted-imports' },
  { name: "import '../../render/x' (únik zo src/sim)", code: "import '../../render/x';", rule: 'no-restricted-imports' },
  { name: "import '../../../ui/x'", code: "import '../../../ui/x';", rule: 'no-restricted-imports' },
  { name: "import '../core/../../render/x' (traverzia v strede)", code: "import '../core/../../render/x';", rule: 'no-restricted-imports' },
  { name: "import './../../render/x'", code: "import './../../render/x';", rule: 'no-restricted-imports' },
  { name: "import '../..' (koreň mimo sim)", code: "import * as m from '../..';\nexport const a = m;", rule: 'no-restricted-imports' },
  { name: "import '/abs/path'", code: "import '/abs/path';", rule: 'no-restricted-imports' },
  { name: "import 'https://cdn/x.js'", code: "import 'https://cdn/x.js';", rule: 'no-restricted-imports' },
  { name: "import('lodash') (dynamický)", code: "export const a = import('lodash');", rule: 'no-restricted-syntax' },
  { name: "export * from 'node:fs'", code: "export * from 'node:fs';", rule: 'no-restricted-imports' },
  { name: "export { x } from 'lodash'", code: "export { x } from 'lodash';", rule: 'no-restricted-imports' },
  { name: "type T = import('react').FC", code: "export type T = import('react').FC;", rule: 'no-restricted-syntax' },
  { name: "import fs = require('fs')", code: "import fs = require('fs');\nexport const a = fs;", rule: 'no-restricted-syntax' },
  // Hĺbka súboru: relatívny únik sa posudzuje podľa polohy súboru
  { name: "src/sim/x.ts: '../render/x'", code: "import '../render/x';", rule: 'no-restricted-imports', file: 'src/sim/x.ts' },
  { name: "src/sim/x.ts: '..'", code: "import * as m from '..';\nexport const a = m;", rule: 'no-restricted-imports', file: 'src/sim/x.ts' },
  {
    name: "src/sim/modules/storage/x.ts: '../../../render/x'",
    code: "import '../../../render/x';",
    rule: 'no-restricted-imports',
    file: 'src/sim/modules/storage/x.ts',
  },
  {
    name: 'src/sim/a/b/c/d/e/f/g/x.ts: 8 krokov ../',
    code: "import '../../../../../../../../render/x';",
    rule: 'no-restricted-imports',
    file: 'src/sim/a/b/c/d/e/f/g/x.ts',
  },
  // Triple-slash direktívy (T00-17 #1)
  { name: '/// <reference lib="dom" />', code: '/// <reference lib="dom" />\nexport const a = 1;', rule: '@typescript-eslint/triple-slash-reference' },
  { name: '/// <reference types="node" />', code: '/// <reference types="node" />\nexport const a = 1;', rule: '@typescript-eslint/triple-slash-reference' },
  { name: '/// <reference path="./x.d.ts" />', code: '/// <reference path="./x.d.ts" />\nexport const a = 1;', rule: '@typescript-eslint/triple-slash-reference' },
  // Ambientné deklarácie (T00-17 #1)
  { name: 'declare global { var x }', code: 'declare global { var x: number }\nexport {};', rule: 'no-restricted-syntax' },
  { name: 'declare module "x"', code: "declare module 'x' {\n  export const y: number;\n}\nexport {};", rule: 'no-restricted-syntax' },
  { name: 'declare namespace N', code: 'declare namespace N {\n  const y: number;\n}\nexport {};', rule: 'no-restricted-syntax' },
  { name: 'declare const fetch: any', code: 'declare const fetch: unknown;\nexport const a = fetch;', rule: 'no-restricted-syntax' },
  { name: 'declare var x', code: 'declare var x: number;\nexport const a = x;', rule: 'no-restricted-syntax' },
  { name: 'declare let x', code: 'declare let x: number;\nexport const a = x;', rule: 'no-restricted-syntax' },
  { name: 'declare function f()', code: 'declare function f(): number;\nexport const a = f();', rule: 'no-restricted-syntax' },
  { name: 'declare function g(): void', code: 'declare function g(): void;\nexport const a = 1;', rule: 'no-restricted-syntax' },
  { name: 'export declare function f()', code: 'export declare function f(): number;', rule: 'no-restricted-syntax' },
  { name: 'declare class C', code: 'declare class C {}\nexport const a = C;', rule: 'no-restricted-syntax' },
  // Vyhodnotenie kódu (T00-17 #2)
  { name: "eval('1')", code: "export const a = eval('1');", rule: 'no-eval' },
  { name: "eval('1') (globál)", code: "export const a = eval('1');", rule: 'no-restricted-globals' },
  { name: "Function('return this')()", code: "export const a = Function('return this')();", rule: 'no-new-func' },
  { name: "new Function('return 1')", code: "export const a = new Function('return 1');", rule: 'no-new-func' },
  { name: 'Function (globál)', code: "export const a = new Function('return 1');", rule: 'no-restricted-globals' },
  // `no-implied-eval` je tu len doplnok: setTimeout nie je v sim definovaný ako globál, takže ho pravidlo nevidí;
  // reťazec do časovača zastaví `no-restricted-globals` (setTimeout je zakázaný globál).
  { name: "setTimeout('code', 1) (implied eval)", code: "setTimeout('1', 1);\nexport const a = 1;", rule: 'no-restricted-globals' },
  { name: ".constructor('return this')()", code: "export const a = (() => 0).constructor('return this')();", rule: 'no-restricted-syntax' },
  { name: '(async () => 0).constructor', code: 'export const a = (async () => 0).constructor;', rule: 'no-restricted-syntax' },
  // Aliasy Math/Date (T00-17 #3)
  { name: 'const m = Math; m.random()', code: 'const m = Math;\nexport const a = m.random();', rule: 'no-restricted-syntax' },
  { name: 'const { random } = Math', code: 'const { random } = Math;\nexport const a = random();', rule: 'no-restricted-syntax' },
  { name: 'const D = Date; new D()', code: 'const D = Date;\nexport const a = new D();', rule: 'no-restricted-syntax' },
  { name: 'const { now } = Date', code: 'const { now } = Date;\nexport const a = now();', rule: 'no-restricted-syntax' },
  { name: 'Reflect.construct(Date, [])', code: 'export const a = Reflect.construct(Date, []);', rule: 'no-restricted-syntax' },
  { name: 'Object(Date)', code: 'export const a = Object(Date);', rule: 'no-restricted-syntax' },
  { name: "Object.getOwnPropertyDescriptor(Math, 'random')", code: "export const a = Object.getOwnPropertyDescriptor(Math, 'random');", rule: 'no-restricted-syntax' },
  { name: 'export { Date as D }', code: 'export { Date as D };', rule: 'no-restricted-syntax' },
  // Nedeterministické API (T00-17 #4)
  { name: 'new Intl.DateTimeFormat()', code: 'export const a = new Intl.DateTimeFormat();', rule: 'no-restricted-globals' },
  { name: 'new WeakRef({})', code: 'export const a = new WeakRef({});', rule: 'no-restricted-globals' },
  { name: 'new FinalizationRegistry', code: 'export const a = new FinalizationRegistry(() => undefined);', rule: 'no-restricted-globals' },
  { name: 'new SharedArrayBuffer(8)', code: 'export const a = new SharedArrayBuffer(8);', rule: 'no-restricted-globals' },
  { name: 'Atomics.add', code: 'export const a = Atomics.add(new Int32Array(1), 0, 1);', rule: 'no-restricted-globals' },
  { name: "'a'.localeCompare('b')", code: "export const a = 'a'.localeCompare('b');", rule: 'no-restricted-properties' },
  { name: '(1).toLocaleString()', code: 'export const a = (1).toLocaleString();', rule: 'no-restricted-properties' },
  { name: 'x.toLocaleDateString()', code: 'export const f = (x: { toLocaleDateString(): string }) => x.toLocaleDateString();', rule: 'no-restricted-properties' },
  { name: 'x.toLocaleTimeString()', code: 'export const f = (x: { toLocaleTimeString(): string }) => x.toLocaleTimeString();', rule: 'no-restricted-properties' },
  // Inline konfigurácia a umlčanie kompilátora (T00-18): noInlineConfig → komentár nemá efekt, pôvodné pravidlo hlási chybu.
  { name: 'eslint-disable-next-line nad Math.random()', code: '// eslint-disable-next-line no-restricted-properties\nexport const a = Math.random();', rule: 'no-restricted-properties' },
  { name: '/* eslint-disable */ nad Math.random()', code: '/* eslint-disable */\nexport const a = Math.random();', rule: 'no-restricted-properties' },
  { name: '/* eslint no-restricted-syntax: off */ nad new Date()', code: '/* eslint no-restricted-syntax: off */\nexport const a = new Date();', rule: 'no-restricted-syntax' },
  { name: "@ts-expect-error nad fetch('x')", code: "// @ts-expect-error fetch nie je v sim typoch\nexport const a = fetch('x');", rule: '@typescript-eslint/ban-ts-comment' },
  { name: '@ts-ignore', code: '// @ts-ignore\nexport const a: number = 1;', rule: '@typescript-eslint/ban-ts-comment' },
  { name: 'fetch (globál)', code: "export const a = fetch('x');", rule: 'no-restricted-globals' },
  { name: 'queueMicrotask', code: 'queueMicrotask(() => undefined);\nexport const a = 1;', rule: 'no-restricted-globals' },
  { name: 'declare enum', code: 'declare enum E { A }\nexport type T = E;', rule: 'no-restricted-syntax' },
];

interface Allowed {
  name: string;
  code: string;
  file?: string;
}

const ALLOWED: Allowed[] = [
  { name: 'bežný kód (Map, Set, Math, Error, JSON)', code: 'const m = new Map<number, number>();\nexport const a = [m.size, new Set([1]).size, Math.max(1, 2), JSON.stringify({}), new Error("x")];' },
  { name: 'Date ako typ', code: 'export function f(d: Date | null): number {\n  return d === null ? 0 : 1;\n}' },
  { name: 'Date.UTC (deterministické)', code: 'export const a = Date.UTC(2000, 0, 1);' },
  { name: 'Date.UTC s premennými', code: 'export const f = (y: number) => Date.UTC(y, 0, 1);' },
  { name: "./x", code: "import { x } from './x';\nexport const a = x;" },
  { name: "./sub/x", code: "import { x } from './sub/x';\nexport const a = x;" },
  { name: "../defs", code: "import { x } from '../defs';\nexport const a = x;" },
  { name: "../defs/types", code: "import type { X } from '../defs/types';\nexport type A = X;" },
  { name: "'..' (index rodiča)", code: "import * as m from '..';\nexport const a = m;" },
  { name: "'.' (index adresára)", code: "import * as m from '.';\nexport const a = m;" },
  { name: "export * from './rng'", code: "export * from './rng';" },
  { name: "@sim/core", code: "import { x } from '@sim/core';\nexport const a = x;" },
  { name: "@sim/core/rng", code: "import { x } from '@sim/core/rng';\nexport const a = x;" },
  { name: "@data/defs/time.json", code: "import t from '@data/defs/time.json';\nexport const a = t;" },
  { name: "import type z @sim", code: "import type { X } from '@sim/defs';\nexport type A = X;" },
  { name: "src/sim/x.ts: './core'", code: "import { x } from './core';\nexport const a = x;", file: 'src/sim/x.ts' },
  {
    name: "src/sim/modules/storage/x.ts: '../../core'",
    code: "import { x } from '../../core';\nexport const a = x;",
    file: 'src/sim/modules/storage/x.ts',
  },
  {
    name: "src/sim/modules/storage/x.ts: '..'",
    code: "import * as m from '..';\nexport const a = m;",
    file: 'src/sim/modules/storage/x.ts',
  },
  {
    name: 'src/sim/a/b/c/d/e/f/g/x.ts: 5 krokov ../ (max)',
    code: "import { x } from '../../../../../core';\nexport const a = x;",
    file: 'src/sim/a/b/c/d/e/f/g/x.ts',
  },
  { name: 'Math.max', code: 'export const a = Math.max(1, 2);' },
  { name: 'Math.imul', code: 'export const a = Math.imul(1, 2);' },
  { name: 'Math.floor + Math.PI', code: 'export const a = Math.floor(Math.PI);' },
  { name: 'Date v poli/generiku ako typ', code: 'export const a: Date[] = [];\nexport const b: Array<Date> = [];\nexport const c: Readonly<{ at: Date }> | null = null;' },
  { name: 'trieda s konštruktorom (kľúč `constructor` nie je člen)', code: 'export class A {\n  private readonly n: number;\n  constructor(n: number) {\n    this.n = n;\n  }\n}' },
  {
    name: 'preťaženia funkcie (overload signatures)',
    code: 'export function f(x: number): number;\nexport function f(x: string): string;\nexport function f(x: number | string) {\n  return x;\n}',
  },
  { name: 'kľúč objektu Date', code: 'export const a = { Date: 1 };' },
  { name: 'enum', code: 'export enum E {\n  A,\n  B,\n}' },
  { name: 'const enum', code: 'export const enum F {\n  B = 1,\n}' },
];

describe('hranica src/sim — ESLint allowlist a zákazy (T00-15, T00-17)', () => {
  it.each(VIOLATIONS)('chyba: $name', async ({ code, rule, file }) => {
    const rules = await errorRules(code, file ?? SIM_FILE);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules).toContain(rule);
  });

  it.each(ALLOWED)('bez chyby: $name', async ({ code, file }) => {
    expect(await errorRules(code, file ?? SIM_FILE)).toEqual([]);
  });

  describe('mimo src/sim sa pravidlá hranice neaplikujú', () => {
    const OUTSIDE: { name: string; code: string; file: string }[] = [
      { name: 'src/ui: document + new Date()', code: 'export const a = document.title;\nexport const d = new Date();', file: 'src/ui/probe.tsx' },
      { name: 'src/ui: Date/Math alias + Intl + localeCompare', code: "const D = Date;\nconst M = Math;\nexport const a = [new D(), M.random(), new Intl.NumberFormat(), 'a'.localeCompare('b')];", file: 'src/ui/probe.tsx' },
      { name: 'src/ui: eval + Function + .constructor', code: "export const a = [eval('1'), Function('return 1')(), (() => 0).constructor];", file: 'src/ui/probe.tsx' },
      { name: 'src/ui: declare global + declare const', code: 'declare global { var x: number }\ndeclare const y: number;\nexport const a = y;', file: 'src/ui/probe.ts' },
      { name: 'src/ui: /// <reference lib="dom" />', code: '/// <reference lib="dom" />\nexport const a = 1;', file: 'src/ui/probe.ts' },
      { name: "src/render: import 'pixi.js'", code: "import { Sprite } from 'pixi.js';\nexport const a = Sprite;", file: 'src/render/probe.ts' },
      { name: "src/app: import '@sim/core'", code: "import { x } from '@sim/core';\nexport const a = x;", file: 'src/app/probe.ts' },
      { name: "tools: import 'node:fs' + console", code: "import fs from 'node:fs';\nconsole.log(fs);", file: 'tools/probe.ts' },
      { name: 'tests: Date.now()', code: 'export const a = Date.now();', file: 'tests/probe.test.ts' },
    ];

    /** Pravidlá, ktoré platia výlučne pre src/sim (triple-slash mimo simu ostáva na predvolenej konfigurácii). */
    const SIM_ONLY = /^(no-restricted-|no-eval$|no-new-func$|no-implied-eval$|@typescript-eslint\/triple-slash-reference$)/;

    it.each(OUTSIDE)('bez chýb z hranice: $name', async ({ code, file }) => {
      const rules = await errorRules(code, file);
      expect(rules.filter((r) => SIM_ONLY.test(r))).toEqual([]);
    });
  });
});

// V src/sim sú povolené len súbory `.ts` (+ tsconfig.json v koreni). Sim ESLint bloky pokrývajú iba `src/sim/**/*.ts`,
// takže súbor `.tsx/.js/.mjs/.cts/.mts` by potichu unikol pravidlám hranice (T00-17 #5).
/** Vráti cesty (relatívne k src/sim, oddeľovač `/`), ktoré v src/sim nesmú existovať. */
function forbiddenSimFiles(relPaths: string[]): string[] {
  return relPaths.filter((p) => !(p.endsWith('.ts') || p === 'tsconfig.json'));
}

/** Rekurzívne zoznam súborov (nie adresárov) pod `dir`, relatívne k `base`, s oddeľovačom `/`. */
function listFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

describe('src/sim obsahuje len súbory .ts (T00-17)', () => {
  const SIM_DIR = join(ROOT, 'src', 'sim');

  it('detektor označí iné prípony než .ts', () => {
    const files = ['a.ts', 'core/b.ts', 'core/c.d.ts', 'tsconfig.json', 'x.tsx', 'core/y.js', 'z.mjs', 'w.cts', 'v.mts', 'data.json', 'core/tsconfig.json', '.gitkeep', 'README.md'];
    expect(forbiddenSimFiles(files)).toEqual(['x.tsx', 'core/y.js', 'z.mjs', 'w.cts', 'v.mts', 'data.json', 'core/tsconfig.json', '.gitkeep', 'README.md']);
  });

  it('v src/sim/** nie je iný súbor než .ts (okrem tsconfig.json)', () => {
    const files = listFiles(SIM_DIR, SIM_DIR);
    expect(files.length).toBeGreaterThan(0); // sanity: zoznam nie je prázdny kvôli zlej ceste
    expect(forbiddenSimFiles(files)).toEqual([]);
  });
});
