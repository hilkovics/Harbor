/**
 * LandsideSystem — krok 8 ticku (ARCHITECTURE §6, §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6;
 * ADR-011, ADR-024, ADR-038): kamióny, brány a spawn. Pohyb kamiónov po cestách (preplánovanie `replanTruck`, jazda `advanceTruck`)
 * robí od R1 `TrafficSystem` v kroku 6a pod pruhovými slotmi (ADR-037); tu ostáva FSM kamiónov — príchody, stojisko, dock, brána.
 * Kamión, ktorému sa stav zmenil už v kroku 6a (`no_path`), v tomto ticku krok FSM nerobí (ADR-016). Poradie v kroku je pevné:
 * 1. **Kamióny** vzostupne podľa id, krok podľa stavu z tabuľky `TRUCK_STEPS` (nie switch), stav mení len
 *    `changeTruckState`:
 *    Ciele za bránou dáva okruh kamióna (`truckCircuit`: brána, stojisko a rampa kamióna nezávisle od cesty pred
 *    bránou — review T04-11, major 2), takže kamión za bránou pri prerušení cesty von naloží a čaká pri bráne.
 *    - jazda (`to_*`): po zmene ciest preplánovanie z kotvy (bez cesty `no_path`), pohyb zdieľaným `advanceCarrier`
 *      a na konci trasy príchod podľa `ARRIVALS` — do fronty brány (`gate_queue`, pri `to_gate_out` na výstupnej strane
 *      brány `gate_queue_out`, pred spätným priechodom stojiskom prechod telom a ďalšia jazda k bráne), do stojiska
 *      (`waiting`, obsadí bay, pobyt `internalTicks` stojiska), k docku (`loading`, `loadTicksPerUnit` na jednotku),
 *      na portál (export: všetky `in_truck → exported`, `TruckExited`, kamión zmizne);
 *    - `waiting`: po pobyte povel do docku (ADR-029), keď je dock kamióna voľný a je na ňom celý jeho náklad —
 *      kamión si vezme dock, uvoľní bay, objaví sa na výstupnej bunke stojiska (abstrahovaný prechod telom, ADR-011)
 *      a ide k docku; inak čaká v bayi a skúsi to v ďalšom ticku (FIFO: v ticku odíde prvý pripravený kamión docku
 *      podľa id); bez výstupu stojiska čaká ďalej (`repathIntervalTicks`);
 *    - `loading`: po `loadTicksPerUnit` presun najstaršej jednotky docku `at_ramp → in_truck` (nárok kamióna klesne);
 *      po naložení `capacityUnits` uvoľní dock a ide k výstupnej strane brány;
 *    - `no_path`: po odpočte nový pokus o cestu, úspech = návrat do stavu, z ktorého kamión vypadol.
 * 2. **Brány** vzostupne podľa id: spoločná FIFO fronta oboch smerov, púšťa sa kamión na čele fronty. Prechod trvá
 *    `passTicks` (`processTicks` + `internalTicks`); po ňom kamión vypadne z fronty (`completePass`, `trucksProcessed`
 *    počíta dokončené prechody), objaví sa na druhej strane brány (strany pre kamión — bez vstupu z portálu podľa
 *    stojiska, dodatok ADR-024) a ide ďalej (`to_bay` / `to_portal`). Ďalší prechod začne najskôr v tom istom ticku — medzi dvoma prechodmi je
 *    teda aspoň `passTicks ≥ processTicks` tickov (tvrdý bottleneck). Fronta je virtuálna: čakajúci kamión stojí na
 *    vonkajšej bunke konektora, kamióny sa navzájom neblokujú (§7.8 bod 2, 3).
 * 3. **Spawn** (`spawnTrucks`): rampy vzostupne podľa id, docky vzostupne; nový kamión len na náklad docku bez nároku
 *    (pripravený alebo vezený vozidlom, `DockSupply`, ADR-029; smie obsadiť aj stojiská rezervované kvótou pre odvoz, ADR-035); potom vjazd
 *    kamiónov z vnútrozemia (`admitFromHinterland`, ADR-035): výdaj prázdneho, export podľa plánu príchodov bookingov (ADR-032) a návrat
 *    prázdneho — každý s rezerváciou (stojisko nad kvótou, dock a sklad so zaručeným miestom na vyloženie).
 *
 * **Prázdne kontajnery** (F6c, ADR-034): kamión `delivery` s prázdnym kontajnerom linky (návrat z vnútrozemia, `admitReturnTrucks`) sa
 * správa ako export (brána `EmptyReturned`, vykládka na dock); kamión misie `collect` (výdaj prázdneho exportérovi) čaká v stojisku na
 * pridelený prázdny a naloží ho z docku, alebo sa po `giveUpTick` (od príchodu do stojiska) vzdá a odíde prázdny zo stojiska (`empty-collect.ts`; vo
 * vnútrozemí sa vzdáva už pred vjazdom, `empty-trucks.ts`). Pri odchode
 * kamióna s importom z mapy sa naplánuje návrat prázdneho (`planEmptyReturn`, `Rng`).
 *
 * **Export** (F6a, ADR-032 bod 4, 7, 13): kamión s misiou `delivery` príde naložený jednou jednotkou, po prechode bránou
 * dnu ju brána zaregistruje (`export-gate.ts`: `ExportArrived`, rolled po cut-off, VGM hold). Po pobyte v stojisku odíde
 * k dock rampy, keď je dock voľný a má staging miesto pre jeho jednotku (dock drží a rezervuje miesto, `holdsIntake`); po
 * príchode `unloading`: po `loadTicksPerUnit` na jednotku `in_truck → at_ramp` (`TruckUnloaded`), potom buď zostane na docku
 * a naloží import (dual transaction, ADR-032 bod 13: `becomePickup`, `unloading → loading`), alebo uvoľní dock a odíde prázdny
 * (`to_gate_out`).
 * Prechod stavu ukončí pohyb kamióna v danom ticku (ako vozidlá, ADR-019): nový, prepustený alebo naložený kamión sa
 * pohne až v ďalšom ticku. Tick vstupu do stavu s odpočtom je jeho nultý tick (ADR-016).
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { LoadingRamp } from '../modules/loading-ramp';
import type { TruckGate } from '../modules/truck-gate';
import { NO_ACCESS } from '../logistics/module-access';
import { advanceCarrier } from '../movement/route-planning';
import type { Truck } from '../trucks/truck';
import { TruckError } from '../trucks/truck-error';
import { TRUCK_STATE_TRAITS, changeTruckState, isTruckTravelState, type TruckMission, type TruckState, type TruckTravelState } from '../trucks/truck-fsm';
import { DockSupply } from '../trucks/dock-supply';
import { collectGivesUp, collectReady, finishCollect, giveUpCollect, loadCollected, startCollectWait } from '../trucks/empty-collect';
import { planEmptyReturn } from '../trucks/empty-plan';
import { onGatePassed } from '../trucks/export-gate';
import { admitFromHinterland } from '../trucks/hinterland-admit';
import { spawnTrucks } from '../trucks/truck-spawner';
import { MIN_STAY_TICKS, waitingStayTicks } from '../trucks/truck-wait';
import {
  canExitTo,
  enterTruckNoPath,
  exitTo,
  faceRoute,
  gateFarSideCell,
  gateOfTruck,
  isAtTravelTarget,
  isOffQueueSide,
  passageBackOf,
  planTruckRoute,
  rampOfTruck,
  startTruckTrip,
  truckCircuit,
  waitingAreaOfTruck,
} from '../trucks/truck-trip';
import { headSlotKey } from '../traffic/head-slot';
import type { World } from '../world/world';

/** Jeden tick odpočtu; `true`, keď práve skončil. */
function countDown(truck: Truck): boolean {
  truck.waitTicks = Math.max(0, truck.waitTicks - 1);
  return truck.waitTicks === 0;
}

