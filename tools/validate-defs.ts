// Validácia data/defs/*.json voči data/schemas/<názov>.schema.json a data/maps/*.json voči data/schemas/map.schema.json
// (JSON Schema draft 2020-12). Spustenie: `pnpm validate:defs` [defsDir schemasDir mapsDir]. Exit 1 pri akejkoľvek chybe.
// Logika je exportovaná ako `validateDefsDir` a `validateMapsDir` (testovateľné bez procesu), CLI sa spustí len pri
// priamom behu súboru. Schéma mapy overuje len štruktúru; vzťahy medzi poľami mapy overuje loader v sime (MapError).
// Katalógové defy (`items: [...]`, ADR-009) majú navyše kontrolu jedinečnosti `id` — JSON Schema ju nevyjadrí.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv';

export const DEFAULT_DEFS_DIR = fileURLToPath(new URL('../data/defs', import.meta.url));
export const DEFAULT_SCHEMAS_DIR = fileURLToPath(new URL('../data/schemas', import.meta.url));
export const DEFAULT_MAPS_DIR = fileURLToPath(new URL('../data/maps', import.meta.url));

const JSON_SUFFIX = '.json';
const SCHEMA_SUFFIX = '.schema.json';
/** Všetky mapy zdieľajú jednu schému, na rozdiel od defov (schéma podľa názvu súboru). */
const MAP_SCHEMA_NAME = `map${SCHEMA_SUFFIX}`;
const MAPS_LABEL_PREFIX = 'maps/';

export interface DefValidationResult {
  /** Názov súboru defu (bez adresára), napr. `time.json`; pri mapách s predponou, napr. `maps/harbor_01.json`. */
  file: string;
  /** Prázdne pole = súbor je platný. Formát chyby: `<file>: <JSON pointer alebo "/"> <správa>`. */
  errors: string[];
}

function describeAjvError(label: string, error: ErrorObject): string {
  let message = error.message ?? 'je neplatné';
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    if (extra !== undefined) message += ` (${extra})`;
  }
  return `${label}: ${error.instancePath || '/'} ${message}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Duplicitné `id` v `items[]` katalógového defu (ADR-009): `<label>: /items/<i>/id duplicitné id 'x' (/items/<j>/id)`.
 * Súbory bez `items` (konfiguračné defy, mapy) a položky bez reťazcového `id` sa preskakujú — tvar hlási schéma.
 */
function findDuplicateIds(label: string, json: unknown): string[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [];
  const items: unknown = (json as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const firstSeen = new Map<string, number>();
  const errors: string[] = [];
  items.forEach((item: unknown, index) => {
    const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') return;
    const first = firstSeen.get(id);
    if (first === undefined) firstSeen.set(id, index);
    else errors.push(`${label}: /items/${String(index)}/id duplicitné id '${id}' (/items/${String(first)}/id)`);
  });
  return errors;
}

/**
 * Overí JSON súbor `filePath` voči schéme `schemaName` z `schemasDir`; `label` je predpona každej chyby.
 * `catalog` zapne kontrolu jedinečnosti `id` v `items[]` (chyby schémy sa hlásia pred duplicitami).
 */
function validateJsonFile(label: string, filePath: string, schemaName: string, schemasDir: string, catalog: boolean): string[] {
  const schemaPath = join(schemasDir, schemaName);
  if (!existsSync(schemaPath)) {
    return [`${label}: / chýba schéma ${schemaName} v ${schemasDir}`];
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (cause) {
    return [`${label}: / neplatný JSON: ${errorMessage(cause)}`];
  }

  try {
    const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
    // Nová inštancia na každý súbor: schémy s rovnakým `$id` sa medzi behmi nezrazia.
    const validate = new Ajv2020({ allErrors: true }).compile(schema as object);
    const duplicates = catalog ? findDuplicateIds(label, json) : [];
    if (validate(json)) return duplicates;
    // Chyby zo subschémy `contains` (jedna na každý nevyhovujúci prvok) sú šum — ostáva len chyba samotného `contains`.
    // Sprievodná chyba `if` („must match "then" schema“) je šum — konkrétne chyby z vetvy `then` ostávajú.
    const schemaErrors = (validate.errors ?? [])
      .filter((error) => !error.schemaPath.includes('/contains/') && error.keyword !== 'if')
      .map((error) => describeAjvError(label, error));
    return [...schemaErrors, ...duplicates];
  } catch (cause) {
    return [`${label}: / neplatná schéma ${schemaName}: ${errorMessage(cause)}`];
  }
}

/**
 * Overí každý `*.json` v `defsDir` voči `<názov>.schema.json` v `schemasDir`.
 * Chýbajúca schéma, nevalidný JSON aj porušenie schémy sú chyby v `errors` (nie výnimky).
 * Výsledky sú zoradené podľa názvu súboru. Výnimku vyhodí iba neexistujúci/nečitateľný `defsDir`.
 */
export function validateDefsDir(defsDir: string, schemasDir: string): DefValidationResult[] {
  return readdirSync(defsDir)
    .filter((name) => name.endsWith(JSON_SUFFIX))
    .sort()
    .map((file) => ({
      file,
      errors: validateJsonFile(file, join(defsDir, file), `${basename(file, JSON_SUFFIX)}${SCHEMA_SUFFIX}`, schemasDir, true),
    }));
}

/**
 * Overí každý `*.json` v `mapsDir` voči `map.schema.json` v `schemasDir`. Rovnaké pravidlá ako `validateDefsDir`,
 * ale `file` (a predpona každej chyby) je `maps/<súbor>`. Výnimku vyhodí iba neexistujúci/nečitateľný `mapsDir`.
 */
export function validateMapsDir(mapsDir: string, schemasDir: string): DefValidationResult[] {
  return readdirSync(mapsDir)
    .filter((name) => name.endsWith(JSON_SUFFIX))
    .sort()
    .map((name) => {
      const file = `${MAPS_LABEL_PREFIX}${name}`;
      return { file, errors: validateJsonFile(file, join(mapsDir, name), MAP_SCHEMA_NAME, schemasDir, false) };
    });
}

function main(argv: readonly string[]): number {
  const defsDir = argv[0] ? resolve(argv[0]) : DEFAULT_DEFS_DIR;
  const schemasDir = argv[1] ? resolve(argv[1]) : DEFAULT_SCHEMAS_DIR;
  const mapsDir = argv[2] ? resolve(argv[2]) : DEFAULT_MAPS_DIR;

  const results: DefValidationResult[] = [];
  for (const [dir, validate] of [
    [defsDir, validateDefsDir],
    [mapsDir, validateMapsDir],
  ] as const) {
    try {
      results.push(...validate(dir, schemasDir));
    } catch (cause) {
      console.error(`validate-defs: nemožno čítať ${dir}: ${errorMessage(cause)}`);
      return 1;
    }
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
    console.error(`validate-defs: ${failed} z ${results.length} súborov (defy a mapy) je neplatných.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
