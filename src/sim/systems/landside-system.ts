/**
 * LandsideSystem — krok 8 ticku (ARCHITECTURE §6, §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6; ADR-011, ADR-024, ADR-038, ADR-041): kamióny, brány a spawn. Pohyb kamiónov po cestách
 * (preplánovanie `replanTruck`, jazda `advanceTruck`) robí od R1 `TrafficSystem` v kroku 6a pod pruhovými slotmi (ADR-037); tu ostáva FSM kamiónov — príchody, odstavná plocha, TP, brána.
 * Kamión, ktorému sa stav zmenil už v kroku 6a (`no_path`), v tomto ticku krok FSM nerobí (ADR-016). Poradie v kroku je pevné:
 * 1. **Kamióny** vzostupne podľa id, krok podľa stavu z tabuľky `TRUCK_STEPS` (nie switch), stav mení len `changeTruckState`:
 *    - jazda (`to_*`): po zmene ciest preplánovanie z kotvy (bez cesty `no_path`), pohyb zdieľaným `advanceCarrier` a na konci trasy príchod podľa `ARRIVALS` — do fronty brány
 *      (`gate_queue`, pri `to_gate_out` `gate_queue_out`), do odstavnej plochy (`holding`), na TP (`at_tp` v pruhu RTG bloku, `at_edge_tp` na hrane bloku), na portál (všetky
 *      `in_truck → exported`, `TruckExited`, kamión zmizne);
 *    - `holding`: TOS kamión zavolá k TP, keď je jeho jednotka pripravená a TP voľné (`trucks/holding.ts`);
 *    - `at_tp` / `at_edge_tp`: fázy bezpečná zóna → unlashing → odovzdanie → bezpečná zóna → lashing, potom odchod alebo dual transaction (`trucks/tp-service.ts`); odovzdanie robí stroj
 *      bloku (krok 6c) alebo straddle carrier (job z kroku 5);
 *    - `no_path`: po odpočte nový pokus o cestu, úspech = návrat do stavu, z ktorého kamión vypadol.
 * 2. **Pruhy brány** vzostupne podľa id (R4, ADR-041 bod 1): každý pruh má vlastnú FIFO frontu a obsluhuje 1 kamión naraz nezávisle od ostatných. Kamión na čele prejde
 *    `gate_queue*` → `gate_pass*` (mimo cesty — uvoľní celé telo, takže sa ďalší kamión z kolóny posunie na vonkajšiu bunku)
 *    a prechod je plán krokov pruhu (`TruckGate.planFor`: OCR / kontrola / lístok, váha / sken / plomba; režim `standard` pri šanci na problém losuje `Rng` raz za prechod).
 *    Po ňom sa kamión objaví na vnútornej strane pruhu a ide ďalej (`to_tp` / `to_holding` podľa tokenu lístka, `to_portal`) **len so zabraným slotom
 *    výjazdovej bunky**; inak ostane na čele fronty v `gate_pass*` a pruh ostáva obsadený (`completePass`, `trucksProcessed`
 *    počíta dokončené prechody). Fronta je **fyzická**: na vonkajšej bunke konektora stojí jediný `gate_queue`
 *    a ďalšie kamióny čakajú za ním na ceste v `to_gate` (ADR-037, R1 č. 9). Dokončený prechod výstupným pruhom zapíše **TTT** (`TruckStats`: od príchodu k vstupnému pruhu).
 * 2b. **Predbránové plochy** (`stepPreGates`): kamión dorazí k vjazdu (`to_pre_gate → pre_gate`), dostane rad s najkratšou frontou (`PreGateBuffer.shortestRow`, pruh brány radu
 *    `r mod počet pruhov`) a čaká mimo cesty vedľa ostatných. Čelo radu vyjde na cestu (`pre_gate → to_gate`), keď je jeho pruh voľný (bez fronty, bez prechodu, nik k nemu nejde)
 *    a výjazdový slot plochy je voľný — pruh tak nikdy nemá viac než jeden kamión naraz a verejná cesta fronty nenesie (ADR-041 bod 2).
 * 3. **Spawn**: kamióny na odvoz importu pre jednotky v sklade (`spawnPickupTrucks`, ADR-041 bod 4); potom vjazd kamiónov z vnútrozemia (`admitFromHinterland`, ADR-035): výdaj prázdneho,
 *    export podľa plánu príchodov bookingov (ADR-032) a návrat prázdneho — každý s lístkom (blok so zaručeným miestom, token TP / státia).
 *
 * **Prázdne kontajnery** (F6c, ADR-034): kamión `delivery` s prázdnym kontajnerom linky (návrat z vnútrozemia) sa správa ako export (brána `EmptyReturned`, vyloženie na TP depa); kamión
 * misie `collect` (výdaj prázdneho exportérovi) naloží pridelený prázdny na TP depa a odíde (`EmptyPickedUp`). Pri odchode kamióna s importom z mapy sa naplánuje návrat prázdneho
 * (`planEmptyReturn`, `Rng`). **Export** (F6a, ADR-032 bod 4, 7): kamión s misiou `delivery` príde naložený jednou jednotkou, po prechode bránou dnu ju brána zaregistruje (`export-gate.ts`:
 * `ExportArrived`, rolled po cut-off, VGM hold).
 * Prechod stavu ukončí pohyb kamióna v danom ticku (ako vozidlá, ADR-019): nový, prepustený alebo naložený kamión sa pohne až v ďalšom ticku. Tick vstupu do stavu s odpočtom je jeho nultý tick (ADR-016).
 */