/** Počet jednotiek v kamióne (ledger). */
function unitsIn(world: World, truck: Truck): number {
  return world.cargo.countAt('in_truck', truck.id);
}

const NOTHING = (): void => undefined;

/**
 * Čo sa stane s jednotkou, ktorá opúšťa mapu s kamiónom (`unit` = snímka pred presunom `→ exported`), podľa misie (tabuľka, nie
 * switch): kamión `pickup` odviezol import → naplánuje sa návrat prázdneho (`planEmptyReturn`, `Rng`), kamión `collect` odviezol prázdny
 * exportérovi (`EmptyPickedUp`); `delivery` kamión odchádza prázdny.
 */
const EXIT_HOOKS: { readonly [M in TruckMission]: (world: World, truck: Truck, unit: CargoUnit) => void } = Object.freeze({
  pickup: (world: World, _truck: Truck, unit: CargoUnit) => {
    planEmptyReturn(world, unit);
  },
  delivery: NOTHING,
  collect: finishCollect,
});

/** Kamión dorazil na portál: `exited`, všetky jednotky `in_truck → exported` (FIFO), `TruckExited`, kamión zmizne. */
function exitMap(truck: Truck, world: World): void {
  changeTruckState(world.events, truck, 'exited');
  let units = 0;
  for (let unitId = world.cargo.firstUnitAt('in_truck', truck.id); unitId !== undefined; unitId = world.cargo.firstUnitAt('in_truck', truck.id)) {
    const unit = world.cargo.get(unitId);
    world.cargo.move(unitId, { kind: 'exported' });
    if (unit !== undefined) EXIT_HOOKS[truck.mission](world, truck, unit);
    units += 1;
  }
  world.removeTruck(truck.id);
  world.events.emit({ type: 'TruckExited', truckId: truck.id, units });
}

