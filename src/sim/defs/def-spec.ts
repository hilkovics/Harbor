/**
 * Tabuľková validácia dát (spoločná pre všetky defy): špecifikácie polí (`NumberSpec`, `EnumSpec`, …), typová väzba
 * tabuľky na typ defu (`SpecTable<V>`) a generické kontroly. Žiadne `switch` podľa druhu dát — pravidlá sú v tabuľkách
 * (`def-registry.ts`, `module-params.ts`), kód je jeden a generický.
 *
 * Hranice v tabuľkách (`min`/`max`/…) zrkadlia `data/schemas/*.schema.json`, nie sú to laditeľné herné hodnoty.
 */
import { DefError } from './def-error';

export interface NumberSpec {
  /** `integer` = celé číslo (schéma `type: integer`), `number` = ľubovoľné konečné číslo. */
  readonly kind: 'integer' | 'number';
  readonly min?: number;
  readonly max?: number;
  /** Hodnota musí byť striktne väčšia (schéma `exclusiveMinimum`). */
  readonly exclusiveMin?: number;
  /**
   * Hodnota musí byť kladná a deliť toto číslo bezo zvyšku (`divisorOf % hodnota === 0`); zrkadlí `enum` deliteľov
   * v schéme. Kladnosť sa kontroluje osobitne, lebo `60 % -10 === 0` a zvyšok po delení nulou je `NaN`.
   */
  readonly divisorOf?: number;
}

/** Neprázdny reťazec, voliteľne so vzorom (napr. snake_case id). */
export interface StringSpec {
  readonly kind: 'string';
  readonly pattern?: RegExp;
  /** Ľudský popis vzoru do chybovej správy. */
  readonly patternName?: string;
}

/** Reťazec z pevnej množiny hodnôt (schéma `enum`). */
export interface EnumSpec<V extends string = string> {
  readonly kind: 'enum';
  readonly values: readonly V[];
}

export interface BooleanSpec {
  readonly kind: 'boolean';
}

export interface IntegerArraySpec {
  readonly kind: 'integerArray';
  readonly minItems: number;
  /** Minimum každej položky. */
  readonly itemMin: number;
  /** Položky sa nesmú opakovať (`uniqueItems`). */
  readonly unique: boolean;
  /** Hodnota, ktorú pole musí obsahovať (`contains: { const }`). */
  readonly contains?: number;
}

/**
 * Dvojica `[min, max]` čísel (rozsah): presne 2 položky, každá podľa `item`, `min ≤ max`. Schéma ju vyjadrí ako pole
 * s `prefixItems`, poradie `min ≤ max` schéma nevyjadrí — kontroluje ho DefRegistry a `pnpm validate:defs`.
 */
export interface RangeSpec {
  readonly kind: 'range';
  /** Špecifikácia oboch hraníc. */
  readonly bound: NumberSpec;
}

/** Pole s položkami podľa `item`; `unique` porovnáva primitívne hodnoty (pre pole objektov nemá účinok). */
export interface ArraySpec<S> {
  readonly kind: 'array';
  readonly minItems: number;
  readonly unique: boolean;
  readonly item: S;
}

/** Vnorený objekt s pevnou sadou kľúčov (schéma `additionalProperties: false`). */
export interface ObjectSpec<V> {
  readonly kind: 'object';
  readonly fields: SpecTable<V>;
}

/** Voliteľné pole (schéma: kľúč mimo `required`); chýbajúci kľúč nie je chyba, prítomný sa validuje. */
type OptionalFlag<T> = undefined extends T ? { readonly optional: true } : { readonly optional?: false };

/** Špecifikácia poľa podľa typu jeho hodnoty; kompilátor tak spáruje tabuľku s typom defu. */
type SpecFor<V> = [V] extends [readonly [number, number]]
  ? RangeSpec
  : [V] extends [readonly number[]]
  ? IntegerArraySpec
  : [V] extends [readonly (infer E)[]]
    ? ArraySpec<SpecFor<E>>
    : [V] extends [number]
      ? NumberSpec
      : [V] extends [string]
        ? string extends V
          ? StringSpec
          : EnumSpec<V>
        : [V] extends [boolean]
          ? BooleanSpec
          : ObjectSpec<V>;

/** Tabuľka pokrýva každý kľúč typu `V` — kompilátor ohlási chýbajúci aj prebytočný kľúč; voliteľný kľúč = `optional: true`. */
export type SpecTable<V> = {
  readonly [K in keyof V]-?: SpecFor<Exclude<V[K], undefined>> & OptionalFlag<V[K]>;
};

/** Nezávislé od typu defu — tvar, s ktorým pracuje generická validácia za behu. */
export type FieldSpec = (
  | NumberSpec
  | StringSpec
  | EnumSpec
  | BooleanSpec
  | IntegerArraySpec
  | RangeSpec
  | ArraySpec<FieldSpec>
  | { readonly kind: 'object'; readonly fields: FieldRecord }
) & { readonly optional?: boolean };
export type FieldRecord = { readonly [key: string]: FieldSpec };

/** Prvý nájdený problém: JSON pointer + správa. */
export interface Problem {
  readonly path: string;
  readonly message: string;
}

/** snake_case identifikátor (`id`, `techRequired`) — zrkadlí `$defs/id` v schémach. */
export const SNAKE_CASE_ID = /^[a-z][a-z0-9_]*$/;
/** Názov CSS tokenu bez `--` (kebab-case). */
export const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;

