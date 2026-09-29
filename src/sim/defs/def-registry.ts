/**
 * DefRegistry — typované gettery nad dátovými definíciami (ARCHITECTURE §4), fail-fast pri chybe.
 *
 * Validácia je zámerne ručná a malá (bez ajv, bez `fs`): sim ostáva bez runtime závislostí a prenositeľný
 * do Web Workera. Plnú JSON schému vynucuje `pnpm validate:defs` (tools); táto vrstva overuje to isté
 * minimum, čo potrebuje kód — prítomnosť defu, `schemaVersion`, povinné polia, typy a rozsahy, neznáme kľúče.
 */
import timeJson from '@data/defs/time.json';
import economyJson from '@data/defs/economy.json';
import { SECONDS_PER_MINUTE } from '../core/sim-clock';
import { SUPPORTED_SCHEMA_VERSION, type DefBase, type EconomyDef, type TimeDef } from './types';

/** Chyba defu: názov defu + JSON pointer na problémové pole (`''` = celý def). Správa: `<defName><path>: <problém>`. */
export class DefError extends Error {
  readonly defName: string;
  /** JSON pointer (RFC 6901), napr. `/tickGameSeconds` alebo `/speeds/2`; prázdny reťazec = koreň defu. */
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

interface NumberSpec {
  /** `integer` = celé číslo (schéma `type: integer`), `number` = ľubovoľné konečné číslo. */
  readonly kind: 'integer' | 'number';
  readonly min?: number;
  readonly max?: number;
  /** Hodnota musí deliť toto číslo bezo zvyšku (`divisorOf % hodnota === 0`); zrkadlí `enum` deliteľov v schéme. */
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

type FieldSpec = NumberSpec | IntegerArraySpec;

/** Tabuľka musí pokryť každé pole defu okrem `schemaVersion` — kompilátor ohlási chýbajúci aj prebytočný kľúč. */
type FieldTable<T extends DefBase> = { readonly [K in Exclude<keyof T, keyof DefBase>]-?: FieldSpec };

const TIME_FIELDS: FieldTable<TimeDef> = {
  // Tick musí deliť minútu (§3), inak by hranice minúty/hodiny/dňa nepadli na celý tick; rovnaké pravidlo má SimClock.
  tickGameSeconds: { kind: 'integer', min: 1, divisorOf: SECONDS_PER_MINUTE },
  ticksPerRealSecond: { kind: 'integer', min: 1 },
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
};

/** Tabuľky všetkých defov; kľúč je názov defu (= názov súboru bez `.json`). */
const DEF_FIELDS = {
  time: TIME_FIELDS,
  economy: ECONOMY_FIELDS,
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

function checkNumber(
  value: unknown,
  spec: Pick<NumberSpec, 'kind' | 'min' | 'max' | 'divisorOf'>,
  path: string,
): Problem | undefined {
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
  if (spec.divisorOf !== undefined && spec.divisorOf % value !== 0) {
    return { path, message: `musí deliť ${String(spec.divisorOf)} bezo zvyšku (§3), dostal ${String(value)}` };
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

function checkField(value: unknown, spec: FieldSpec, path: string): Problem | undefined {
  return spec.kind === 'integerArray' ? checkIntegerArray(value, spec, path) : checkNumber(value, spec, path);
}

/**
 * Overí surový def voči tabuľke polí a vráti jeho zmrazenú kópiu (vstup sa nemení ani nezmrazuje).
 * Hlási prvý nájdený problém: koreň → neznáme kľúče → `schemaVersion` → polia v poradí tabuľky.
 */
function validateDef<T extends DefBase>(defName: string, raw: unknown, fields: FieldTable<T>): Readonly<T> {
  const fail = ({ path, message }: Problem): never => {
    throw new DefError(defName, path, message);
  };

  if (raw === undefined) return fail({ path: '', message: 'def chýba' });
  if (!isPlainObject(raw)) return fail({ path: '', message: `očakávaný objekt, dostal ${describeValue(raw)}` });

  // additionalProperties: false — preklep v názve poľa je pravdepodobnejší než zámerné rozšírenie.
  const known = new Set<string>(['schemaVersion', ...Object.keys(fields)]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) fail({ path: pointerSegment(key), message: 'neznámy kľúč' });
  }

  const versionPath = pointerSegment('schemaVersion');
  if (!Object.hasOwn(raw, 'schemaVersion')) fail({ path: versionPath, message: 'chýba povinné pole' });
  if (raw['schemaVersion'] !== SUPPORTED_SCHEMA_VERSION) {
    fail({
      path: versionPath,
      message: `nepodporovaná verzia schémy, očakávaná ${String(SUPPORTED_SCHEMA_VERSION)}, dostal ${describeValue(raw['schemaVersion'])}`,
    });
  }

  const result: Record<string, unknown> = { schemaVersion: SUPPORTED_SCHEMA_VERSION };
  for (const [key, spec] of Object.entries<FieldSpec>(fields)) {
    const path = pointerSegment(key);
    if (!Object.hasOwn(raw, key)) fail({ path, message: 'chýba povinné pole' });
    const value = raw[key];
    const problem = checkField(value, spec, path);
    if (problem) fail(problem);
    result[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  // Všetky polia tabuľky prešli kontrolou, takže tvar zodpovedá `T`.
  return Object.freeze(result) as Readonly<T>;
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
  ) {}

  /** Zvaliduje surové defy (fail-fast, `DefError`) a zostaví register so zmrazenými objektmi. */
  static fromRaw(raw: RawDefs): DefRegistry {
    return new DefRegistry(
      validateDef<TimeDef>('time', raw.time, DEF_FIELDS.time),
      validateDef<EconomyDef>('economy', raw.economy, DEF_FIELDS.economy),
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
}

/** Načíta defy zabalené v `data/defs/` (statické JSON importy, bez `fs`) a zvaliduje ich. */
export function loadBundledDefs(): DefRegistry {
  return DefRegistry.fromRaw({ time: timeJson, economy: economyJson });
}
