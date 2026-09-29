// Validácia data/defs/*.json voči data/schemas/<názov>.schema.json (JSON Schema draft 2020-12).
// Spustenie: `pnpm validate:defs` [defsDir schemasDir]. Exit 1 pri akejkoľvek chybe.
// Logika je exportovaná ako `validateDefsDir` (testovateľná bez procesu), CLI sa spustí len pri priamom behu súboru.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv';

export const DEFAULT_DEFS_DIR = fileURLToPath(new URL('../data/defs', import.meta.url));
export const DEFAULT_SCHEMAS_DIR = fileURLToPath(new URL('../data/schemas', import.meta.url));

const DEF_SUFFIX = '.json';
const SCHEMA_SUFFIX = '.schema.json';

export interface DefValidationResult {
  /** Názov súboru defu (bez adresára), napr. `time.json`. */
  file: string;
  /** Prázdne pole = def je platný. Formát chyby: `<súbor>: <JSON pointer alebo "/"> <správa>`. */
  errors: string[];
}

function describeAjvError(file: string, error: ErrorObject): string {
  let message = error.message ?? 'je neplatné';
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    if (extra !== undefined) message += ` (${extra})`;
  }
  return `${file}: ${error.instancePath || '/'} ${message}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function validateDefFile(file: string, defsDir: string, schemasDir: string): string[] {
  const schemaName = `${basename(file, DEF_SUFFIX)}${SCHEMA_SUFFIX}`;
  const schemaPath = join(schemasDir, schemaName);
  if (!existsSync(schemaPath)) {
    return [`${file}: / chýba schéma ${schemaName} v ${schemasDir}`];
  }

  let def: unknown;
  try {
    def = JSON.parse(readFileSync(join(defsDir, file), 'utf8'));
  } catch (cause) {
    return [`${file}: / neplatný JSON: ${errorMessage(cause)}`];
  }

  try {
    const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
    // Nová inštancia na každý súbor: schémy s rovnakým `$id` sa medzi behmi nezrazia.
    const validate = new Ajv2020({ allErrors: true }).compile(schema as object);
    if (validate(def)) return [];
    // Chyby zo subschémy `contains` (jedna na každý nevyhovujúci prvok) sú šum — ostáva len chyba samotného `contains`.
    return (validate.errors ?? [])
      .filter((error) => !error.schemaPath.includes('/contains/'))
      .map((error) => describeAjvError(file, error));
  } catch (cause) {
    return [`${file}: / neplatná schéma ${schemaName}: ${errorMessage(cause)}`];
  }
}

/**
 * Overí každý `*.json` v `defsDir` voči `<názov>.schema.json` v `schemasDir`.
 * Chýbajúca schéma, nevalidný JSON aj porušenie schémy sú chyby v `errors` (nie výnimky).
 * Výsledky sú zoradené podľa názvu súboru. Výnimku vyhodí iba neexistujúci/nečitateľný `defsDir`.
 */
export function validateDefsDir(defsDir: string, schemasDir: string): DefValidationResult[] {
  return readdirSync(defsDir)
    .filter((name) => name.endsWith(DEF_SUFFIX))
    .sort()
    .map((file) => ({ file, errors: validateDefFile(file, defsDir, schemasDir) }));
}

function main(argv: readonly string[]): number {
  const defsDir = argv[0] ? resolve(argv[0]) : DEFAULT_DEFS_DIR;
  const schemasDir = argv[1] ? resolve(argv[1]) : DEFAULT_SCHEMAS_DIR;

  let results: DefValidationResult[];
  try {
    results = validateDefsDir(defsDir, schemasDir);
  } catch (cause) {
    console.error(`validate-defs: nemožno čítať ${defsDir}: ${errorMessage(cause)}`);
    return 1;
  }

  let failed = 0;
  for (const { file, errors } of results) {
    if (errors.length === 0) {
      console.log(`OK ${file}`);
      continue;
    }
    failed += 1;
    for (const line of errors) console.error(line);
  }
  if (failed > 0) {
    console.error(`validate-defs: ${failed} z ${results.length} defov je neplatných.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
