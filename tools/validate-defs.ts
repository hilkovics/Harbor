// Validácia data/defs/*.json voči data/schemas/<názov>.schema.json, data/maps/*.json voči data/schemas/map.schema.json
// a assets/manifest.json voči data/schemas/asset-manifest.schema.json (JSON Schema draft 2020-12).
// Spustenie: `pnpm validate:defs` [defsDir schemasDir mapsDir manifestPath]. Exit 1 pri akejkoľvek chybe.
// Logika je exportovaná ako `validateDefsDir`, `validateMapsDir` a `validateAssetManifest` (testovateľné bez procesu),
// CLI sa spustí len pri priamom behu súboru. Schéma mapy overuje len štruktúru; vzťahy medzi poľami mapy overuje
// loader v sime (MapError). Schéma manifestu tiež len štruktúru; existenciu SVG súborov, ich pokrytie a rozmery
// overuje tests/tools/asset-manifest.test.ts. `validateAssetManifest` navyše krížovo overí, že každý modul z
// `modules.json` má `sprites[id]`, každá loď zo `ships.json` má `entities.ship_{id}`, každé vozidlo z
// `vehicles.json` a každý kamión z `trucks.json` má `entities[id]`; navyše `params.bays` čakacej plochy sa musí
// zhodovať s počtom `stalls` a `params.docks` rampy s počtom `docks` v manifeste.
// Katalógové defy (`items: [...]`, ADR-009) majú navyše kontrolu jedinečnosti `id` — JSON Schema ju nevyjadrí.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv';

export const DEFAULT_DEFS_DIR = fileURLToPath(new URL('../data/defs', import.meta.url));
export const DEFAULT_SCHEMAS_DIR = fileURLToPath(new URL('../data/schemas', import.meta.url));
export const DEFAULT_MAPS_DIR = fileURLToPath(new URL('../data/maps', import.meta.url));
export const DEFAULT_ASSET_MANIFEST = fileURLToPath(new URL('../assets/manifest.json', import.meta.url));

const JSON_SUFFIX = '.json';
const SCHEMA_SUFFIX = '.schema.json';
/** Všetky mapy zdieľajú jednu schému, na rozdiel od defov (schéma podľa názvu súboru). */
const MAP_SCHEMA_NAME = `map${SCHEMA_SUFFIX}`;
const MAPS_LABEL_PREFIX = 'maps/';
const ASSET_MANIFEST_SCHEMA_NAME = `asset-manifest${SCHEMA_SUFFIX}`;
const ASSETS_LABEL_PREFIX = 'assets/';
/** Katalógy defov, ktoré musia mať sprite v manifeste, a sekcia manifestu + predpona kľúča, kde ho hľadať. */
const MODULES_DEF_FILE = `modules${JSON_SUFFIX}`;
const SHIPS_DEF_FILE = `ships${JSON_SUFFIX}`;
const VEHICLES_DEF_FILE = `vehicles${JSON_SUFFIX}`;
const TRUCKS_DEF_FILE = `trucks${JSON_SUFFIX}`;
const CARGO_TYPES_DEF_FILE = `cargo_types${JSON_SUFFIX}`;
const ECONOMY_DEF_FILE = `economy${JSON_SUFFIX}`;
const CONTRACT_TEMPLATES_DEF_FILE = `contract_templates${JSON_SUFFIX}`;
const MODULE_SPRITES_SECTION = 'sprites';
const ENTITIES_SECTION = 'entities';
const SHIP_ENTITY_PREFIX = 'ship_';

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
 * Krížová kontrola rámp a kamiónov (review T04-11 f, dodatok ADR-024): pre každú rampu v `modules.json` musí
 * `trucks.json` mať kamión jej kategórie (prvý v poradí — ten pošle spawner) a jeho `capacityUnits ≤ stagingPerDock`
 * rampy; inak rampa prijíma outbound joby a nič z nej neodíde. Kapacitu overuje aj `DefRegistry.fromRaw` (fail-fast),
 * existenciu len táto kontrola zabalených dát (syntetické defy testov rampu bez kamióna smú mať). Chyba:
 * `modules.json: /items/<i>/params/<category|stagingPerDock> <správa>`. Chýbajúci alebo nečitateľný katalóg a položky
 * bez očakávaného tvaru sa preskočia (hlási ich schéma).
 */
