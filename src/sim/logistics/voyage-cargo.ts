/**
 * Náklad lode voyage — import (a prekládka z lode A) na vykládku a export, prekládka na lodi B a prázdne na nakládku (F6a, ADR-032 bod
 * 8–12; ADR-033; F6c, ADR-034). Čisté dotazy nad ledgerom a knihou kontraktov, svet nemenia ani nespotrebujú `Rng`; systémy (žeriav,
 * loď, dispatcher) ich volajú v hot path, preto nealokujú (znovupoužiteľné polia na úrovni modulu) a import-only svet sa správa bitovo
 * a výkonovo ako vo F5.
 *
 * - **Bookingy nakládky lode** (`openLoadBookings`): neukončené kontrakty, ktoré nakladajú na loď `shipId` (`Contract.loadShipId`: export
 *   a repositioning loď voyage, prekládka loď B), vzostupne podľa id. Rýchla cesta: bez otvoreného bookingu v knihe
 *   (`ContractBook.hasOpenExports`) sa kontrakty nečítajú vôbec (to isté `pendingExportUnits`).
 * - **Náklad na nakládku na palube** (`exportAboard`) = jednotky `on_ship` smeru `export` a `empty` (ledger, O(1)) a **naložená prekládka**
 *   (jednotka `tranship` na lodi B = `Contract.loadShipId` jej kontraktu, `isOutboundOnShip`); **náklad na vykládku** (`importAboard`) = ostatné
 *   jednotky `on_ship` (import a prekládka na lodi A). Rozlišuje ich smer jednotky (a pri prekládke kontrakt), nie otvorené bookingy: uzavretý
 *   booking s nákladom na palube (zlyhanie počas nakládky) nezmení, čo je na lodi vykládané a čo naložené.
 * - **Čakajúci náklad** (`pendingExportUnits`) = jednotky bookingov na termináli, ktoré sa ešte naložia: prijaté (export: bránou, prekládka:
 *   vyložené z lode A, repositioning: pridelené nakládke) − naložené − vrátené − v hold (zadržané jednotky loď nečaká, rozhodnutie 5).
 * - `stowageOutOfOrder`: je na termináli nenaložená jednotka lode mimo hold s menším kľúčom stowage plánu (plné pred prázdnymi)?
 */
import { compareStowageOrder } from '../cargo/stowage';
import { OUTBOUND_BY_DIRECTION, type CargoUnit } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import type { ContractKind } from '../contracts/contract-fsm';
import { slaLapsed } from '../contracts/contract-terms';
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { CRANE_CYCLE_TRAITS, CraneModule } from '../modules/crane-module';
import type { Ship } from '../ships/ship';
import type { World } from '../world/world';
import { countAvailableEmpties } from './empty-stock';
import { collectLoadBerths } from './load-access';

const NO_BOOKINGS: readonly Contract[] = Object.freeze([]);
const NO_BERTHS: readonly BerthModule[] = Object.freeze([]);

/** Do `into` (najprv sa vyprázdni) neukončené kontrakty nakladajúce na loď `shipId` vzostupne podľa id; bez bookingu v knihe prázdne. */
export function openLoadBookings(world: World, shipId: EntityId, into: Contract[]): readonly Contract[] {
  into.length = 0;
  if (!world.contractBook.hasOpenExports) return NO_BOOKINGS;
  for (const contract of world.contractBook.openContracts.values()) {
    if (contract.loadShipId === shipId) into.push(contract);
  }
  return into;
}

/** Znovupoužiteľné pole bookingov pre hot path (jedno vlákno simulácie; obsah sa vždy najprv vyprázdni). */
const SCRATCH: Contract[] = [];

/**
 * Je jednotka `unit` na lodi `shipId` (alebo čaká na jej apron — `null` = loď neznáma) **náklad na nakládku**? Export a prázdny vždy
 * (`OUTBOUND_BY_DIRECTION`); prekládka len na lodi B svojho kontraktu (na lodi A je náklad na vykládku); import nikdy.
 */
export function isOutboundOnShip(world: World, unit: CargoUnit, shipId: EntityId | null): boolean {
  if (OUTBOUND_BY_DIRECTION[unit.direction]) return true;
  if (unit.direction !== 'tranship' || shipId === null || unit.contractId === null) return false;
  return world.contractBook.get(unit.contractId)?.loadShipId === shipId;
}

/** Počet naložených jednotiek prekládky na lodi `shipId` (prechod jednotkami lode — volá sa len keď má loď prekládku). */
function loadedTranshipAboard(world: World, shipId: EntityId): number {
  const count = world.cargo.countAt('on_ship', shipId);
  let loaded = 0;
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_ship', shipId, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit?.direction === 'tranship' && isOutboundOnShip(world, unit, shipId)) loaded += 1;
  }
  return loaded;
}

