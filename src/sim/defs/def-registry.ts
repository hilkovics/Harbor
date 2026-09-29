/**
 * DefRegistry — typované gettery nad dátovými definíciami (ARCHITECTURE §4), fail-fast pri chybe.
 *
 * Validácia je zámerne ručná a malá (bez ajv, bez `fs`): sim ostáva bez runtime závislostí a prenositeľný
 * do Web Workera. Plnú JSON schému vynucuje `pnpm validate:defs` (tools); táto vrstva overuje to isté
 * minimum, čo potrebuje kód — prítomnosť defu, `schemaVersion`, povinné polia, typy a rozsahy, neznáme kľúče.
 */
import timeJson from '@data/defs/time.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import { SECONDS_PER_MINUTE } from '../core/sim-clock';
import {
  SUPPORTED_SCHEMA_VERSION,
  type DefBase,
  type EconomyDef,
  type InfrastructureDef,
  type InfrastructureLayerDef,
  type TimeDef,
} from './types';

/** Chyba defu: názov defu + JSON pointer na problémové pole (`''` = celý def). Správa: `<defName><path>: <problém>`. */
export class DefError extends Error {
  readonly defName: string;
  /** JSON pointer (RFC 6901), napr. `/tickGameSeconds` alebo `/road/costPerCellCents`; prázdny reťazec = koreň defu. */
  readonly path: string;
  readonly problem: string;

