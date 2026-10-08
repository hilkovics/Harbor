/**
 * Poloha jednotky nákladu (ARCHITECTURE §7.1) a tabuľka povolených prechodov medzi druhmi lokácií.
 *
 * Všetko, čo sa o druhu lokácie dá povedať, je v dátových tabuľkách (pravidlo 7, žiadne switch-e podľa `kind`):
 * - `CARGO_TRANSITIONS` — povolené prechody `from → to` (importné aj exportné reťazce §7.1, ADR-032; `exported`
 *   a `shipped` sú konečné stavy),
 * - `CARGO_HOLDER_SPECS` — ktoré pole nesie držiteľa (loď, žeriav, berth…), ktoré slot a či je slot jedinečný,
 * - `CARGO_SPAWN_KINDS` — kde smie jednotka vzniknúť (import na lodi, export v kamióne — `CARGO_SPAWN_KIND_BY_DIRECTION`
 *   v ledgeri).
 *
 * `normalizeLocation` je jediná brána, cez ktorú vstupuje lokácia do `CargoLedger` (z kódu aj zo save): overí tvar
 * a vráti zmrazenú kópiu s kanonickým poradím kľúčov (`kind`, držiteľ, slot) — kvôli deterministickému JSON.
 */
import type { EntityId } from '../core/entity-id';
import { describeValue, isPlainObject, pointerSegment } from '../defs/def-spec';

export type CargoLocation =
  | { readonly kind: 'on_ship'; readonly shipId: EntityId }
  | { readonly kind: 'in_crane'; readonly craneId: EntityId }
  | { readonly kind: 'on_apron'; readonly berthId: EntityId; readonly slot: number }
  | { readonly kind: 'in_vehicle'; readonly vehicleId: EntityId }
  | { readonly kind: 'in_handler'; readonly machineId: EntityId }
  | { readonly kind: 'in_storage'; readonly moduleId: EntityId; readonly slot: number }
  | { readonly kind: 'in_pipeline'; readonly pipelineId: EntityId }
  | { readonly kind: 'at_ramp'; readonly rampId: EntityId; readonly dock: number }
  | { readonly kind: 'in_truck'; readonly truckId: EntityId }
  | { readonly kind: 'in_train'; readonly trainId: EntityId }
  | { readonly kind: 'exported' }
  | { readonly kind: 'shipped' };

export type CargoLocationKind = CargoLocation['kind'];

/** Člen únie podľa druhu, napr. `CargoLocationOf<'on_apron'>`. */
export type CargoLocationOf<K extends CargoLocationKind> = Extract<CargoLocation, { readonly kind: K }>;

/**
 * Konečné stavy bez držiteľa (ADR-014, ADR-032): `exported` — jednotka opustila mapu po súši (kamión, vlak),
 * `shipped` — odplávala na lodi (export). Ledger ich neeviduje, ostávajú len počítadlá `exportedCount` / `shippedCount`.
 */
export type CargoTerminalKind = 'exported' | 'shipped';

/** Druhy lokácií na mape s držiteľom (entitou, v ktorej jednotka je) — všetky okrem konečných stavov. */
export type CargoHolderKind = Exclude<CargoLocationKind, CargoTerminalKind>;

/** Poradie jednotiek v indexe držiteľa: `id` = vzostupne podľa id, `arrival` = v poradí príchodu (FIFO). */
export type CargoIndexOrder = 'id' | 'arrival';

/** Kľúče lokácie `L`, ktorých hodnota je `EntityId` (držiteľ). */
type IdKeyOf<L> = { [P in keyof L]-?: L[P] extends EntityId ? P : never }[keyof L];
/** Číselné kľúče lokácie `L` okrem držiteľa (slot, dock). */
type NumberKeyOf<L> = { [P in keyof L]-?: L[P] extends EntityId ? never : L[P] extends number ? P : never }[keyof L];
type OrNull<T> = [T] extends [never] ? null : T;

/** Opis druhu lokácie s držiteľom; typ vynúti, že kľúče zodpovedajú členu únie `CargoLocation`. */
export interface CargoHolderSpec<K extends CargoHolderKind = CargoHolderKind> {
  /** Pole s id držiteľa (`shipId`, `berthId`, …). */
  readonly holderKey: IdKeyOf<CargoLocationOf<K>>;
  /** Pole s číslom miesta u držiteľa (`slot`, `dock`), alebo `null`. */
  readonly slotKey: OrNull<NumberKeyOf<CargoLocationOf<K>>>;
  /** `true` = jedno miesto u držiteľa smie obsadiť najviac jedna jednotka. */
  readonly uniqueSlot: boolean;
  readonly order: CargoIndexOrder;
}

