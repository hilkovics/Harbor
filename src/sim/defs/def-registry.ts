/**
 * DefRegistry — typované gettery nad dátovými definíciami (ARCHITECTURE §4), fail-fast pri chybe.
 *
 * Validácia je zámerne ručná a malá (bez ajv, bez `fs`): sim ostáva bez runtime závislostí a prenositeľný
 * do Web Workera. Plnú JSON schému vynucuje `pnpm validate:defs` (tools); táto vrstva overuje to isté
 * minimum, čo potrebuje kód — prítomnosť defu, `schemaVersion`, povinné polia, typy a rozsahy, neznáme kľúče,
 * jedinečnosť `id` v katalógoch a vzťahy medzi poľami (konektor vo footprinte). Generický kód je v `def-spec.ts`,
 * pravidlá sú tabuľky nižšie (`FieldTable`, `SpecTable`).
 *
 * Konfiguračné defy (`time`, `economy`, `infrastructure`) sú jeden objekt, katalógové (`cargo_types`, `modules`,
 * `ships`) majú `items: [...]` (ADR-009) a vystavujú sa ako `Catalog`.
 */
import cargoTypesJson from '@data/defs/cargo_types.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import { SECONDS_PER_MINUTE } from '../core/sim-clock';
import { TERRAIN_TYPES } from '../grid/terrain';
import { validateCatalog, type Catalog } from './catalog';
import { DefError } from './def-error';
import {
  SNAKE_CASE_ID,
  TOKEN_NAME,
  checkFields,
  describeValue,
  failWith,
  findUnknownKey,
  freezeCopy,
  isPlainObject,
  pointerSegment,
  type FieldRecord,
  type Problem,
  type SpecTable,
  type StringSpec,
} from './def-spec';
import { checkModuleItem } from './module-def';
import {
  CARGO_CATEGORIES,
  CONNECTOR_TYPES,
  MODULE_KINDS,
  SIDES,
  SUPPORTED_SCHEMA_VERSION,
  type CargoTypeDef,
  type DefBase,
  type EconomyDef,
  type InfrastructureDef,
  type InfrastructureLayerDef,
  type ModuleDef,
  type ShipClassDef,
  type TimeDef,
} from './types';

export { DefError };

// ---------------------------------------------------------------------------------------------------------
// Tabuľky polí — jedna na def; jediný kód validácie je generický (`validateDef`, `validateCatalog`).
// ---------------------------------------------------------------------------------------------------------

/** Tabuľka defu: každé pole okrem `schemaVersion`. */
type FieldTable<T extends DefBase> = SpecTable<Omit<T, keyof DefBase>>;

const TIME_FIELDS: FieldTable<TimeDef> = {
  // Tick musí deliť minútu (§3), inak by hranice minúty/hodiny/dňa nepadli na celý tick; rovnaké pravidlo má SimClock.
  tickGameSeconds: { kind: 'integer', min: 1, divisorOf: SECONDS_PER_MINUTE },
  ticksPerRealSecond: { kind: 'integer', min: 1 },
  maxTicksPerFrame: { kind: 'integer', min: 1 },
  speeds: { kind: 'integerArray', minItems: 1, itemMin: 0, unique: true, contains: 0 },
};

const ECONOMY_FIELDS: FieldTable<EconomyDef> = {
  startingCashCents: { kind: 'integer', min: 0 },
  demurrageRateOfRewardPerHour: { kind: 'number', min: 0, max: 1 },
  latePenaltyRateOfRewardPerDay: { kind: 'number', min: 0, max: 1 },
  failAfterDaysLate: { kind: 'integer', min: 0 },
  leaseMonthlyRateOfPrice: { kind: 'number', min: 0, max: 1 },
  bankruptcyDays: { kind: 'integer', min: 1 },
  offersPerDay: { kind: 'integer', min: 0 },
  offerExpiryDays: { kind: 'integer', min: 1 },
  removalRefundRate: { kind: 'number', min: 0, max: 1 },
};

/** Cesta aj koľaj majú rovnaké polia (ADR-010), líšia sa iba hodnotami v defe. */
const INFRASTRUCTURE_LAYER_FIELDS: SpecTable<InfrastructureLayerDef> = {
  costPerCellCents: { kind: 'integer', min: 0 },
  maintenancePerDayCents: { kind: 'integer', min: 0 },
};