  constructor(defName: string, path: string, problem: string) {
    super(`${defName}${path}: ${problem}`);
    this.name = 'DefError';
    this.defName = defName;
    this.path = path;
    this.problem = problem;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Tabuľka polí — jedna na def; jediný kód validácie je generický (`validateDef`).
// Hranice (`min`/`max`/...) zrkadlia `data/schemas/*.schema.json`, nie sú to laditeľné herné hodnoty.
// ---------------------------------------------------------------------------------------------------------

export interface NumberSpec {
  /** `integer` = celé číslo (schéma `type: integer`), `number` = ľubovoľné konečné číslo. */
  readonly kind: 'integer' | 'number';
  readonly min?: number;
  readonly max?: number;
  /**
   * Hodnota musí byť kladná a deliť toto číslo bezo zvyšku (`divisorOf % hodnota === 0`); zrkadlí `enum` deliteľov
   * v schéme. Kladnosť sa kontroluje osobitne, lebo `60 % -10 === 0` a zvyšok po delení nulou je `NaN`.
   */
  readonly divisorOf?: number;
}

interface IntegerArraySpec {
  readonly kind: 'integerArray';
  readonly minItems: number;
  /** Minimum každej položky. */
  readonly itemMin: number;
  /** Položky sa nesmú opakovať (`uniqueItems`). */
  readonly unique: boolean;
  /** Hodnota, ktorú pole musí obsahovať (`contains: { const }`). */
  readonly contains?: number;
}

/** Vnorený objekt s pevnou sadou povinných kľúčov (schéma `additionalProperties: false`, `required` všetky). */
interface ObjectSpec<V> {
  readonly kind: 'object';
  readonly fields: SpecTable<V>;
}

/** Špecifikácia poľa podľa typu jeho hodnoty; kompilátor tak spáruje tabuľku s typom defu. */
type SpecFor<V> = V extends readonly number[] ? IntegerArraySpec : V extends number ? NumberSpec : ObjectSpec<V>;

/** Tabuľka pokrýva každý kľúč typu `V` — kompilátor ohlási chýbajúci aj prebytočný kľúč. */
type SpecTable<V> = { readonly [K in keyof V]-?: SpecFor<V[K]> };

/** Tabuľka defu: každé pole okrem `schemaVersion`. */
type FieldTable<T extends DefBase> = SpecTable<Omit<T, keyof DefBase>>;

/** Nezávislé od typu defu — tvar, s ktorým pracuje generická validácia za behu. */
type FieldSpec = NumberSpec | IntegerArraySpec | { readonly kind: 'object'; readonly fields: FieldRecord };
type FieldRecord = { readonly [key: string]: FieldSpec };

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

/** Tabuľky všetkých defov; kľúč je názov defu (= názov súboru bez `.json`). */
const DEF_FIELDS = {
  time: TIME_FIELDS,
  economy: ECONOMY_FIELDS,
  infrastructure: INFRASTRUCTURE_FIELDS,
} as const;

type DefName = keyof typeof DEF_FIELDS;

// ---------------------------------------------------------------------------------------------------------
// Generická validácia
// ---------------------------------------------------------------------------------------------------------

interface Problem {
  readonly path: string;
  readonly message: string;
}

/** Escapovanie segmentu JSON pointeru (RFC 6901). */
function pointerSegment(segment: string | number): string {
  return `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'pole';
  if (typeof value === 'object') return 'objekt';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Overí číslo podľa `spec`; vráti prvý problém (poradie: typ, celé číslo, min, max, deliteľ) alebo `undefined`. */
export function checkNumber(value: unknown, spec: NumberSpec, path: string): Problem | undefined {
  const expected = spec.kind === 'integer' ? 'celé číslo' : 'číslo';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { path, message: `očakávané ${expected}, dostal ${describeValue(value)}` };
  }
  if (spec.kind === 'integer' && !Number.isInteger(value)) {
    return { path, message: `očakávané celé číslo, dostal ${String(value)}` };
  }
  if (spec.min !== undefined && value < spec.min) {
    return { path, message: `musí byť ≥ ${String(spec.min)}, dostal ${String(value)}` };
  }
  if (spec.max !== undefined && value > spec.max) {
    return { path, message: `musí byť ≤ ${String(spec.max)}, dostal ${String(value)}` };
  }
  if (spec.divisorOf !== undefined) {
    if (value <= 0) {
      return { path, message: `musí byť kladné (deliteľ ${String(spec.divisorOf)}), dostal ${String(value)}` };
    }
    if (spec.divisorOf % value !== 0) {
      return { path, message: `musí deliť ${String(spec.divisorOf)} bezo zvyšku (§3), dostal ${String(value)}` };
    }
  }
  return undefined;
}

function checkIntegerArray(value: unknown, spec: IntegerArraySpec, path: string): Problem | undefined {
  if (!Array.isArray(value)) return { path, message: `očakávané pole celých čísel, dostal ${describeValue(value)}` };
  if (value.length < spec.minItems) {
    return { path, message: `pole musí mať aspoň ${String(spec.minItems)} položiek, má ${String(value.length)}` };
  }
  for (const [index, item] of value.entries()) {
    const problem = checkNumber(item, { kind: 'integer', min: spec.itemMin }, `${path}${pointerSegment(index)}`);
    if (problem) return problem;
  }
  if (spec.unique && new Set(value).size !== value.length) {
    return { path, message: 'položky sa nesmú opakovať' };
  }
  if (spec.contains !== undefined && !value.includes(spec.contains)) {
    return { path, message: `pole musí obsahovať ${String(spec.contains)}` };
  }
  return undefined;
}

/** additionalProperties: false — preklep v názve poľa je pravdepodobnejší než zámerné rozšírenie. */
function findUnknownKey(raw: Record<string, unknown>, known: ReadonlySet<string>, path: string): Problem | undefined {
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { path: `${path}${pointerSegment(key)}`, message: 'neznámy kľúč' };
  }
  return undefined;
}

/** Každé pole tabuľky musí existovať a prejsť svojou špecifikáciou; hlási prvý problém v poradí tabuľky. */
function checkFields(raw: Record<string, unknown>, fields: FieldRecord, path: string): Problem | undefined {
  for (const [key, spec] of Object.entries(fields)) {
    const fieldPath = `${path}${pointerSegment(key)}`;
    if (!Object.hasOwn(raw, key)) return { path: fieldPath, message: 'chýba povinné pole' };
    const problem = checkField(raw[key], spec, fieldPath);
    if (problem) return problem;
  }
  return undefined;
}

function checkField(value: unknown, spec: FieldSpec, path: string): Problem | undefined {
  if (spec.kind === 'integerArray') return checkIntegerArray(value, spec, path);
  if (spec.kind === 'object') {
    if (!isPlainObject(value)) return { path, message: `očakávaný objekt, dostal ${describeValue(value)}` };
    return findUnknownKey(value, new Set(Object.keys(spec.fields)), path) ?? checkFields(value, spec.fields, path);
  }
  return checkNumber(value, spec, path);
}

/** Hlboká zmrazená kópia JSON hodnoty (objekty a polia); vstup sa nemení ani nezmrazuje. */
function freezeCopy(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item: unknown) => freezeCopy(item)));
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCopy(item)])));
  }
  return value;
}

/**
 * Overí surový def voči tabuľke polí a vráti jeho zmrazenú kópiu (vstup sa nemení ani nezmrazuje).
 * Hlási prvý nájdený problém: koreň → neznáme kľúče → `schemaVersion` → polia v poradí tabuľky (vnorené objekty
 * rekurzívne rovnakým poradím, cesta je úplný JSON pointer).
 */
function validateDef<T extends DefBase>(defName: string, raw: unknown, fields: FieldTable<T>): Readonly<T> {
  const fail = ({ path, message }: Problem): never => {
    throw new DefError(defName, path, message);
  };

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
  ) {}

  /** Zvaliduje surové defy (fail-fast, `DefError`) a zostaví register so zmrazenými objektmi. */
  static fromRaw(raw: RawDefs): DefRegistry {
    return new DefRegistry(
      validateDef<TimeDef>('time', raw.time, DEF_FIELDS.time),
      validateDef<EconomyDef>('economy', raw.economy, DEF_FIELDS.economy),
      validateDef<InfrastructureDef>('infrastructure', raw.infrastructure, DEF_FIELDS.infrastructure),
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
}

/** Načíta defy zabalené v `data/defs/` (statické JSON importy, bez `fs`) a zvaliduje ich. */
export function loadBundledDefs(): DefRegistry {
  return DefRegistry.fromRaw({ time: timeJson, economy: economyJson, infrastructure: infrastructureJson });
}
