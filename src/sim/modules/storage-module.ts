/**
 * Sklad (ARCHITECTURE §5, §5.3, §7.7; ADR-017, ADR-018) — abstraktná báza skladov podľa kategórie nákladu (pravidlo 7:
 * `ContainerYard` pre kontajnery, neskôr `Silo`, `TankFarm`, `GasHolder`, `VehicleLot`). Triedu vyberá tabuľka
 * `STORAGE_MODULES` podľa `params.category` (`ModuleRegistry`, druh `storage`).
 *
 * Model (review T02-13): sklad drží **len rezervácie slotov** (`SlotReservations`, druh `in_storage`) a kumulatívne
 * počítadlá `unitsIn` / `unitsOut`; obsadenie (`storedCount`, jednotky, slot jednotky) číta z `CargoLedger` — poloha
 * nákladu má jediný zápis (pravidlo 2).
 *
 * Rezervácie patria jobom (ADR-018): každý aktívny `TransportJob` s cieľom v sklade drží práve svoj slot `to.slot`
 * a iné rezervácie sklad nemá (invariant kroku 12). Preto sa do save neukladajú — obnova ich vytvorí z jobov
 * (`reserveSlot`), rovnako ako rezervácie apronu zo žeriavov (ADR-014). `runtime` = len počítadlá.
 *
 * Tok (T03-05 dispatcher, T03-06 vozidlo): `reserve()` pri vzniku jobu → pri vykládke `assertCommittable(slot, unit)` →
 * `CargoLedger.move(unit, in_storage(id, slot))` → `commit(slot, unit)` (rezervácia zaniká, `unitsIn += 1`). Výdaj
 * (outbound job, T04-03): `CargoLedger.move(unit, in_vehicle…)` → `recordTaken(unit)` (`unitsOut += 1`). Zrušený job:
 * `release(slot)`. Vozidlo a svet pristupujú k slotu cieľa genericky cez `cargoDropTarget()` (ADR-023).
 *
 * Kapacita pre alokátor = `stored + reserved` (`freeCount`), pre UI `stored / capacity` (§7.7).
 */
import type { EntityId } from '../core/entity-id';
import { storageParams } from '../defs/module-def';
import type { CargoCategory, StorageParams } from '../defs/types';
import type { CargoDropTarget } from './cargo-drop-target';
import { Module, type ModuleInit } from './module';
import { ModuleError } from './module-error';
import { checkRuntimeKeys, readCount } from './runtime-state';
import { SlotReservations, type CargoSlotsView } from './slot-reservations';

/**
 * Dynamický stav skladu v save (`WorldState.modules[i].runtime`, ADR-017, ADR-018): len kumulatívne počítadlá —
 * obsadenie je v ledgeri a rezervácie sa odvodia z jobov.
 */
export type StorageRuntimeState = {
  readonly unitsIn: number;
  readonly unitsOut: number;
};

const RUNTIME_KEYS: readonly (keyof StorageRuntimeState)[] = ['unitsIn', 'unitsOut'];

export abstract class StorageModule extends Module {
  /** Typované `params` defu (`storageParams`). */
  readonly params: StorageParams;
  /** Počet slotov = `params.capacityUnits`. */
  readonly capacity: number;
  private readonly slots: SlotReservations;
  /** Cieľ doručenia jobu (`in_storage`, slot = miesto) — jeden objekt na sklad, vracia ho `cargoDropTarget()`. */
  private readonly drop: CargoDropTarget;
  private inCount = 0;
  private outCount = 0;

  /**
   * `category` = kategória, ktorú trieda skladuje. Chyby: def iného druhu než `storage` → `DefError`; iná kategória
   * v `params` → `ModuleError('invalid_input')`.
   */
  protected constructor(init: ModuleInit, category: CargoCategory) {
    super(init);
    this.params = storageParams(init.def);
    if (this.params.category !== category) {
      throw new ModuleError('invalid_input', `${this.label}: trieda skladuje kategóriu '${category}', def má '${this.params.category}'`);
    }
    this.capacity = this.params.capacityUnits;
    this.slots = new SlotReservations({ kind: 'in_storage', holderId: this.id, capacity: this.capacity, cargo: init.cargo, label: `sklad ${this.label}` });
    const { capacity, slots } = this;
    this.drop = Object.freeze({
      kind: 'in_storage',
      category: this.params.category,
      places: capacity,
      reservationsAt: (slot: number): number => (Number.isInteger(slot) && slot >= 0 && slot < capacity && slots.isReserved(slot) ? 1 : 0),
      restoreReservation: (slot: number): void => {
        this.reserveSlot(slot);
      },
      release: (slot: number): void => {
        this.release(slot);
      },
      assertCommittable: (slot: number, unitId: EntityId): void => {
        this.assertCommittable(slot, unitId);
      },
      commit: (slot: number, unitId: EntityId): void => {
        this.commit(slot, unitId);
      },
    });
  }

