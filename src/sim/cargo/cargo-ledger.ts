/**
 * CargoLedger — jediný zdroj polohy nákladu (ARCHITECTURE §7.1, pravidlo 2 „nič sa neteleportuje“).
 *
 * - `create` pridelí id zo spoločného `world.ids`, `quantity = cargoType.unitsPerBatch` (ADR-003) a jednotku so štítkami
 *   (`CargoUnitLabels`, ADR-032) zaradí do lokácie vzniku podľa smeru (`CARGO_SPAWN_KIND_BY_DIRECTION`: import
 *   `on_ship`, export `in_truck`). Udalosť nemá — vznik ohlási zdroj (`ShipSpawned`, spawn exportného kamióna).
 * - `move` je jediný spôsob zmeny polohy: overí prechod podľa `CARGO_TRANSITIONS`, tvar cieľa a voľné jedinečné
 *   miesto (slot apronu/skladu), potom **atomicky** prepíše indexy a emituje `CargoMoved { unitId, from, to, tick }`.
 *   Pri akejkoľvek chybe sa nezmení nič a nič sa neemituje.
 * - Presun do lokácie bez držiteľa (`exported`, `shipped` — ADR-032) jednotku z ledgera odstráni; ostane len
 *   v počítadle `exportedCount` / `shippedCount` (save nerastie s každým vyvezeným kontajnerom). `get` pre ňu vráti
 *   `undefined` a ďalší `move` zlyhá (`unknown_unit`) — oba sú konečné stavy.
 * - `setHold` mení len zadržanie jednotky (VGM, ADR-032 bod 5), nie polohu — nová zmrazená jednotka na tom istom
 *   mieste indexu, bez udalosti (udalosť emituje systém, ktorý hold zmenil).
 * - `setStatus` mení len stav kvality prázdneho kontajnera (kontrola a M&R v depe, ADR-034) rovnakým spôsobom ako `setHold`.
 *
 * Indexy: pre každý druh lokácie s držiteľom `id držiteľa → { units, slots }`; loď drží jednotky vzostupne podľa id,
 * ostatní vo FIFO. Prázdny index sa odstráni. Jednotky sú zmrazené hodnoty — presun vytvorí novú jednotku, takže
 * objekt z `get()` ani lokácie v udalostiach sa už nezmenia.
 */
import type { ContractId, EntityId, EntityIdAllocator } from '../core/entity-id';
import type { Catalog } from '../defs/catalog';
import type { CargoTypeDef, ContainerTypeDef } from '../defs/types';
import type { CargoMovedEvent } from '../events/sim-event';
import { findConservationViolation } from './cargo-conservation';
import { CargoConservationError, CargoError, CargoTransitionError } from './cargo-error';
import {
  CARGO_HOLDER_KINDS,
  CARGO_LOCATION_KINDS,
  CARGO_SPAWN_KINDS,
  CARGO_TRANSITIONS,
  IN_HANDLER_CAPACITY,
  formatLocation,
  holderIdOf,
  holderSpecOf,
  isEntityIdValue,
  isTransitionAllowed,
  normalizeLocation,
  uniqueSlotOf,
  type CargoHolderKind,
  type CargoLocation,
  type CargoLocationKind,
} from './cargo-location';
import { parseCargoLedgerState, type CargoLedgerState } from './cargo-ledger-state';
import type { StorageGuards } from './storage-guard';
import {
  DEFAULT_CARGO_STATUS,
  DEFAULT_CONTAINER_LABELS,
  IMPORT_LABELS,
  OUTBOUND_BY_DIRECTION,
  cargoHoldProblem,
  cargoLabelsProblem,
  cargoStatusProblem,
  containerLabelsDefProblem,
  needsPlug,
  reeferStateProblem,
  teuOf,
  type CargoDirection,
  type CargoHold,
  type CargoStatus,
  type CargoUnit,
  type CargoUnitLabels,
  type CargoUnitLabelsInput,
  type ReeferState,
} from './cargo-unit';