/** Jednotky na palube lode, ktoré sú náklad na nakládku (export, prázdne, naložená prekládka); O(1) z ledgera, ak loď nenesie prekládku. */
export function exportAboard(world: World, shipId: EntityId): number {
  const base = world.cargo.countExportsAt('on_ship', shipId);
  return world.cargo.countTranshipAt('on_ship', shipId) === 0 ? base : base + loadedTranshipAboard(world, shipId);
}

/** Jednotky na palube lode, ktoré sa majú vyložiť (import, prekládka z lode A) = jednotky `on_ship` − náklad na nakládku. */
export function importAboard(world: World, shipId: EntityId): number {
  return world.cargo.countAt('on_ship', shipId) - exportAboard(world, shipId);
}

/** Prvá jednotka na vykládku na lodi (najmenšie id, náklad na nakládku sa preskočí); bez nej `undefined`. Bez prekládky O(1) ako `firstUnitAt`. */
export function firstUnloadableOnShip(world: World, shipId: EntityId): EntityId | undefined {
  const count = world.cargo.countAt('on_ship', shipId);
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_ship', shipId, i);
    const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
    if (unit !== undefined && !isOutboundOnShip(world, unit, shipId)) return unitId;
  }
  return undefined;
}

/**
 * Jednotky bookingu `contract`, ktoré ešte nie sú pridelené nakládke, ale loď ich môže dostať (`PENDING_UNASSIGNED`): export a prekládka žiadne (ich
 * jednotky sú „prijaté“ bránou / vykládkou lode A), repositioning dostupné prázdne linky v sklade s cestou ku kotvisku lode (`load-access.ts`, T6C-07b: odrezané depo loď nezdržuje), najviac toľko, koľko
 * booking ešte smie prideliť — loď na ne počká, aby nikdy neodišla skôr, než dispatcher stihne prázdne prideliť (booking sa otvorí v ticku, keď loď zakotví).
 */
const PENDING_UNASSIGNED: { readonly [K in ContractKind]: (world: World, contract: Contract, berths: readonly BerthModule[]) => number } = {
  import: () => 0,
  export: () => 0,
  tranship: () => 0,
  empty_repositioning: (world, contract, berths) =>
    contract.acceptsLoading && !loadingStopped(world, contract) ? Math.min(contract.loadsToAssign, countAvailableEmpties(world, contract.lineId, berths)) : 0,
};

/** Znovupoužiteľné pole kotvísk nakládky lode pre `pendingExportUnits` (hot path; obsah sa vždy najprv vyprázdni). */
const LOAD_BERTHS: BerthModule[] = [];

/**
 * Jednotky lode na termináli, ktoré sa ešte naložia: Σ (prijaté − naložené − vrátené − v hold) cez jej otvorené bookingy (nie pod 0) plus
 * dostupné prázdne, ktoré si repositioning ešte môže prideliť (`PENDING_UNASSIGNED`). Loď s nimi počká, kým sa naložia; zadržané (VGM) a vrátené
 * neblokujú (ADR-032 bod 12).
 */
export function pendingExportUnits(world: World, shipId: EntityId): number {
  if (!world.contractBook.hasOpenExports) return 0;
  const ship = world.ships.get(shipId);
  const berths = ship === undefined ? NO_BERTHS : collectLoadBerths(world, ship, LOAD_BERTHS);
  let pending = 0;
  for (const contract of openLoadBookings(world, shipId, SCRATCH)) {
    const booking = contract.booking;
    if (booking === null) continue;
    pending += Math.max(0, booking.arrivedUnits - booking.loadedUnits - booking.returnedUnits - booking.heldUnits) + PENDING_UNASSIGNED[contract.kind](world, contract, berths);
  }
  return pending;
}

/**
 * Uplynula lehota zlyhania bookingu (`economy.failAfterDaysLate` dní po `slaDeadlineTick`)? Od tej chvíle sa pre booking nezačínajú nové
 * joby nakládky (`createExportLoadJobs`); rozbehnutá nakládka sa dokončí (`loadingInFlight`) a booking sa uzavrie (`closeBooking`).
 */
export function loadingStopped(world: World, contract: Contract): boolean {
  return slaLapsed(world.clock.tick, contract.slaDeadlineTick, world.defs.economy.failAfterDaysLate, world.clock.ticksPerDay);
}

/**
 * Je pre booking rozbehnutá nakládka na lodi `ship`? Job nakládky jeho jednotky (`→ on_apron` / `→ in_crane`, v ktoromkoľvek stave),
 * jeho jednotka na aprone kotviska lode (čaká na žeriav) alebo žeriav lode s nakládkou v ceste. Jednotku bookingu rozpoznáva
 * `Contract.loadsUnit` (export, prekládka podľa kontraktu, prázdne podľa linky). Volá sa len po lehote zlyhania (zriedka), preto
 * prechádza joby a aprony bez indexu.
 */
