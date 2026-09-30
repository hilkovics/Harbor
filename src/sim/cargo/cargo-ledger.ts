/**
 * CargoLedger — jediný zdroj polohy nákladu (ARCHITECTURE §7.1, pravidlo 2 „nič sa neteleportuje“).
 *
 * - `create` pridelí id zo spoločného `world.ids`, `quantity = cargoType.unitsPerBatch` (ADR-003) a jednotku zaradí
 *   do lokácie z `CARGO_SPAWN_KINDS` (F2: len `on_ship`). Udalosť nemá — vznik ohlási zdroj (`ShipSpawned`).
 * - `move` je jediný spôsob zmeny polohy: overí prechod podľa `CARGO_TRANSITIONS`, tvar cieľa a voľné jedinečné
 *   miesto (slot apronu/skladu), potom **atomicky** prepíše indexy a emituje `CargoMoved { unitId, from, to, tick }`.
 *   Pri akejkoľvek chybe sa nezmení nič a nič sa neemituje.
 * - Presun do lokácie bez držiteľa (`exported`) jednotku z ledgera odstráni; ostane len v počítadle `exportedCount`
 *   (save nerastie s každým vyvezeným kontajnerom). `get` pre ňu vráti `undefined` a ďalší `move` zlyhá
 *   (`unknown_unit`) — `exported` je konečný stav.
 *
 * Indexy: pre každý druh lokácie s držiteľom `id držiteľa → { units, slots }`; loď drží jednotky vzostupne podľa id,
 * ostatní vo FIFO. Prázdny index sa odstráni. Jednotky sú zmrazené hodnoty — presun vytvorí novú jednotku, takže
 * objekt z `get()` ani lokácie v udalostiach sa už nezmenia.
 */
