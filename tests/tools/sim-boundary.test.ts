import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Regresný test hranice src/sim (CLAUDE.md, pravidlá 1 a 3; ARCHITECTURE §2; nález T00-12 #1).
// Vrstva 2 (ESLint) sa testuje cez Node API nad reálnym eslint.config.js. Vrstvu 1 (src/sim/tsconfig.json)
// kontroluje `pnpm typecheck` — tsc sondy sú v acceptance karty T00-15.

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
  // DOM / Node globály (pravidlo 1; kompilátor ich chytá tiež, ESLint pokrýva aj .js/.mjs)
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
  // Iné prípony v src/sim sa lintujú rovnako
  { name: '.js: new Date()', code: 'export const a = new Date();', rule: 'no-restricted-syntax', file: 'src/sim/core/probe.js' },
  { name: ".mjs: import 'lodash'", code: "import x from 'lodash';\nexport const a = x;", rule: 'no-restricted-imports', file: 'src/sim/core/probe.mjs' },
  { name: '.mts: globalThis', code: 'export const a = globalThis.Math;', rule: 'no-restricted-syntax', file: 'src/sim/core/probe.mts' },
  { name: '.tsx: document', code: 'export const a = document.title;', rule: 'no-restricted-globals', file: 'src/sim/core/probe.tsx' },
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
  { name: '.js: relatívny import', code: "import { x } from './x.js';\nexport const a = x;", file: 'src/sim/core/probe.js' },
];

describe('hranica src/sim — ESLint allowlist a zákazy (T00-15)', () => {
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
      { name: "src/render: import 'pixi.js'", code: "import { Sprite } from 'pixi.js';\nexport const a = Sprite;", file: 'src/render/probe.ts' },
      { name: "src/app: import '@sim/core'", code: "import { x } from '@sim/core';\nexport const a = x;", file: 'src/app/probe.ts' },
      { name: "tools: import 'node:fs' + console", code: "import fs from 'node:fs';\nconsole.log(fs);", file: 'tools/probe.ts' },
      { name: 'tests: Date.now()', code: 'export const a = Date.now();', file: 'tests/probe.test.ts' },
    ];

    it.each(OUTSIDE)('bez chýb z hranice: $name', async ({ code, file }) => {
      const rules = await errorRules(code, file);
      expect(rules.filter((r) => r.startsWith('no-restricted-'))).toEqual([]);
    });
  });
});