/** Závislosti ledgera od sveta (v `World` sú to `defs.cargoTypes`, `ids`, `events`, `clock`). */
export interface CargoLedgerDeps {
  readonly cargoTypes: Catalog<Readonly<CargoTypeDef>>;
  /** Typy kontajnerov (`defs.containerTypes`, ADR-039): `create` a obnova save overia `containerType`, veľkosť a nadrozmer. */
  readonly containerTypes: Catalog<Readonly<ContainerTypeDef>>;
  /** Spoločný alokátor id sveta — jednotky nákladu dostávajú id z rovnakej postupnosti ako ostatné entity. */
  readonly ids: EntityIdAllocator;
  /** Cieľ udalostí `CargoMoved` (`world.events`). */
  readonly events: { emit(event: CargoMovedEvent): void };
  /** Zdroj `CargoMoved.tick` (`world.clock`). */
  readonly clock: { readonly tick: number };
  /**
   * Voliteľný pozorovateľ presunov (F5, ADR-026: počítadlá kontraktov) — volá sa po každom úspešnom `move` hneď po
   * `CargoMoved` s jednotkou **pred** presunom a cieľom. Nesmie vyhodiť ani meniť ledger (presun je už hotový).
   */
  readonly observer?: CargoMoveObserver;
  /** Stráž skladov so stohmi (ADR-039): kontroluje pravidlá stohu pri presune do skladu / zo skladu. Bez nej sa pravidlá nekontrolujú (samostatný ledger). */
  readonly storageGuard?: StorageGuards;
}

/** Pozorovateľ presunov nákladu (`CargoLedgerDeps.observer`). */
export interface CargoMoveObserver {
  cargoMoved(unit: CargoUnit, to: CargoLocation): void;
}

/**
 * Čítanie polohy nákladu bez možnosti presunu (T03-02, review T02-13): moduly, ktoré majú sloty (apron, sklad),
 * odvodzujú obsadenie z ledgera a držia len rezervácie — ledger ostáva jediným zdrojom polohy (pravidlo 2).
 * `unitAtIndex` (T04-02): rampa počíta jednotky na docku prechodom svojich jednotiek bez kópie (dock nie je jedinečné
 * miesto, ledger ho neindexuje).
 */
export type CargoReader = Pick<CargoLedger, 'containerTypeOf' | 'get' | 'unitsAt' | 'countAt' | 'teuAt' | 'firstUnitAt' | 'unitAtSlot' | 'unitAtIndex'>;

/** Index jednotiek jedného držiteľa. */
interface Bucket {
  readonly units: EntityId[];
  /** Miesto → jednotka; len pre druhy s `uniqueSlot`. */
  readonly slots: Map<number, EntityId> | null;
  /** Počet jednotiek smeru `export` a `empty` v `units` (`OUTBOUND_BY_DIRECTION`, `CargoLedger.countExportsAt`, O(1) — pre import / export na palube lode). */
  exports: number;
  /** Počet jednotiek smeru `tranship` v `units` (`CargoLedger.countTranshipAt`, O(1)); na lodi A sú vykladané, na lodi B naložené. */
  tranships: number;
  /** Súčet TEU jednotiek v `units` (`teuOf`, ADR-039; `CargoLedger.teuAt`, O(1) — kapacita lode v TEU). */
  teu: number;
}

const NO_UNITS: readonly EntityId[] = Object.freeze([]);

/** Vloží id do vzostupne zoradeného poľa (binárne vyhľadanie pozície). */
function insertSorted(ids: EntityId[], id: EntityId): void {
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ids[mid] < id) low = mid + 1;
    else high = mid;
  }
  ids.splice(low, 0, id);
}

/**
 * Lokácia vzniku jednotky podľa smeru (ADR-032 bod 3, ADR-034): import a tranship vznikajú na lodi (`spawnShip`), export
 * a prázdny kontajner v kamióne pri jeho spawne (krok 8). Zjednotenie hodnôt = `CARGO_SPAWN_KINDS`.
 */
export const CARGO_SPAWN_KIND_BY_DIRECTION: { readonly [D in CargoDirection]: CargoLocationKind } = Object.freeze({
  import: 'on_ship',
  export: 'in_truck',
  tranship: 'on_ship',
  empty: 'in_truck',
});