const INFRASTRUCTURE_FIELDS: FieldTable<InfrastructureDef> = {
  road: { kind: 'object', fields: INFRASTRUCTURE_LAYER_FIELDS },
  rail: { kind: 'object', fields: INFRASTRUCTURE_LAYER_FIELDS },
};

/** Tabuľky konfiguračných defov; kľúč je názov defu (= názov súboru bez `.json`). */
const DEF_FIELDS = {
  time: TIME_FIELDS,
  economy: ECONOMY_FIELDS,
  infrastructure: INFRASTRUCTURE_FIELDS,
} as const;

// Katalógové defy (ADR-009): tabuľka polí jednej položky; `id` je vždy prvé pole.

const ID_FIELD: StringSpec = { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor' };
const TEXT_FIELD: StringSpec = { kind: 'string' };

const CARGO_TYPE_FIELDS: SpecTable<CargoTypeDef> = {
  id: ID_FIELD,
  category: { kind: 'enum', values: CARGO_CATEGORIES },
  unitName: TEXT_FIELD,
  unitsPerBatch: { kind: 'integer', min: 1 },
  basePricePerUnitCents: { kind: 'integer', min: 0 },
  xpPerUnit: { kind: 'number', min: 0 },
  colorToken: { kind: 'string', pattern: TOKEN_NAME, patternName: 'názov tokenu (kebab-case, bez `--`)' },
};

/** `params` nie je v tabuľke — jeho tvar závisí od `kind` (`checkModuleItem`, `MODULE_PARAM_SPECS`). */
const MODULE_FIELDS: SpecTable<Omit<ModuleDef, 'params'>> = {
  id: ID_FIELD,
  kind: { kind: 'enum', values: MODULE_KINDS },
  displayName: TEXT_FIELD,
  footprint: { kind: 'object', fields: { w: { kind: 'integer', min: 1 }, h: { kind: 'integer', min: 1 } } },
  placement: {
    kind: 'object',
    fields: {
      requiredTerrain: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: TERRAIN_TYPES } },
      waterSide: { kind: 'enum', values: ['north'], optional: true },
      requiresParcelOwnership: { kind: 'boolean' },
      mustAttachTo: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: MODULE_KINDS }, optional: true },
    },
  },
  connectors: {
    kind: 'array',
    minItems: 0,
    unique: false,
    item: {
      kind: 'object',
      fields: {
        x: { kind: 'integer', min: 0 },
        y: { kind: 'integer', min: 0 },
        side: { kind: 'enum', values: SIDES },
        type: { kind: 'enum', values: CONNECTOR_TYPES },
      },
    },
  },
  costCents: { kind: 'integer', min: 0 },
  maintenancePerDayCents: { kind: 'integer', min: 0 },
  techRequired: { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor', optional: true },
};

const SHIP_CLASS_FIELDS: SpecTable<ShipClassDef> = {
  id: ID_FIELD,
  displayName: TEXT_FIELD,
  lengthCells: { kind: 'integer', min: 1 },
  widthCells: { kind: 'integer', min: 1 },
  draftClass: { kind: 'integer', min: 1, max: 3 },
  capacityUnits: { kind: 'integer', min: 1 },
  speedCellsPerTick: { kind: 'number', exclusiveMin: 0 },
  cargoCategories: { kind: 'array', minItems: 1, unique: true, item: { kind: 'enum', values: CARGO_CATEGORIES } },
  berthAllowanceTicks: { kind: 'integer', min: 1 },
  techRequired: { kind: 'string', pattern: SNAKE_CASE_ID, patternName: 'snake_case identifikátor', optional: true },
};

type DefName = keyof typeof DEF_FIELDS | 'cargo_types' | 'modules' | 'ships';

// ---------------------------------------------------------------------------------------------------------
// Validácia konfiguračného defu
// ---------------------------------------------------------------------------------------------------------

/**
 * Overí surový def voči tabuľke polí a vráti jeho zmrazenú kópiu (vstup sa nemení ani nezmrazuje).
 * Hlási prvý nájdený problém: koreň → neznáme kľúče → `schemaVersion` → polia v poradí tabuľky (vnorené objekty
 * rekurzívne rovnakým poradím, cesta je úplný JSON pointer).
 */
