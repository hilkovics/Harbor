/**
 * TruckSpawner — vznik kamiónov v kroku 8 (ARCHITECTURE §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 3 a 5;
 * ADR-024, ADR-029). Pre každý dock prevádzkovej rampy (rampy vzostupne podľa id, docky vzostupne) vznikne najviac
 * jeden kamión za tick na road portáli (`roadPortals[0]`), keď:
 * - rampa je prevádzková (`World.isRampOperational`, ADR-022) a existuje kamión (`trucks.json`) jej kategórie,
 * - dock má pre kamión náklad, na ktorý ešte nemá nárok iný kamión: pripravené jednotky (`stagedAt`) + jednotky, ktoré
 *   k docku vezie vozidlo (`DockSupply`), − nároky kamiónov docku (`claimedAt`) ≥ `capacityUnits` (ADR-029),
 * - niektoré stojisko na trasách rampy (`World.landsideRoutes`, poradie id brány, potom stojiska) má voľný bay.
 * Kamión si pri vzniku nárokuje `capacityUnits` jednotiek docku a rezervuje najnižší voľný bay prvej takej trasy
 * (`World.addTruck`), emituje `TruckSpawned` a naplánuje cestu k vstupnej strane brány. Dock **nedrží** — ten si vezme
 * až pri odchode zo stojiska (landside systém), takže na jeden dock môže byť v okruhu viac kamiónov; ich počet
 * ohraničujú bays stojiska a náklad docku (najviac `stagingPerDock / capacityUnits` kamiónov bez naloženia).
 * Bez voľného bay kamión nevznikne a rampa ohlási `NoWaitingBay` najviac raz za hernú hodinu
 * (`LoadingRamp.lastNoWaitingBayHour`); dopyt bez bay sa počíta do `Hinterland.pickupBayStarvationTicks` (ADR-035). Bez rámp sa neprechádza nič.
 * Pickup kamión smie obsadiť aj stojiská rezervované kvótou pre odvoz (`routeWithFreeBay`); kamióny s dovozom vpúšťa vnútrozemie
 * (`trucks/hinterland-entry.ts`).
 */
import type { EntityId } from '../core/entity-id';
import type { DefRegistry } from '../defs/def-registry';
import type { CargoCategory, TruckDef } from '../defs/types';
import type { Rotation } from '../grid/rotation';
import { NO_ACCESS } from '../logistics/module-access';
import type { LoadingRamp } from '../modules/loading-ramp';
import { WaitingArea } from '../modules/waiting-area';
import { carrierPosition } from '../movement/carrier';
import type { LandsideRoute } from '../world/landside';
import type { World } from '../world/world';
import type { DockSupply } from './dock-supply';
import { Truck } from './truck';
import { TRUCK_MISSION_USES_PICKUP_BAYS, type TruckMission } from './truck-fsm';
import { enterTruckNoPath, faceRoute, planTruckRoute } from './truck-trip';

/**
 * Kurz nového kamióna, kým nemá trasu (0 = sever). Po naplánovaní ho prepíše smer prvého úseku (`faceRoute`); ostane
 * len pri kamióne, ktorý hneď po vzniku nemá cestu (`no_path`). Technická východisková hodnota, nie balans.
 */
const SPAWN_HEADING_FALLBACK: Rotation = 0;

/** Prvý kamión v poradí `trucks.json`, ktorý vozí kategóriu; žiadny → `undefined`. */
export function truckDefFor(defs: DefRegistry, category: CargoCategory): Readonly<TruckDef> | undefined {
  for (const def of defs.trucks.items) {
    if (def.cargoCategories.includes(category)) return def;
  }
  return undefined;
}

/**
 * Prvá trasa rampy, ktorej stojisko má pre misiu `mission` voľný bay; žiadna → `undefined`. Misia, ktorá náklad odváža (`pickup`, `collect`), smie
 * obsadiť ľubovoľný voľný bay, misia s dovozom (`delivery`) len voľný nad kvótou pre odvoz (`WaitingArea.freeBaysForDelivery`, ADR-035). Misia je
 * povinná (T6D-05b): predvolená `pickup` by potichu udelila výnimku z kvóty stojísk.
 */