/** Mutovateľný stav jednotky mimo polohy — `hold` a stav kvality (`setHold`, `setStatus`). */
interface UnitState {
  readonly hold: CargoHold | null;
  readonly status: CargoStatus;
  readonly repairUntilTick: number | null;
  readonly reefer: ReeferState | null;
}

/** Zmrazená jednotka s kanonickým poradím kľúčov (`id, typeId, contractId, štítky, hold, status, repairUntilTick, quantity, location`). */
function freezeUnit(base: Omit<CargoUnit, 'location' | 'hold' | 'status' | 'repairUntilTick' | 'reefer'>, state: UnitState, location: CargoLocation): CargoUnit {
  return Object.freeze({
    id: base.id,
    typeId: base.typeId,
    contractId: base.contractId,
    voyageId: base.voyageId,
    lineId: base.lineId,
    direction: base.direction,
    destinationPort: base.destinationPort,
    weightClass: base.weightClass,
    sizeFt: base.sizeFt,
    containerType: base.containerType,
    oog: base.oog,
    hold: state.hold,
    status: state.status,
    repairUntilTick: state.repairUntilTick,
    reefer: state.reefer,
    quantity: base.quantity,
    location,
  });
}

/** Počiatočný stav reeferu: na palube napájaný z lode, inak bez napájania od `tick`. */
function freshReefer(onShip: boolean, tick: number): ReeferState {
  return Object.freeze({ plugged: onShip, unpluggedSinceTick: onShip ? null : tick, switchAtTick: null, waitSinceTick: null, alarmUntilTick: null, fixUntilTick: null });
}

/** Počiatočný stav novej jednotky: bez zadržania, `available`. */
const FRESH_STATE: UnitState = Object.freeze({ hold: null, status: DEFAULT_CARGO_STATUS, repairUntilTick: null, reefer: null });

function zeroCounts(): Record<CargoLocationKind, number> {
  return Object.fromEntries(CARGO_LOCATION_KINDS.map((kind) => [kind, 0])) as Record<CargoLocationKind, number>;
}

/** Nezmrazená kópia jednotky pre save (kanonické poradie kľúčov ako `freezeUnit`; nezdieľa objekty s ledgerom). */
function unitState(unit: CargoUnit): CargoUnit {
  return {
    id: unit.id,
    typeId: unit.typeId,
    contractId: unit.contractId,
    voyageId: unit.voyageId,
    lineId: unit.lineId,
    direction: unit.direction,
    destinationPort: unit.destinationPort,
    weightClass: unit.weightClass,
    sizeFt: unit.sizeFt,
    containerType: unit.containerType,
    oog: unit.oog,
    hold: unit.hold === null ? null : { reason: unit.hold.reason, untilTick: unit.hold.untilTick },
    status: unit.status,
    repairUntilTick: unit.repairUntilTick,
    reefer: unit.reefer === null ? null : { ...unit.reefer },
    quantity: unit.quantity,
    location: { ...unit.location },
  };
}

export class CargoLedger {
  private readonly deps: CargoLedgerDeps;
  /** Živé jednotky (na mape) podľa id. */
  private readonly units = new Map<EntityId, CargoUnit>();
  /** Druh lokácie s držiteľom → id držiteľa → index. */
  private readonly buckets: ReadonlyMap<CargoLocationKind, Map<EntityId, Bucket>>;
  /** Počet jednotiek podľa druhu lokácie; `exported` = počet exportovaných. */
  private readonly counts: Record<CargoLocationKind, number> = zeroCounts();
  private created = 0;

  constructor(deps: CargoLedgerDeps) {
    this.deps = deps;
    this.buckets = new Map(CARGO_HOLDER_KINDS.map((kind) => [kind, new Map<EntityId, Bucket>()] as const));
  }