type Arrival = (truck: Truck, world: World) => void;

/** Stav kamióna po príchode k docku podľa misie (tabuľka, nie switch): pickup a collect nakladajú, delivery vykladá. */
const DOCK_STATE: { readonly [M in TruckMission]: TruckState } = Object.freeze({ pickup: 'loading', delivery: 'unloading', collect: 'loading' });

/** Čo sa stane, keď kamión dorazí do stojiska (tabuľka podľa misie): `collect` začína lehotu čakania (`giveUpTick`), ostatné misie nič. */
const WAITING_STARTED: { readonly [M in TruckMission]: (world: World, truck: Truck) => void } = Object.freeze({
  pickup: NOTHING,
  delivery: NOTHING,
  collect: startCollectWait,
});

/** Po prechode telom stojiska (kamión stojí na jeho vstupnej bunke bez slotov): trasa k bráne a slot hlavy vstupnej bunky. */
function continueFromHop(world: World, truck: Truck): void {
  if (planTruckRoute(world, truck, 'to_gate_out')) faceRoute(world, truck);
  else enterTruckNoPath(world, truck);
  truck.reserveHead(headSlotKey(world, truck));
}

/** Príchod na koniec trasy podľa jazdného stavu (tabuľka, nie switch). */
const ARRIVALS: { readonly [S in TruckTravelState]: Arrival } = Object.freeze({
  to_gate: (truck: Truck, world: World) => {
    changeTruckState(world.events, truck, 'gate_queue');
    gateOfTruck(world, truck).enqueue(truck.id);
  },
  to_bay: (truck: Truck, world: World) => {
    const area = waitingAreaOfTruck(world, truck);
    area.occupyBay(truck.id);
    truck.waitTicks = waitingStayTicks(area, world.defs.logistics);
    changeTruckState(world.events, truck, 'waiting');
    WAITING_STARTED[truck.mission](world, truck);
  },
  to_dock: (truck: Truck, world: World) => {
    truck.waitTicks = rampOfTruck(world, truck).params.loadTicksPerUnit;
    changeTruckState(world.events, truck, DOCK_STATE[truck.mission]);
  },
  to_gate_out: (truck: Truck, world: World) => {
    if (isAtTravelTarget(world, truck, 'to_gate_out')) {
      changeTruckState(world.events, truck, 'gate_queue_out');
      gateOfTruck(world, truck).enqueue(truck.id);
      return;
    }
    // Koniec trasy pred spätným priechodom stojiskom: prechod telom (okamžitý, bez bay) len so zabraným slotom vstupnej
    // bunky stojiska — je obsadený, kamión stojí na výstupnej bunke a skúsi to v ďalšom ticku; potom ďalej k bráne.
    const passage = passageBackOf(world, truck);
    if (passage !== undefined && truck.cell === passage.from) {
      if (!canExitTo(world, truck, passage.to, 'to_gate_out')) return;
      truck.jumpTo(passage.to, world.grid.width);
      continueFromHop(world, truck);
      return;
    }
    if (planTruckRoute(world, truck, 'to_gate_out')) faceRoute(world, truck);
    else enterTruckNoPath(world, truck);
  },
  to_portal: exitMap,
});