export function routeWithFreeBay(world: World, ramp: LoadingRamp, mission: TruckMission): LandsideRoute | undefined {
  const usesPickupBays = TRUCK_MISSION_USES_PICKUP_BAYS[mission];
  for (const route of world.landsideRoutes(ramp)) {
    const area = world.modules.get(route.waitingAreaId);
    if (area instanceof WaitingArea && (usesPickupBays ? area.freeBays : area.freeBaysForDelivery) > 0) return route;
  }
  return undefined;
}

/** `NoWaitingBay` najviac raz za hernú hodinu na rampu. */
function reportNoWaitingBay(world: World, ramp: LoadingRamp): void {
  const hour = world.clock.gameHour;
  if (ramp.lastNoWaitingBayHour === hour) return;
  ramp.lastNoWaitingBayHour = hour;
  world.events.emit({ type: 'NoWaitingBay', rampId: ramp.id });
}

/**
 * Nový kamión na portáli pre dock `dock` rampy s trasou `route` (stojisko má voľný bay a dock náklad bez nároku — overil
 * volajúci): `World.addTruck` (nárok na `capacityUnits` jednotiek docku a bay), `TruckSpawned`, plán cesty k vstupnej
 * strane brány (bez cesty hneď `no_path`). Kamión s misiou `delivery` (export, ADR-032) nemá nárok na náklad docku;
 * `loadCargo` (voláno hneď po `World.addTruck`) naň položí jednotku `in_truck` (`CargoLedger.create`).
 */
export function spawnTruck(
  world: World,
  ramp: LoadingRamp,
  dock: number,
  route: LandsideRoute,
  def: Readonly<TruckDef>,
  portal: number,
  mission: TruckMission,
  loadCargo?: (truck: Truck) => void,
): Truck {
  const area = world.modules.get(route.waitingAreaId);
  const bay = area instanceof WaitingArea ? area.firstFreeBay() : -1;
  const position = carrierPosition(portal, undefined, 0, world.grid.width);
  const truck = new Truck({
    id: world.ids.next() as EntityId,
    def,
    state: 'to_gate',
    mission,
    x: position.x,
    y: position.y,
    heading: SPAWN_HEADING_FALLBACK,
    route: [portal],
    rampId: ramp.id,
    dock,
    gateId: route.gateId,
    waitingAreaId: route.waitingAreaId,
    bay,
  });
  world.addTruck(truck);
  loadCargo?.(truck);
  world.events.emit({ type: 'TruckSpawned', truckId: truck.id, rampId: ramp.id, dock });
  if (planTruckRoute(world, truck, 'to_gate')) faceRoute(world, truck);
  else enterTruckNoPath(world, truck);
  return truck;
}

/**
 * Krok 8, časť spawn: prejde rampy (`ramps` vzostupne podľa id) a ich docky (viď hlavička). `supply` = znovupoužiteľné
 * počty vezených jednotiek (vlastní ich `LandsideSystem`); prepočíta sa len pri prevádzkovej rampe s kamiónom.
 */
export function spawnTrucks(world: World, ramps: readonly LoadingRamp[], supply: DockSupply): void {
  if (ramps.length === 0) return;
  const portal = world.landside.portalCell;
  if (portal === NO_ACCESS) return;
  let counted = false;
  for (const ramp of ramps) {
    if (!world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    if (def === undefined) continue;
    if (!counted) {
      supply.refresh(world);
      counted = true;
    }
    for (let dock = 0; dock < ramp.docks; dock++) {
      if (supply.unclaimedAt(ramp, dock) < def.capacityUnits) continue;
      const route = routeWithFreeBay(world, ramp, 'pickup');
      if (route === undefined) {
        // Dopyt po kamióne na odvoz (náklad na docku) bez voľného bay: počíta sa ako nedostatok stojísk pre odvoz (ADR-035).
        world.hinterland.recordPickupStarved(world.clock.tick);
        reportNoWaitingBay(world, ramp);
        continue;
      }
      spawnTruck(world, ramp, dock, route, def, portal, 'pickup');
    }
  }
}