  /**
   * Obnoví ledger zo `getState()` (aj po `JSON.parse`). Neplatný stav → `CargoStateError` s JSON pointerom
   * (pozri `parseCargoLedgerState`). Poradie FIFO indexov sa obnoví z poradia `units`.
   */
  static fromState(raw: unknown, deps: CargoLedgerDeps): CargoLedger {
    const state = parseCargoLedgerState(raw, deps.cargoTypes, deps.ids.getState().nextId, deps.containerTypes);
    const ledger = new CargoLedger(deps);
    for (const unit of state.units) ledger.place(unit);
    ledger.created = state.createdCount;
    ledger.counts.exported = state.exportedCount;
    ledger.counts.shipped = state.shippedCount;
    return ledger;
  }

  /** Počet jednotiek vytvorených za celú hru. */
  get createdCount(): number {
    return this.created;
  }

  /** Počet jednotiek, ktoré opustili mapu. */
  get exportedCount(): number {
    return this.counts.exported;
  }

  /** Počet jednotiek, ktoré odplávali na lodi (`shipped`, ADR-032). */
  get shippedCount(): number {
    return this.counts.shipped;
  }

  /** Počet jednotiek na mape (`createdCount − exportedCount − shippedCount`). */
  get liveCount(): number {
    return this.units.size;
  }

  /**
   * Nová jednotka typu `typeId` v lokácii `location` so štítkami `labels` (predvolene import bez kontraktu,
   * `IMPORT_LABELS`); `hold` je `null` a stav `available`. Lokácia musí byť miesto vzniku smeru jednotky
   * (`CARGO_SPAWN_KIND_BY_DIRECTION`: import a tranship `on_ship`, export a prázdny `in_truck`). Chyby (stav sa nezmení a id sa
   * nespotrebuje): neznámy typ → `CargoError('unknown_cargo_type')`, neplatná lokácia, `contractId` alebo štítky
   * (`cargoLabelsProblem`: export bez kontraktu, voyage alebo cieľového prístavu, import s cieľovým prístavom…) →
   * `CargoError('invalid_input')`, lokácia mimo miesta vzniku smeru → `CargoTransitionError`, obsadené miesto →
   * `CargoError('slot_occupied')`.
   */
  create(typeId: string, location: CargoLocation, contractId: ContractId | null = null, input: CargoUnitLabelsInput = IMPORT_LABELS): CargoUnit {
    if (!this.deps.cargoTypes.has(typeId)) {
      throw new CargoError('unknown_cargo_type', `CargoLedger.create: neznámy typ nákladu '${typeId}'`);
    }
    const target = this.normalizeTarget(location, 'CargoLedger.create');
    if (contractId !== null && !isEntityIdValue(contractId)) {
      throw new CargoError('invalid_input', `CargoLedger.create: contractId musí byť null alebo celé číslo ≥ 1, dostal ${String(contractId)}`);
    }
    const labels: CargoUnitLabels = { ...DEFAULT_CONTAINER_LABELS, ...input };
    const labelProblem = cargoLabelsProblem(labels, contractId) ?? containerLabelsDefProblem(labels, this.deps.containerTypes);
    if (labelProblem !== undefined) throw new CargoError('invalid_input', `CargoLedger.create: ${labelProblem.field}: ${labelProblem.problem}`);
    const spawnKind = CARGO_SPAWN_KIND_BY_DIRECTION[labels.direction];
    if (!CARGO_SPAWN_KINDS.includes(target.kind) || target.kind !== spawnKind) {
      throw new CargoTransitionError(null, null, target, `${labels.direction} jednotka smie vzniknúť len v: ${spawnKind}`);
    }
    this.assertSlotFree(target, null);
    const { unitsPerBatch } = this.deps.cargoTypes.get(typeId);
    // Od tohto bodu nič nevyhadzuje: id sa spotrebuje len pre skutočne vytvorenú jednotku.
    const base = { id: this.deps.ids.next(), typeId, contractId, ...labels, quantity: unitsPerBatch };
    // Reefer (R5, ADR-042): na palube je napájaný z lode, inak vzniká bez napájania (kamión) — hodiny bez napájania bežia od vzniku.
    const reefer = needsPlug({ containerType: labels.containerType, direction: labels.direction }, this.deps.containerTypes) ? freshReefer(target.kind === 'on_ship', this.deps.clock.tick) : null;
    const unit = freezeUnit(base, { ...FRESH_STATE, reefer }, target);
    this.place(unit);
    this.created += 1;
    return unit;
  }

