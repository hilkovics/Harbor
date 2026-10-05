/**
 * Depo prázdnych kontajnerov (F6c, ADR-034; PORT_OPERATIONS §2.2) — sklad kategórie `container` s rolou `empty_depot`:
 * vyššie stohovanie (väčšia kapacita na plochu), prijíma len prázdne kontajnery (`acceptsDirection`) a má `repairBays`
 * súčasných opráv (M&R poškodených prázdnych: stav `damaged` čaká na voľné miesto, `in_repair` beží `repairHours`).
 * Obsluhuje ho prednostne empty handler (vozidlo s `cargoDirections: ['empty']`), inak bežné vozidlá.
 *
 * Správanie skladu (sloty, rezervácie, `unitsIn` / `unitsOut`, save) je celé v `StorageModule`; kontrolu pri uložení
 * (`damageChance`), opravy a ich ceny riadia systémy (T6C-02), nie modul. Depo **nezvyšuje kapacitu pre import ponuky poolu**
 * (`storageCapacityUnits` = 0): uskladňuje len prázdne, nie náklad kontraktov.
 */
import type { CargoDirection } from '../cargo/cargo-unit';
import { ModuleError } from './module-error';
import type { ModuleInit } from './module';
import { StorageModule } from './storage-module';

/** Kategória nákladu, ktorú depo prázdnych skladuje. */
export const EMPTY_DEPOT_CATEGORY = 'container';

export class EmptyDepot extends StorageModule {
  /** Počet súčasných opráv (`params.repairBays`). */
  readonly repairBays: number;

  /** Def musí byť sklad kontajnerov s `params.role = 'empty_depot'` a `repairBays` (inak `ModuleError('invalid_input')`). */
  constructor(init: ModuleInit) {
    super(init, EMPTY_DEPOT_CATEGORY);
    const { role, repairBays } = this.params;
    if (role !== 'empty_depot' || repairBays === undefined) {
      throw new ModuleError('invalid_input', `${this.label}: depo prázdnych vyžaduje params.role 'empty_depot' a repairBays`);
    }
    this.repairBays = repairBays;
  }

  /** Depo prijíma len prázdne kontajnery. */
  override acceptsDirection(direction: CargoDirection): boolean {
    return direction === 'empty';
  }

  /** Depo prázdnych nezvyšuje kapacitu skladov pre `capacityHint` poolu (neuskladňuje náklad kontraktov). */
  override storageCapacityUnits(): number {
    return 0;
  }
}
