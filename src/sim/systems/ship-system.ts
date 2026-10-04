/**
 * ShipSystem — krok 3 ticku (ARCHITECTURE §6, §7.4; ADR-016, ADR-029): pohyb lodí, vstup do prístavu, alokácia kotvísk,
 * docking a undocking — bez prekrývania lodí (rezervácie trás, `ShipTraffic`).
 *
 * Lode sa spracúvajú vzostupne podľa id (= poradie spawnu), takže skoršia loď má pri alokácii kotvísk aj pri vstupe
 * prednosť (FIFO bez head-of-line blokovania). Každý stav má jeden krok v tabuľke `SHIP_STEPS` (nie switch); stav mení
 * len `Ship.transition`, trasu stavu rezervuje `ShipTraffic`.
 *
 * - `arriving`: vstup, keď má loď cieľ s voľnou trasou (`tryEnter`) — v tom istom ticku už pláva (vstup je jediný
 *   prechod, ktorý pohyb v ticku neukončí: loď pred mapou sa nemala čo pohnúť). Loď s voľným kotviskom → `inbound`
 *   (po sea lane ku kotvisku), loď bez voľného kotviska → rovno `waiting_anchorage` (anchorage pridelená pri vstupe,
 *   plavba priamo zo vstupu na rejdu — T6D-03).
 * - `inbound`: plavba po sea lane; na jej konci `berthing` (kotviská z rezervácie pri vstupe).
 * - `waiting_anchorage`: priama plavba na rejdu (po rezervovanej trase), na nej jednotný kurz `anchorageHeading` a každý
 *   tick pokus o kotvisko (`tryStartBerthing`). Anchorage drží vždy (loď bez cieľa zo save v5 presunie parser pred
 *   vstup — `arriving`, ADR-029 addendum).
 * - `berthing`: plavba po rezervovanej trase k polohe pri kotvisku; po príchode `docked` s kurzom `DOCKED_HEADING`
 *   a `ShipDocked`.
 * - `docked`: keď na lodi nie je žiadna jednotka (`on_ship`) a trasa von je voľná → `undocking` + `ShipUndocked`. Loď s exportom
 *   (ADR-032 bod 12): počká, kým je na palube import alebo na termináli nenaložená jednotka voyage mimo hold; potom pri aspoň
 *   jednej naloženej jednotke `lashing` (`ShipLashingStarted`, `lashingTicksPerUnit × naložené + paperworkTicks`), inak
 *   rovno `undocking`.
 * - `lashing` (ADR-032 bod 11): loď drží kotvisko; odpočet `lashingTicksLeft`, po ňom (a keď je trasa von voľná) `undocking` +
 *   `ShipUndocked`. Demurrage beží ďalej (loď je `moored`, ADR-026).
 * - `undocking` → na konci dráhy uvoľní kotviská → `outbound` → po `seaLane` k `seaLane[0]` → `despawned`: naložený export
 *   `on_ship → shipped` (každá jednotka s `CargoMoved`, potom `ExportShipped`), loď sa odstráni zo sveta a emituje `ShipDeparted`.
 * Prechod stavu ukončí pohyb lode v danom ticku (zvyšok kroku prepadne), okrem vstupu.
 */
import { exportAboard, importAboard, isOutboundOnShip, loadsInFlight, pendingExportUnits } from '../logistics/voyage-cargo';
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

/** `inbound` na konci sea lane: ku kotviskám z rezervácie pri vstupe (úsek za koncom dráhy). */
function reachLaneEnd(ship: Ship, world: World): void {
  const traffic = world.shipTraffic;
  ship.transition('berthing', traffic.legAfterLane(ship));
  traffic.bump();
}

/** Čo urobí loď `docked` v tomto ticku: čaká (náklad na palube / na termináli), začne lashing, alebo odíde. */
type DockedVerdict = 'wait' | 'lash' | 'leave';

/**
 * Verdikt lode `docked` (ADR-032 bod 12). Čaká, kým je na palube import (`importAboard`, podľa smeru jednotky), na termináli
 * nenaložená jednotka voyage mimo hold (`pendingExportUnits`) alebo má žeriav nakládku v ceste (`loadsInFlight` — booking sa mohol
 * uzavrieť pred jej koncom, SLA); potom pri aspoň jednej jednotke exportu na palube `lashing`, inak odíde. Loď bez exportu
 * (F2–F5) odíde, keď na palube nie je žiadna jednotka. Export na palube uzavretého bookingu loď neblokuje — odplává ako `shipped`.
 */
function dockedVerdict(ship: Ship, world: World): DockedVerdict {
  if (importAboard(world, ship.id) > 0 || pendingExportUnits(world, ship.id) > 0 || loadsInFlight(world, ship) > 0) return 'wait';
  return exportAboard(world, ship.id) > 0 ? 'lash' : 'leave';
}

/** `docked → lashing`: `lashingTicksPerUnit × naložené + paperworkTicks` (def triedy lode), `ShipLashingStarted`. */
function startLashing(ship: Ship, world: World): void {
  const loadedUnits = exportAboard(world, ship.id);
  const ticks = ship.def.lashingTicksPerUnit * loadedUnits + ship.def.paperworkTicks;
  ship.transition('lashing');
  ship.lashingTicksLeft = Math.max(1, ticks);
  world.shipTraffic.bump();
  world.events.emit({ type: 'ShipLashingStarted', shipId: ship.id, loadedUnits, ticks: ship.lashingTicksLeft });
}

/** `docked → undocking`, keď je trasa von voľná (`ShipUndocked`). */
function undock(ship: Ship, world: World): void {
  if (!world.shipTraffic.tryUndock(ship)) return;
  world.events.emit({ type: 'ShipUndocked', shipId: ship.id });
}

const DOCKED_STEPS: { readonly [V in DockedVerdict]: ShipStep } = {
  wait: () => undefined,
  lash: startLashing,
  leave: undock,
};

/**
 * Odchod z mapy (`outbound → despawned`): naložený náklad (export, prázdne repositioningu, prekládka na lodi B) `on_ship → shipped`
 * vzostupne podľa id (každá jednotka s `CargoMoved`), potom `ExportShipped`; `World.removeShip` vyžaduje prázdnu loď. Náklad na
 * vykládku (import, prekládka z lode A) na palube by tu zostal (loď s ním neodchádza).
 */
function shipExports(ship: Ship, world: World): void {
  let shipped = 0;
  for (const unitId of world.cargo.unitsOnShip(ship.id)) {
    const unit = world.cargo.get(unitId);
    if (unit === undefined || !isOutboundOnShip(world, unit, ship.id)) continue;
    world.cargo.move(unitId, { kind: 'shipped' });
    shipped += 1;
  }
  if (shipped > 0) world.events.emit({ type: 'ExportShipped', shipId: ship.id, units: shipped });
}

const SHIP_STEPS: { readonly [S in ShipState]: ShipStep } = {
  arriving: (ship, world) => {
    if (world.shipTraffic.tryEnter(ship)) SHIP_STEPS[ship.state](ship, world);
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
    DOCKED_STEPS[dockedVerdict(ship, world)](ship, world);
  },
  lashing: (ship, world) => {
    if (ship.lashingTicksLeft > 1) {
      ship.lashingTicksLeft -= 1;
      return;
    }
    if (!world.shipTraffic.tryUndock(ship)) return;
    ship.lashingTicksLeft = 0;
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
    shipExports(ship, world);
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
