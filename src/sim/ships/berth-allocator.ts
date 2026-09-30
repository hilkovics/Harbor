/**
 * BerthAllocator (ARCHITECTURE §5.4; karta T02-05; rozhodnutie orchestrátora 1 v ADR-016) — čistá funkcia, ktorá
 * pre loď nájde súvislý úsek voľných kotvísk. Svet nemení; rezerváciu (`dockedShipId`, `berthIds`) zapíše `ShipSystem`.
 *
 * Pravidlá (v poradí vyhodnotenia):
 * 1. skupiny `world.berthGroups` v poradí id; skupina prichádza do úvahy, keď `totalLength ≥ lengthCells`,
 *    `minDepth ≥ draftClass` a má aspoň jeden žeriav kategórie nákladu lode;
 * 2. v skupine súvislé úseky kotvísk (poradie po pobreží) od najmenšieho počtu kotvísk, pri rovnakom počte od
 *    najmenšieho indexu po pobreží; úsek musí byť celý voľný (`dockedShipId === null` — bez lode aj rezervácie),
 *    so súčtom `lengthCells ≥ lengthCells` lode, s pásom vody hlbokým aspoň `widthCells` lode (loď sa zmestí na vodu)
 *    a s aspoň jedným kompatibilným žeriavom (inak by loď na kotvisku nikdy nevyložila);
 * 3. prvý vyhovujúci úsek vyhráva; žiadny → `null` (loď čaká na anchorage).
 *
 * Poradie čakajúcich lodí (FIFO podľa spawnu) zabezpečuje `ShipSystem`, ktorý lode spracúva vzostupne podľa id.
 */
import type { EntityId } from '../core/entity-id';
import type { CargoCategory, ShipClassDef } from '../defs/types';
import type { BerthGroup } from '../modules/berth-group';
import { BerthModule } from '../modules/berth-module';
import { CraneModule } from '../modules/crane-module';
import type { Module } from '../modules/module';

/** Čo alokátor zo sveta číta (`World` to spĺňa). */
export interface BerthAllocationWorld {
  readonly berthGroups: readonly BerthGroup[];
  readonly modules: ReadonlyMap<EntityId, Module>;
}

/** Čo alokátor potrebuje o lodi. */
export interface BerthRequest {
  readonly def: Pick<ShipClassDef, 'lengthCells' | 'widthCells' | 'draftClass'>;
  readonly cargoCategory: CargoCategory;
}

/** Stojí na kotvisku žeriav danej kategórie? */
export function hasCompatibleCrane(world: BerthAllocationWorld, berth: BerthModule, category: CargoCategory): boolean {
  return berth.craneIds.some((craneId) => {
    const crane = world.modules.get(craneId);
    return crane instanceof CraneModule && crane.category === category;
  });
}

function berthsOf(world: BerthAllocationWorld, group: BerthGroup): readonly BerthModule[] {
  return group.berthIds.map((berthId) => {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) throw new Error(`BerthAllocator: skupina ${String(group.id)} odkazuje na #${String(berthId)}, ktorý nie je berth`);
    return berth;
  });
}

/** Úsek `berths[start … start + count)` vyhovuje lodi (bod 2 hlavičky)? */
function fitsRun(world: BerthAllocationWorld, berths: readonly BerthModule[], start: number, count: number, request: BerthRequest): boolean {
  let length = 0;
  let crane = false;
  for (let i = start; i < start + count; i++) {
    const berth = berths[i];
    if (berth.dockedShipId !== null || berth.params.frontWaterCells < request.def.widthCells) return false;
    length += berth.lengthCells;
    crane ||= hasCompatibleCrane(world, berth, request.cargoCategory);
  }
  return crane && length >= request.def.lengthCells;
}

/**
 * Kotviská pre loď v poradí po pobreží (podľa pravidiel v hlavičke súboru), alebo `null`, keď žiadny úsek nevyhovuje.
 * Svet nemení.
 */
export function allocateBerths(world: BerthAllocationWorld, request: BerthRequest): readonly BerthModule[] | null {
  for (const group of world.berthGroups) {
    if (group.totalLength < request.def.lengthCells || group.minDepth < request.def.draftClass) continue;
    const berths = berthsOf(world, group);
    if (!berths.some((berth) => hasCompatibleCrane(world, berth, request.cargoCategory))) continue;
    for (let count = 1; count <= berths.length; count++) {
      for (let start = 0; start + count <= berths.length; start++) {
        if (fitsRun(world, berths, start, count, request)) return Object.freeze(berths.slice(start, start + count));
      }
    }
  }
  return null;
}
