/**
 * Kto môže držať náklad (ARCHITECTURE §7.1) — tabuľka druh lokácie → entity sveta, ktoré sú jej držiteľmi
 * (pravidlo 7, žiadny switch). Používa ju invariant „každá jednotka je u existujúceho držiteľa“
 * (`World.assertInvariants`), obnova zo save (`restoreEntities`) aj `World.removeModule` (modul s nákladom
 * nejde odstrániť).
 *
 * Druhy bez entít v aktuálnej fáze (kamióny, vlaky) nemajú držiteľov — jednotka v nich je chyba. Vozidlá (T03-04)
 * sú držiteľmi `in_vehicle`. Nová entita = nový riadok tu (a jej poradie v save).
 */
import type { CargoHolderKind } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import type { ModuleKind } from '../defs/types';
import type { Module } from '../modules/module';

/** Časť sveta, z ktorej sa čítajú držitelia (`World` ju spĺňa). */
export interface CargoHolderWorld {
  readonly modules: ReadonlyMap<EntityId, Module>;
  readonly ships: ReadonlyMap<EntityId, unknown>;
  readonly vehicles: ReadonlyMap<EntityId, unknown>;
}

type HolderSource = (world: CargoHolderWorld) => Iterable<EntityId>;

/** Id modulov daných druhov v poradí umiestnenia. */
function modulesOfKinds(...kinds: readonly ModuleKind[]): HolderSource {
  return function* moduleHolders(world) {
    for (const module of world.modules.values()) {
      if (kinds.includes(module.kind)) yield module.id;
    }
  };
}

const NO_HOLDERS: HolderSource = () => [];

/** Držitelia podľa druhu lokácie. */
export const CARGO_HOLDER_SOURCES: { readonly [K in CargoHolderKind]: HolderSource } = Object.freeze({
  on_ship: (world: CargoHolderWorld) => world.ships.keys(),
  in_crane: modulesOfKinds('crane'),
  on_apron: modulesOfKinds('berth'),
  in_vehicle: (world: CargoHolderWorld) => world.vehicles.keys(),
  in_storage: modulesOfKinds('storage'),
  in_pipeline: modulesOfKinds('pipeline'),
  at_ramp: modulesOfKinds('ramp', 'rail_station'),
  in_truck: NO_HOLDERS,
  in_train: NO_HOLDERS,
});

/** Druhy lokácií, ktorých držiteľom je modul — modul s nákladom v nich nejde odstrániť. */
export const MODULE_CARGO_HOLDER_KINDS: readonly CargoHolderKind[] = Object.freeze([
  'in_crane',
  'on_apron',
  'in_storage',
  'in_pipeline',
  'at_ramp',
]);