import type { CargoUnit } from '../cargo/cargo-unit';
import type { EntityId } from '../core/entity-id';
import type { TruckGate } from '../modules/truck-gate';
import { YardBlock } from '../modules/yard-block';
import { NO_ACCESS, accessCellIndex } from '../logistics/module-access';
import { advanceCarrier } from '../movement/route-planning';
import type { Truck } from '../trucks/truck';
import { TruckError } from '../trucks/truck-error';
import { TRUCK_STATE_TRAITS, changeTruckState, isTruckTravelState, type TruckMission, type TruckState, type TruckTravelState } from '../trucks/truck-fsm';
import { finishCollect } from '../trucks/empty-collect';
import { planEmptyReturn } from '../trucks/empty-plan';
import { onGatePassed } from '../trucks/export-gate';
import { laneLoad } from '../trucks/gate-choice';
import { callFromHolding } from '../trucks/holding';
import { admitFromHinterland } from '../trucks/hinterland-admit';
import { hasLaneTp } from '../trucks/tp-points';
import { arriveAtTp, stepTp } from '../trucks/tp-service';
import { spawnPickupTrucks } from '../trucks/truck-spawner';
import { canExitTo, enterTruckNoPath, exitTo, faceRoute, gateFarSideCell, gateOfTruck, gateOutOfTruck, isAtTravelTarget, isOffGateSide, planTruckRoute, preGateOfTruck, startTruckTrip } from '../trucks/truck-trip';
import type { World } from '../world/world';

