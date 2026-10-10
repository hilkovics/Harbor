/**
 * Nákladové polia render view-modelov (F6c, ADR-034; T6C-06a): čo `SimBridge` z ledgera zloží pre prázdne kontajnery, depo prázdnych
 * a prekládku. Čisté funkcie nad `World` bez side-effectov (nič nemenia, `Rng` nespotrebujú) a bez závislosti na DOM / Pixi / React.
 *
 * - **Prázdne kontajnery** (`direction: 'empty'`): `emptyLook` (apron: `empty` + `lineToken`), `depotVM` (depo: dostupné / poškodené / v oprave z `depotCargoSplit` + `repairBays`).
 * - **Náklad lode pre palubu** (`shipDeckSplit`): tri smery pre renderer — import, export a prázdne. Prekládka (`tranship`) sa
 *   zarátava do **importu na lodi A** (privezie ju, vyloží sa pod hák) a do **exportu na lodi B** (odvezie ju, nakladá sa spolu
 *   s exportom). Loď A pozná jednotka podľa `voyageId` (štítok pri vzniku = voyage lode A, ledger ho nemení), loď B je každá iná
 *   (`ContractBook.voyageIdOfShip`: voyage lode kontraktu — pre B `outVoyageId`, po záchrane zmeškanej prekládky voyage ďalšej lode).
 *   `ShipSplitCache` výsledok drží, kým sa nezmení revízia snapshotu (`SimBridge.REVISION_EVENTS`: `CargoMoved`, `ShipSpawned`,
 *   `ContractAccepted`, `TranshipRescued` …) alebo počet jednotiek na palube — ledger sa neprechádza každý frame.
 * - **Vozidlá a kamióny** (`unitCarriesEmpty`, `truckCarriesEmpty`): vezená jednotka je prázdny kontajner. Kamión misie `collect`
 *   (výdaj prázdneho exportérovi) je pred naložením prázdny (`loaded: false`) a po naložení nesie `carriesEmpty`; kamión, ktorý
 *   prázdny dovezie, ho vyloží skôr, než ho renderer dokončí cúvaním do docku — preto si pamätá poslednú hodnotu (`truckCarriesEmpty`).
 */
import type { CargoDirection, CargoUnit } from '@sim/cargo';
import type { EntityId, VoyageId } from '@sim/core';
import type { EmptyDepot } from '@sim/modules';
import type { Ship } from '@sim/ships';
import { depotCargoSplit, type World } from '@sim/world';
import type { ModuleVM } from '@render/view-models';

/** Je jednotka prázdny kontajner (`direction: 'empty'`)? */
export function isEmptyUnit(unit: CargoUnit | undefined): boolean {
  return unit?.direction === 'empty';
}

/** Token farby linky jednotky (`LineDef.colorToken`, napr. `line-blue`), alebo `undefined`, ak jednotka linku nemá alebo ju `lines.json` nepozná. */
export function lineTokenOf(world: Pick<World, 'defs'>, unit: CargoUnit): string | undefined {
  const { lines } = world.defs;
  return unit.lineId !== null && lines.has(unit.lineId) ? lines.get(unit.lineId).colorToken : undefined;
}

/** Vzhľad jednotky na aprone: prázdny kontajner nesie `empty` a farbu svojej linky (`lineToken`), ostatné jednotky nič (oranžový kontajner). */
export function emptyLook(world: Pick<World, 'defs'>, unit: CargoUnit): { empty?: true; lineToken?: string } {
  if (!isEmptyUnit(unit)) return {};
  const lineToken = lineTokenOf(world, unit);
  return lineToken === undefined ? { empty: true } : { empty: true, lineToken };
}

/** VM depa prázdnych: prázdne uskladnené v depe podľa stavu kvality (súčet liniek) a počet miest opravy. */
export function depotVM(world: Pick<World, 'cargo' | 'defs'>, depot: EmptyDepot): NonNullable<ModuleVM['depot']> {
  let available = 0;
  let damaged = 0;
  let inRepair = 0;
  for (const line of depotCargoSplit(world, depot.id).lines) {
    available += line.available;
    damaged += line.damaged;
    inRepair += line.in_repair;
  }
  return { available, damaged, inRepair, repairBays: depot.repairBays };
}

/** Náklad lode pre palubu: import, export a prázdne v jednotkách (prekládka je už zaradená — viď hlavička). */
export interface DeckSplit {
  readonly import: number;
  readonly export: number;
  readonly empty: number;
}

type DeckKind = keyof DeckSplit;

/** Smer jednotky → druh nákladu na palube. `tranship` rozhoduje loď (`transhipDeckKind`), preto nie je v tabuľke. */
const DECK_KIND_OF: { readonly [D in Exclude<CargoDirection, 'tranship'>]: DeckKind } = Object.freeze({
  import: 'import',
  export: 'export',
  empty: 'empty',
});

