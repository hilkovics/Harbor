/**
 * LandsideSystem — krok 8 ticku (ARCHITECTURE §6, §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6;
 * ADR-011, ADR-024): kamióny, brány a spawn. Poradie v kroku je pevné:
 * 1. **Kamióny** vzostupne podľa id, krok podľa stavu z tabuľky `TRUCK_STEPS` (nie switch), stav mení len
 *    `changeTruckState`:
 *    - jazda (`to_*`): po zmene ciest preplánovanie z kotvy (bez cesty `no_path`), pohyb zdieľaným `advanceCarrier`
 *      a na konci trasy príchod podľa `ARRIVALS` — do fronty brány (`gate_queue`, pri `to_gate_out` na výstupnej strane
 *      brány `gate_queue_out`, pred spätným priechodom stojiskom prechod telom a ďalšia jazda k bráne), do stojiska
 *      (`waiting`, obsadí bay, pobyt `internalTicks` stojiska), k docku (`loading`, `loadTicksPerUnit` na jednotku),
 *      na portál (export: všetky `in_truck → exported`, `TruckExited`, kamión zmizne);
 *    - `waiting`: po pobyte povel do docku — kamión uvoľní bay, objaví sa na výstupnej bunke stojiska (abstrahovaný
 *      prechod telom, ADR-011) a ide k docku; bez výstupu stojiska čaká ďalej (`repathIntervalTicks`);
 *    - `loading`: po `loadTicksPerUnit` presun najstaršej jednotky docku `at_ramp → in_truck`; po naložení
 *      `capacityUnits` uvoľní dock a ide k výstupnej strane brány;
 *    - `no_path`: po odpočte nový pokus o cestu, úspech = návrat do stavu, z ktorého kamión vypadol.
 * 2. **Brány** vzostupne podľa id: spoločná FIFO fronta oboch smerov, púšťa sa kamión na čele fronty. Prechod trvá
 *    `passTicks` (`processTicks` + `internalTicks`); po ňom kamión vypadne z fronty, objaví sa na druhej strane brány
 *    a ide ďalej (`to_bay` / `to_portal`). Ďalší prechod začne najskôr v tom istom ticku — medzi dvoma prechodmi je
 *    teda aspoň `passTicks ≥ processTicks` tickov (tvrdý bottleneck). Fronta je virtuálna: čakajúci kamión stojí na
 *    vonkajšej bunke konektora, kamióny sa navzájom neblokujú (§7.8 bod 2, 3).
 * 3. **Spawn** (`spawnTrucks`): rampy vzostupne podľa id, docky vzostupne.
 * Prechod stavu ukončí pohyb kamióna v danom ticku (ako vozidlá, ADR-019): nový, prepustený alebo naložený kamión sa
 * pohne až v ďalšom ticku. Tick vstupu do stavu s odpočtom je jeho nultý tick (ADR-016).
 */
import type { EntityId } from '../core/entity-id';
import { LoadingRamp } from '../modules/loading-ramp';
import { TruckGate } from '../modules/truck-gate';
import { NO_ACCESS } from '../logistics/module-access';
import { advanceCarrier } from '../movement/route-planning';
import type { Truck } from '../trucks/truck';
import { TruckError } from '../trucks/truck-error';
import { TRUCK_STATE_TRAITS, changeTruckState, isTruckTravelState, type TruckState, type TruckTravelState } from '../trucks/truck-fsm';
import { spawnTrucks } from '../trucks/truck-spawner';
import {
  enterTruckNoPath,
  faceRoute,
  gateFarSideCell,
  gateOfTruck,
  isAtTravelTarget,
  passageBackOf,
  planTruckRoute,
  rampOfTruck,
  startTruckTrip,
  truckRoute,
  waitingAreaOfTruck,
} from '../trucks/truck-trip';
import type { World } from '../world/world';

/**
 * Najkratší pobyt v stave s odpočtom: stav trvá aspoň tick príchodu (nultý tick) a skončí najskôr v ďalšom ticku —
 * `waitTicks ≥ 1` je invariant stavov s čakaním (krok 12). Pri `internalTicks` stojiska 0 kamión odíde hneď v ďalšom
 * ticku. Štrukturálna hranica konvencie odpočtu (ADR-016), nie balans.
 */
const MIN_STAY_TICKS = 1;

/** Jeden tick odpočtu; `true`, keď práve skončil. */
function countDown(truck: Truck): boolean {
  truck.waitTicks = Math.max(0, truck.waitTicks - 1);
  return truck.waitTicks === 0;
}

/** Počet jednotiek v kamióne (ledger). */
function unitsIn(world: World, truck: Truck): number {
  return world.cargo.countAt('in_truck', truck.id);
}

/** Kamión dorazil na portál: `exited`, všetky jednotky `in_truck → exported` (FIFO), `TruckExited`, kamión zmizne. */
function exitMap(truck: Truck, world: World): void {
  changeTruckState(world.events, truck, 'exited');
  let units = 0;
  for (let unitId = world.cargo.firstUnitAt('in_truck', truck.id); unitId !== undefined; unitId = world.cargo.firstUnitAt('in_truck', truck.id)) {
    world.cargo.move(unitId, { kind: 'exported' });
    units += 1;
  }
  world.removeTruck(truck.id);
  world.events.emit({ type: 'TruckExited', truckId: truck.id, units });
}

