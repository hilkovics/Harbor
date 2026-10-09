/**
 * Cieľ lístka kamióna (R4, ADR-041 bod 4 a 5): **token** = rezervované TP bloku, alebo — keď je TP obsadené — státie odstavnej plochy, odkiaľ TOS kamión zavolá, keď sa TP uvoľní
 * (`trucks/holding.ts`). Token sa rezervuje pri vzniku kamióna, takže vnútri prístavu je najviac toľko kamiónov, koľko je TP a státí; ďalší čakajú vo vnútrozemí (ADR-035) a na ceste
 * sa front netvorí. Cieľ musí byť obslužiteľný z niektorého vstupného pruhu a z TP musí viesť cesta von (`LandsideNetwork.servesTp`).
 */
import type { EntityId } from '../core/entity-id';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import { TruckHolding } from '../modules/truck-holding';
import type { YardBlock } from '../modules/yard-block';
import type { World } from '../world/world';
import type { Truck } from './truck';
import { stopReady } from './stop-ready';
import { chooseTp, firstFreeStall, hasLaneTp, isTpFree, tpCellsOf } from './tp-points';

/** Rezervované TP. */
export interface TpToken {
  readonly kind: 'tp';
  readonly cell: number;
}

/** Rezervované státie odstavnej plochy. */
export interface StallToken {
  readonly kind: 'stall';
  readonly holding: TruckHolding;
  readonly stall: number;
}

export type Token = TpToken | StallToken;

/** Slúži niektorý platný vstupný pruh kamiónu s cieľom `cell` (cesta tam a z TP von)? */
export function anyLaneServes(world: World, cell: number): boolean {
  for (const lane of world.landside.inLanes) if (world.landside.servesTp(lane, cell)) return true;
  return false;
}

/** Bay TP, ku ktorému má kamión mieriť pre slot `slot` bloku (RTG: `RtgBlock.tpBayNear`), alebo `undefined` (blok bez TP v pruhu). */
export function nearBayOfSlot(block: YardBlock, slot: number): number | undefined {
  return hasLaneTp(block) ? block.tpBayNear(block.positionOfSlot(slot).bay) : undefined;
}

/** Prístupová bunka vjazdu (`entry`) alebo výjazdu (`exit`) odstavnej plochy, alebo `NO_ACCESS`. */
export function holdingCell(world: World, holding: TruckHolding, side: 'entry' | 'exit'): number {
  const connector = holding.connectors[side === 'entry' ? 0 : 1];
  return connector === undefined ? NO_ACCESS : accessCellIndex(world.grid, connector);
}

/** Prvá odstavná plocha s voľným státím, ktorú niektorý vstupný pruh obslúži (vjazd) a z ktorej vedie cesta von (výjazd → späť k bráne von); inak `undefined`. */
function freeHolding(world: World): StallToken | undefined {
  for (const holding of world.landsideModules.holdings) {
    const stall = firstFreeStall(world, holding);
    if (stall < 0) continue;
    const entry = holdingCell(world, holding, 'entry');
    const exit = holdingCell(world, holding, 'exit');
    if (entry === NO_ACCESS || exit === NO_ACCESS || !anyLaneServes(world, entry) || !world.landside.reachesOut(exit)) continue;
    return { kind: 'stall', holding, stall };
  }
  return undefined;
}

/** Má kamión z odstavnej plochy voľné TP z `cells`, na ktoré ho TOS môže zavolať (cesta z výjazdu plochy k TP a z TP von; rovnaká podmienka ako `callFromHolding`)? */
function callableToFreeTp(world: World, truck: Truck, cells: readonly number[], self: EntityId | undefined): boolean {
  const holding = truck.holdingId === null ? undefined : world.modules.get(truck.holdingId);
  if (!(holding instanceof TruckHolding)) return false;
  const exit = holdingCell(world, holding, 'exit');
  if (exit === NO_ACCESS) return false;
  for (const cell of cells) if (isTpFree(world, cell, self) && world.distances.distance(exit, cell) < Infinity && world.landside.reachesOut(cell)) return true;
  return false;
}

/**
 * Smie si nový záujemca zobrať voľné TP `cell` bloku `block`? Kamióny v odstavnej ploche, ktoré na TP bloku čakajú a ich zastávka je pripravená, majú prednosť (inak by nové kamióny
 * donekonečna predbiehali čakajúcich, keď sa TP uvoľní skôr, než ho TOS zavolá): záujemca uspeje, len keď voľných TP bloku je viac ako pripravených čakajúcich. TP, ktoré už drží `self`
 * (dual transaction na tom istom mieste), sa neodoberá nikomu.
 */
function tpOpenTo(world: World, block: YardBlock, cell: number, self: EntityId | undefined): boolean {
  const waiting = world.truckIndex.holdingFor(block.id);
  if (waiting.length === 0 || (self !== undefined && world.truckIndex.tpHolder(cell)?.id === self)) return true;
  const cells = tpCellsOf(world, block);
  let free = 0;
  for (const candidate of cells) if (isTpFree(world, candidate, self)) free += 1;
  // Čakajúci, ktorého TOS nemá kam zavolať (žiadne voľné TP z výjazdu jeho plochy), TP nezdržiava.
  let ready = 0;
  for (const truck of waiting) if (stopReady(world, truck) && callableToFreeTp(world, truck, cells, self)) ready += 1;
  return free > ready;
}

/**
 * Token cieľa pre blok `block`: voľné TP najbližšie k bayu `nearBay` s cestou tam a von; inak voľné státie odstavnej plochy (`allowStall`); `null` = ani jedno (kamión čaká vo vnútrozemí).
 * `self` = kamión, ktorý už token drží (jeho TP sa nepočíta ako obsadené).
 */
export function reserveToken(world: World, block: YardBlock, nearBay: number | undefined, allowStall: boolean, self?: EntityId): Token | null {
  const cell = chooseTp(world, block, nearBay, self, (candidate) => anyLaneServes(world, candidate));
  if (cell !== NO_ACCESS) {
    if (tpOpenTo(world, block, cell, self)) return { kind: 'tp', cell };
    // TP je vyhradené čakajúcemu kamiónu z odstavnej plochy: záujemca dostane `null` (čaká vo vnútrozemí), nie státie — ďalšie kamióny mieriace do odstavných plôch by zahltili cestu,
    // po ktorej sa čakajúci kamióny volajú k TP (namerané: pobyt v bráne ×3 v špičke).
    return null;
  }
  return allowStall ? (freeHolding(world) ?? null) : null;
}

/** Bunka, ku ktorej kamión s tokenom mieri po bráne: TP, alebo vjazd odstavnej plochy. */
export function tokenCell(world: World, token: Token): number {
  return token.kind === 'tp' ? token.cell : holdingCell(world, token.holding, 'entry');
}

/** Zapíše token kamiónu (TP, alebo státie); druhý druh tokenu sa vynuluje. */
export function applyToken(truck: Truck, token: Token): void {
  if (token.kind === 'tp') {
    truck.tpCell = token.cell;
    truck.holdingId = null;
    truck.stall = null;
  } else {
    truck.tpCell = null;
    truck.holdingId = token.holding.id;
    truck.stall = token.stall;
  }
}
