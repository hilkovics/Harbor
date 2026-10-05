/**
 * Plánovanie trasy nosiča po cestách (ARCHITECTURE §7.3, §7.4; ADR-018, ADR-019, ADR-020, ADR-024) — spoločné pre
 * vozidlá aj kamióny.
 *
 * - Trasa sa plánuje z **kotvy** nosiča: `cell`, pri pohybe medzi bunkami `nextCell` (rozbehnutý úsek nosič dokončí).
 *   Ak nová cesta z `nextCell` vedie hneď späť do `cell`, nosič sa otočí uprostred úseku (`turnAround`), aby sa v ticku
 *   reálne pohol. Obrat nastane len vtedy, keď A* z `nextCell` smie ísť hneď do `cell` (smer jednosmerky, ADR-020).
 * - Cesty dáva `PathCache` (deterministický A* po smerových hranách, ADR-018, ADR-020); cena cesty je
 *   `Pathfinder.routeCost` (1 / `speedFactor` za bunku). Z viacerých cieľových buniek vyhrá najlacnejšia, pri zhode prvá.
 * - Pohyb za tick = `Carrier.advance` rýchlosťou `speedCellsPerTick` × `speedFactor` typu cieľovej bunky úseku
 *   (`World.roadSpeeds`).
 */
import type { Grid } from '../grid/grid';
import type { Module } from '../modules/module';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import type { PathCache } from '../logistics/path-cache';
import type { Pathfinder, QuayCells } from '../logistics/pathfinder';
import type { RoadSpeeds } from '../logistics/road-speed';
import type { AdvanceGate, Carrier } from './carrier';

/** Časť sveta, ktorú plánovanie a pohyb nosiča čítajú (`World` ju spĺňa). */
export interface MovementWorld {
  readonly grid: Grid;
  readonly paths: PathCache;
  readonly pathfinder: Pathfinder;
  readonly roadSpeeds: RoadSpeeds;
  /** Nábrežie kotvísk pod hákom (F6d, ADR-033 dodatok): jazdné bunky vozidla bez cesty; bez neho sa jazdí len po cestách. */
  readonly quay?: QuayCells;
  /**
   * Brána úseku dopravy bez prekrývania (ADR-037): `TrafficSystem` ju nastaví na nosič, ktorý sa práve hýbe. Bez nej (testy
   * pohybu) sa nosič hýbe bez slotov ako pred R1.
   */
  readonly trafficGate?: AdvanceGate;
}

/**
 * Smie nosič stáť a ísť po bunke `index`: bunka s cestou, alebo (F6d) nábrežie kotviska pod hákom — nábrežie je jazdné len pre
 * hľadanie trasy s koncom v ňom (`Pathfinder`), kontrola pohybu ho pripúšťa pre každú bunku trasy.
 */
export function isDrivableCell(world: MovementWorld, index: number): boolean {
  return world.grid.atIndex(index).road === 'road' || (world.quay !== undefined && world.quay.owners()[index] !== 0);
}

/** Kotva plánovania: bunka nosiča, pri pohybe medzi bunkami cieľová bunka úseku. */
export function routeAnchor(carrier: Carrier): number | undefined {
  return carrier.progress > 0 ? carrier.nextCell : carrier.cell;
}

/**
 * Nastaví nosiču cestu `path` naplánovanú z kotvy: pri ceste späť cez `cell` obrat uprostred úseku, inak `followRoute`
 * (pri pohybe medzi bunkami s predradenou `cell` — jediná alokácia plánovania).
 */
export function takePath(world: MovementWorld, carrier: Carrier, path: readonly number[]): void {
  const between = carrier.progress > 0;
  if (between && path[1] === carrier.cell) carrier.turnAround(path, world.grid.width);
  else carrier.followRoute(between ? Object.freeze([carrier.cell, ...path]) : path);
}

/**
 * Naplánuje trasu z kotvy do bunky `target` a nastaví ju nosiču. `false` = cieľ neexistuje (`NO_ACCESS`) alebo k nemu
 * nevedie cesta (nosič sa nezmení).
 */
export function planRouteToCell(world: MovementWorld, carrier: Carrier, target: number): boolean {
  const anchor = routeAnchor(carrier);
  if (anchor === undefined || target === NO_ACCESS) return false;
  const path = world.paths.get(anchor, target);
  if (path === null) return false;
  takePath(world, carrier, path);
  return true;
}

/**
 * Naplánuje trasu z kotvy k najbližšej prístupovej bunke modulu (vonkajšia bunka cestného konektora s cestou, ADR-017;
 * pri zhode cien prvý konektor v poradí defu) a nastaví ju nosiču. `false` = modul nemá prístupovú bunku, ku ktorej
 * vedie cesta (nosič sa nezmení). Alokuje len pri pohybe medzi bunkami bez obratu; inak použije zmrazenú cestu z cache.
 */
export function planRouteToModule(world: MovementWorld, carrier: Carrier, module: Module): boolean {
  const anchor = routeAnchor(carrier);
  if (anchor === undefined) return false;
  let best: readonly number[] | null = null;
  let bestCost = Infinity;
  for (const connector of module.connectors) {
    const access = accessCellIndex(world.grid, connector);
    if (access === NO_ACCESS) continue;
    const path = world.paths.get(anchor, access);
    if (path === null) continue;
    const cost = world.pathfinder.routeCost(path);
    if (cost < bestCost) {
      best = path;
      bestCost = cost;
    }
  }
  if (best === null) return false;
  takePath(world, carrier, best);
  return true;
}

/**
 * Jeden tick jazdy po trase rýchlosťou `speedCellsPerTick` (ADR-019, ADR-020); `true` = nosič stojí na konci trasy.
 * Sloty ďalších buniek stráži brána sveta (`trafficGate`, ADR-037): obsadený slot nosič zastaví v strede bunky.
 */
export function advanceCarrier(world: MovementWorld, carrier: Carrier, speedCellsPerTick: number): boolean {
  return carrier.advance(speedCellsPerTick, world.grid.width, world.roadSpeeds.speedFactor, world.trafficGate);
}