function validateDef<T extends DefBase>(defName: string, raw: unknown, fields: FieldTable<T>): Readonly<T> {
  const fail = (problem: Problem): never => failWith(defName, problem);

  if (raw === undefined) return fail({ path: '', message: 'def chýba' });
  if (!isPlainObject(raw)) return fail({ path: '', message: `očakávaný objekt, dostal ${describeValue(raw)}` });

  const table: FieldRecord = fields;
  const unknownKey = findUnknownKey(raw, new Set(['schemaVersion', ...Object.keys(table)]), '');
  if (unknownKey) fail(unknownKey);

  const versionPath = pointerSegment('schemaVersion');
  if (!Object.hasOwn(raw, 'schemaVersion')) fail({ path: versionPath, message: 'chýba povinné pole' });
  if (raw['schemaVersion'] !== SUPPORTED_SCHEMA_VERSION) {
    fail({
      path: versionPath,
      message: `nepodporovaná verzia schémy, očakávaná ${String(SUPPORTED_SCHEMA_VERSION)}, dostal ${describeValue(raw['schemaVersion'])}`,
    });
  }

  const problem = checkFields(raw, table, '');
  if (problem) fail(problem);
  // Všetky polia tabuľky prešli kontrolou a neznáme kľúče sú vylúčené, takže tvar zodpovedá `T`.
  return freezeCopy(raw) as Readonly<T>;
}

// ---------------------------------------------------------------------------------------------------------
// DefRegistry
// ---------------------------------------------------------------------------------------------------------

/** Surové (nevalidované) defy, napr. rovno z `JSON.parse`/JSON importu. Chýbajúci def → `DefError`. */
export type RawDefs = { readonly [K in DefName]?: unknown };

export class DefRegistry {
  private constructor(
    private readonly timeDef: Readonly<TimeDef>,
    private readonly economyDef: Readonly<EconomyDef>,
    private readonly infrastructureDef: Readonly<InfrastructureDef>,
    private readonly cargoTypesCatalog: Catalog<Readonly<CargoTypeDef>>,
    private readonly modulesCatalog: Catalog<Readonly<ModuleDef>>,
    private readonly shipsCatalog: Catalog<Readonly<ShipClassDef>>,
  ) {}

  /** Zvaliduje surové defy (fail-fast, `DefError`) a zostaví register so zmrazenými objektmi. */
  static fromRaw(raw: RawDefs): DefRegistry {
    return new DefRegistry(
      validateDef<TimeDef>('time', raw.time, DEF_FIELDS.time),
      validateDef<EconomyDef>('economy', raw.economy, DEF_FIELDS.economy),
      validateDef<InfrastructureDef>('infrastructure', raw.infrastructure, DEF_FIELDS.infrastructure),
      validateCatalog<CargoTypeDef>('cargo_types', raw.cargo_types, { fields: CARGO_TYPE_FIELDS }),
      validateCatalog<ModuleDef>('modules', raw.modules, { fields: MODULE_FIELDS, extraKeys: ['params'], check: checkModuleItem }),
      validateCatalog<ShipClassDef>('ships', raw.ships, { fields: SHIP_CLASS_FIELDS }),
    );
  }

  /** `time.json` (ARCHITECTURE §3); použiteľný priamo ako `SimClockConfig`. */
  get time(): Readonly<TimeDef> {
    return this.timeDef;
  }

  /** `economy.json` (ARCHITECTURE §4.6). */
  get economy(): Readonly<EconomyDef> {
    return this.economyDef;
  }

  /** `infrastructure.json` (ARCHITECTURE §4.6, ADR-010): cena a údržba cesty a koľaje za bunku. */
  get infrastructure(): Readonly<InfrastructureDef> {
    return this.infrastructureDef;
  }

  /** `cargo_types.json` (§4.1): typy nákladu. */
  get cargoTypes(): Catalog<Readonly<CargoTypeDef>> {
    return this.cargoTypesCatalog;
  }

  /** `modules.json` (§4.2, §5.3): moduly; typované parametre cez `berthParams(def)` / `craneParams(def)`. */
  get modules(): Catalog<Readonly<ModuleDef>> {
    return this.modulesCatalog;
  }

  /** `ships.json` (§4.3): triedy lodí. */
  get ships(): Catalog<Readonly<ShipClassDef>> {
    return this.shipsCatalog;
  }
}

/** Načíta defy zabalené v `data/defs/` (statické JSON importy, bez `fs`) a zvaliduje ich. */
export function loadBundledDefs(): DefRegistry {
  return DefRegistry.fromRaw({
    time: timeJson,
    economy: economyJson,
    infrastructure: infrastructureJson,
    cargo_types: cargoTypesJson,
    modules: modulesJson,
    ships: shipsJson,
  });
}
