/**
 * Odovzdávacie miesta (TP) kamiónov pri blokoch a tokeny cieľa (R4, ADR-041 bod 4 a 5; docs/TERMINAL_2.md §6.4).
 *
 * - **TP v pruhu RTG bloku** (`lane`): bunky jednosmerného pruhu bloku v bayoch s rozstupom `tpSpacingBays`; kamión stojí v pruhu (drží sloty, `at_tp`) a stroj bloku ho obslúži.
 * - **TP na hrane bloku** (`edge`): vonkajšia bunka cestného konektora s prístupom `in` (straddle blok, depo prázdnych); kamión je abstraktne v module (`at_edge_tp`) a obsluhuje ho
 *   straddle carrier (alebo empty handler).
 * - **Token cieľa**: každý kamión od vzniku po odchod z TP drží práve jedno TP (`Truck.tpCell`), alebo státie odstavnej plochy (`Truck.holdingId` + `Truck.stall`). Obsadenie je odvodené
 *   z kamiónov (nie je v save samostatne), takže TP ani státie nemá dvoch držiteľov.
 *
 * Funkcie sú deterministické (poradie `(vzdialenosť bayov, bunka)` pri TP, `(id plochy, státie)` pri odstavných plochách) a nemenia svet.
 */
import type { EntityId } from '../core/entity-id';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import { connectorAllows } from '../modules/module-geometry';
import { RtgBlock } from '../modules/rtg-block';
import type { TruckHolding } from '../modules/truck-holding';
import { YardBlock as YardBlockClass, type YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import type { Truck } from './truck';

/** Má blok TP v pruhu (RTG), alebo na hrane (straddle, depo)? */
export function hasLaneTp(block: YardBlock): block is RtgBlock {
  return block instanceof RtgBlock;
}

/** Bunky TP bloku: v pruhu RTG bloku bunky bayov s rozstupom `tpSpacingBays` (a posledný bay), inak prístupové bunky konektorov s prístupom `in`. */
export function tpCellsOf(world: World, block: YardBlock): readonly number[] {
  if (hasLaneTp(block)) {
    const lane = world.quay.laneCellsOf(block.id);
    if (lane === undefined) return [];
    const cells: number[] = [];
    for (let bay = 0; bay < lane.length; bay++) if (bay % block.tpSpacingBays === 0 || bay === lane.length - 1) cells.push(lane[bay]);
    return cells;
  }
  const cells: number[] = [];
  for (const connector of block.connectors) {
    if (!connectorAllows(connector, 'in')) continue;
    const cell = accessCellIndex(world.grid, connector);
    if (cell !== NO_ACCESS && !cells.includes(cell)) cells.push(cell);
  }
  return cells;
}

/** Bay pruhu RTG bloku, na ktorom leží bunka TP (−1, keď bunka nie je v pruhu bloku). */
export function laneBayOf(world: World, block: YardBlock, cell: number): number {
  return world.quay.laneCellsOf(block.id)?.indexOf(cell) ?? -1;
}

/** Kamión, ktorý drží rezervované TP `cell`; `undefined` = TP je voľné. */
export function tpHolder(world: World, cell: number): Truck | undefined {
  for (const truck of world.trucks.values()) if (truck.tpCell === cell) return truck;
  return undefined;
}

/** Je TP voľné pre kamión `self` (nikto iný ho nedrží)? */
export function isTpFree(world: World, cell: number, self?: EntityId): boolean {
  const holder = tpHolder(world, cell);
  return holder === undefined || holder.id === self;
}

/** Počet kamiónov s rezervovaným TP v blokoch (bez alokácie okrem výsledku; na metriky a VM). */
export function tpHolders(world: World, block: YardBlock): Truck[] {
  const cells = tpCellsOf(world, block);
  const holders: Truck[] = [];
  for (const truck of world.trucks.values()) if (truck.tpCell !== null && cells.includes(truck.tpCell)) holders.push(truck);
  return holders;
}

/**
 * Najvhodnejšie voľné TP bloku (viď hlavička): v pruhu RTG bloku najbližšie k bayu `nearBay` (`undefined` = najbližšie k vjazdu pruhu), na hrane prvé s najnižšou cenou cesty z `from`.
 * `acceptable` (voliteľné) vyradí TP, ku ktorým kamión nemá cestu tam a späť von. `NO_ACCESS`, keď žiadne vyhovujúce TP nie je.
 */
export function chooseTp(world: World, block: YardBlock, nearBay: number | undefined, self: EntityId | undefined, acceptable: (cell: number) => boolean, from: number = NO_ACCESS): number {
  let best = NO_ACCESS;
  let bestScore = Infinity;
  for (const cell of tpCellsOf(world, block)) {
    if (!isTpFree(world, cell, self) || !acceptable(cell)) continue;
    const bay = laneBayOf(world, block, cell);
    const score = bay >= 0 ? Math.abs(bay - (nearBay ?? 0)) : from === NO_ACCESS ? 0 : world.distances.distance(from, cell);
    if (score < bestScore) {
      best = cell;
      bestScore = score;
    }
  }
  return best;
}

/** Kamión, ktorý drží státie `stall` odstavnej plochy `holding`; `undefined` = voľné. */
export function stallHolder(world: World, holding: TruckHolding, stall: number): Truck | undefined {
  for (const truck of world.trucks.values()) if (truck.holdingId === holding.id && truck.stall === stall) return truck;
  return undefined;
}

/** Počet voľných státí odstavnej plochy. */
export function freeStalls(world: World, holding: TruckHolding): number {
  let used = 0;
  for (const truck of world.trucks.values()) if (truck.holdingId === holding.id) used += 1;
  return holding.stalls - used;
}

/** Prvé voľné státie odstavnej plochy, alebo −1. */
export function firstFreeStall(world: World, holding: TruckHolding): number {
  for (let stall = 0; stall < holding.stalls; stall++) if (stallHolder(world, holding, stall) === undefined) return stall;
  return -1;
}

/** Je vo svete aspoň jedno voľné TP (v ktoromkoľvek bloku), alebo voľné státie odstavnej plochy? Lacný predfilter pred prechodom dopytov. */
export function hasFreeToken(world: World): boolean {
  for (const holding of world.landsideModules.holdings) if (freeStalls(world, holding) > 0) return true;
  for (const module of world.modules.values()) {
    if (!(module instanceof YardBlockClass)) continue;
    for (const cell of tpCellsOf(world, module)) if (tpHolder(world, cell) === undefined) return true;
  }
  return false;
}