/** Jeden tick odpočtu; `true`, keď práve skončil. */
function countDown(truck: Truck): boolean {
  truck.waitTicks = Math.max(0, truck.waitTicks - 1);
  return truck.waitTicks === 0;
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

/** Po vstupnej bráne kamión mieri na TP, alebo (token = státie) do odstavnej plochy; po výstupnej na portál (`TRUCK_STATE_TRAITS.afterGate`). */
function afterGateOf(truck: Truck): TruckTravelState | null {
  const traits = TRUCK_STATE_TRAITS[truck.state];
  if (traits.gateSide === 'entry') return truck.stall !== null ? 'to_holding' : 'to_tp';
  return traits.afterGate;
}

/** Príchod na koniec trasy podľa jazdného stavu (tabuľka, nie switch). */
const ARRIVALS: { readonly [S in TruckTravelState]: Arrival } = Object.freeze({
  to_pre_gate: (truck: Truck, world: World) => {
    const buffer = preGateOfTruck(world, truck);
    const row = buffer.shortestRow();
    // Plná plocha: kamión ostane na ceste a skúsi to v ďalšom ticku (rezervácia miesta pri vjazde to nepripustí; ochrana pred prestavbou).
    if (row < 0) return;
    const lanes = world.landside.preGateLanes(buffer);
    if (lanes.length === 0) {
      enterTruckNoPath(world, truck);
      return;
    }
    buffer.admit(truck.id, row);
    truck.row = row;
    truck.gateId = lanes[row % lanes.length].id;
    changeTruckState(world.events, truck, 'pre_gate');
  },
  to_gate: (truck: Truck, world: World) => {
    changeTruckState(world.events, truck, 'gate_queue');
    gateOfTruck(world, truck).enqueue(truck.id);
    truck.gateInTick ??= world.clock.tick;
  },
  to_holding: (truck: Truck, world: World) => {
    truck.waitTicks = 1;
    changeTruckState(world.events, truck, 'holding');
  },
  to_tp: (truck: Truck, world: World) => {
    const block = world.modules.get(truck.blockId);
    if (!(block instanceof YardBlock)) throw new TruckError('inconsistent', `${truck.label}: blok #${String(truck.blockId)} vo svete nie je`);
    arriveAtTp(world, truck, hasLaneTp(block));
  },
  to_gate_out: (truck: Truck, world: World) => {
    if (isAtTravelTarget(world, truck, 'to_gate_out')) {
      changeTruckState(world.events, truck, 'gate_queue_out');
      gateOutOfTruck(world, truck).enqueue(truck.id);
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

/** Nový pokus o cestu z `no_path`; úspech = návrat do stavu, z ktorého kamión vypadol. */
function retry(truck: Truck, world: World): void {
  const travel = truck.resume;
  if (travel === null) throw new TruckError('inconsistent', `${truck.label}: no_path bez stavu na návrat`);
  if (planTruckRoute(world, truck, travel)) changeTruckState(world.events, truck, travel);
  else truck.waitTicks = world.defs.logistics.repathIntervalTicks;
}

type TruckStep = (truck: Truck, world: World) => void;

const TRUCK_STEPS: { readonly [S in TruckState]: TruckStep } = {
  to_pre_gate: arriveWhenThere,
  pre_gate: () => undefined,
  to_gate: arriveWhenThere,
  gate_queue: () => undefined,
  gate_pass: () => undefined,
  to_holding: arriveWhenThere,
  holding: (truck, world) => {
    callFromHolding(world, truck);
  },
  to_tp: arriveWhenThere,
  at_tp: (truck, world) => {
    stepTp(world, truck);
  },
  at_edge_tp: (truck, world) => {
    stepTp(world, truck);
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
  const next = afterGateOf(truck);
  if (far === NO_ACCESS || next === null || !canExitTo(world, truck, far, next)) return false;
  gate.completePass();
  onGatePassed(world, truck);
  // Výstupná brána uzatvára TTT: od príchodu k vstupnému pruhu po koniec prechodu výstupným pruhom (ADR-041, metrika `truckTurnTimeAvgMin`).
  if (TRUCK_STATE_TRAITS[truck.state].gateSide === 'exit' && truck.gateInTick !== null) world.hinterland.recordTurn(world.clock.tick - truck.gateInTick);
  exitTo(world, truck, far, next);
  return true;
}

/**
 * Začiatok prechodu kamióna `truck` na čele fronty (len keď druhá strana brány existuje): kamión prejde do `gate_pass*`
 * (mimo cesty — uvoľní celé telo, ďalší kamión z kolóny sa posunie na vonkajšiu bunku) a pruh odpočítava plán prechodu.
 */
function beginPass(world: World, gate: TruckGate, truck: Truck): void {
  const passState = TRUCK_STATE_TRAITS[truck.state].passState;
  if (passState === null || gateFarSideCell(world, truck) === NO_ACCESS) return;
  // Režim `standard`: šanca na problém (`Rng` raz za prechod; express a trouble pruhy `Rng` nespotrebujú).
  const mode = gate.mode;
  const trouble = mode === 'standard' && gate.issueChance > 0 && world.rng.chance(gate.issueChance);
  gate.beginPass(gate.planFor(mode, trouble));
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
 * Predbránové plochy (viď hlavička, bod 2b): čelo každého radu vyjde na cestu k svojmu pruhu brány, keď je pruh voľný a výjazdový slot plochy je voľný. Plochy a rady vzostupne
 * (deterministicky); pruh radu je `preGateLanes[r mod počet]`, takže kamión sa po zmene ciest preradí na aktuálny pruh radu.
 */
function stepPreGates(world: World): void {
  for (const buffer of world.landsideModules.preGates) {
    if (buffer.occupied === 0) continue;
    const lanes = world.landside.preGateLanes(buffer);
    const exitConnector = buffer.connectors[1];
    const exitCell = exitConnector === undefined ? NO_ACCESS : accessCellIndex(world.grid, exitConnector);
    if (lanes.length === 0 || exitCell === NO_ACCESS) continue;
    for (let row = 0; row < buffer.rowCount; row++) {
      const headId = buffer.head(row);
      if (headId === undefined) continue;
      const truck = world.trucks.get(headId);
      if (truck === undefined || truck.state !== 'pre_gate') throw new TruckError('inconsistent', `${buffer.label}: čelo radu ${String(row)} #${String(headId)} nie je kamión v pre_gate`);
      const lane = lanes[row % lanes.length];
      truck.gateId = lane.id;
      if (lane.busyTicksLeft > 0 || laneLoad(world, lane) > 0 || !canExitTo(world, truck, exitCell, 'to_gate')) continue;
      buffer.releaseHead(row);
      truck.row = null;
      truck.preGateId = null;
      exitTo(world, truck, exitCell, 'to_gate');
    }
  }
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
      if (truck === undefined || !isOffGateSide(world, truck)) continue;
      const traits = TRUCK_STATE_TRAITS[truck.state];
      const next = afterGateOf(truck);
      if (next === null) continue;
      if (traits.passing) {
        // Kamión v prechode je mimo cesty: vyjde na bunke, na ktorej stojí, len so zabraným slotom (inak dokončí prechod bežne).
        if (!canExitTo(world, truck, truck.cell, next)) continue;
        gate.withdraw(truck.id);
        onGatePassed(world, truck);
        exitTo(world, truck, truck.cell, next);
        continue;
      }
      gate.withdraw(truck.id);
      onGatePassed(world, truck);
      startTruckTrip(world, truck, next);
    }
  }
}

export class LandsideSystem {
  /** Krok 8: kamióny → brány → spawn (viď hlavička); brány a plochy z registra sveta (`World.landsideModules`). */
  tick(world: World): void {
    for (const truck of world.trucks.values()) {
      if (!world.traffic.changedState(truck.id)) TRUCK_STEPS[truck.state](truck, world);
    }
    for (const gate of world.landsideModules.gates) stepGate(world, gate);
    stepPreGates(world);
    spawnPickupTrucks(world);
    admitFromHinterland(world);
  }
}
