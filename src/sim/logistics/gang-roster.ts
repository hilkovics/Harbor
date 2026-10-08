/**
 * Prideľovanie ťahačov žeriavom STS (ADR-040 bod 7; TR3-02): `pool` / `gang` podľa stavu žeriava (`SetCraneGang`, východisko z `equipment.json` `tractors`).
 *
 * **Gang**: ťahače bez zdvihu (`canLift: false`) vzostupne podľa id sa rozdelia žeriavom v režime `gang` vzostupne podľa id žeriava — žeriav dostane ďalších
 * `tractorsPerSts` ťahačov (menej, ak ich nezostalo). Ťahač gangu obsluhuje len joby svojho žeriava. **Pool**: žeriav v režime `pool` dostane najbližší voľný ťahač,
 * ktorý nepatrí do gangu žiadneho žeriava. Rozdelenie je odvodené (nie je v save) — závisí len od ťahačov sveta a stavu žeriavov, takže je deterministické.
 * Vozidlá so zdvihom (straddle) a joby bez žeriava sa gangom neobmedzujú.
 */
import type { EntityId } from '../core/entity-id';
import type { CraneGangMode } from '../defs/types';
import { CraneModule } from '../modules/crane-module';
import type { Vehicle } from '../vehicles/vehicle';
import type { World } from '../world/world';
import { vehicleCanLift } from './handling-chains';
import { hookCraneOf } from './job-source';
import type { TransportJob } from './transport-job';

/** Účinný režim žeriavu: jeho vlastný, inak východisko z defu. */
export function craneGangMode(world: Pick<World, 'defs'>, crane: CraneModule): CraneGangMode {
  return crane.gangMode ?? world.defs.equipment.tractors.defaultMode;
}

/** Účinný počet ťahačov na STS v režime `gang`: vlastný žeriavu, inak východisko z defu. */
export function craneTractorsPerSts(world: Pick<World, 'defs'>, crane: CraneModule): number {
  return crane.tractorsPerSts ?? world.defs.equipment.tractors.defaultPerSts;
}

/** Gang každého žeriava v režime `gang` (id žeriava → ťahače vzostupne podľa id); prázdne, keď žiadny žeriav gang nepoužíva. */
export function gangRoster(world: Pick<World, 'defs' | 'modules' | 'vehicles'>): ReadonlyMap<EntityId, readonly EntityId[]> {
  const roster = new Map<EntityId, EntityId[]>();
  const cranes: CraneModule[] = [];
  for (const module of world.modules.values()) {
    if (module instanceof CraneModule && craneGangMode(world, module) === 'gang') cranes.push(module);
  }
  if (cranes.length === 0) return roster;
  const tractors: EntityId[] = [];
  for (const vehicle of world.vehicles.values()) {
    if (!vehicleCanLift(vehicle)) tractors.push(vehicle.id);
  }
  let next = 0;
  for (const crane of cranes) {
    const size = Math.min(craneTractorsPerSts(world, crane), tractors.length - next);
    roster.set(crane.id, tractors.slice(next, next + size));
    next += size;
  }
  return roster;
}

/**
 * Predikát „smie vozidlo job“ podľa gangu, alebo `undefined`, keď job nie je viazaný na žeriav v gangu ani na bazén s gangmi (každé vozidlo smie).
 * Počíta sa raz pre job (dispatcher ho volá pre každého kandidáta); vozidlá so zdvihom sú vždy povolené.
 */
export function gangFilter(world: Pick<World, 'defs' | 'modules' | 'vehicles'>, job: TransportJob): ((vehicle: Pick<Vehicle, 'id' | 'def'>) => boolean) | undefined {
  const craneId = hookCraneOf(job);
  const crane = craneId === undefined ? undefined : world.modules.get(craneId);
  if (!(crane instanceof CraneModule)) return undefined;
  const roster = gangRoster(world);
  if (roster.size === 0) return undefined;
  const mine = craneGangMode(world, crane) === 'gang' ? new Set(roster.get(crane.id)) : undefined;
  if (mine !== undefined) return (vehicle) => vehicleCanLift(vehicle) || mine.has(vehicle.id);
  const owned = new Set<EntityId>();
  for (const members of roster.values()) for (const id of members) owned.add(id);
  return (vehicle) => vehicleCanLift(vehicle) || !owned.has(vehicle.id);
}