/** Tvar `CargoHolderSpec` bez typových parametrov — pre generický kód ledgera. */
export interface AnyCargoHolderSpec {
  readonly holderKey: string;
  readonly slotKey: string | null;
  readonly uniqueSlot: boolean;
  readonly order: CargoIndexOrder;
}

/**
 * Druhy lokácií s držiteľom. Slot apronu aj skladu je jedinečný (§7.7 `slots: (EntityId | null)[]`), dock rampy nie —
 * na jednom docku čaká viac jednotiek na kamión (§7.5). Loď vydáva jednotky od najmenšieho id (§7.2 / T02-05),
 * ostatní držitelia vo FIFO.
 */
export const CARGO_HOLDER_SPECS: { readonly [K in CargoHolderKind]: CargoHolderSpec<K> } = Object.freeze({
  on_ship: { holderKey: 'shipId', slotKey: null, uniqueSlot: false, order: 'id' },
  in_crane: { holderKey: 'craneId', slotKey: null, uniqueSlot: false, order: 'arrival' },
  on_apron: { holderKey: 'berthId', slotKey: 'slot', uniqueSlot: true, order: 'arrival' },
  in_vehicle: { holderKey: 'vehicleId', slotKey: null, uniqueSlot: false, order: 'arrival' },
  in_handler: { holderKey: 'machineId', slotKey: null, uniqueSlot: false, order: 'arrival' },
  in_storage: { holderKey: 'moduleId', slotKey: 'slot', uniqueSlot: true, order: 'arrival' },
  in_pipeline: { holderKey: 'pipelineId', slotKey: null, uniqueSlot: false, order: 'arrival' },
  at_ramp: { holderKey: 'rampId', slotKey: 'dock', uniqueSlot: false, order: 'arrival' },
  in_truck: { holderKey: 'truckId', slotKey: null, uniqueSlot: false, order: 'arrival' },
  in_train: { holderKey: 'trainId', slotKey: null, uniqueSlot: false, order: 'arrival' },
});

/**
 * Povolené prechody (§7.1). Reťazce:
 * - import container/bulk: `on_ship → in_crane → on_apron → in_vehicle → in_storage → in_vehicle → at_ramp → in_truck | in_train → exported`,
 * - liquid/gas: `on_ship → in_pipeline → in_storage → in_pipeline → at_ramp → …`,
 * - RoRo: `on_ship → in_vehicle (auto samo) → in_storage (lot) → in_vehicle → at_ramp → in_truck → exported`,
 * - export kontajner (F6a, ADR-032 bod 3, reverzný reťazec): vznik `in_truck` → `at_ramp` (kamión vyloží na docku)
 *   → `in_vehicle` → `in_storage` → `in_vehicle` → `on_apron` → `in_crane` → `on_ship` → `shipped` (loď opustila
 *   mapu); „last minute" `at_ramp → in_vehicle → on_apron` bez skladu; vrátenie odosielateľovi ide importnou pozemnou
 *   vetvou `in_storage → in_vehicle → at_ramp → in_truck → exported`,
 * - odovzdávanie pod hákom (F6a, ADR-033, `handoverMode: 'under_hook'`): vykládka `on_ship → in_crane → in_vehicle →
 *   in_storage`, nakládka `in_storage → in_vehicle → in_crane → on_ship` — jednotka sa medzi žeriavom a vozidlom odovzdá
 *   priamo (`in_crane ↔ in_vehicle`), apron ostáva len buffer (`in_crane → on_apron`).
 * - stroj bloku (R3, ADR-040 bod 3, TERMINAL_2 §6.10): vykládka `in_vehicle → in_handler → in_storage` (RTG zdvihne z ťahača a uloží do stohu), nakládka
 *   `in_storage → in_handler → in_vehicle`; `in_handler` drží najviac jednu jednotku (stroj) a je vždy len prechodová poloha.
 * Tabuľka je podľa druhu lokácie, nie kategórie nákladu ani smeru — kompatibilitu kategórie so žeriavom/potrubím/vozidlom
 * a smer toku strážia systémy.
 */