  /**
   * Zmení zadržanie jednotky (VGM hold, ADR-032 bod 5) — poloha ani poradie v indexe sa nemenia, udalosť nevzniká
   * (`VgmHoldStarted` / `VgmHoldReleased` emituje volajúci systém). Chyby (stav sa nezmení): neznáma alebo exportovaná
   * jednotka → `CargoError('unknown_unit')`, neplatný hold alebo hold import jednotky (`cargoHoldProblem`) →
   * `CargoError('invalid_input')`.
   */
  setHold(unitId: EntityId, hold: CargoHold | null): CargoUnit {
    const unit = this.units.get(unitId);
    if (unit === undefined) {
      throw new CargoError('unknown_unit', `CargoLedger.setHold: jednotka #${String(unitId)} neexistuje (neznáme id alebo už opustila mapu)`);
    }
    const problem = cargoHoldProblem(hold, unit.direction);
    if (problem !== undefined) throw new CargoError('invalid_input', `CargoLedger.setHold(#${String(unitId)}): ${problem}`);
    const next = freezeUnit(unit, { ...unit, hold: hold === null ? null : Object.freeze({ reason: hold.reason, untilTick: hold.untilTick }) }, unit.location);
    this.units.set(unitId, next);
    return next;
  }

  /**
   * Zmení stav kvality jednotky (kontrola a M&R prázdneho kontajnera, ADR-034) — poloha ani poradie v indexe sa nemenia,
   * udalosť nevzniká (`EmptyDamaged`, `EmptyRepairStarted`, `EmptyRepaired` emituje volajúci systém). `repairUntilTick` je
   * povinný práve pri `in_repair` (inak `null`). Chyby (stav sa nezmení): neznáma alebo odídená jednotka →
   * `CargoError('unknown_unit')`, neplatná kombinácia alebo jednotka, ktorá nie je prázdna (`cargoStatusProblem`) →
   * `CargoError('invalid_input')`.
   */
  setStatus(unitId: EntityId, status: CargoStatus, repairUntilTick: number | null = null): CargoUnit {
    const unit = this.units.get(unitId);
    if (unit === undefined) {
      throw new CargoError('unknown_unit', `CargoLedger.setStatus: jednotka #${String(unitId)} neexistuje (neznáme id alebo už opustila mapu)`);
    }
    const problem = cargoStatusProblem(status, repairUntilTick, unit.direction);
    if (problem !== undefined) throw new CargoError('invalid_input', `CargoLedger.setStatus(#${String(unitId)}): ${problem}`);
    const next = freezeUnit(unit, { hold: unit.hold, status, repairUntilTick, reefer: unit.reefer }, unit.location);
    this.units.set(unitId, next);
    return next;
  }

  /**
   * Zmení stav reeferu (R5, ADR-042) — poloha ani poradie v indexe sa nemenia, udalosť nevzniká (hlási ju volajúci systém). Chyby (stav sa nezmení): neznáma jednotka →
   * `CargoError('unknown_unit')`, jednotka, ktorá reefer nie je (`needsPlug`), alebo neplatný stav (`reeferStateProblem`) → `CargoError('invalid_input')`.
   */
  setReefer(unitId: EntityId, reefer: ReeferState): CargoUnit {
    const unit = this.units.get(unitId);
    if (unit === undefined) {
      throw new CargoError('unknown_unit', `CargoLedger.setReefer: jednotka #${String(unitId)} neexistuje (neznáme id alebo už opustila mapu)`);
    }
    if (unit.reefer === null) throw new CargoError('invalid_input', `CargoLedger.setReefer(#${String(unitId)}): jednotka nie je reefer so zásuvkou (typ ${unit.containerType}, smer ${unit.direction})`);
    const problem = reeferStateProblem(reefer);
    if (problem !== undefined) throw new CargoError('invalid_input', `CargoLedger.setReefer(#${String(unitId)}): ${problem}`);
    const next = freezeUnit(unit, { hold: unit.hold, status: unit.status, repairUntilTick: unit.repairUntilTick, reefer: Object.freeze({ ...reefer }) }, unit.location);
    this.units.set(unitId, next);
    return next;
  }