/** Jazdný stav kamióna (má príchod); iný → `TruckError('inconsistent')`. */
function travelOf(truck: Truck): TruckTravelState {
  const state = truck.state;
  if (isTruckTravelState(state)) return state;
  throw new TruckError('inconsistent', `${truck.label}: jazda v stave '${state}'`);
}

/**
 * Preplánovanie kamióna v jazdnom stave po zmene ciest (volá `TrafficSystem` pred získaním slotov a pohybom, krok 6a,
 * ADR-038): nová trasa z kotvy k cieľu stavu, bez cesty `no_path`. `false` = kamión prešiel do `no_path`. Bez čakajúceho
 * preplánovania nič nerobí (`true`).
 */
export function replanTruck(truck: Truck, world: World): boolean {
  if (!truck.replanPending) return true;
  if (planTruckRoute(world, truck, travelOf(truck))) return true;
  enterTruckNoPath(world, truck);
  return false;
}

/**
 * Jeden tick jazdy kamióna po trase (volá `TrafficSystem`, krok 6a): sloty ďalších buniek stráži brána sveta (`advanceCarrier`,
 * ADR-037). Príchod na koniec trasy spracuje až FSM krok kamióna (`arriveWhenThere`).
 */
export function advanceTruck(truck: Truck, world: World): void {
  advanceCarrier(world, truck, truck.def.speedCellsPerTick);
}

/** Jazdný stav (FSM krok bez pohybu): kamión, ktorý stojí na konci trasy, dorazil (`ARRIVALS`). */
function arriveWhenThere(truck: Truck, world: World): void {
  if (truck.cellsAhead === 0) ARRIVALS[travelOf(truck)](truck, world);
}

/**
 * Môže kamión odísť k docku (podľa misie, tabuľka — pravidlo 7)? Pickup: na docku je celý jeho náklad na odvoz
 * (`stagedAt ≥ capacityUnits` — nakládka potom nikdy nečaká, ADR-029). Delivery: dock má staging miesto pre jednotky,
 * ktoré vezie (`freeAt ≥ in_truck`; export na prijatie na docku kapacitu zaberá, ADR-032 bod 13). Collect: pridelený prázdny leží na docku
 * (`collectReady`). Dock musí byť voľný.
 */
const DOCK_READY: { readonly [M in TruckMission]: (world: World, truck: Truck, ramp: LoadingRamp) => boolean } = Object.freeze({
  pickup: (_world: World, truck: Truck, ramp: LoadingRamp) => ramp.stagedAt(truck.dock) >= truck.def.capacityUnits,
  delivery: (world: World, truck: Truck, ramp: LoadingRamp) => ramp.freeAt(truck.dock) >= unitsIn(world, truck),
  // Collect: pridelený prázdny kontajner už leží na docku kamióna (F6c, ADR-034).
  collect: collectReady,
});

/**
 * Pri odchode k docku delivery kamión rezervuje staging miesto pre každú jednotku, ktorú vezie (`holdsIntake`) — kapacita
 * docku mu už nikto nezoberie (outbound joby rezervujú len voľné miesta); pickup nič.
 */
