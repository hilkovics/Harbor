/**
 * TruckSpawner — vznik kamiónov v kroku 8 (ARCHITECTURE §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 3 a 5;
 * ADR-024). Pre každý dock prevádzkovej rampy (rampy vzostupne podľa id, docky vzostupne) vznikne kamión na road
 * portáli (`roadPortals[0]`), keď:
 * - rampa je prevádzková (`World.isRampOperational`, ADR-022) a existuje kamión (`trucks.json`) jej kategórie,
 * - na docku je pripravených aspoň `capacityUnits` jednotiek (`stagedAt(dock)`),
 * - na dock ešte nemieri iný kamión (`LoadingRamp.dockTruck(dock) === null`),
 * - niektoré stojisko na trasách rampy (`World.landsideRoutes`, poradie id brány, potom stojiska) má voľný bay.
 * Kamión si pri vzniku drží dock a rezervuje najnižší voľný bay prvej takej trasy (`World.addTruck`), emituje
 * `TruckSpawned` a naplánuje cestu k vstupnej strane brány. Bez voľného bay kamión nevznikne a rampa ohlási
 * `NoWaitingBay` najviac raz za hernú hodinu (`LoadingRamp.lastNoWaitingBayHour`).
 * Za tick nevznikne viac kamiónov ako dockov s pripraveným nákladom; bez rámp sa neprechádza nič.
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
import { Truck } from './truck';
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

/** Prvá trasa rampy, ktorej stojisko má voľný bay; žiadna → `undefined`. */
function routeWithFreeBay(world: World, ramp: LoadingRamp): LandsideRoute | undefined {
  for (const route of world.landsideRoutes(ramp)) {
    const area = world.modules.get(route.waitingAreaId);
    if (area instanceof WaitingArea && area.freeBays > 0) return route;
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
 * Nový kamión na portáli pre dock `dock` rampy s trasou `route` (stojisko má voľný bay — overil volajúci): `World.addTruck`
 * (drží dock a bay), `TruckSpawned`, plán cesty k vstupnej strane brány (bez cesty hneď `no_path`).
 */
export function spawnTruck(world: World, ramp: LoadingRamp, dock: number, route: LandsideRoute, def: Readonly<TruckDef>, portal: number): Truck {
  const area = world.modules.get(route.waitingAreaId);
  const bay = area instanceof WaitingArea ? area.firstFreeBay() : -1;
  const position = carrierPosition(portal, undefined, 0, world.grid.width);
  const truck = new Truck({
    id: world.ids.next() as EntityId,
    def,
    state: 'to_gate',
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
  world.events.emit({ type: 'TruckSpawned', truckId: truck.id, rampId: ramp.id, dock });
  if (planTruckRoute(world, truck, 'to_gate')) faceRoute(world, truck);
  else enterTruckNoPath(world, truck);
  return truck;
}

/** Krok 8, časť spawn: prejde rampy (`ramps` vzostupne podľa id) a ich docky (viď hlavička). */
export function spawnTrucks(world: World, ramps: readonly LoadingRamp[]): void {
  if (ramps.length === 0) return;
  const portal = world.landside.portalCell;
  if (portal === NO_ACCESS) return;
  for (const ramp of ramps) {
    if (!world.isRampOperational(ramp)) continue;
    const def = truckDefFor(world.defs, ramp.category);
    if (def === undefined) continue;
    for (let dock = 0; dock < ramp.docks; dock++) {
      if (ramp.dockTruck(dock) !== null || ramp.stagedAt(dock) < def.capacityUnits) continue;
      const route = routeWithFreeBay(world, ramp);
      if (route === undefined) {
        reportNoWaitingBay(world, ramp);
        continue;
      }
      spawnTruck(world, ramp, dock, route, def, portal);
    }
  }
}
