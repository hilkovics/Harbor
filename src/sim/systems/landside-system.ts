/**
 * LandsideSystem — krok 8 ticku (ARCHITECTURE §6, §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6;
 * ADR-011, ADR-024): kamióny, brány a spawn. Poradie v kroku je pevné:
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
 *    (pripravený alebo vezený vozidlom, `DockSupply`, ADR-029); potom kamióny s exportom podľa plánu príchodov bookingov
 *    (`spawnExportTrucks`, ADR-032).
 *
 * **Prázdne kontajnery** (F6c, ADR-034): kamión `delivery` s prázdnym kontajnerom linky (návrat z vnútrozemia, `spawnEmptyTrucks`) sa
 * správa ako export (brána `EmptyReturned`, vykládka na dock); kamión misie `collect` (výdaj prázdneho exportérovi) čaká v stojisku na
 * pridelený prázdny a naloží ho z docku, alebo sa po `giveUpTick` (od príchodu do stojiska) vzdá a odíde prázdny zo stojiska (`empty-collect.ts`). Pri odchode
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
import { spawnEmptyTrucks } from '../trucks/empty-trucks';
import { onGatePassed } from '../trucks/export-gate';
import { spawnExportTrucks } from '../trucks/export-trucks';
import { spawnTrucks } from '../trucks/truck-spawner';
import { MIN_STAY_TICKS, waitingStayTicks } from '../trucks/truck-wait';
import {
  enterTruckNoPath,
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
    // Koniec trasy pred spätným priechodom stojiskom: prechod telom (okamžitý, bez bay), potom ďalej k bráne.
    const passage = passageBackOf(world, truck);
    if (passage !== undefined && truck.cell === passage.from) truck.jumpTo(passage.to, world.grid.width);
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

/** Jazda: preplánovanie po zmene ciest, pohyb, príchod. */
function drive(truck: Truck, world: World): void {
  const travel = travelOf(truck);
  if (truck.replanPending && !planTruckRoute(world, truck, travel)) {
    enterTruckNoPath(world, truck);
    return;
  }
  if (advanceCarrier(world, truck, truck.def.speedCellsPerTick)) ARRIVALS[travel](truck, world);
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
    giveUpWaiting(truck, world, exit);
    return;
  }
  const ramp = rampOfTruck(world, truck);
  if (ramp.dockTruck(truck.dock) !== null || !DOCK_READY[truck.mission](world, truck, ramp)) {
    truck.waitTicks = MIN_STAY_TICKS;
    return;
  }
  waitingAreaOfTruck(world, truck).releaseBay(truck.id);
  truck.bay = null;
  ramp.assignDock(truck.dock, truck.id);
  DOCK_DEPARTURE[truck.mission](world, truck, ramp);
  truck.jumpTo(exit, world.grid.width);
  startTruckTrip(world, truck, 'to_dock');
}

/**
 * Kamión misie `collect` sa vzdal (`EmptyPickupMissed`): uvoľní bay, objaví sa na výstupnej bunke stojiska (`exit`, okruh kamióna) a ide
 * prázdny k bráne von (`waiting → to_gate_out`, dock nedrží) — späť k bráne cez spätný priechod stojiskom ako po nakládke.
 */
function giveUpWaiting(truck: Truck, world: World, exit: number): void {
  giveUpCollect(world, truck);
  waitingAreaOfTruck(world, truck).releaseBay(truck.id);
  truck.bay = null;
  truck.jumpTo(exit, world.grid.width);
  startTruckTrip(world, truck, 'to_gate_out');
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
  ramp.releaseDock(truck.dock, truck.id);
  startTruckTrip(world, truck, 'to_gate_out');
}

/**
 * Koniec nakládky jednej jednotky: najstaršia jednotka docku `at_ramp → in_truck` (uvoľnené staging miesto doplní
 * dispatcher v kroku 5 ďalšieho ticku); ďalšia jednotka `loadTicksPerUnit`, alebo uvoľnenie docku a jazda k bráne von.
 */