const DOCK_DEPARTURE: { readonly [M in TruckMission]: (world: World, truck: Truck, ramp: LoadingRamp) => void } = Object.freeze({
  pickup: NOTHING,
  delivery: (world: World, truck: Truck, ramp: LoadingRamp) => {
    for (let i = unitsIn(world, truck); i > 0; i--) ramp.reserve(truck.dock);
  },
  collect: NOTHING,
});

/**
 * Vzdá sa kamión v stojisku (tabuľka podľa misie)? Len `collect` bez prideleného prázdneho po `giveUpTick` (F6c, ADR-034): odíde zo
 * stojiska prázdny priamo k bráne von, bez docku.
 */
const WAITING_GIVE_UP: { readonly [M in TruckMission]: (world: World, truck: Truck) => boolean } = Object.freeze({
  pickup: () => false,
  delivery: () => false,
  collect: collectGivesUp,
});

/**
 * Koniec pobytu v stojisku (povel do docku, ADR-029): kamión odíde, keď je jeho dock voľný (`LoadingRamp.dockTruck`) a je
 * pripravený podľa misie (`DOCK_READY`: pickup má na docku celý náklad, delivery miesto na vyloženie). Vtedy si dock vezme,
 * uvoľní bay, objaví sa na výstupnej bunke stojiska svojho okruhu (`truckCircuit` — nezávisle od cesty pred bránou) a ide
 * k docku (bez cesty `no_path`). Inak čaká v bayi a skúsi to v ďalšom ticku; kamióny idú vzostupne podľa id, takže
 * z pripravených kamiónov docku odíde prvý (FIFO podľa spawnu). Keď okruh (priechod stojiskom k rampe) zanikol, kamión čaká
 * ďalej a skúsi to o `repathIntervalTicks`.
 */
function leaveWaitingArea(truck: Truck, world: World): void {
  const exit = truckCircuit(world, truck)?.waitingExitCell ?? NO_ACCESS;
  if (exit === NO_ACCESS) {
    truck.waitTicks = world.defs.logistics.repathIntervalTicks;
    return;
  }
  if (WAITING_GIVE_UP[truck.mission](world, truck)) {
    if (canExitTo(world, truck, exit, 'to_gate_out')) giveUpWaiting(truck, world, exit);
    else truck.waitTicks = MIN_STAY_TICKS;
    return;
  }
  const ramp = rampOfTruck(world, truck);
  // Výjazd potrebuje voľný slot výjazdovej bunky stojiska; inak kamión čaká v bayi (bay ostáva obsadený, dock voľný).
  if (ramp.dockTruck(truck.dock) !== null || !DOCK_READY[truck.mission](world, truck, ramp) || !canExitTo(world, truck, exit, 'to_dock')) {
    truck.waitTicks = MIN_STAY_TICKS;
    return;
  }
  waitingAreaOfTruck(world, truck).releaseBay(truck.id);
  truck.bay = null;
  ramp.assignDock(truck.dock, truck.id);
  DOCK_DEPARTURE[truck.mission](world, truck, ramp);
  exitTo(world, truck, exit, 'to_dock');
}

/**
 * Kamión misie `collect` sa vzdal (`EmptyPickupMissed`): uvoľní bay, objaví sa na výstupnej bunke stojiska (`exit`, okruh kamióna) a ide
 * prázdny k bráne von (`waiting → to_gate_out`, dock nedrží) — späť k bráne cez spätný priechod stojiskom ako po nakládke.
 */
function giveUpWaiting(truck: Truck, world: World, exit: number): void {
  giveUpCollect(world, truck);
  waitingAreaOfTruck(world, truck).releaseBay(truck.id);
  truck.bay = null;
  exitTo(world, truck, exit, 'to_gate_out');
}

/**
 * Môže delivery kamión po vykládke naložiť import na tom istom docku (**dual transaction**, ADR-032 bod 13)? Na docku je náklad na
 * odvoz, na ktorý nemá nárok iný kamión, pre celú kapacitu kamióna (`stagedAt − claimedAt ≥ capacityUnits`; export na prijatie sa
 * do pripravených nepočíta) — nakládka tak nikdy nečaká (ako pri spawne pickup kamióna, ADR-029).
 */