  /** Kategória nákladu, ktorú sklad prijíma. */
  get category(): CargoCategory {
    return this.params.category;
  }

  /** Uložené jednotky (ledger `in_storage` u tohto modulu). */
  get storedCount(): number {
    return this.slots.usedCount;
  }

  /** Rezervované sloty pre prichádzajúce jednotky. */
  get reservedCount(): number {
    return this.slots.reservedCount;
  }

  /** `capacity − storedCount − reservedCount` — koľko ďalších `reserve()` uspeje. */
  get freeCount(): number {
    return this.slots.freeCount;
  }

  /** Kumulatívny počet prijatých jednotiek (`commit`). */
  get unitsIn(): number {
    return this.inCount;
  }

  /** Kumulatívny počet vydaných jednotiek (`recordTaken`). */
  get unitsOut(): number {
    return this.outCount;
  }

  /** `params.internalTicks` (chýba → `undefined`, platí `logistics.defaultInternalTicks`). */
  override vehicleInternalTicks(): number | undefined {
    return this.params.internalTicks;
  }

  override cargoSlots(): CargoSlotsView {
    return this.slots;
  }

  /** Cieľ inbound jobu: slot skladu (`in_storage`, ADR-018, ADR-023). */
  override cargoDropTarget(): CargoDropTarget {
    return this.drop;
  }

  /** Jednotka na slote podľa ledgera; `null` = prázdny. Slot mimo rozsahu → `ModuleError('invalid_slot')`. */
  unitAt(slot: number): EntityId | null {
    return this.slots.unitAt(slot);
  }

  isReserved(slot: number): boolean {
    return this.slots.isReserved(slot);
  }

  /** Slot jednotky v tomto sklade (ledger); `undefined`, ak tu nie je. */
  slotOf(unitId: EntityId): number | undefined {
    return this.slots.slotOf(unitId);
  }

  /** Uložené jednotky v poradí príchodu (kópia z ledgera). */
  units(): readonly EntityId[] {
    return this.slots.units();
  }

  reservedSlots(): readonly number[] {
    return this.slots.reservedSlots();
  }

  /** Rezervuje najnižší voľný slot (job, T03-05); bez neho `ModuleError('no_free_slot')`. */
  reserve(): number {
    return this.slots.reserve();
  }

  /**
   * Rezervuje konkrétny slot — obnova zo save podľa aktívneho jobu (ADR-018). Chyby ako `SlotReservations.reserveSlot`
   * (`invalid_slot`, `slot_occupied`, `slot_reserved`).
   */
  reserveSlot(slot: number): void {
    this.slots.reserveSlot(slot);
  }

  /** Zruší rezerváciu slotu (zrušený job); chyby ako `SlotReservations.release`. */
  release(slot: number): void {
    this.slots.release(slot);
  }

  /** Kontrola pred `CargoLedger.move(unit, in_storage(id, slot))` — chyby ako `SlotReservations.assertCommittable`. */
  assertCommittable(slot: number, unitId: EntityId): void {
    this.slots.assertCommittable(slot, unitId);
  }

  /** Po presune do skladu: rezervácia zaniká a `unitsIn += 1`; chyby ako `SlotReservations.commit` (bez zmeny stavu). */
  commit(slot: number, unitId: EntityId): void {
    this.slots.commit(slot, unitId);
    this.inCount += 1;
  }

  /**
   * Po presune jednotky zo skladu (`in_storage → in_vehicle | in_pipeline`, outbound job T04-03): `unitsOut += 1`.
   * Jednotka, ktorá podľa ledgera v sklade stále leží → `ModuleError('unit_still_held')`, počítadlo sa nezmení.
   */
  override recordTaken(unitId: EntityId): void {
    if (this.slots.slotOf(unitId) !== undefined) {
      throw new ModuleError('unit_still_held', `${this.label}.recordTaken: jednotka #${String(unitId)} podľa ledgera stále leží v sklade`);
    }
    this.outCount += 1;
  }

  override getRuntimeState(): StorageRuntimeState {
    return { unitsIn: this.inCount, unitsOut: this.outCount };
  }

  /**
   * Kontroly: presne kľúče `StorageRuntimeState`, počítadlá celé ≥ 0. Neplatný stav → `ModuleStateError`; obnova je
   * atomická (pri chybe sa nezmení nič). Rezervácie obnoví svet z jobov (`reserveSlot`).
   */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, RUNTIME_KEYS);
    const unitsIn = readCount(fields['unitsIn'], '/unitsIn');
    const unitsOut = readCount(fields['unitsOut'], '/unitsOut');
    this.inCount = unitsIn;
    this.outCount = unitsOut;
  }
}