function loadUnit(truck: Truck, world: World): void {
  const ramp = rampOfTruck(world, truck);
  const unitId = ramp.firstUnitAt(truck.dock);
  if (unitId === undefined) throw new TruckError('inconsistent', `${truck.label}: na docku ${String(truck.dock)} ${ramp.label} nie je jednotka na nakládku`);
  world.cargo.move(unitId, { kind: 'in_truck', truckId: truck.id });
  ramp.settleClaim(truck.dock, 1);
  if (unitsIn(world, truck) < truck.def.capacityUnits) {
    truck.waitTicks = ramp.params.loadTicksPerUnit;
    return;
  }
  ramp.releaseDock(truck.dock, truck.id);
  startTruckTrip(world, truck, 'to_gate_out');
}

/**
 * Koniec nakládky kamióna `collect`: pridelený prázdny `at_ramp → in_truck`, uvoľnenie docku a jazda k bráne von (F6c, ADR-034).
 */
function loadCollectedUnit(truck: Truck, world: World): void {
  const ramp = rampOfTruck(world, truck);
  loadCollected(world, truck, ramp);
  ramp.releaseDock(truck.dock, truck.id);
  startTruckTrip(world, truck, 'to_gate_out');
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
  to_gate: drive,
  gate_queue: () => undefined,
  to_bay: drive,
  waiting: (truck, world) => {
    if (countDown(truck)) leaveWaitingArea(truck, world);
  },
  to_dock: drive,
  loading: (truck, world) => {
    if (countDown(truck)) LOADERS[truck.mission](truck, world);
  },
  // Vykládka exportu (delivery kamión, ADR-032 bod 4): po `loadTicksPerUnit` jednotka na dock rampy.
  unloading: (truck, world) => {
    if (countDown(truck)) unloadUnit(truck, world);
  },
  to_gate_out: drive,
  gate_queue_out: () => undefined,
  to_portal: drive,
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
 * Koniec prechodu: kamión na čele vypadne z fronty (`completePass`, počíta sa dokončený prechod), objaví sa na druhej
 * strane brány (strany pre kamión, `gateFarSideCell`) a ide ďalej (`afterGate`). Keď druhá strana medzitým zanikla
 * (prestavba ciest), kamión ostane na čele a prechod sa zopakuje, keď bude strana späť.
 */
function finishPass(world: World, gate: TruckGate): void {
  const truck = headOf(world, gate);
  if (truck === undefined) return;
  const far = gateFarSideCell(world, truck);
  const next = TRUCK_STATE_TRAITS[truck.state].afterGate;
  if (far === NO_ACCESS || next === null) return;
  gate.completePass();
  onGatePassed(world, truck);
  truck.jumpTo(far, world.grid.width);
  startTruckTrip(world, truck, next);
}

/** Začiatok prechodu kamióna na čele fronty (len keď druhá strana brány existuje). */
function beginPass(world: World, gate: TruckGate): void {
  const truck = headOf(world, gate);
  if (truck === undefined || gateFarSideCell(world, truck) === NO_ACCESS) return;
  gate.beginPass(gate.passTicks);
}

/** Jeden tick brány: odpočet prechodu, jeho koniec a začiatok ďalšieho. */
function stepGate(world: World, gate: TruckGate): void {
  if (gate.busyTicksLeft > 0) {
    gate.advancePass();
    if (gate.busyTicksLeft === 0) finishPass(world, gate);
  }
  if (gate.busyTicksLeft === 0) beginPass(world, gate);
}

/**
 * Urovnanie front po zmene siete (dodatok ADR-024; volá `World` po zverejnení reťazca v príkazovej fáze): kamión vo
 * fronte, pod ktorým sa strany brány preklopili (`isOffQueueSide` — stojí na inej prístupovej bunke brány, než je jeho
 * strana), už je na druhej strane: vypadne z fronty bez prechodu (`TruckGate.withdraw`, čelo zruší aj prechod) a ide
 * ďalej (`afterGate`, `TruckStateChanged`). Brány vzostupne podľa id, kamióny v poradí fronty; bez takých kamiónov
 * nič nemení ani nealokuje.
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
    for (const truck of world.trucks.values()) TRUCK_STEPS[truck.state](truck, world);
    const { gates, ramps } = world.landsideModules;
    for (const gate of gates) stepGate(world, gate);
    spawnTrucks(world, ramps, this.supply);
    spawnExportTrucks(world);
    spawnEmptyTrucks(world);
  }
}
