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

type GangPredicate = (vehicle: Pick<Vehicle, 'id' | 'def'>) => boolean;

/** Rozdelenie ťahačov pre jeden prechod dispatchera: roster, množina ťahačov v gangoch a predikáty podľa žeriavu (vypočítané raz, nie pre každý job). */
class GangPass {
  readonly roster: ReadonlyMap<EntityId, readonly EntityId[]>;
  private readonly byCrane = new Map<EntityId, GangPredicate>();
  private pool: GangPredicate | undefined;

  constructor(world: Pick<World, 'defs' | 'modules' | 'vehicles'>) {
    this.roster = gangRoster(world);
  }

  filterFor(world: Pick<World, 'defs'>, crane: CraneModule): GangPredicate | undefined {
    if (this.roster.size === 0) return undefined;
    if (craneGangMode(world, crane) === 'gang') {
      let predicate = this.byCrane.get(crane.id);
      if (predicate === undefined) {
        const mine = new Set(this.roster.get(crane.id));
        predicate = (vehicle) => vehicleCanLift(vehicle) || mine.has(vehicle.id);
        this.byCrane.set(crane.id, predicate);
      }
      return predicate;
    }
    if (this.pool === undefined) {
      const owned = new Set<EntityId>();
      for (const members of this.roster.values()) for (const id of members) owned.add(id);
      this.pool = (vehicle) => vehicleCanLift(vehicle) || !owned.has(vehicle.id);
    }
    return this.pool;
  }
}

let activePass: { readonly world: unknown; pass: GangPass | undefined } | undefined;

/**
 * Začiatok prechodu dispatchera (krok 5): rozdelenie ťahačov sa počíta najviac raz (lazy, pri prvom `gangFilter`) a platí do `endGangPass` — svet sa počas kroku 5
 * nemení (vozidlá ani moduly nevznikajú), takže cache nemôže zostarnúť; mimo prechodu (testy, nástroje) `gangFilter` počíta vždy znova.
 */
export function beginGangPass(world: World): void {
  activePass = { world, pass: undefined };
}

/** Koniec prechodu dispatchera: zahodí cache rozdelenia. */
export function endGangPass(): void {
  activePass = undefined;
}

/**
 * Predikát „smie vozidlo job“ podľa gangu, alebo `undefined`, keď job nie je viazaný na žeriav v gangu ani na bazén s gangmi (každé vozidlo smie).
 * Vozidlá so zdvihom sú vždy povolené. Počas prechodu dispatchera (`beginGangPass`) sa rozdelenie a predikáty zdieľajú medzi jobmi.
 */
export function gangFilter(world: Pick<World, 'defs' | 'modules' | 'vehicles'>, job: TransportJob): GangPredicate | undefined {
  const craneId = hookCraneOf(job);
  const crane = craneId === undefined ? undefined : world.modules.get(craneId);
  if (!(crane instanceof CraneModule)) return undefined;
  if (activePass !== undefined && activePass.world === world) {
    activePass.pass ??= new GangPass(world);
    return activePass.pass.filterFor(world, crane);
  }
  return new GangPass(world).filterFor(world, crane);
}