function canDualTransact(truck: Truck, ramp: LoadingRamp): boolean {
  return ramp.stagedAt(truck.dock) - ramp.claimedAt(truck.dock) >= truck.def.capacityUnits;
}

/**
 * Koniec vykládky jednej jednotky (delivery, ADR-032): najstaršia jednotka kamióna `in_truck → at_ramp` na jeho dock
 * (`assertCommittable → CargoLedger.move → commit` rezervovaného miesta); ďalšia jednotka `loadTicksPerUnit`, alebo
 * `TruckUnloaded`: pri náklade na odvoz na docku (`canDualTransact`) kamión **zostane na docku** (`becomePickup`, nárok na náklad)
 * a naloží import (`unloading → loading`, `dualTransaction: true`), inak uvoľní dock a odíde prázdny k bráne von. Vykladanú
 * jednotku prevezme dispatcher (krok 5 ďalšieho ticku, job `at_ramp → in_storage`).
 */
function unloadUnit(truck: Truck, world: World): void {
  const ramp = rampOfTruck(world, truck);
  // Kamión bez jednotiek vo vykládke už vyložil všetko a čaká na voľnú výjazdovú bunku (`leaveDock`).
  if (unitsIn(world, truck) > 0) {
    const unitId = world.cargo.firstUnitAt('in_truck', truck.id);
    if (unitId === undefined) throw new TruckError('inconsistent', `${truck.label}: vo vykládke nie je v kamióne jednotka`);
    ramp.assertCommittable(truck.dock, unitId);
    world.cargo.move(unitId, { kind: 'at_ramp', rampId: ramp.id, dock: truck.dock });
    ramp.commit(truck.dock, unitId);
    if (unitsIn(world, truck) > 0) {
      truck.waitTicks = ramp.params.loadTicksPerUnit;
      return;
    }
    const dualTransaction = canDualTransact(truck, ramp);
    world.events.emit({ type: 'TruckUnloaded', truckId: truck.id, rampId: ramp.id, dock: truck.dock, unitId, dualTransaction });
    if (dualTransaction) {
      truck.becomePickup();
      ramp.claim(truck.dock, truck.def.capacityUnits);
      truck.waitTicks = ramp.params.loadTicksPerUnit;
      changeTruckState(world.events, truck, 'loading');
      return;
    }
  }
  leaveDock(truck, world, ramp);
}

/**
 * Odchod od docku k bráne von (ADR-037): dock sa uvoľní až so slotom výjazdovej bunky (bunka, na ktorej kamión v docku stojí);
 * je obsadený, kamión čaká vnútri a dock ostáva jeho (skúsi to v ďalšom ticku).
 */
function leaveDock(truck: Truck, world: World, ramp: LoadingRamp): void {
  if (!canExitTo(world, truck, truck.cell, 'to_gate_out')) {
    truck.waitTicks = MIN_STAY_TICKS;
    return;
  }
  ramp.releaseDock(truck.dock, truck.id);
  exitTo(world, truck, truck.cell, 'to_gate_out');
}

/**
 * Koniec nakládky jednej jednotky: najstaršia jednotka docku `at_ramp → in_truck` (uvoľnené staging miesto doplní
 * dispatcher v kroku 5 ďalšieho ticku); ďalšia jednotka `loadTicksPerUnit`, alebo odchod od docku k bráne von (`leaveDock`).
 * Plný kamión, ktorý čakal na voľnú výjazdovú bunku, už nenakladá.
 */
function loadUnit(truck: Truck, world: World): void {
  const ramp = rampOfTruck(world, truck);
  if (unitsIn(world, truck) < truck.def.capacityUnits) {
    const unitId = ramp.firstUnitAt(truck.dock);
    if (unitId === undefined) throw new TruckError('inconsistent', `${truck.label}: na docku ${String(truck.dock)} ${ramp.label} nie je jednotka na nakládku`);
    world.cargo.move(unitId, { kind: 'in_truck', truckId: truck.id });
    ramp.settleClaim(truck.dock, 1);
    if (unitsIn(world, truck) < truck.def.capacityUnits) {
      truck.waitTicks = ramp.params.loadTicksPerUnit;
      return;
    }
  }
  leaveDock(truck, world, ramp);
}