  /** Def typu kontajnera jednotky (pravidlá stohu), alebo `undefined` pre neznámu jednotku. */
  containerTypeOf(unitId: EntityId): Readonly<ContainerTypeDef> | undefined {
    const unit = this.units.get(unitId);
    return unit === undefined ? undefined : this.deps.containerTypes.get(unit.containerType);
  }

  /**
   * Presunie jednotku do `to` a emituje `CargoMoved`. Chyby (stav sa nezmení, nič sa neemituje): neznáma alebo
   * exportovaná jednotka → `CargoError('unknown_unit')`, neplatná lokácia → `CargoError('invalid_input')`,
   * nepovolený prechod (§7.1) → `CargoTransitionError`, obsadené jedinečné miesto → `CargoError('slot_occupied')`,
   * poškodený index → `CargoConservationError`.
   */
  move(unitId: EntityId, to: CargoLocation): void {
    const unit = this.units.get(unitId);
    if (unit === undefined) {
      throw new CargoError('unknown_unit', `CargoLedger.move: jednotka #${String(unitId)} neexistuje (neznáme id alebo už exportovaná)`);
    }
    const target = this.normalizeTarget(to, `CargoLedger.move(#${String(unitId)})`);
    const from = unit.location;
    if (!isTransitionAllowed(from.kind, target.kind)) {
      const allowed = CARGO_TRANSITIONS.get(from.kind) ?? [];
      const hint = allowed.length === 0 ? `'${from.kind}' je konečný stav` : `z '${from.kind}' smie ísť len do: ${allowed.join(', ')}`;
      throw new CargoTransitionError(unitId, from, target, hint);
    }
    this.assertSlotFree(target, unitId);
    if (target.kind === 'in_handler' && this.countAt('in_handler', target.machineId) >= IN_HANDLER_CAPACITY) {
      throw new CargoError('slot_occupied', `CargoLedger: jednotka #${String(unitId)}: stroj #${String(target.machineId)} už drží ${String(IN_HANDLER_CAPACITY)} jednotku (in_handler ≤ ${String(IN_HANDLER_CAPACITY)})`);
    }
    const guards = this.deps.storageGuard;
    const takeGuard = guards !== undefined && from.kind === 'in_storage' ? guards(from.moduleId) : undefined;
    const placeGuard = guards !== undefined && target.kind === 'in_storage' ? guards(target.moduleId) : undefined;
    takeGuard?.assertCanTake(unit);
    placeGuard?.assertCanPlace(unit, target.kind === 'in_storage' ? target.slot : -1);
    const bucket = this.bucketOf(from);
    const index = bucket?.units.indexOf(unitId) ?? -1;
    if (bucket === undefined || index < 0) {
      throw new CargoConservationError(`jednotka #${String(unitId)} (${formatLocation(from)}) chýba v indexe svojej lokácie`);
    }

    // Od tohto bodu nič nevyhadzuje — presun je atomický.
    this.unplace(unit, bucket, index);
    this.place(freezeUnit(unit, unit, target));
    takeGuard?.taken(unit);
    placeGuard?.placed(unit, target.kind === 'in_storage' ? target.slot : -1);
    this.deps.events.emit({ type: 'CargoMoved', unitId, from, to: target, tick: this.deps.clock.tick });
    this.deps.observer?.cargoMoved(unit, target);
  }

  /** Jednotka na mape; `undefined` pre neznáme alebo exportované id. Vrátený objekt je zmrazená snímka. */
  get(unitId: EntityId): CargoUnit | undefined {
    return this.units.get(unitId);
  }

  /**
   * Živé jednotky (na mape) v poradí vzniku bez kópie — len na čítanie, pre zriedkavé dotazy (`stowageOutOfOrder`); počas
   * iterácie sa nesmie volať `create` ani `move` (mapa by sa menila).
   */
  liveUnits(): IterableIterator<CargoUnit> {
    return this.units.values();
  }