/** Prekládka na lodi A (voyage lode = voyage jednotky) je príchozí náklad (`import`), na akejkoľvek inej lodi (B) odchádzajúci (`export`). */
function transhipDeckKind(unitVoyageId: VoyageId | null, shipVoyageId: VoyageId | undefined): DeckKind {
  return unitVoyageId !== null && unitVoyageId === shipVoyageId ? 'import' : 'export';
}

/**
 * Náklad lode `ship` pre render: jednotky `on_ship` rozdelené na import (vrátane prekládky na lodi A), export (vrátane prekládky
 * na lodi B) a prázdne. Súčet = `world.cargo.countAt('on_ship', ship.id)`. O(jednotky na palube); voyage lode sa hľadá len pri
 * prekládke (`ContractBook.voyageIdOfShip`).
 */
export function shipDeckSplit(world: World, ship: Ship): DeckSplit {
  const { cargo } = world;
  const totals: { [K in DeckKind]: number } = { import: 0, export: 0, empty: 0 };
  let shipVoyageId: VoyageId | undefined | null = null; // `null` = ešte nehľadané
  const count = cargo.countAt('on_ship', ship.id);
  for (let i = 0; i < count; i++) {
    const unitId = cargo.unitAtIndex('on_ship', ship.id, i);
    const unit = unitId === undefined ? undefined : cargo.get(unitId);
    if (unit === undefined) continue;
    if (unit.direction === 'tranship') {
      if (shipVoyageId === null) shipVoyageId = world.contractBook.voyageIdOfShip(ship.id);
      totals[transhipDeckKind(unit.voyageId, shipVoyageId)] += 1;
    } else {
      totals[DECK_KIND_OF[unit.direction]] += 1;
    }
  }
  return totals;
}

/** Zapamätaný náklad lode a kľúč, pre ktorý platí. */
interface ShipSplitEntry {
  readonly revision: number;
  readonly onBoard: number;
  readonly split: DeckSplit;
}

/**
 * Cache `shipDeckSplit` podľa lode: rozdelenie platí, kým sa nezmení revízia snapshotu a počet jednotiek na palube (poistka pre
 * zmenu ledgera bez udalosti, napr. v testoch). Zaniknuté lode sa zabudnú (`prune`).
 */
export class ShipSplitCache {
  private readonly entries = new Map<EntityId, ShipSplitEntry>();

  /** Náklad lode `ship` pre `revision` (prepočíta sa len pri zmene kľúča). */
  split(world: World, ship: Ship, revision: number): DeckSplit {
    const onBoard = world.cargo.countAt('on_ship', ship.id);
    const hit = this.entries.get(ship.id);
    if (hit !== undefined && hit.revision === revision && hit.onBoard === onBoard) return hit.split;
    const split = shipDeckSplit(world, ship);
    this.entries.set(ship.id, { revision, onBoard, split });
    return split;
  }

  /** Zabudne lode, ktoré už vo svete nie sú. */
  prune(world: Pick<World, 'ships'>): void {
    for (const id of this.entries.keys()) {
      if (!world.ships.has(id)) this.entries.delete(id);
    }
  }
}

/** Vezie jednotka, ktorú drží držiteľ `kind` / `holderId` (prvá v poradí), prázdny kontajner? Bez jednotky `false`. */
export function holderCarriesEmpty(world: Pick<World, 'cargo'>, kind: 'in_vehicle' | 'in_truck', holderId: EntityId): boolean {
  const unitId = world.cargo.firstUnitAt(kind, holderId);
  return unitId !== undefined && isEmptyUnit(world.cargo.get(unitId));
}

/**
 * `TruckVM.carriesEmpty`: kamión vezie prázdny kontajner. Kým nesie jednotku, rozhoduje jej smer; bez jednotky platí `before` (hodnota
 * z posledného ticku, v ktorom nejakú niesol) — kamión, ktorý prázdny dovezie, ho vyloží (`in_truck → at_ramp`) rýchlejšie, než
 * renderer dokončí cúvanie do docku, a ten kreslí kontajner z príchodu (`DockManeuver.displayLoaded`), takže potrebuje poznať jeho druh.
 * Kamión misie `collect` pred naložením `before` nemá (`false`), po naložení nesie prázdny.
 */
export function truckCarriesEmpty(world: Pick<World, 'cargo'>, truckId: EntityId, before: boolean | undefined): boolean {
  const unitId = world.cargo.firstUnitAt('in_truck', truckId);
  if (unitId === undefined) return before ?? false;
  return isEmptyUnit(world.cargo.get(unitId));
}