/**
 * Koniec nakládky kamióna `collect`: pridelený prázdny `at_ramp → in_truck` a odchod od docku k bráne von (F6c, ADR-034;
 * `leaveDock`). Kamión s naloženým prázdnym, ktorý čakal na voľnú výjazdovú bránu, už nenakladá.
 */
function loadCollectedUnit(truck: Truck, world: World): void {
  const ramp = rampOfTruck(world, truck);
  if (unitsIn(world, truck) === 0) loadCollected(world, truck, ramp);
  leaveDock(truck, world, ramp);
}

/** Koniec nakládky podľa misie (tabuľka, nie switch); delivery nakladá až po `becomePickup`, takže tu nikdy nie je. */
const LOADERS: { readonly [M in TruckMission]: (truck: Truck, world: World) => void } = Object.freeze({
  pickup: loadUnit,
  delivery: loadUnit,
  collect: loadCollectedUnit,
});

/** Nový pokus o cestu z `no_path`; úspech = návrat do stavu, z ktorého kamión vypadol. */
function retry(truck: Truck, world: World): void {
  const travel = truck.resume;
  if (travel === null) throw new TruckError('inconsistent', `${truck.label}: no_path bez stavu na návrat`);
  if (planTruckRoute(world, truck, travel)) changeTruckState(world.events, truck, travel);
  else truck.waitTicks = world.defs.logistics.repathIntervalTicks;
}

type TruckStep = (truck: Truck, world: World) => void;

const TRUCK_STEPS: { readonly [S in TruckState]: TruckStep } = {
  to_gate: arriveWhenThere,
  gate_queue: () => undefined,
  gate_pass: () => undefined,
  to_bay: arriveWhenThere,
  waiting: (truck, world) => {
    if (countDown(truck)) leaveWaitingArea(truck, world);
  },
  to_dock: arriveWhenThere,
  loading: (truck, world) => {
    if (countDown(truck)) LOADERS[truck.mission](truck, world);
  },
  // Vykládka exportu (delivery kamión, ADR-032 bod 4): po `loadTicksPerUnit` jednotka na dock rampy.
  unloading: (truck, world) => {
    if (countDown(truck)) unloadUnit(truck, world);
  },
  to_gate_out: arriveWhenThere,
  gate_queue_out: () => undefined,
  gate_pass_out: () => undefined,
  to_portal: arriveWhenThere,
  exited: (truck) => {
    throw new TruckError('inconsistent', `${truck.label} v stave 'exited' je stále vo world.trucks`);
  },
  no_path: (truck, world) => {
    if (countDown(truck)) retry(truck, world);
  },
};

/** Kamión na čele fronty brány (vo svete); prázdna fronta → `undefined`, chýbajúci kamión → `TruckError`. */
function headOf(world: World, gate: TruckGate): Truck | undefined {
  const head: EntityId | undefined = gate.peekQueue();
  if (head === undefined) return undefined;
  const truck = world.trucks.get(head);
  if (truck === undefined) throw new TruckError('inconsistent', `${gate.label}: kamión #${String(head)} z fronty vo svete nie je`);
  return truck;
}

/**
 * Koniec prechodu (kamión `truck` na čele fronty je v `gate_pass*`): kamión sa objaví na druhej strane brány (strany pre kamión,
 * `gateFarSideCell`) a ide ďalej (`afterGate`) — len so zabraným slotom výjazdovej bunky (`canExitTo`, ADR-037). Je obsadený
 * alebo druhá strana medzitým zanikla (prestavba ciest): kamión ostane v bráne na čele fronty (brána ostáva obsadená)
 * a výjazd sa zopakuje v ďalšom ticku. `true` = kamión vyšiel, brána je voľná pre ďalší prechod.
 */
