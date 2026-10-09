/**
 * TruckSpawner — vznik kamiónov v kroku 8 (ARCHITECTURE §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 3 a 5; ADR-024, ADR-041). Kamión vzniká s **lístkom**: blok zastávky, token
 * cieľa (rezervované TP, alebo státie odstavnej plochy; `trucks/destination.ts`) a job zastávky (`logistics/truck-jobs.ts`). Vznikne na voľnom portáli vjazdu (R4, ADR-041 bod 3: pri viacerých
 * ho vyberie `Rng` podľa `trafficShare`, `pickInPortalFor`) a hneď zaberie slot hlavy — portál je cesta (ADR-037, R1 č. 10); je obsadený → vznik sa odloží, dopyt ostane a skúsi sa v ďalšom ticku.
 *
 * **Odvoz importu** (`spawnPickupTrucks`): pre každú jednotku, ktorú treba odviezť (`logistics/pickup-demand.ts`: v poradí priority, vybrateľná zo stohu, bez jobu), vznikne kamión
 * `pickup` s jobom `receive` — **dopyt sleduje sklad, nie dock**: jednotka sa odváža priamo zo stohu na TP. Bez voľného TP aj státia (token) kamión nevznikne; jednotka čaká a kamióny čakajú vo
 * vnútrozemí (ADR-035). Kamióny s dovozom (`delivery`, `collect`) vpúšťa vnútrozemie (`trucks/hinterland-*.ts`) cez `spawnTruck`.
 * Kamión si pri vzniku nájde vstup do prístavu podľa odhadu času (`gate-choice.ts`): k predbránovej ploche (`to_pre_gate`) alebo k vstupnému pruhu (`to_gate`).
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import { slotOf } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import type { DefRegistry } from '../defs/def-registry';
import type { CargoCategory, TruckDef } from '../defs/types';
import type { Rotation } from '../grid/rotation';
import { NO_ACCESS } from '../logistics/module-access';
import { forEachPickupCandidate } from '../logistics/pickup-demand';
import { openReceiveJob } from '../logistics/truck-jobs';
import type { YardBlock } from '../modules/yard-block';
import { carrierPosition } from '../movement/carrier';
import { headSlotKey } from '../traffic/head-slot';
import type { World } from '../world/world';
import { nearBayOfSlot, reserveToken, tokenCell, type Token } from './destination';
import { isPortalBlocked, pickGate, pickInPortalFor, type GateChoice } from './gate-choice';
import { hasFreeToken } from './tp-points';
import { Truck } from './truck';
import { TruckError } from './truck-error';
import type { TruckMission } from './truck-fsm';
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

export { isPortalBlocked };

/**
 * Nový kamión na portáli `portal` s lístkom na blok `block` a tokenom `token` (volajúci overil token, vstup `choice` a voľný portál): `World.addTruck`, `openStop` (vznik jednotky a jobu
 * zastávky — kamión už je vo svete), `TruckSpawned` a plán cesty k vstupu (bez cesty hneď `no_path`).
 */
export function spawnTruck(world: World, def: Readonly<TruckDef>, portal: number, mission: TruckMission, block: YardBlock, token: Token, choice: GateChoice, openStop: (truck: Truck) => void): Truck {
  const { buffer } = choice;
  const position = carrierPosition(portal, undefined, 0, world.grid.width);
  const truck = new Truck({
    id: world.ids.next() as EntityId,
    def,
    state: buffer === null ? 'to_gate' : 'to_pre_gate',
    mission,
    x: position.x,
    y: position.y,
    heading: SPAWN_HEADING_FALLBACK,
    route: [portal],
    blockId: block.id,
    tpCell: token.kind === 'tp' ? token.cell : null,
    holdingId: token.kind === 'stall' ? token.holding.id : null,
    stall: token.kind === 'stall' ? token.stall : null,
    gateId: choice.lane.id,
    preGateId: buffer === null ? null : buffer.id,
  });
  world.addTruck(truck);
  openStop(truck);
  world.events.emit({ type: 'TruckSpawned', truckId: truck.id, blockId: block.id });
  if (planTruckRoute(world, truck, buffer === null ? 'to_gate' : 'to_pre_gate')) faceRoute(world, truck);
  else enterTruckNoPath(world, truck);
  truck.reserveHead(headSlotKey(world, truck));
  return truck;
}

/**
 * Pokus o vznik kamióna s lístkom na blok `block` (token pre `nearBay`, vstup a voľný portál): `true` = kamión vznikol, `false` = niečo chýba (token, vstup, portál) a dopyt čaká;
 * `portalBusy` hlási, že žiaden portál nie je voľný (volajúci môže skončiť prechod dopytov).
 */
export function trySpawn(
  world: World,
  def: Readonly<TruckDef>,
  mission: TruckMission,
  block: YardBlock,
  nearBay: number | undefined,
  openStop: (truck: Truck, token: Token) => void,
): 'spawned' | 'no_token' | 'portal_busy' {
  const token = reserveToken(world, block, nearBay, true);
  if (token === null) return 'no_token';
  const cell = tokenCell(world, token);
  // Portál je cesta (ADR-037, R1 č. 10): kým ho drží nosič, kamión nevznikne a dopyt ostane (voľný portál vyberá `pickInPortalFor`, ADR-041 bod 3).
  const portal = pickInPortalFor(world, def, cell);
  if (portal === NO_ACCESS) return 'portal_busy';
  const choice = pickGate(world, portal, def, cell);
  if (choice === undefined) throw new TruckError('inconsistent', `trySpawn: portál ${String(portal)} bol vybraný bez vstupu do prístavu`);
  spawnTruck(world, def, portal, mission, block, token, choice, (truck) => {
    openStop(truck, token);
  });
  return 'spawned';
}

/** Jednotka `unit` uloží do kamióna odvoz: job `receive` a token — pomocník pre `spawnPickupTrucks` a výdaj prázdneho. */
export function openReceiveStop(world: World, truck: Truck, unit: CargoUnit, block: YardBlock): void {
  openReceiveJob(world, truck, unit, block);
}

/**
 * Krok 8, časť spawn: kamióny na odvoz importu (`pickup`) pre jednotky v sklade v poradí priority (viď hlavička). Prechod dopytov sa preskočí, keď niet portálu vjazdu, voľného
 * portálu, alebo žiadneho voľného tokenu (TP, státie) — bez nich by sa zbytočne skúmali stohy.
 */
export function spawnPickupTrucks(world: World): void {
  if (world.landside.inPortals.length === 0 || !hasFreeToken(world)) return;
  let anyFreePortal = false;
  for (const portal of world.landside.inPortals) if (!isPortalBlocked(world, portal.cell)) anyFreePortal = true;
  if (!anyFreePortal) return;
  forEachPickupCandidate(world, (unit, block) => {
    const category = world.defs.cargoTypes.get(unit.typeId).category;
    const def = truckDefFor(world.defs, category);
    const slot = slotOf(unit.location);
    if (def === undefined || slot === null) return true;
    const outcome = trySpawn(world, def, 'pickup', block, nearBayOfSlot(block, slot), (truck) => {
      openReceiveStop(world, truck, unit, block);
    });
    // Dopyt po kamióne na odvoz bez tokenu (TP aj státie obsadené) sa počíta ako nedostatok miesta pre odvoz (ADR-035).
    if (outcome === 'no_token') world.hinterland.recordPickupStarved(world.clock.tick);
    return outcome !== 'portal_busy' && hasFreeToken(world);
  });
}