export function loadingInFlight(world: World, contract: Contract, ship: Ship): boolean {
  for (const job of world.jobs.values()) {
    if (job.to.kind !== 'on_apron' && job.to.kind !== 'in_crane') continue;
    const unit = world.cargo.get(job.unitIds[0]);
    if (unit !== undefined && contract.loadsUnit(unit)) return true;
  }
  for (const berthId of ship.berthIds) {
    const count = world.cargo.countAt('on_apron', berthId);
    for (let i = 0; i < count; i++) {
      const unitId = world.cargo.unitAtIndex('on_apron', berthId, i);
      const unit = unitId === undefined ? undefined : world.cargo.get(unitId);
      if (unit !== undefined && contract.loadsUnit(unit)) return true;
    }
  }
  return loadsInFlight(world, ship) > 0;
}

/** Jednotka je naložiteľná: plná (export, prekládka) alebo dostupný prázdny kontajner, mimo hold a nie je už na lodi / mimo mapy. */
export function isLoadable(unit: CargoUnit): boolean {
  return unit.direction !== 'import' && unit.hold === null && unit.status === 'available';
}

/** Nakladá aspoň jeden z `bookings` jednotku `unit` (`Contract.loadsUnit`)? Cyklus bez uzáveru (hot path). */
export function anyBookingLoads(bookings: readonly Contract[], unit: CargoUnit): boolean {
  for (const contract of bookings) if (contract.loadsUnit(unit)) return true;
  return false;
}

/** Neukončené kontrakty, ktorých náklad je jednotka `unit` (do `SCRATCH`); používa ho `stowageOutOfOrder` bez lode. */
function bookingsOfUnit(world: World, unit: CargoUnit): readonly Contract[] {
  SCRATCH.length = 0;
  for (const contract of world.contractBook.openContracts.values()) if (contract.loadsUnit(unit)) SCRATCH.push(contract);
  return SCRATCH;
}

/**
 * Nenaložená jednotka lode s menším kľúčom stowage plánu než `loaded` na termináli (sklad, apron, vozidlo, dock rampy), mimo hold? Hodnota
 * `UnitLoaded.outOfOrder` (metrika `stowageOrderViolations`, ADR-032 bod 9, ADR-034 bod 10 — plné pred prázdnymi). Jednotky lode sú
 * jednotky jej bookingov (`openLoadBookings` pre `shipId`; bez lode bookingy jednotky `loaded` samotnej). O(živé jednotky) — volá sa len
 * pri nakládke jednej jednotky. Jednotky ešte v kamióne (neprešli bránou) a už naložené sa nepočítajú.
 */
export function stowageOutOfOrder(world: World, loaded: CargoUnit, shipId?: EntityId): boolean {
  const bookings = shipId === undefined ? bookingsOfUnit(world, loaded) : openLoadBookings(world, shipId, SCRATCH);
  if (bookings.length === 0) return false;
  for (const unit of world.cargo.liveUnits()) {
    if (unit.id === loaded.id || !isLoadable(unit)) continue;
    const { kind } = unit.location;
    if (kind !== 'in_storage' && kind !== 'on_apron' && kind !== 'in_vehicle' && kind !== 'at_ramp' && kind !== 'in_crane') continue;
    if (compareStowageOrder(unit, loaded) < 0 && anyBookingLoads(bookings, unit)) return true;
  }
  return false;
}

/** Žeriav kategórie lode s nakládkou v cykle — jednotka exportu je v ceste na loď (`grabbing`, `swinging`, `placing`). */
export const isLoadingInFlight = (crane: CraneModule): boolean =>
  crane.state !== 'idle' && crane.state !== 'blocked' && CRANE_CYCLE_TRAITS[crane.cycle].direction === 'load';

/** Počet žeriavov kategórie lode na jej kotviskách, ktoré spĺňajú `predicate` (bez alokácie okrem výsledku). */
export function countShipCranes(world: World, ship: Ship, predicate: (crane: CraneModule) => boolean): number {
  let count = 0;
  for (const berthId of ship.berthIds) {
    const berth = world.modules.get(berthId);
    if (!(berth instanceof BerthModule)) continue;
    for (const craneId of berth.craneIds) {
      const crane = world.modules.get(craneId);
      if (crane instanceof CraneModule && crane.category === ship.cargoCategory && predicate(crane)) count += 1;
    }
  }
  return count;
}

/**
 * Počet žeriavov lode s nakládkou v ceste (`isLoadingInFlight`). Loď, ktorej booking sa uzavrel počas nakládky (SLA), s nimi
 * neodíde — žeriav by ukončil cyklus bez dokovanej lode; počká, kým ich cyklus skončí.
 */
export function loadsInFlight(world: World, ship: Ship): number {
  return countShipCranes(world, ship, isLoadingInFlight);
}