function finishPass(world: World, gate: TruckGate, truck: Truck): boolean {
  const far = gateFarSideCell(world, truck);
  const next = TRUCK_STATE_TRAITS[truck.state].afterGate;
  if (far === NO_ACCESS || next === null || !canExitTo(world, truck, far, next)) return false;
  gate.completePass();
  onGatePassed(world, truck);
  exitTo(world, truck, far, next);
  return true;
}

/**
 * Začiatok prechodu kamióna `truck` na čele fronty (len keď druhá strana brány existuje): kamión prejde do `gate_pass*`
 * (mimo cesty — uvoľní celé telo, ďalší kamión z kolóny sa posunie na vonkajšiu bunku) a brána odpočítava `passTicks`.
 */
function beginPass(world: World, gate: TruckGate, truck: Truck): void {
  const passState = TRUCK_STATE_TRAITS[truck.state].passState;
  if (passState === null || gateFarSideCell(world, truck) === NO_ACCESS) return;
  gate.beginPass(gate.passTicks);
  changeTruckState(world.events, truck, passState);
}

/**
 * Jeden tick brány: odpočet prechodu, jeho koniec (výjazd kamióna so slotom) a začiatok ďalšieho. Kamión, ktorý prechod
 * dokončil, ale nemá kam vyjsť, ostáva na čele fronty v `gate_pass*` (`busyTicksLeft = 0`) a výjazd sa opakuje každý tick;
 * ďalší prechod začne najskôr v tom istom ticku, keď predchádzajúci kamión vyšiel — medzi dvoma prechodmi je aspoň `passTicks`.
 */
function stepGate(world: World, gate: TruckGate): void {
  if (gate.busyTicksLeft > 0) gate.advancePass();
  if (gate.busyTicksLeft > 0) return;
  let head = headOf(world, gate);
  if (head !== undefined && TRUCK_STATE_TRAITS[head.state].passing) {
    if (!finishPass(world, gate, head)) return;
    head = headOf(world, gate);
  }
  if (head !== undefined) beginPass(world, gate, head);
}

/**
 * Urovnanie front po zmene siete (dodatok ADR-024; volá `World` po zverejnení reťazca v príkazovej fáze): kamión vo
 * fronte, pod ktorým sa strany brány preklopili (`isOffQueueSide` — stojí na inej prístupovej bunke brány, než je jeho
 * strana), už je na druhej strane: vypadne z fronty bez prechodu (`TruckGate.withdraw`, čelo zruší aj prechod) a ide
 * ďalej (`afterGate`, `TruckStateChanged`; kamión stojí na ceste, takže si slot svojej bunky ponecháva). Kamión v prechode
 * (`gate_pass*`) sa neurovnáva — prechod dokončí a vyjde na strane určenej v čase výjazdu. Brány vzostupne podľa id,
 * kamióny v poradí fronty; bez takých kamiónov nič nemení ani nealokuje.
 */
export function settleGateQueues(world: World): void {
  for (const gate of world.landsideModules.gates) {
    const queued = gate.queuedTruckIds;
    for (const truckId of queued) {
      const truck = world.trucks.get(truckId);
      if (truck === undefined || !isOffQueueSide(world, truck)) continue;
      const next = TRUCK_STATE_TRAITS[truck.state].afterGate;
      if (next === null) continue;
      gate.withdraw(truck.id);
      onGatePassed(world, truck);
      startTruckTrip(world, truck, next);
    }
  }
}

export class LandsideSystem {
  /** Znovupoužiteľné počty jednotiek, ktoré vozidlá vezú k dockom (spawner, ADR-029); nie je stav simulácie. */
  private readonly supply = new DockSupply();

  /** Krok 8: kamióny → brány → spawn (viď hlavička); brány a rampy z registra sveta (`World.landsideModules`). */
  tick(world: World): void {
    for (const truck of world.trucks.values()) {
      if (!world.traffic.changedState(truck.id)) TRUCK_STEPS[truck.state](truck, world);
    }
    const { gates, ramps } = world.landsideModules;
    for (const gate of gates) stepGate(world, gate);
    spawnTrucks(world, ramps, this.supply);
    admitFromHinterland(world);
  }
}