const TRANSITIONS: { readonly [K in CargoLocationKind]: readonly CargoLocationKind[] } = {
  on_ship: ['in_crane', 'in_pipeline', 'in_vehicle', 'shipped'],
  in_crane: ['on_apron', 'on_ship', 'in_vehicle'],
  on_apron: ['in_vehicle', 'in_crane'],
  in_vehicle: ['in_storage', 'at_ramp', 'on_apron', 'in_crane', 'in_handler'],
  in_handler: ['in_storage', 'in_vehicle'],
  in_storage: ['in_vehicle', 'in_pipeline', 'in_handler'],
  in_pipeline: ['in_storage', 'at_ramp'],
  at_ramp: ['in_truck', 'in_train', 'in_vehicle'],
  in_truck: ['exported', 'at_ramp'],
  in_train: ['exported'],
  exported: [],
  shipped: [],
};

/** Všetky druhy lokácií v poradí §7.1 (poradie tabuľky prechodov). */
export const CARGO_LOCATION_KINDS: readonly CargoLocationKind[] = Object.freeze(Object.keys(TRANSITIONS) as CargoLocationKind[]);

/** Druhy lokácií s držiteľom v poradí `CARGO_LOCATION_KINDS`. */
export const CARGO_HOLDER_KINDS: readonly CargoHolderKind[] = Object.freeze(Object.keys(CARGO_HOLDER_SPECS) as CargoHolderKind[]);

/** Tabuľka povolených prechodov `from → [to…]` (dáta, nie switch); konečné stavy (`exported`, `shipped`) nemajú výstupy. */
export const CARGO_TRANSITIONS: ReadonlyMap<CargoLocationKind, readonly CargoLocationKind[]> = new Map(
  CARGO_LOCATION_KINDS.map((kind) => [kind, Object.freeze([...TRANSITIONS[kind]])] as const),
);

/**
 * Kde smie jednotka vzniknúť (`CargoLedger.create`): import na lodi (F2), export v kamióne pri jeho spawne (F6a,
 * ADR-032 bod 3). Konkrétny druh podľa smeru jednotky určuje `CARGO_SPAWN_KIND_BY_DIRECTION` v ledgeri.
 */
export const CARGO_SPAWN_KINDS: readonly CargoLocationKind[] = Object.freeze(['on_ship', 'in_truck']);

/** Konečné stavy (bez držiteľa) v poradí `CARGO_LOCATION_KINDS`. */
export const CARGO_TERMINAL_KINDS: readonly CargoTerminalKind[] = Object.freeze(['exported', 'shipped']);

const HOLDER_SPECS_BY_KIND: ReadonlyMap<string, AnyCargoHolderSpec> = new Map(
  CARGO_HOLDER_KINDS.map((kind): [string, AnyCargoHolderSpec] => [kind, CARGO_HOLDER_SPECS[kind]]),
);

/** Je `kind` známy druh lokácie? (Vstup zo save alebo zvonka simu.) */
export function isCargoLocationKind(kind: unknown): kind is CargoLocationKind {
  return typeof kind === 'string' && CARGO_TRANSITIONS.has(kind as CargoLocationKind);
}

