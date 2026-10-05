/**
 * Dosiahnuteľnosť zdrojov nakládky (T6C-07b, review src/sim, M2; ADR-034 dodatok T6C-07b) — jednotka na nakládku lode (export, prekládka na
 * loď B, prázdne repositioningu) leží v sklade a job `in_storage → on_apron / in_crane` vedie od skladu ku kotvisku lode. Sklad, z ktorého
 * ku kotvisku nevedie cesta (`distance(sklad, kotvisko) = ∞`: odrezaný dvor, depo bez prístupu), nesmie byť zdrojom nakládky — vozidlo by sa
 * k jobu nikdy nedostalo (`no_path` s jednotkou na palube, alebo job navždy `open`), job by držal `loadingInFlight` a `arrivedUnits` a loď
 * s kotviskom by uviazli. Vzor `createEmptyPickupJobs` (jednotka výdaja sa vyberá len z dosiahnuteľných skladov).
 *
 * Čisté dotazy nad svetom, bez alokácie okrem zápisu do poľa volajúceho (`into`, znovupoužiteľné pole hot pathu).
 */
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { CraneModule } from '../modules/crane-module';
import type { Module } from '../modules/module';
import type { Ship } from '../ships/ship';
import type { World } from '../world/world';
import { distanceBetweenModules } from './module-access';

/** Kotvisko lode `ship` obsluhuje žeriav kategórie jej nákladu? */
export function berthHasCraneFor(world: Pick<World, 'modules'>, berth: BerthModule, ship: Pick<Ship, 'cargoCategory'>): boolean {
  for (const craneId of berth.craneIds) {
    const crane = world.modules.get(craneId);
    if (crane instanceof CraneModule && crane.category === ship.cargoCategory) return true;
  }
  return false;
}

/**
 * Kotviská lode `ship`, na ktorých sa nakladá (majú žeriav kategórie nákladu), vzostupne podľa poradia `ship.berthIds`, do `into` (najprv
 * sa vyprázdni). Jediný zdroj „kotvisko nakládky“ pre výber jednotky aj pre `openLoadJob`.
 */
export function collectLoadBerths(world: Pick<World, 'modules'>, ship: Ship, into: BerthModule[]): readonly BerthModule[] {
  into.length = 0;
  for (const berthId of ship.berthIds) {
    const berth = world.modules.get(berthId);
    if (berth instanceof BerthModule && berthHasCraneFor(world, berth, ship)) into.push(berth);
  }
  return into;
}

/** Vedie cesta zo skladu `storageId` k aspoň jednému z `targets` (kotvisko lode, rampa)? Neznámy sklad → `false`. Bez alokácie. */
export function storageReaches(world: Pick<World, 'modules' | 'grid' | 'distances'>, storageId: EntityId, targets: readonly Module[]): boolean {
  const storage = world.modules.get(storageId);
  if (storage === undefined) return false;
  for (const target of targets) if (distanceBetweenModules(world, storage, target) !== Infinity) return true;
  return false;
}