function findRampTruckProblems(defsDir: string): string[] {
  const modules = readJsonOrUndefined(join(defsDir, MODULES_DEF_FILE));
  const trucks = readJsonOrUndefined(join(defsDir, TRUCKS_DEF_FILE));
  const moduleItems = isRecord(modules) ? modules['items'] : undefined;
  const truckItems = isRecord(trucks) ? trucks['items'] : undefined;
  if (!Array.isArray(moduleItems) || !Array.isArray(truckItems)) return [];
  const errors: string[] = [];
  moduleItems.forEach((item: unknown, index) => {
    if (!isRecord(item) || item['kind'] !== 'ramp' || !isRecord(item['params'])) return;
    const { category, stagingPerDock } = item['params'];
    if (typeof category !== 'string' || typeof stagingPerDock !== 'number') return;
    const truck = truckItems.find((candidate: unknown) => isRecord(candidate) && Array.isArray(candidate['cargoCategories']) && candidate['cargoCategories'].includes(category));
    const at = `${MODULES_DEF_FILE}: /items/${String(index)}/params`;
    if (!isRecord(truck)) {
      errors.push(`${at}/category rampa '${String(item['id'])}' nakladá kategóriu '${category}', ale ${TRUCKS_DEF_FILE} nemá kamión tejto kategórie`);
      return;
    }
    const capacity = truck['capacityUnits'];
    if (typeof capacity === 'number' && capacity > stagingPerDock) {
      errors.push(
        `${at}/stagingPerDock kamión '${String(truck['id'])}' má capacityUnits ${String(capacity)} > stagingPerDock ${String(stagingPerDock)} rampy '${String(item['id'])}' — dock by sa nikdy nenaplnil`,
      );
    }
  });
  return errors;
}

/** Dvojica čísel `[min, max]`, inak `undefined` (tvar rozsahu hlási schéma). */
function asRange(value: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [min, max] = value as unknown[];
  return typeof min === 'number' && typeof max === 'number' ? [min, max] : undefined;
}

/** `<at> rozsah musí mať min ≤ max` pre rozsah, ktorého poradie schéma nevyjadrí; neúplný rozsah sa preskočí. */
function findRangeOrderProblem(at: string, value: unknown): string[] {
  const range = asRange(value);
  return range !== undefined && range[0] > range[1]
    ? [`${at} rozsah musí mať min ≤ max, dostal [${String(range[0])}, ${String(range[1])}]`]
    : [];
}

/**
 * Vzťahy polí `economy.json` (F5), ktoré schéma nevyjadrí: `min ≤ max` v `arrivalDaysRange` a `volumeScaleRange`
 * a `arrivalDaysRange[1] > 0` (loď kontraktu nesmie prísť v ticku prijatia). Chýbajúci alebo nečitateľný súbor sa preskočí.
 */
function findEconomyProblems(defsDir: string): string[] {
  const economy = readJsonOrUndefined(join(defsDir, ECONOMY_DEF_FILE));
  if (!isRecord(economy)) return [];
  const label = ECONOMY_DEF_FILE;
  const errors = [
    ...findRangeOrderProblem(`${label}: /arrivalDaysRange`, economy['arrivalDaysRange']),
    ...findRangeOrderProblem(`${label}: /volumeScaleRange`, economy['volumeScaleRange']),
  ];
  const arrival = asRange(economy['arrivalDaysRange']);
  if (arrival !== undefined && arrival[1] <= 0) {
    errors.push(`${label}: /arrivalDaysRange/1 musí byť > 0 (loď kontraktu nesmie prísť v ticku prijatia), dostal ${String(arrival[1])}`);
  }
  return errors;
}

