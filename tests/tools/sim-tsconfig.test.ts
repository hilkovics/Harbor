import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Regresný test vrstvy 1 hranice src/sim (CLAUDE.md, pravidlá 1 a 3; ARCHITECTURE §2; re-review T00-15).
// src/sim/tsconfig.json musí kompilátoru zakázať DOM/Node typy: každý DOM/Node globál je v src/sim chyba
// kompilácie. Test (a) číta konfiguráciu, (b) spustí `tsc --noEmit -p` nad fixtúrou v dočasnom adresári
// MIMO repozitára, ktorá `extends` src/sim/tsconfig.json — do src/sim sa nezapisuje nič.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SIM_TSCONFIG = join(ROOT, 'src', 'sim', 'tsconfig.json');
const TSC_TIMEOUT_MS = 60_000;

/** DOM-podobné lib súbory (lib.dom.d.ts, lib.dom.iterable.d.ts, lib.webworker*.d.ts, lib.scripthost.d.ts). */
const HOST_LIB = /(^|[./\\])lib\.(dom|webworker|scripthost)/i;

describe('src/sim/tsconfig.json — konfigurácia', () => {
  const raw = ts.readConfigFile(SIM_TSCONFIG, ts.sys.readFile);
  const rawOptions = (raw.config?.compilerOptions ?? {}) as { lib?: string[]; types?: string[] };

  it('súbor sa dá prečítať bez chýb', () => {
    expect(raw.error).toBeUndefined();
  });

  it('lib je zadaný explicitne a neobsahuje DOM*/WebWorker/ScriptHost', () => {
    expect(Array.isArray(rawOptions.lib)).toBe(true);
    expect(rawOptions.lib?.length).toBeGreaterThan(0);
    for (const lib of rawOptions.lib ?? []) expect(lib).not.toMatch(/^(dom|webworker|scripthost)/i);
  });

  it('types je prázdne pole (žiadne @types/node ani vite/client)', () => {
    expect(rawOptions.types).toEqual([]);
  });

  it('po rozbalení `extends` platí to isté (lib bez DOM, types [])', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      SIM_TSCONFIG,
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    expect(parsed).toBeDefined();
    expect(parsed?.errors ?? []).toEqual([]);
    const options = parsed?.options;
    expect(options?.types).toEqual([]);
    expect(options?.lib?.length).toBeGreaterThan(0);
    for (const lib of options?.lib ?? []) expect(lib).not.toMatch(HOST_LIB);
    // include pokrýva len src/sim (žiadny súbor mimo)
    const simDir = join(ROOT, 'src', 'sim').split('\\').join('/');
    expect(parsed?.fileNames.length).toBeGreaterThan(0);
    for (const f of parsed?.fileNames ?? []) expect(f.split('\\').join('/').startsWith(`${simDir}/`)).toBe(true);
  });
});

describe('src/sim/tsconfig.json — tsc nad fixtúrou', () => {
  /** Globály z T00-15/T00-17: každý musí byť v src/sim chyba kompilácie „Cannot find name“. */
  const LEAKS: { name: string; code: string; ident: string }[] = [
    { name: 'window', code: 'export const x = window;', ident: 'window' },
    { name: 'document.title', code: 'export const x = document.title;', ident: 'document' },
    { name: 'self', code: 'export const x = self;', ident: 'self' },
    { name: 'localStorage', code: 'export const x = localStorage;', ident: 'localStorage' },
    { name: 'navigator.userAgent', code: 'export const x = navigator.userAgent;', ident: 'navigator' },
    { name: 'setTimeout', code: 'export const x = setTimeout(() => 0, 1);', ident: 'setTimeout' },
    { name: 'process.hrtime()', code: 'export const x = process.hrtime();', ident: 'process' },
    { name: 'crypto.randomUUID()', code: 'export const x = crypto.randomUUID();', ident: 'crypto' },
    { name: 'structuredClone', code: 'export const x = structuredClone({});', ident: 'structuredClone' },
    { name: 'console.log', code: 'export const x = console.log(1);', ident: 'console' },
    { name: 'fetch', code: 'export const x = fetch;', ident: 'fetch' },
  ];

  let tmp = '';
  let output = '';
  let status: number | null = null;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sim-tsconfig-'));
    const dir = join(tmp, 'fixture');
    mkdirSync(dir);
    // pozitívna kontrola: čistý ES2023 kód sa musí skompilovať
    writeFileSync(join(dir, 'ok.ts'), 'export const x: number = Math.max(1, [1, 2].at(-1) ?? 0);\n');
    // Node modul bez @types/node → TS2307 (importy sú navyše strážené ESLint allowlistom)
    writeFileSync(join(dir, 'node-import.ts'), "import 'node:fs';\nexport const x = 1;\n");
    LEAKS.forEach((l, i) => writeFileSync(join(dir, `leak-${i}.ts`), `${l.code}\n`));
    writeFileSync(
      join(tmp, 'tsconfig.json'),
      JSON.stringify({
        extends: SIM_TSCONFIG.split('\\').join('/'),
        compilerOptions: { noEmit: true },
        include: ['./fixture/*.ts'],
      }),
    );

    const tscBin = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const run = spawnSync(process.execPath, [tscBin, '--noEmit', '--pretty', 'false', '-p', join(tmp, 'tsconfig.json')], {
      cwd: tmp,
      encoding: 'utf8',
      timeout: TSC_TIMEOUT_MS,
    });
    status = run.status;
    output = `${run.stdout}${run.stderr}`;
  }, TSC_TIMEOUT_MS);

  afterAll(() => {
    if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  });

  it('tsc skončí s chybou (exit 1/2 = diagnostiky, nie pád konfigurácie)', () => {
    expect([1, 2], output).toContain(status);
    // konfigurácia sa našla a rozbalila: žiadna chyba typu TS5xxx (config) ani TS6xxx
    expect(output).not.toMatch(/error TS[56]\d{3}/);
  });

  it('pozitívna kontrola: čistý ES2023 súbor nemá chybu', () => {
    expect(output).not.toMatch(/ok\.ts\(\d+,\d+\)/);
  });

  it('import node:fs je chyba kompilácie', () => {
    expect(output).toMatch(/node-import\.ts\(\d+,\d+\): error TS2307/);
  });

  it.each(LEAKS.map((l, i) => ({ ...l, i })))('DOM/Node globál je chyba kompilácie: $name', ({ i, ident }) => {
    const re = new RegExp(`leak-${i}\\.ts\\(\\d+,\\d+\\): error TS\\d+: Cannot find name '${ident}'`);
    expect(output).toMatch(re);
  });
});