  /**
   * Id jednotiek u držiteľa v poradí jeho indexu (loď vzostupne podľa id, ostatní FIFO). Vracia **kópiu** —
   * dá sa bezpečne iterovať aj počas `move` jednotiek z nej.
   */
  unitsAt(kind: CargoHolderKind, holderId: EntityId): readonly EntityId[] {
    const bucket = this.buckets.get(kind)?.get(holderId);
    return bucket === undefined ? NO_UNITS : [...bucket.units];
  }

  /** Počet jednotiek u držiteľa (bez alokácie). */
  countAt(kind: CargoHolderKind, holderId: EntityId): number {
    return this.buckets.get(kind)?.get(holderId)?.units.length ?? 0;
  }

  /**
   * Počet jednotiek smeru `export` a `empty` (náklad na nakládku už podľa smeru, `OUTBOUND_BY_DIRECTION`) u držiteľa (bez alokácie,
   * O(1)); zvyšok `countAt` sú jednotky smeru `import` a `tranship` (`countTranshipAt`).
   */
  countExportsAt(kind: CargoHolderKind, holderId: EntityId): number {
    return this.buckets.get(kind)?.get(holderId)?.exports ?? 0;
  }

  /** Súčet TEU jednotiek u držiteľa (`teuOf`: 20′ = 1, 40′ = 2; bez alokácie, O(1)) — kapacita lode je v TEU (ADR-039). */
  teuAt(kind: CargoHolderKind, holderId: EntityId): number {
    return this.buckets.get(kind)?.get(holderId)?.teu ?? 0;
  }

  /** Počet jednotiek smeru `tranship` u držiteľa (bez alokácie, O(1)); či je na lodi vykladaná alebo naložená, určuje kontrakt. */
  countTranshipAt(kind: CargoHolderKind, holderId: EntityId): number {
    return this.buckets.get(kind)?.get(holderId)?.tranships ?? 0;
  }

  /**
   * Prvá jednotka v poradí indexu držiteľa (loď: najmenšie id, ostatní: najstaršia) bez alokácie; prázdny držiteľ →
   * `undefined`. Žeriav ňou vyberá jednotku z lode (ADR-016).
   */
  firstUnitAt(kind: CargoHolderKind, holderId: EntityId): EntityId | undefined {
    return this.buckets.get(kind)?.get(holderId)?.units[0];
  }

  /**
   * Jednotka na pozícii `index` v poradí indexu držiteľa (`0 … countAt − 1`) bez alokácie; mimo rozsahu `undefined`.
   * Dispatcher (T03-05) ňou prechádza aprony vo FIFO bez kópie zoznamu — počas prechodu sa nesmie volať `move`
   * jednotiek toho istého držiteľa.
   */
  unitAtIndex(kind: CargoHolderKind, holderId: EntityId, index: number): EntityId | undefined {
    return this.buckets.get(kind)?.get(holderId)?.units[index];
  }

  /** Jednotka na jedinečnom mieste držiteľa (slot apronu/skladu); pre druhy bez jedinečných miest vždy `undefined`. */
  unitAtSlot(kind: CargoHolderKind, holderId: EntityId, slot: number): EntityId | undefined {
    return this.buckets.get(kind)?.get(holderId)?.slots?.get(slot);
  }

  /** Jednotky na lodi vzostupne podľa id (kópia). */
  unitsOnShip(shipId: EntityId): readonly EntityId[] {
    return this.unitsAt('on_ship', shipId);
  }

  /** Jednotky na aprone berthu v poradí príchodu — FIFO (kópia). */
  unitsOnApron(berthId: EntityId): readonly EntityId[] {
    return this.unitsAt('on_apron', berthId);
  }

  /** Počet jednotiek v lokáciách daného druhu; `exported` = `exportedCount`, `shipped` = `shippedCount`. */
  countByKind(kind: CargoLocationKind): number {
    return this.counts[kind];
  }

  /** Invariant konzervácie (§6 krok 12, §16); porušenie → `CargoConservationError` s jednotkou a lokáciami. */
  assertConservation(): void {
    const violation = findConservationViolation({
      units: this.units,
      buckets: this.buckets,
      counts: this.counts,
      createdCount: this.created,
    });
    if (violation !== undefined) throw new CargoConservationError(violation);
  }