/**
 * Krížová kontrola `contract_templates.json` voči `cargo_types.json` a `ships.json` (F5; rovnaké pravidlá ako
 * `DefRegistry.fromRaw`): `min ≤ max` v `volumeUnitsRange` a `slaDaysRange`, `cargoTypeId` a `shipClassIds` existujú,
 * každá loď šablóny vozí kategóriu nákladu a `volumeUnitsRange[1] ≤` najmenšia `capacityUnits` lodí šablóny. Chyba:
 * `contract_templates.json: /items/<i>/<pole> <správa>`. Chýbajúci alebo nečitateľný katalóg a položky bez očakávaného
 * tvaru sa preskočia (hlási ich schéma).
 */
function findContractTemplateProblems(defsDir: string): string[] {
  const templates = readJsonOrUndefined(join(defsDir, CONTRACT_TEMPLATES_DEF_FILE));
  const cargoTypes = readJsonOrUndefined(join(defsDir, CARGO_TYPES_DEF_FILE));
  const ships = readJsonOrUndefined(join(defsDir, SHIPS_DEF_FILE));
  const templateItems = isRecord(templates) ? templates['items'] : undefined;
  const cargoItems = isRecord(cargoTypes) ? cargoTypes['items'] : undefined;
  const shipItems = isRecord(ships) ? ships['items'] : undefined;
  if (!Array.isArray(templateItems) || !Array.isArray(cargoItems) || !Array.isArray(shipItems)) return [];
  const findById = (items: unknown[], id: unknown): Record<string, unknown> | undefined => {
    const found = items.find((candidate: unknown) => isRecord(candidate) && candidate['id'] === id);
    return isRecord(found) ? found : undefined;
  };
  const errors: string[] = [];
  templateItems.forEach((item: unknown, index) => {
    if (!isRecord(item)) return;
    const at = `${CONTRACT_TEMPLATES_DEF_FILE}: /items/${String(index)}`;
    errors.push(...findRangeOrderProblem(`${at}/volumeUnitsRange`, item['volumeUnitsRange']), ...findRangeOrderProblem(`${at}/slaDaysRange`, item['slaDaysRange']));
    const cargo = findById(cargoItems, item['cargoTypeId']);
    if (cargo === undefined) {
      errors.push(`${at}/cargoTypeId neznámy typ nákladu '${String(item['cargoTypeId'])}' (${CARGO_TYPES_DEF_FILE})`);
    }
    const shipIds = Array.isArray(item['shipClassIds']) ? (item['shipClassIds'] as unknown[]) : [];
    let smallestCapacity = Number.POSITIVE_INFINITY;
    shipIds.forEach((shipId: unknown, shipIndex) => {
      const ship = findById(shipItems, shipId);
      const shipAt = `${at}/shipClassIds/${String(shipIndex)}`;
      if (ship === undefined) {
        errors.push(`${shipAt} neznáma trieda lode '${String(shipId)}' (${SHIPS_DEF_FILE})`);
        return;
      }
      const category = cargo?.['category'];
      if (typeof category === 'string' && Array.isArray(ship['cargoCategories']) && !ship['cargoCategories'].includes(category)) {
        errors.push(`${shipAt} loď '${String(shipId)}' nevozí kategóriu '${category}' nákladu '${String(item['cargoTypeId'])}'`);
      }
      if (typeof ship['capacityUnits'] === 'number') smallestCapacity = Math.min(smallestCapacity, ship['capacityUnits']);
    });
    const volume = asRange(item['volumeUnitsRange']);
    if (volume !== undefined && volume[1] > smallestCapacity) {
      errors.push(`${at}/volumeUnitsRange/1 musí byť ≤ najmenšia kapacita lodí šablóny (${String(smallestCapacity)}), dostal ${String(volume[1])}`);
    }
  });
  return errors;
}

/** Krížové kontroly, ktoré JSON Schema nevyjadrí, podľa súboru defu (`undefined` = súbor ich nemá). */
const DEF_FILE_CHECKS: Readonly<Record<string, (defsDir: string) => string[]>> = {
  [MODULES_DEF_FILE]: findRampTruckProblems,
  [ECONOMY_DEF_FILE]: findEconomyProblems,
  [CONTRACT_TEMPLATES_DEF_FILE]: findContractTemplateProblems,
};