/** Smie jednotka prejsť z lokácie druhu `from` do `to`? Rovnaký druh (napr. apron → apron) nie je prechod. */
export function isTransitionAllowed(from: CargoLocationKind, to: CargoLocationKind): boolean {
  return CARGO_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Opis držiteľa pre druh lokácie; `undefined` pre lokáciu mimo mapy (`exported`, `shipped`). */
export function holderSpecOf(kind: CargoLocationKind): AnyCargoHolderSpec | undefined {
  return HOLDER_SPECS_BY_KIND.get(kind);
}

/** Polia lokácie ako záznam (generický prístup podľa kľúčov z `CARGO_HOLDER_SPECS`). */
function fieldsOf(location: CargoLocation): Readonly<Record<string, unknown>> {
  return location;
}

/** Id držiteľa lokácie (loď, žeriav, berth…); `null` pre konečné stavy (`exported`, `shipped`). */
export function holderIdOf(location: CargoLocation): EntityId | null {
  const spec = holderSpecOf(location.kind);
  return spec === undefined ? null : (fieldsOf(location)[spec.holderKey] as EntityId);
}

/** Číslo miesta u držiteľa (`slot`, `dock`); `null`, ak ho druh lokácie nemá. */
export function slotOf(location: CargoLocation): number | null {
  const slotKey = holderSpecOf(location.kind)?.slotKey ?? null;
  return slotKey === null ? null : (fieldsOf(location)[slotKey] as number);
}

/**
 * Jedinečné miesto lokácie (slot apronu/skladu, `uniqueSlot`); `null` pre druhy bez jedinečných miest (loď, žeriav,
 * dock rampy…). Druh s `uniqueSlot` má vždy `slotKey`, takže výsledok je pre neho vždy číslo.
 */
export function uniqueSlotOf(location: CargoLocation): number | null {
  return holderSpecOf(location.kind)?.uniqueSlot === true ? slotOf(location) : null;
}

/** Sú dve lokácie tá istá poloha (rovnaký druh, držiteľ a miesto)? Bez alokácie. */
export function isSameLocation(a: CargoLocation, b: CargoLocation): boolean {
  return a.kind === b.kind && holderIdOf(a) === holderIdOf(b) && slotOf(a) === slotOf(b);
}

/** Čitateľný opis pre chybové správy: `on_apron(berthId=3, slot=1)`, `exported`. */
export function formatLocation(location: CargoLocation): string {
  const spec = holderSpecOf(location.kind);
  if (spec === undefined) return location.kind;
  const fields = fieldsOf(location);
  const parts = [`${spec.holderKey}=${String(fields[spec.holderKey])}`];
  if (spec.slotKey !== null) parts.push(`${spec.slotKey}=${String(fields[spec.slotKey])}`);
  return `${location.kind}(${parts.join(', ')})`;
}

/** Výsledok `normalizeLocation`: zmrazená kanonická lokácia, alebo problém s JSON pointerom relatívnym k lokácii. */
export type NormalizedLocation =
  | { readonly ok: true; readonly location: CargoLocation }
  | { readonly ok: false; readonly path: string; readonly problem: string };

/** Id entity: bezpečné celé číslo ≥ 1 (alokátor prideľuje od 1, `EntityIdAllocator`). */
export function isEntityIdValue(value: unknown): value is EntityId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isSlotValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const fail = (path: string, problem: string): NormalizedLocation => ({ ok: false, path, problem });

/**
 * Overí lokáciu (aj z `JSON.parse`) a vráti jej zmrazenú kópiu s kľúčmi v kanonickom poradí `kind`, držiteľ, slot.
 * Požiadavky: objekt so známym `kind`, presne kľúče daného druhu, držiteľ = celé číslo ≥ 1, slot/dock = celé ≥ 0.
 * Existenciu držiteľa (lode, berthu…) ani rozsah slotu voči kapacite neoveruje — to je vec modulov (T02-03).
 */
export function normalizeLocation(raw: unknown): NormalizedLocation {
  if (!isPlainObject(raw)) return fail('', `lokácia musí byť objekt, dostal ${describeValue(raw)}`);
  const { kind } = raw;
  if (!isCargoLocationKind(kind)) {
    return fail('/kind', `neznámy druh lokácie ${describeValue(kind)} (známe: ${CARGO_LOCATION_KINDS.join(', ')})`);
  }
  const spec = holderSpecOf(kind);
  const keys = ['kind'];
  if (spec !== undefined) keys.push(spec.holderKey);
  if (spec?.slotKey != null) keys.push(spec.slotKey);
  const unknownKey = Object.keys(raw).find((key) => !keys.includes(key));
  if (unknownKey !== undefined) {
    return fail(pointerSegment(unknownKey), `neznámy kľúč pre lokáciu '${kind}' (kľúče: ${keys.join(', ')})`);
  }
  const missingKey = keys.find((key) => !Object.hasOwn(raw, key));
  if (missingKey !== undefined) return fail(pointerSegment(missingKey), `chýba povinný kľúč lokácie '${kind}'`);

  const normalized: Record<string, unknown> = { kind };
  if (spec !== undefined) {
    const holder = raw[spec.holderKey];
    if (!isEntityIdValue(holder)) {
      return fail(pointerSegment(spec.holderKey), `id držiteľa musí byť celé číslo ≥ 1, dostal ${describeValue(holder)}`);
    }
    normalized[spec.holderKey] = holder;
    if (spec.slotKey !== null) {
      const slot = raw[spec.slotKey];
      if (!isSlotValue(slot)) return fail(pointerSegment(spec.slotKey), `miesto musí byť celé číslo ≥ 0, dostal ${describeValue(slot)}`);
      normalized[spec.slotKey] = slot;
    }
  }
  return { ok: true, location: Object.freeze(normalized) as CargoLocation };
}
