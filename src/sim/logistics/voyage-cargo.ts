/**
 * Náklad lode voyage — import na vykládku a export na nakládku (F6a, ADR-032 bod 8–12; ADR-033). Čisté dotazy nad ledgerom
 * a knihou kontraktov, svet nemenia ani nespotrebujú `Rng`; systémy (žeriav, loď, dispatcher) ich volajú v hot path, preto
 * ich rýchla cesta pre svet bez exportu (`ContractBook.hasOpenExports`) nealokuje a nečíta kontrakty — import-only svet
 * sa správa bitovo a výkonovo ako vo F5.
 *
 * - **Export bookingy lode** (`openExportBookings`): neukončené kontrakty druhu `export`, ktorých loď voyage je `shipId`
 *   (`Contract.shipId` od `accepted → ship_en_route`), vzostupne podľa id.
 * - **Export na palube** = Σ `loadedUnits` bookingov (jednotka naložená `in_crane → on_ship` ostáva na lodi, kým loď neopustí
 *   mapu — `shipped`), **import na palube** = jednotky `on_ship` − export na palube. Bez skenu jednotiek.
 * - **Čakajúci export** (`pendingExportUnits`) = jednotky bookingov na termináli, ktoré sa ešte naložia: prijaté − naložené −
 *   vrátené − v hold (zadržané jednotky loď nečaká, rozhodnutie 5).
 * - `stowageOutOfOrder`: je na termináli nenaložená jednotka voyage mimo hold s menším kľúčom stowage plánu?
 */
import { compareStowageOrder } from '../cargo/stowage';
import type { CargoUnit } from '../cargo/cargo-unit';
import type { Contract } from '../contracts/contract';
import type { EntityId } from '../core/entity-id';
import type { World } from '../world/world';

const NO_BOOKINGS: readonly Contract[] = Object.freeze([]);

/** Do `into` (najprv sa vyprázdni) neukončené export bookingy lode `shipId` vzostupne podľa id; bez exportu v knihe prázdne. */
export function openExportBookings(world: World, shipId: EntityId, into: Contract[]): readonly Contract[] {
  into.length = 0;
  if (!world.contractBook.hasOpenExports) return NO_BOOKINGS;
  for (const contract of world.contractBook.openContracts.values()) {
    if (contract.kind === 'export' && contract.shipId === shipId) into.push(contract);
  }
  return into;
}

/** Znovupoužiteľné pole bookingov pre hot path (jedno vlákno simulácie; obsah sa vždy najprv vyprázdni). */
const SCRATCH: Contract[] = [];

/** Jednotky exportu naložené na palube lode (Σ `loadedUnits` jej otvorených bookingov); bez exportu v knihe 0. */
export function exportAboard(world: World, shipId: EntityId): number {
  if (!world.contractBook.hasOpenExports) return 0;
  let loaded = 0;
  for (const contract of openExportBookings(world, shipId, SCRATCH)) loaded += contract.booking?.loadedUnits ?? 0;
  return loaded;
}

/** Jednotky importu na palube lode = jednotky `on_ship` − export na palube. */
export function importAboard(world: World, shipId: EntityId): number {
  return world.cargo.countAt('on_ship', shipId) - exportAboard(world, shipId);
}

/** Prvá jednotka importu na lodi (najmenšie id, export sa preskočí); bez nej `undefined`. Bez exportu O(1) ako `firstUnitAt`. */
export function firstImportOnShip(world: World, shipId: EntityId): EntityId | undefined {
  const count = world.cargo.countAt('on_ship', shipId);
  for (let i = 0; i < count; i++) {
    const unitId = world.cargo.unitAtIndex('on_ship', shipId, i);
    if (unitId !== undefined && world.cargo.get(unitId)?.direction === 'import') return unitId;
  }
  return undefined;
}

/**
 * Jednotky exportu lode na termináli, ktoré sa ešte naložia: Σ (prijaté − naložené − vrátené − v hold) cez jej otvorené
 * bookingy (nie pod 0). Loď s nimi počká, kým sa naložia; zadržané (VGM) a vrátené neblokujú (ADR-032 bod 12).
 */
export function pendingExportUnits(world: World, shipId: EntityId): number {
  if (!world.contractBook.hasOpenExports) return 0;
  let pending = 0;
  for (const contract of openExportBookings(world, shipId, SCRATCH)) {
    const booking = contract.booking;
    if (booking === null) continue;
    pending += Math.max(0, booking.arrivedUnits - booking.loadedUnits - booking.returnedUnits - booking.heldUnits);
  }
  return pending;
}

/** Jednotka exportu je naložiteľná: smer export, mimo hold a nie je už na lodi / mimo mapy. */
export function isLoadable(unit: CargoUnit): boolean {
  return unit.direction === 'export' && unit.hold === null;
}

/**
 * Nenaložená jednotka voyage s menším kľúčom stowage plánu než `loaded` na termináli (sklad, apron, vozidlo, dock rampy),
 * mimo hold? Hodnota `UnitLoaded.outOfOrder` (metrika `stowageOrderViolations`, ADR-032 bod 9). O(živé jednotky) — volá sa len
 * pri nakládke jednej jednotky exportu. Jednotky ešte v kamióne (neprešli bránou) a už naložené sa nepočítajú.
 */
export function stowageOutOfOrder(world: World, loaded: CargoUnit): boolean {
  if (loaded.voyageId === null) return false;
  for (const unit of world.cargo.liveUnits()) {
    if (unit.id === loaded.id || unit.voyageId !== loaded.voyageId || !isLoadable(unit)) continue;
    const { kind } = unit.location;
    if (kind !== 'in_storage' && kind !== 'on_apron' && kind !== 'in_vehicle' && kind !== 'at_ramp' && kind !== 'in_crane') continue;
    if (compareStowageOrder(unit, loaded) < 0) return true;
  }
  return false;
}