/**
 * Overí každý `*.json` v `defsDir` voči `<názov>.schema.json` v `schemasDir`; k niektorým súborom pridá krížové kontroly
 * (`DEF_FILE_CHECKS`: `modules.json` rampy × kamióny, `economy.json` rozsahy, `contract_templates.json` × cargo × lode). Chýbajúca schéma, nevalidný JSON aj porušenie schémy sú chyby v `errors`
 * (nie výnimky). Výsledky sú zoradené podľa názvu súboru. Výnimku vyhodí iba neexistujúci/nečitateľný `defsDir`.
 */
export function validateDefsDir(defsDir: string, schemasDir: string): DefValidationResult[] {
  return readdirSync(defsDir)
    .filter((name) => name.endsWith(JSON_SUFFIX))
    .sort()
    .map((file) => {
      const errors = validateJsonFile(file, join(defsDir, file), `${basename(file, JSON_SUFFIX)}${SCHEMA_SUFFIX}`, schemasDir, true);
      const crossChecks = DEF_FILE_CHECKS[file]?.(defsDir) ?? [];
      return { file, errors: [...errors, ...crossChecks] };
    });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON súbor alebo `undefined`, ak sa nedá prečítať / parsovať (chybu vtedy hlási samotná validácia súboru). */
function readJsonOrUndefined(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** `{ id, index }` položiek katalógu `defsDir/file`; `null` = súbor chýba, je nečitateľný alebo nemá `items[]`. */
function catalogEntries(defsDir: string, file: string): { id: string; index: number }[] | null {
  const json = readJsonOrUndefined(join(defsDir, file));
  const items = isRecord(json) ? json['items'] : undefined;
  if (!Array.isArray(items)) return null;
  const entries: { id: string; index: number }[] = [];
  items.forEach((item: unknown, index) => {
    const id = isRecord(item) ? item['id'] : undefined;
    if (typeof id === 'string') entries.push({ id, index });
  });
  return entries;
}

/**
 * Krížová kontrola manifestu voči defom: každý modul z `modules.json` má `sprites[id]`, každá loď zo `ships.json`
 * má `entities.ship_{id}`, každé vozidlo z `vehicles.json` a každý kamión z `trucks.json` má `entities[id]`.
 * Chyba: `<label>: /<sekcia>/<kľúč> chýba sprite pre <modul|loď|vozidlo|kamión> '<id>' (<def>: /items/<i>/id)`.
 * Katalóg, ktorý chýba alebo sa nedá čítať, a sekcia manifestu, ktorá nie je objekt, sa preskočia (hlási ich schéma /
 * `validateDefsDir`). Sprity bez defu (budúce moduly) chyba nie sú.
 */
function findMissingSprites(label: string, manifest: unknown, defsDir: string): string[] {
  if (!isRecord(manifest)) return [];
  const checks = [
    { defFile: MODULES_DEF_FILE, section: MODULE_SPRITES_SECTION, keyPrefix: '', what: 'modul' },
    { defFile: SHIPS_DEF_FILE, section: ENTITIES_SECTION, keyPrefix: SHIP_ENTITY_PREFIX, what: 'loď' },
    { defFile: VEHICLES_DEF_FILE, section: ENTITIES_SECTION, keyPrefix: '', what: 'vozidlo' },
    { defFile: TRUCKS_DEF_FILE, section: ENTITIES_SECTION, keyPrefix: '', what: 'kamión' },
  ] as const;
  const errors: string[] = [];
  for (const { defFile, section, keyPrefix, what } of checks) {
    const sprites = manifest[section];
    const entries = catalogEntries(defsDir, defFile);
    if (!isRecord(sprites) || entries === null) continue;
    for (const { id, index } of entries) {
      const key = `${keyPrefix}${id}`;
      if (!(key in sprites)) {
        errors.push(`${label}: /${section}/${key} chýba sprite pre ${what} '${id}' (${defFile}: /items/${String(index)}/id)`);
      }
    }
  }
  return errors;
}

/**
 * Parametre modulov, ktoré musia zodpovedať počtu prvkov poľa v jeho sprite (kľúč `sprites[id][spriteKey]`):
 * `waiting_area.bays` = počet `stalls`, `ramp.docks` = počet `docks`.
 */
const SPRITE_COUNT_PARAMS = [
  { kind: 'waiting_area', param: 'bays', spriteKey: 'stalls', what: 'stojísk' },
  { kind: 'ramp', param: 'docks', spriteKey: 'docks', what: 'dockov' },
] as const;

/**
 * Krížová kontrola počtov: modul druhu `kind` s číselným `params[param]` a sprite s poľom `spriteKey` musia mať rovnaký
 * počet. Chyba: `<label>: /sprites/<id>/<spriteKey> počet <what> (<n>) sa nezhoduje s params.<param> (<m>) (modules.json: /items/<i>/params/<param>)`.
 * Modul bez sprite alebo sprite bez poľa sa preskočí (chýbajúci sprite hlási `findMissingSprites`, tvar schéma).
 */
function findSpriteCountMismatches(label: string, manifest: unknown, defsDir: string): string[] {
  if (!isRecord(manifest)) return [];
  const sprites = manifest[MODULE_SPRITES_SECTION];
  const json = readJsonOrUndefined(join(defsDir, MODULES_DEF_FILE));
  const items = isRecord(json) ? json['items'] : undefined;
  if (!isRecord(sprites) || !Array.isArray(items)) return [];
  const errors: string[] = [];
  items.forEach((item: unknown, index) => {
    if (!isRecord(item) || typeof item['id'] !== 'string') return;
    const sprite = sprites[item['id']];
    const params = item['params'];
    for (const { kind, param, spriteKey, what } of SPRITE_COUNT_PARAMS) {
      if (item['kind'] !== kind || !isRecord(sprite) || !isRecord(params)) continue;
      const parts = sprite[spriteKey];
      const declared = params[param];
      if (!Array.isArray(parts) || typeof declared !== 'number' || parts.length === declared) continue;
      errors.push(
        `${label}: /${MODULE_SPRITES_SECTION}/${item['id']}/${spriteKey} počet ${what} (${String(parts.length)}) sa nezhoduje s params.${param} (${String(declared)}) (${MODULES_DEF_FILE}: /items/${String(index)}/params/${param})`,
      );
    }
  });
  return errors;
}

/**
 * Overí `manifestPath` (`assets/manifest.json`) voči `asset-manifest.schema.json` v `schemasDir` a krížovo voči
 * defom v `defsDir` (pozri `findMissingSprites` a `findSpriteCountMismatches`). `file` výsledku je `assets/<názov súboru>`. Chýbajúci súbor,
 * nevalidný JSON, chýbajúca schéma aj porušenie sú chyby v `errors` (nie výnimky).
 */
export function validateAssetManifest(manifestPath: string, schemasDir: string, defsDir: string): DefValidationResult {
  const file = `${ASSETS_LABEL_PREFIX}${basename(manifestPath)}`;
  if (!existsSync(manifestPath)) return { file, errors: [`${file}: / chýba súbor ${manifestPath}`] };
  const schemaErrors = validateJsonFile(file, manifestPath, ASSET_MANIFEST_SCHEMA_NAME, schemasDir, false);
  const manifest = readJsonOrUndefined(manifestPath);
  return {
    file,
    errors: [...schemaErrors, ...findMissingSprites(file, manifest, defsDir), ...findSpriteCountMismatches(file, manifest, defsDir)],
  };
}

function main(argv: readonly string[]): number {
  const defsDir = argv[0] ? resolve(argv[0]) : DEFAULT_DEFS_DIR;
  const schemasDir = argv[1] ? resolve(argv[1]) : DEFAULT_SCHEMAS_DIR;
  const mapsDir = argv[2] ? resolve(argv[2]) : DEFAULT_MAPS_DIR;
  const manifestPath = argv[3] ? resolve(argv[3]) : DEFAULT_ASSET_MANIFEST;

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
  results.push(validateAssetManifest(manifestPath, schemasDir, defsDir));

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
    console.error(`validate-defs: ${failed} z ${results.length} súborov (defy, mapy a asset manifest) je neplatných.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