type Arrival = (truck: Truck, world: World) => void;

/** Príchod na koniec trasy podľa jazdného stavu (tabuľka, nie switch). */
const ARRIVALS: { readonly [S in TruckTravelState]: Arrival } = Object.freeze({
  to_gate: (truck: Truck, world: World) => {
    changeTruckState(world.events, truck, 'gate_queue');
    gateOfTruck(world, truck).enqueue(truck.id);
  },
  to_bay: (truck: Truck, world: World) => {
    const area = waitingAreaOfTruck(world, truck);
    area.occupyBay(truck.id);
    truck.waitTicks = Math.max(MIN_STAY_TICKS, area.internalTicks ?? world.defs.logistics.defaultInternalTicks);
    changeTruckState(world.events, truck, 'waiting');
  },
  to_dock: (truck: Truck, world: World) => {
    truck.waitTicks = rampOfTruck(world, truck).params.loadTicksPerUnit;
    changeTruckState(world.events, truck, 'loading');
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
 * Koniec pobytu v stojisku (povel do docku): dock kamióna je jeho od spawnu, takže kamión ide hneď. Uvoľní bay, objaví
 * sa na výstupnej bunke stojiska svojej trasy a ide k docku (bez cesty `no_path`). Keď trasa (výstup stojiska) zanikla,
 * kamión čaká v bayi ďalej a skúsi to o `repathIntervalTicks`.
 */
function leaveWaitingArea(truck: Truck, world: World): void {
  const exit = truckRoute(world, truck)?.waitingExitCell ?? NO_ACCESS;
  if (exit === NO_ACCESS) {
    truck.waitTicks = world.defs.logistics.repathIntervalTicks;
    return;
  }
  waitingAreaOfTruck(world, truck).releaseBay(truck.id);
  truck.bay = null;
  truck.jumpTo(exit, world.grid.width);
  startTruckTrip(world, truck, 'to_dock');
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
  if (unitsIn(world, truck) < truck.def.capacityUnits) {
    truck.waitTicks = ramp.params.loadTicksPerUnit;
    return;
  }
  ramp.releaseDock(truck.dock, truck.id);
  startTruckTrip(world, truck, 'to_gate_out');
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
  to_gate: drive,
  gate_queue: () => undefined,
  to_bay: drive,
  waiting: (truck, world) => {
    if (countDown(truck)) leaveWaitingArea(truck, world);
  },
  to_dock: drive,
  loading: (truck, world) => {
    if (countDown(truck)) loadUnit(truck, world);
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
 * Koniec prechodu: kamión na čele vypadne z fronty, objaví sa na druhej strane brány a ide ďalej (`afterGate`). Keď
 * druhá strana medzitým zanikla (prestavba ciest), kamión ostane na čele a prechod sa zopakuje, keď bude strana späť.
 */
function finishPass(world: World, gate: TruckGate): void {
  const truck = headOf(world, gate);
  if (truck === undefined) return;
  const far = gateFarSideCell(world, gate, truck.state);
  const next = TRUCK_STATE_TRAITS[truck.state].afterGate;
  if (far === NO_ACCESS || next === null) return;
  gate.dequeue();
  truck.jumpTo(far, world.grid.width);
  startTruckTrip(world, truck, next);
}

/** Začiatok prechodu kamióna na čele fronty (len keď druhá strana brány existuje). */
function beginPass(world: World, gate: TruckGate): void {
  const truck = headOf(world, gate);
  if (truck === undefined || gateFarSideCell(world, gate, truck.state) === NO_ACCESS) return;
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

export class LandsideSystem {
  /** Znovupoužiteľné zoznamy brán a rámp vzostupne podľa id (nie sú stav simulácie; obnovia sa pri zmene modulov). */
  private readonly gates: TruckGate[] = [];
  private readonly ramps: LoadingRamp[] = [];
  private moduleVersion = Number.NaN;

  /** Krok 8: kamióny → brány → spawn (viď hlavička). */
  tick(world: World): void {
    this.refreshModules(world);
    for (const truck of world.trucks.values()) TRUCK_STEPS[truck.state](truck, world);
    for (const gate of this.gates) stepGate(world, gate);
    spawnTrucks(world, this.ramps);
  }

  /** Brány a rampy sveta prejde len pri zmene množiny modulov (`moduleVersion`). */
  private refreshModules(world: World): void {
    if (world.moduleVersion === this.moduleVersion) return;
    this.moduleVersion = world.moduleVersion;
    this.gates.length = 0;
    this.ramps.length = 0;
    for (const module of world.modules.values()) {
      if (module instanceof TruckGate) this.gates.push(module);
      else if (module instanceof LoadingRamp) this.ramps.push(module);
    }
  }
}
