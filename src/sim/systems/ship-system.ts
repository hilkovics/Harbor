/**
 * ShipSystem — krok 3 ticku (ARCHITECTURE §6, §7.4; ADR-016, ADR-029): pohyb lodí, vstup do prístavu, alokácia kotvísk,
 * docking a undocking — bez prekrývania lodí (rezervácie trás, `ShipTraffic`).
 *
 * Lode sa spracúvajú vzostupne podľa id (= poradie spawnu), takže skoršia loď má pri alokácii kotvísk aj pri vstupe
 * prednosť (FIFO bez head-of-line blokovania). Každý stav má jeden krok v tabuľke `SHIP_STEPS` (nie switch); stav mení
 * len `Ship.transition`, trasu stavu rezervuje `ShipTraffic`.
 *
 * - `arriving`: vstup, keď má loď cieľ (kotviská alebo anchorage) s voľnou trasou (`tryEnter`) — v tom istom ticku
 *   už pláva (vstup je jediný prechod, ktorý pohyb v ticku neukončí: loď pred mapou sa nemala čo pohnúť).
 * - `inbound`: plavba po sea lane; na jej konci `berthing` (kotviská z rezervácie alebo novo pridelené s voľnou
 *   trasou), inak `waiting_anchorage` po rezervovanom úseku k anchorage.
 * - `waiting_anchorage`: plavba k anchorage; na nej každý tick pokus o kotvisko (`tryStartBerthing`). Anchorage drží
 *   vždy (loď bez cieľa zo save v5 presunie parser pred vstup — `arriving`, ADR-029 addendum).
 * - `berthing`: plavba po rezervovanej trase k polohe pri kotvisku; po príchode `docked` s kurzom `DOCKED_HEADING`
 *   a `ShipDocked`.
 * - `docked`: keď na lodi nie je žiadna jednotka (`on_ship`) a trasa von je voľná → `undocking` + `ShipUndocked`.
 * - `undocking` → na konci dráhy uvoľní kotviská → `outbound` → po `seaLane` k `seaLane[0]` → `despawned`: loď sa
 *   odstráni zo sveta a emituje `ShipDeparted`.
 * Prechod stavu ukončí pohyb lode v danom ticku (zvyšok kroku prepadne), okrem vstupu.
 */
import { ShipError } from '../ships/ship-error';
import type { Ship } from '../ships/ship';
import type { ShipState } from '../ships/ship-fsm';
import { DOCKED_HEADING, advanceAlongRoute, firstBerthOf, shipRoute } from '../ships/ship-route';
import type { World } from '../world/world';

type ShipStep = (ship: Ship, world: World) => void;

/** Posunie loď po trase jej stavu o `speedCellsPerTick`; `true` = dorazila na koniec trasy. */
function sail(ship: Ship): boolean {
  return advanceAlongRoute(ship, shipRoute(ship), ship.def.speedCellsPerTick);
}

/** Loď v pokoji na konci svojej trasy (anchorage, kotvisko)? */
function atRest(ship: Ship): boolean {
  return ship.waypointIndex >= ship.route.length;
}

/** `inbound` na konci sea lane: ku kotviskám z rezervácie, novo pridelené kotvisko, alebo k anchorage. */
function reachLaneEnd(ship: Ship, world: World): void {
  const traffic = world.shipTraffic;
  const leg = traffic.legAfterLane(ship);
  if (ship.berthIds.length > 0) {
    ship.transition('berthing', leg);
    traffic.bump();
    return;
  }
  if (traffic.tryStartBerthing(ship)) return;
  ship.transition('waiting_anchorage', leg);
  traffic.bump();
}

const SHIP_STEPS: { readonly [S in ShipState]: ShipStep } = {
  arriving: (ship, world) => {
    if (world.shipTraffic.tryEnter(ship)) SHIP_STEPS.inbound(ship, world);
  },
  inbound: (ship, world) => {
    // Plavba len po úsek sea lane; úsek za koncom dráhy pokračuje v ďalšom stave.
    if (!advanceAlongRoute(ship, ship.route, ship.def.speedCellsPerTick, world.shipTraffic.laneEndIndex(ship))) return;
    reachLaneEnd(ship, world);
  },
  waiting_anchorage: (ship, world) => {
    if (!atRest(ship)) {
      sail(ship);
      return;
    }
    world.shipTraffic.tryStartBerthing(ship);
  },
  berthing: (ship, world) => {
    if (!sail(ship)) return;
    const first = firstBerthOf(ship, world);
    ship.transition('docked');
    ship.heading = DOCKED_HEADING[first.waterSide];
    world.shipTraffic.bump();
    world.events.emit({ type: 'ShipDocked', shipId: ship.id, berthIds: ship.berthIds });
  },
  docked: (ship, world) => {
    if (world.cargo.countAt('on_ship', ship.id) > 0) return;
    if (!world.shipTraffic.tryUndock(ship)) return;
    world.events.emit({ type: 'ShipUndocked', shipId: ship.id });
  },
  undocking: (ship, world) => {
    if (!sail(ship)) return;
    world.shipTraffic.releaseBerths(ship);
    ship.transition('outbound', world.shipTraffic.laneOutRoute);
  },
  outbound: (ship, world) => {
    if (!sail(ship)) return;
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
    world.shipTraffic.beginTick();
    for (const ship of [...world.ships.values()]) SHIP_STEPS[ship.state](ship, world);
    world.shipTraffic.endTick();
  }
}