  /** Čistý JSON stav (tvar a poradie pozri `CargoLedgerState`); nezdieľa objekty s ledgerom. */
  getState(): CargoLedgerState {
    const units: CargoUnit[] = [];
    for (const kind of CARGO_HOLDER_KINDS) {
      const holders = this.buckets.get(kind);
      if (holders === undefined) continue;
      const holderIds = [...holders.keys()].sort((a, b) => a - b);
      for (const holderId of holderIds) {
        for (const unitId of holders.get(holderId)?.units ?? NO_UNITS) {
          const unit = this.units.get(unitId);
          if (unit !== undefined) units.push(unitState(unit));
        }
      }
    }
    return { createdCount: this.created, exportedCount: this.counts.exported, shippedCount: this.counts.shipped, units };
  }

  // -------------------------------------------------------------------------------------------------------
  // Vnútro: jediné miesta, ktoré menia indexy (volajú sa až po všetkých kontrolách).
  // -------------------------------------------------------------------------------------------------------

  private normalizeTarget(location: CargoLocation, context: string): CargoLocation {
    const normalized = normalizeLocation(location);
    if (!normalized.ok) throw new CargoError('invalid_input', `${context}: neplatná lokácia${normalized.path}: ${normalized.problem}`);
    return normalized.location;
  }

  private bucketOf(location: CargoLocation): Bucket | undefined {
    const holderId = holderIdOf(location);
    return holderId === null ? undefined : this.buckets.get(location.kind)?.get(holderId);
  }

  private assertSlotFree(target: CargoLocation, movingId: EntityId | null): void {
    const slot = uniqueSlotOf(target);
    if (slot === null) return;
    const occupant = this.bucketOf(target)?.slots?.get(slot);
    if (occupant !== undefined && occupant !== movingId) {
      const subject = movingId === null ? 'nová jednotka' : `jednotka #${String(movingId)}`;
      throw new CargoError('slot_occupied', `CargoLedger: ${subject}: miesto ${formatLocation(target)} už obsadila jednotka #${String(occupant)}`);
    }
  }

  /** Zaradí jednotku do jej lokácie (lokácia bez držiteľa = jednotka opúšťa ledger, ostáva len v počítadle). */
  private place(unit: CargoUnit): void {
    const { location } = unit;
    this.counts[location.kind] += 1;
    const spec = holderSpecOf(location.kind);
    const holders = this.buckets.get(location.kind);
    const holderId = holderIdOf(location);
    if (spec === undefined || holders === undefined || holderId === null) {
      this.units.delete(unit.id);
      return;
    }
    this.units.set(unit.id, unit);
    let bucket = holders.get(holderId);
    if (bucket === undefined) {
      bucket = { units: [], slots: spec.uniqueSlot ? new Map() : null, exports: 0, tranships: 0, teu: 0 };
      holders.set(holderId, bucket);
    }
    if (spec.order === 'id') insertSorted(bucket.units, unit.id);
    else bucket.units.push(unit.id);
    if (OUTBOUND_BY_DIRECTION[unit.direction]) bucket.exports += 1;
    if (unit.direction === 'tranship') bucket.tranships += 1;
    bucket.teu += teuOf(unit);
    const slot = uniqueSlotOf(location);
    if (slot !== null) bucket.slots?.set(slot, unit.id);
  }

  /** Vyradí jednotku z indexu jej lokácie (`index` = pozícia v `bucket.units`); prázdny index odstráni. */
  private unplace(unit: CargoUnit, bucket: Bucket, index: number): void {
    const { location } = unit;
    this.counts[location.kind] -= 1;
    bucket.units.splice(index, 1);
    if (OUTBOUND_BY_DIRECTION[unit.direction]) bucket.exports -= 1;
    if (unit.direction === 'tranship') bucket.tranships -= 1;
    bucket.teu -= teuOf(unit);
    const slot = uniqueSlotOf(location);
    if (slot !== null) bucket.slots?.delete(slot);
    const holderId = holderIdOf(location);
    if (bucket.units.length === 0 && holderId !== null) this.buckets.get(location.kind)?.delete(holderId);
  }
}