/** Escapovanie segmentu JSON pointeru (RFC 6901). */
export function pointerSegment(segment: string | number): string {
  return `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'pole';
  if (typeof value === 'object') return 'objekt';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Overí číslo podľa `spec`; vráti prvý problém (poradie: typ, celé číslo, min, max, exkluzívne min, deliteľ) alebo `undefined`. */
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
  if (spec.exclusiveMin !== undefined && value <= spec.exclusiveMin) {
    return { path, message: `musí byť > ${String(spec.exclusiveMin)}, dostal ${String(value)}` };
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

function checkString(value: unknown, spec: StringSpec, path: string): Problem | undefined {
  if (typeof value !== 'string') return { path, message: `očakávaný reťazec, dostal ${describeValue(value)}` };
  if (value.length === 0) return { path, message: 'reťazec nesmie byť prázdny' };
  if (spec.pattern !== undefined && !spec.pattern.test(value)) {
    const name = spec.patternName ?? String(spec.pattern);
    return { path, message: `musí byť ${name}, dostal ${JSON.stringify(value)}` };
  }
  return undefined;
}

function checkEnum(value: unknown, spec: EnumSpec, path: string): Problem | undefined {
  if (typeof value === 'string' && spec.values.includes(value)) return undefined;
  return { path, message: `musí byť jedna z hodnôt ${spec.values.join(', ')}, dostal ${describeValue(value)}` };
}

function checkBoolean(value: unknown, path: string): Problem | undefined {
  return typeof value === 'boolean' ? undefined : { path, message: `očakávaný boolean, dostal ${describeValue(value)}` };
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

function checkRange(value: unknown, spec: RangeSpec, path: string): Problem | undefined {
  if (!Array.isArray(value)) return { path, message: `očakávaný rozsah [min, max], dostal ${describeValue(value)}` };
  if (value.length !== 2) return { path, message: `rozsah musí mať presne 2 položky [min, max], má ${String(value.length)}` };
  for (const [index, item] of value.entries()) {
    const problem = checkNumber(item, spec.bound, `${path}${pointerSegment(index)}`);
    if (problem) return problem;
  }
  const [min, max] = value as [number, number];
  if (min > max) return { path, message: `rozsah musí mať min ≤ max, dostal [${String(min)}, ${String(max)}]` };
  return undefined;
}

function checkArray(value: unknown, spec: ArraySpec<FieldSpec>, path: string): Problem | undefined {
  if (!Array.isArray(value)) return { path, message: `očakávané pole, dostal ${describeValue(value)}` };
  if (value.length < spec.minItems) {
    return { path, message: `pole musí mať aspoň ${String(spec.minItems)} položiek, má ${String(value.length)}` };
  }
  for (const [index, item] of value.entries()) {
    const problem = checkField(item, spec.item, `${path}${pointerSegment(index)}`);
    if (problem) return problem;
  }
  if (spec.unique && new Set<unknown>(value).size !== value.length) {
    return { path, message: 'položky sa nesmú opakovať' };
  }
  return undefined;
}

/** additionalProperties: false — preklep v názve poľa je pravdepodobnejší než zámerné rozšírenie. */
export function findUnknownKey(raw: Record<string, unknown>, known: ReadonlySet<string>, path: string): Problem | undefined {
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { path: `${path}${pointerSegment(key)}`, message: 'neznámy kľúč' };
  }
  return undefined;
}

/**
 * Každé pole tabuľky musí existovať (okrem `optional`) a prejsť svojou špecifikáciou; hlási prvý problém v poradí
 * tabuľky. Neznáme kľúče kontroluje volajúci (`findUnknownKey`) — aby sa dali k tabuľke pridať polia mimo nej.
 */
export function checkFields(raw: Record<string, unknown>, fields: FieldRecord, path: string): Problem | undefined {
  for (const [key, spec] of Object.entries(fields)) {
    const fieldPath = `${path}${pointerSegment(key)}`;
    if (!Object.hasOwn(raw, key)) {
      if (spec.optional === true) continue;
      return { path: fieldPath, message: 'chýba povinné pole' };
    }
    const problem = checkField(raw[key], spec, fieldPath);
    if (problem) return problem;
  }
  return undefined;
}

export function checkField(value: unknown, spec: FieldSpec, path: string): Problem | undefined {
  if (spec.kind === 'integerArray') return checkIntegerArray(value, spec, path);
  if (spec.kind === 'range') return checkRange(value, spec, path);
  if (spec.kind === 'array') return checkArray(value, spec, path);
  if (spec.kind === 'object') {
    if (!isPlainObject(value)) return { path, message: `očakávaný objekt, dostal ${describeValue(value)}` };
    return findUnknownKey(value, new Set(Object.keys(spec.fields)), path) ?? checkFields(value, spec.fields, path);
  }
  if (spec.kind === 'string') return checkString(value, spec, path);
  if (spec.kind === 'enum') return checkEnum(value, spec, path);
  if (spec.kind === 'boolean') return checkBoolean(value, path);
  return checkNumber(value, spec, path);
}

/** `value` je objekt presne s poľami tabuľky (bez neznámych kľúčov), každé prejde svojou špecifikáciou. */
export function matchesFields(value: unknown, fields: FieldRecord): boolean {
  if (!isPlainObject(value)) return false;
  return findUnknownKey(value, new Set(Object.keys(fields)), '') === undefined && checkFields(value, fields, '') === undefined;
}

/** Hlboká zmrazená kópia JSON hodnoty (objekty a polia); vstup sa nemení ani nezmrazuje. */
export function freezeCopy(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item: unknown) => freezeCopy(item)));
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCopy(item)])));
  }
  return value;
}

export function failWith(defName: string, { path, message }: Problem): never {
  throw new DefError(defName, path, message);
}