import type { EntityId, EntityIdAllocator } from '../core/entity-id';
import type { Catalog } from '../defs/catalog';
import type { CargoTypeDef } from '../defs/types';
import type { CargoMovedEvent } from '../events/sim-event';
import { findConservationViolation } from './cargo-conservation';
import { CargoConservationError, CargoError, CargoTransitionError } from './cargo-error';
import {
  CARGO_HOLDER_KINDS,
  CARGO_LOCATION_KINDS,
  CARGO_SPAWN_KINDS,
  CARGO_TRANSITIONS,
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
import type { CargoUnit } from './cargo-unit';

/** Závislosti ledgera od sveta (v `World` sú to `defs.cargoTypes`, `ids`, `events`, `clock`). */
export interface CargoLedgerDeps {
  readonly cargoTypes: Catalog<Readonly<CargoTypeDef>>;
  /** Spoločný alokátor id sveta — jednotky nákladu dostávajú id z rovnakej postupnosti ako ostatné entity. */
  readonly ids: EntityIdAllocator;
  /** Cieľ udalostí `CargoMoved` (`world.events`). */
  readonly events: { emit(event: CargoMovedEvent): void };
  /** Zdroj `CargoMoved.tick` (`world.clock`). */
  readonly clock: { readonly tick: number };
}

/** Index jednotiek jedného držiteľa. */
interface Bucket {
  readonly units: EntityId[];
  /** Miesto → jednotka; len pre druhy s `uniqueSlot`. */
  readonly slots: Map<number, EntityId> | null;
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

function freezeUnit(id: EntityId, typeId: string, contractId: EntityId | null, quantity: number, location: CargoLocation): CargoUnit {
  return Object.freeze({ id, typeId, contractId, quantity, location });
}

function zeroCounts(): Record<CargoLocationKind, number> {
  return Object.fromEntries(CARGO_LOCATION_KINDS.map((kind) => [kind, 0])) as Record<CargoLocationKind, number>;
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
    const state = parseCargoLedgerState(raw, deps.cargoTypes, deps.ids.getState().nextId);
    const ledger = new CargoLedger(deps);
    for (const unit of state.units) ledger.place(unit);
    ledger.created = state.createdCount;
    ledger.counts.exported = state.exportedCount;
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

  /** Počet jednotiek na mape (`createdCount − exportedCount`). */
  get liveCount(): number {
    return this.units.size;
  }

  /**
   * Nová jednotka typu `typeId` v lokácii `location` (musí byť v `CARGO_SPAWN_KINDS`). Chyby (stav sa nezmení
   * a id sa nespotrebuje): neznámy typ → `CargoError('unknown_cargo_type')`, neplatná lokácia alebo `contractId`
   * → `CargoError('invalid_input')`, lokácia mimo `CARGO_SPAWN_KINDS` → `CargoTransitionError`, obsadené miesto →
   * `CargoError('slot_occupied')`.
   */
  create(typeId: string, location: CargoLocation, contractId: EntityId | null = null): CargoUnit {
    if (!this.deps.cargoTypes.has(typeId)) {
      throw new CargoError('unknown_cargo_type', `CargoLedger.create: neznámy typ nákladu '${typeId}'`);
    }
    const target = this.normalizeTarget(location, 'CargoLedger.create');
    if (!CARGO_SPAWN_KINDS.includes(target.kind)) {
      throw new CargoTransitionError(null, null, target, `jednotka smie vzniknúť len v: ${CARGO_SPAWN_KINDS.join(', ')}`);
    }
    if (contractId !== null && !isEntityIdValue(contractId)) {
      throw new CargoError('invalid_input', `CargoLedger.create: contractId musí byť null alebo celé číslo ≥ 1, dostal ${String(contractId)}`);
    }
    this.assertSlotFree(target, null);
    const { unitsPerBatch } = this.deps.cargoTypes.get(typeId);
    // Od tohto bodu nič nevyhadzuje: id sa spotrebuje len pre skutočne vytvorenú jednotku.
    const unit = freezeUnit(this.deps.ids.next(), typeId, contractId, unitsPerBatch, target);
    this.place(unit);
    this.created += 1;
    return unit;
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
    const bucket = this.bucketOf(from);
    const index = bucket?.units.indexOf(unitId) ?? -1;
    if (bucket === undefined || index < 0) {
      throw new CargoConservationError(`jednotka #${String(unitId)} (${formatLocation(from)}) chýba v indexe svojej lokácie`);
    }

    // Od tohto bodu nič nevyhadzuje — presun je atomický.
    this.unplace(unit, bucket, index);
    this.place(freezeUnit(unit.id, unit.typeId, unit.contractId, unit.quantity, target));
    this.deps.events.emit({ type: 'CargoMoved', unitId, from, to: target, tick: this.deps.clock.tick });
  }

  /** Jednotka na mape; `undefined` pre neznáme alebo exportované id. Vrátený objekt je zmrazená snímka. */
  get(unitId: EntityId): CargoUnit | undefined {
    return this.units.get(unitId);
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

  /** Počet jednotiek v lokáciách daného druhu; `exported` = `exportedCount`. */
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
          if (unit !== undefined) {
            units.push({ id: unit.id, typeId: unit.typeId, contractId: unit.contractId, quantity: unit.quantity, location: { ...unit.location } });
          }
        }
      }
    }
    return { createdCount: this.created, exportedCount: this.counts.exported, units };
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
      bucket = { units: [], slots: spec.uniqueSlot ? new Map() : null };
      holders.set(holderId, bucket);
    }
    if (spec.order === 'id') insertSorted(bucket.units, unit.id);
    else bucket.units.push(unit.id);
    const slot = uniqueSlotOf(location);
    if (slot !== null) bucket.slots?.set(slot, unit.id);
  }

  /** Vyradí jednotku z indexu jej lokácie (`index` = pozícia v `bucket.units`); prázdny index odstráni. */
  private unplace(unit: CargoUnit, bucket: Bucket, index: number): void {
    const { location } = unit;
    this.counts[location.kind] -= 1;
    bucket.units.splice(index, 1);
    const slot = uniqueSlotOf(location);
    if (slot !== null) bucket.slots?.delete(slot);
    const holderId = holderIdOf(location);
    if (bucket.units.length === 0 && holderId !== null) this.buckets.get(location.kind)?.delete(holderId);
  }
}
