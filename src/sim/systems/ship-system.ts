/**
 * ShipSystem — krok 3 ticku (ARCHITECTURE §6, §7.4; ADR-016): pohyb lodí, alokácia kotvísk, docking a undocking.
 *
 * Lode sa spracúvajú vzostupne podľa id (= poradie spawnu), takže skoršia loď má pri alokácii kotvísk prednosť
 * (FIFO). Každý stav má jeden krok v tabuľke `SHIP_STEPS` (nie switch); stav mení len `Ship.transition`.
 *
 * - `inbound`: plavba po `seaLane`; na jej konci `allocateBerths` → `berthing`, inak `waiting_anchorage` na prvej
 *   voľnej bunke anchorage (všetky obsadené → čaká na konci `seaLane`).
 * - `waiting_anchorage`: každý tick skúsi alokáciu (→ `berthing`); inak si obsadí voľnú anchorage a pláva k nej.
 * - `berthing`: kotviská sú rezervované (`dockedShipId`), loď pláva po úsečke k `dockPoint`; po príchode `docked`
 *   s kurzom rovnobežne s hranou (`DOCKED_HEADING`) a `ShipDocked`.
 * - `docked`: keď na lodi nie je žiadna jednotka (`on_ship`), kotviská sa uvoľnia → `undocking` + `ShipUndocked`.
 * - `undocking` → koniec `seaLane` → `outbound` → po `seaLane` k `seaLane[0]` → `despawned`: loď sa odstráni zo sveta
 *   a emituje `ShipDeparted`.
 * Prechod stavu ukončí pohyb lode v danom ticku (zvyšok kroku prepadne).
 */
import type { EntityId } from '../core/entity-id';
import { BerthModule } from '../modules/berth-module';
import { allocateBerths } from '../ships/berth-allocator';
import type { Ship } from '../ships/ship';
import { ShipError } from '../ships/ship-error';
import type { ShipState } from '../ships/ship-fsm';
import { DOCKED_HEADING, advanceAlongRoute, firstBerthOf, shipRoute } from '../ships/ship-route';
import type { World } from '../world/world';

type ShipStep = (ship: Ship, world: World) => void;

/** Posunie loď po trase jej stavu o `speedCellsPerTick`; `true` = dorazila na koniec trasy. */
function sail(ship: Ship, world: World): boolean {
  return advanceAlongRoute(ship, shipRoute(ship, world), ship.def.speedCellsPerTick);
}

/** Kotvisko z `berthIds`; chýbajúce alebo iný modul → `ShipError('inconsistent')`. */
function berthById(world: World, ship: Ship, berthId: EntityId): BerthModule {
  const berth = world.modules.get(berthId);
  if (!(berth instanceof BerthModule)) throw new ShipError('inconsistent', `${ship.label}: kotvisko #${String(berthId)} z berthIds neexistuje`);
  return berth;
}

/** Prvá bunka `map.anchorage`, ktorú nemá obsadenú iná loď; `null` = všetky obsadené. */
function freeAnchorage(world: World, ship: Ship): number | null {
  const taken = new Set<number>();
  for (const other of world.ships.values()) {
    if (other !== ship && other.anchorageIndex !== null) taken.add(other.anchorageIndex);
  }
  for (let index = 0; index < world.map.anchorage.length; index++) {
    if (!taken.has(index)) return index;
  }
  return null;
}

/** Skúsi prideliť kotviská; pri úspechu ich rezervuje a loď prejde do `berthing`. */
function tryStartBerthing(ship: Ship, world: World): boolean {
  const berths = allocateBerths(world, ship);
  if (berths === null) return false;
  for (const berth of berths) berth.dockedShipId = ship.id;
  ship.berthIds = Object.freeze(berths.map((berth) => berth.id));
  ship.anchorageIndex = null;
  ship.transition('berthing');
  return true;
}

/** Obsadí prvú voľnú anchorage (ak loď ešte žiadnu nemá) a začne k nej novú trasu. */
function claimAnchorage(ship: Ship, world: World): void {
  if (ship.anchorageIndex !== null) return;
  const index = freeAnchorage(world, ship);
  if (index === null) return;
  ship.anchorageIndex = index;
  ship.waypointIndex = 0;
}

const SHIP_STEPS: { readonly [S in ShipState]: ShipStep } = {
  inbound: (ship, world) => {
    if (!sail(ship, world)) return;
    if (tryStartBerthing(ship, world)) return;
    ship.transition('waiting_anchorage');
    claimAnchorage(ship, world);
  },
  waiting_anchorage: (ship, world) => {
    if (tryStartBerthing(ship, world)) return;
    claimAnchorage(ship, world);
    sail(ship, world);
  },
  berthing: (ship, world) => {
    if (!sail(ship, world)) return;
    const first = firstBerthOf(ship, world);
    ship.transition('docked');
    ship.heading = DOCKED_HEADING[first.waterSide];
    world.events.emit({ type: 'ShipDocked', shipId: ship.id, berthIds: ship.berthIds });
  },
  docked: (ship, world) => {
    if (world.cargo.countAt('on_ship', ship.id) > 0) return;
    for (const berthId of ship.berthIds) berthById(world, ship, berthId).dockedShipId = null;
    ship.berthIds = Object.freeze([]);
    ship.transition('undocking');
    world.events.emit({ type: 'ShipUndocked', shipId: ship.id });
  },
  undocking: (ship, world) => {
    if (sail(ship, world)) ship.transition('outbound');
  },
  outbound: (ship, world) => {
    if (!sail(ship, world)) return;
    ship.transition('despawned');
    world.removeShip(ship.id);
    world.events.emit({ type: 'ShipDeparted', shipId: ship.id });
  },
  despawned: (ship) => {
    throw new ShipError('inconsistent', `${ship.label}: loď v stave 'despawned' nemá byť vo world.ships`);
  },
};

export class ShipSystem {
  /** Krok 3: jeden krok FSM každej lode vzostupne podľa id (kópia zoznamu — lode počas kroku odchádzajú zo sveta). */
  tick(world: World): void {
    for (const ship of [...world.ships.values()]) SHIP_STEPS[ship.state](ship, world);
  }
}
