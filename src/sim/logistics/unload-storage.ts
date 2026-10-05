/**
 * Sklad pre jednotku vyloženú žeriavom z lode (dispatcher krok 5; F6c, ADR-034): jednotka z lode (alebo z apronu kotviska) dostane sklad
 * podľa **smeru** — tabuľka `UNLOAD_STORAGE`, nie switch (pravidlo 7):
 * - `import` a vrátený `export`: najbližší sklad s voľným miestom (`allocateStorage`, F3),
 * - `tranship`: **zoskupene podľa kontraktu** (`allocateGroupedStorage` — „uložia zoskupene podľa B“: sklad, v ktorom už jednotky kontraktu
 *   ležia alebo kam mieria), inak najbližší sklad,
 * - `empty` (prázdny, ktorý sa po uzavretí bookingu repositioningu vracia z apronu): depo prázdnych, fallback bežný sklad.
 * Sklad rezervuje slot volajúci (`StorageModule.reserve`); výber svet nemení.
 */
import type { CargoDirection, CargoUnit } from '../cargo/cargo-unit';
import type { CargoCategory } from '../defs/types';
import type { Module } from '../modules/module';
import type { StorageModule } from '../modules/storage-module';
import type { World } from '../world/world';
import { allocateEmptyStorage } from './empty-stock';
import { allocateGroupedStorage } from './export-intake';
import { allocateStorage } from './storage-allocator';

type UnloadStorage = (world: World, source: Module, unit: CargoUnit, category: CargoCategory) => StorageModule | undefined;

const UNLOAD_STORAGE: { readonly [D in CargoDirection]: UnloadStorage } = {
  import: (world, source, _unit, category) => allocateStorage(world, source, category),
  export: (world, source, unit, category) => allocateStorage(world, source, category, unit.direction),
  tranship: (world, source, unit, category) => allocateGroupedStorage(world, source, unit, category),
  empty: (world, source, _unit, category) => allocateEmptyStorage(world, source, category),
};

/** Sklad pre jednotku vyloženú z lode zo zdroja `source` (kotvisko; viď hlavička súboru); inak `undefined` (jednotka čaká, kotvisko hlási `NoStorageAvailable`). */
export function allocateUnloadStorage(world: World, source: Module, unit: CargoUnit): StorageModule | undefined {
  return UNLOAD_STORAGE[unit.direction](world, source, unit, world.defs.cargoTypes.get(unit.typeId).category);
}
