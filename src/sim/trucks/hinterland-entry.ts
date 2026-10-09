/**
 * Vjazd kamióna z vnútrozemia do prístavu (F6d, ADR-035; `trucks/hinterland.ts`): kamión s dovozom (`delivery` — export, návrat prázdneho) dostane
 * vjazd, len keď má rezerváciu — pre prvú vhodnú rampu (kategória nákladu, prevádzková, kamión kategórie) musia platiť všetky tri podmienky:
 * 1. **stojisko**: voľný bay nad kvótou pre odvoz (`routeWithFreeBay(…, 'delivery')`, `WaitingArea.pickupReservedBays`);
 * 2. **dock**: niektorý dock má voľné staging miesto po odpočítaní miest prisľúbených kamiónom, ktoré si ich ešte nerezervovali (`DockIntake.roomAt`);
 *    dock s najmenej kamiónmi (rozloženie vykládok), pri zhode nižší;
 * 3. **sklad / depo**: kontajner bude mať kde skončiť (`inboundRoom`, viď `trucks/hinterland-room.ts`).
 * Výsledok pokusu: `admitted` (rezervácia je splnená, kamión sa môže vytvoriť na road portáli a plán sa spotrebuje), `declined` (len návrat prázdneho: depo
 * prázdnych nemá štrukturálne žiadne miesto — viď `inboundRoom.free` — a čakať nemá zmysel, plán sa zahodí) alebo `waiting` (kamión čaká vo vnútrozemí, plán
 * ostáva; pri každej zlyhanej podmienke, aj keď iná rampa uspela by).
 *
 * Pokus má dve časti (T6D-05b, hot path): `planDeliveryAdmission` len overí podmienky a pri `admitted` zapíše miesto vjazdu (rampa, dock, trasa, def) do
 * znovupoužiteľného záznamu — bez alokácie, aj keď kamión čaká celé tiky — a `spawnDelivery` až vtedy vytvorí kamión a nakladač (closure) jeho jednotky.
 */
import type { CargoDirection } from '../cargo/cargo-unit';
import type { CargoCategory, TruckDef } from '../defs/types';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { World } from '../world/world';
import { hasInboundRoom, inboundRoom } from './hinterland-room';
import type { Truck } from './truck';
import { TruckError } from './truck-error';
import { NO_ACCESS } from '../logistics/module-access';
import { pickInPortalFor } from './gate-choice';
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

/** Smer jednotky kamióna s dovozom: `export` (booking) alebo `empty` (návrat prázdneho). */
export type DeliveryDirection = Extract<CargoDirection, 'export' | 'empty'>;

/** Miesto vjazdu zapísané pokusom `planDeliveryAdmission` pri `admitted` a spotrebované `spawnDelivery` (jediný záznam — pokusy idú za sebou, nevnárajú sa). */
interface AdmissionSlot {
  ramp: LoadingRamp | undefined;
  dock: number;
  portal: number;
  def: Readonly<TruckDef> | undefined;
}

const SLOT: AdmissionSlot = { ramp: undefined, dock: -1, portal: NO_ACCESS, def: undefined };

/**
 * Pokus o vjazd kamióna s dovozom jednotky smeru `direction` kategórie `category` (viď hlavička): prejde rampy a overí stojisko, dock a miesto v sklade / depe.
 * Pri `admitted` je miesto vjazdu v `SLOT` a volajúci musí hneď zavolať `spawnDelivery`; inak nič nevzniklo a `SLOT` sa nepoužije.
 */
export function planDeliveryAdmission(world: World, direction: DeliveryDirection, category: CargoCategory): AdmissionOutcome {
  let blocked = false;
  let declined = false;
  for (const ramp of world.landsideModules.ramps) {
    if (ramp.category !== category || !world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    if (def === undefined) continue;
    if (routeWithFreeBay(world, ramp, 'delivery') === undefined) {
      blocked = true;
      continue;
    }
    world.dockIntake.refreshIfStale(world);
    const dock = leastBusyDock(world, ramp, true);
    if (dock < 0) {
      blocked = true;
      continue;
    }
    const room = inboundRoom(world, ramp, category, direction);
    if (!hasInboundRoom(room)) {
      // Návrat prázdneho do depa bez jediného voľného miesta nemá na čo čakať (depo sa nevyprázdňuje); ostatné prípady sa vyriešia samy.
      if (direction === 'empty' && room.free <= 0) declined = true;
      else blocked = true;
      continue;
    }
    // Portál je cesta (ADR-037, R1 č. 10): kým ho drží nosič, kamión nevznikne — vnútrozemie čaká pri každom portáli zvlášť (ADR-041 bod 3): vznikne na voľnom portáli
    // (pri viacerých ho vyberie `Rng`), inak položka plánu ostane a skúsi sa v ďalšom ticku.
    const portal = pickInPortalFor(world, ramp, 'delivery', def);
    if (portal === NO_ACCESS) return 'waiting';
    SLOT.ramp = ramp;
    SLOT.dock = dock;
    SLOT.portal = portal;
    SLOT.def = def;
    return 'admitted';
  }
  return declined && !blocked ? 'declined' : 'waiting';
}

/**
 * Vytvorí kamión s dovozom na portáli, ktorý vybral `planDeliveryAdmission`, na mieste, ktoré práve vybral `planDeliveryAdmission` (`admitted`); `load` položí jednotku na nový kamión
 * (`CargoLedger.create` v `in_truck`) hneď po `World.addTruck`. Prisľúbené miesto docku (`DockIntake`) sa tým mení — cache sa zneplatní, aby ďalší pokus
 * v tom istom ticku videl aj tento kamión.
 */
export function spawnDelivery(world: World, load: (truck: Truck) => void): void {
  const { ramp, dock, portal, def } = SLOT;
  if (ramp === undefined || portal === NO_ACCESS || def === undefined) {
    throw new TruckError('inconsistent', 'spawnDelivery bez predchádzajúceho planDeliveryAdmission s výsledkom admitted');
  }
  SLOT.ramp = undefined;
  SLOT.portal = NO_ACCESS;
  SLOT.def = undefined;
  spawnTruck(world, ramp, dock, def, portal, 'delivery', load);
  world.dockIntake.invalidate();
}
