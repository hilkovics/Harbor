/**
 * Sklad (ARCHITECTURE §5, §5.3, §7.7; ADR-017) — abstraktná báza skladov podľa kategórie nákladu (pravidlo 7:
 * `ContainerYard` pre kontajnery, neskôr `Silo`, `TankFarm`, `GasHolder`, `VehicleLot`). Triedu vyberá tabuľka
 * `STORAGE_MODULES` podľa `params.category` (`ModuleRegistry`, druh `storage`).
 *
 * Model (review T02-13): sklad drží **len rezervácie slotov** (`SlotReservations`, druh `in_storage`) a kumulatívne
 * počítadlá `unitsIn` / `unitsOut`; obsadenie (`storedCount`, jednotky, slot jednotky) číta z `CargoLedger` — poloha
 * nákladu má jediný zápis (pravidlo 2).
 *
 * Tok (T03-05 dispatcher, T03-06 vozidlo): `reserve()` pri vzniku jobu → pri vykládke `assertCommittable(slot, unit)` →
 * `CargoLedger.move(unit, in_storage(id, slot))` → `commit(slot, unit)` (rezervácia zaniká, `unitsIn += 1`). Výdaj (F4):
 * `CargoLedger.move(unit, in_vehicle…)` → `recordTaken(unit)` (`unitsOut += 1`). Zrušený job: `release(slot)`.
 *
 * Kapacita pre alokátor = `stored + reserved` (`freeCount`), pre UI `stored / capacity` (§7.7).
 */
import type { EntityId } from '../core/entity-id';
import { describeValue, pointerSegment } from '../defs/def-spec';
import { storageParams } from '../defs/module-def';
import type { CargoCategory, StorageParams } from '../defs/types';
import { Module, type ModuleInit } from './module';
import { ModuleError, ModuleStateError } from './module-error';
import { checkRuntimeKeys, readCount } from './runtime-state';
import { SlotReservations, type CargoSlotsView } from './slot-reservations';

/** Dynamický stav skladu v save (`WorldState.modules[i].runtime`, ADR-017); obsadenie je v ledgeri. */
export type StorageRuntimeState = {
  /** Rezervované sloty ostro vzostupne. */
  readonly reservedSlots: readonly number[];
  readonly unitsIn: number;
  readonly unitsOut: number;
};

const RUNTIME_KEYS: readonly (keyof StorageRuntimeState)[] = ['reservedSlots', 'unitsIn', 'unitsOut'];

export abstract class StorageModule extends Module {
  /** Typované `params` defu (`storageParams`). */
  readonly params: StorageParams;
  /** Počet slotov = `params.capacityUnits`. */
  readonly capacity: number;
  private readonly slots: SlotReservations;
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

  override cargoSlots(): CargoSlotsView {
    return this.slots;
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
   * Po presune jednotky zo skladu (`in_storage → in_vehicle | in_pipeline`, F4): `unitsOut += 1`. Jednotka, ktorá
   * podľa ledgera v sklade stále leží → `ModuleError('unit_still_held')`, počítadlo sa nezmení.
   */
  recordTaken(unitId: EntityId): void {
    if (this.slots.slotOf(unitId) !== undefined) {
      throw new ModuleError('unit_still_held', `${this.label}.recordTaken: jednotka #${String(unitId)} podľa ledgera stále leží v sklade`);
    }
    this.outCount += 1;
  }

  override getRuntimeState(): StorageRuntimeState {
    return { reservedSlots: [...this.slots.reservedSlots()], unitsIn: this.inCount, unitsOut: this.outCount };
  }

  /**
   * Kontroly: presne kľúče `StorageRuntimeState`, `reservedSlots` pole celých čísel ostro vzostupne v `0 … capacity − 1`,
   * ktoré podľa ledgera nie sú obsadené (ledger sa obnovuje pred modulmi), počítadlá celé ≥ 0. Neplatný stav →
   * `ModuleStateError`; obnova je atomická (pri chybe sa nezmení nič).
   */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, RUNTIME_KEYS);
    const rawSlots = fields['reservedSlots'];
    if (!Array.isArray(rawSlots)) throw new ModuleStateError('/reservedSlots', `musí byť pole, dostal ${describeValue(rawSlots)}`);
    const slots: number[] = [];
    rawSlots.forEach((value: unknown, i) => {
      const path = `/reservedSlots${pointerSegment(i)}`;
      const slot = readCount(value, path);
      if (slot >= this.capacity) throw new ModuleStateError(path, `slot ${String(slot)} je mimo 0…${String(this.capacity - 1)}`);
      const previous = slots.at(-1);
      if (previous !== undefined && slot <= previous) throw new ModuleStateError(path, `sloty musia byť ostro vzostupne, ${String(slot)} ≤ ${String(previous)}`);
      const occupant = this.slots.unitAt(slot);
      if (occupant !== null) throw new ModuleStateError(path, `rezervovaný slot ${String(slot)} obsadila jednotka #${String(occupant)}`);
      slots.push(slot);
    });
    const unitsIn = readCount(fields['unitsIn'], '/unitsIn');
    const unitsOut = readCount(fields['unitsOut'], '/unitsOut');

    // Od tohto bodu nič nevyhadzuje — obnova je atomická (sloty sú overené, vzostupné a voľné).
    for (const slot of this.slots.reservedSlots()) this.slots.release(slot);
    for (const slot of slots) this.slots.reserveSlot(slot);
    this.inCount = unitsIn;
    this.outCount = unitsOut;
  }
}
