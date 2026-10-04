/**
 * Vjazd kamióna z vnútrozemia do prístavu (F6d, ADR-035; `trucks/hinterland.ts`): kamión s dovozom (`delivery` — export, návrat prázdneho) dostane
 * vjazd, len keď má rezerváciu — pre prvú vhodnú rampu (kategória nákladu, prevádzková, kamión kategórie) musia platiť všetky tri podmienky:
 * 1. **stojisko**: voľný bay nad kvótou pre odvoz (`routeWithFreeBay(…, 'delivery')`, `WaitingArea.pickupReservedBays`);
 * 2. **dock**: niektorý dock má voľné staging miesto po odpočítaní miest prisľúbených kamiónom, ktoré si ich ešte nerezervovali (`DockIntake.roomAt`);
 *    dock s najmenej kamiónmi (rozloženie vykládok), pri zhode nižší;
 * 3. **sklad / depo**: kontajner bude mať kde skončiť (`inboundRoom`, viď `trucks/hinterland-room.ts`).
 * Výsledok pokusu: `admitted` (kamión vznikol na road portáli, plán sa spotrebuje), `declined` (len návrat prázdneho: depo prázdnych nemá štrukturálne
 * žiadne miesto — viď `inboundRoom.free` — a čakať nemá zmysel, plán sa zahodí) alebo `waiting` (kamión čaká vo vnútrozemí, plán ostáva; pri každej
 * zlyhanej podmienke, aj keď iná rampa uspela by).
 */
import type { CargoDirection } from '../cargo/cargo-unit';
import type { CargoCategory } from '../defs/types';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { World } from '../world/world';
import { hasInboundRoom, inboundRoom } from './hinterland-room';
import type { Truck } from './truck';
import { routeWithFreeBay, spawnTruck, truckDefFor } from './truck-spawner';

/** Výsledok pokusu o vjazd (viď hlavička). */
export type AdmissionOutcome = 'admitted' | 'declined' | 'waiting';

/** Znovupoužiteľné pole počtu kamiónov na dock pre `leastBusyDock` (hot path bez alokácie; plní sa pri každom volaní). */
const DOCK_TRUCKS: number[] = [];

/**
 * Dock rampy s najmenej kamiónmi (každej misie, vrátane tých na ceste k bráne); pri zhode nižší dock. `needRoom`: berú sa len docky, ktoré majú voľné
 * staging miesto po odpočítaní prisľúbených (`DockIntake.roomAt`, volajúci obnovil `world.dockIntake`); žiadny taký → −1.
 */
export function leastBusyDock(world: World, ramp: LoadingRamp, needRoom = false): number {
  DOCK_TRUCKS.length = ramp.docks;
  DOCK_TRUCKS.fill(0);
  for (const truck of world.trucks.values()) if (truck.rampId === ramp.id && truck.dock < ramp.docks) DOCK_TRUCKS[truck.dock] += 1;
  let best = -1;
  for (let dock = 0; dock < ramp.docks; dock++) {
    if (needRoom && world.dockIntake.roomAt(ramp, dock) <= 0) continue;
    if (best < 0 || DOCK_TRUCKS[dock] < DOCK_TRUCKS[best]) best = dock;
  }
  return best;
}

/** Kamión s dovozom, ktorý chce vojsť: smer a kategória jeho jednotky a nakladač, ktorý ju po vzniku kamióna položí `in_truck` (`CargoLedger.create`). */
export interface DeliveryRequest {
  /** Smer jednotky: `export` (booking) alebo `empty` (návrat prázdneho). */
  readonly direction: Extract<CargoDirection, 'export' | 'empty'>;
  readonly category: CargoCategory;
  /** Položí jednotku na nový kamión — volané hneď po `World.addTruck`, len keď kamión vzniká. */
  readonly load: (truck: Truck) => void;
}

/** Pokus o vjazd kamióna s dovozom `request` na road portáli `portal` (viď hlavička). */
export function admitDelivery(world: World, request: DeliveryRequest, portal: number): AdmissionOutcome {
  let blocked = false;
  let declined = false;
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.category !== request.category || !world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    if (def === undefined) continue;
    const route = routeWithFreeBay(world, ramp, 'delivery');
    if (route === undefined) {
      blocked = true;
      continue;
    }
    world.dockIntake.refresh(world);
    const dock = leastBusyDock(world, ramp, true);
    if (dock < 0) {
      blocked = true;
      continue;
    }
    const room = inboundRoom(world, ramp, request.category, request.direction);
    if (!hasInboundRoom(room)) {
      // Návrat prázdneho do depa bez jediného voľného miesta nemá na čo čakať (depo sa nevyprázdňuje); ostatné prípady sa vyriešia samy.
      if (request.direction === 'empty' && room.free <= 0) declined = true;
      else blocked = true;
      continue;
    }
    spawnTruck(world, ramp, dock, route, def, portal, 'delivery', request.load);
    return 'admitted';
  }
  return declined && !blocked ? 'declined' : 'waiting';
}
