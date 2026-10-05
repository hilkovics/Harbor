/**
 * Pozemná časť exportu vo fáze 4 (T04-05, TDD): rozloženie brány, čakacej plochy a rampy, prevádzkovosť rampy, brána ako
 * úzke hrdlo (1 kamión za `processTicks`, spoločná FIFO fronta), stojisko (kamión sa nespawnuje bez voľného bay,
 * `NoWaitingBay` najviac 1× za hodinu) a odstraňovanie modulov, ktoré používa kamión. Testy idú výlučne cez verejné API
 * a JSON príkazy, proti rozhraniu z `docs/tasks/phase-04.md` („Spoločné rozhrania", „Rozhodnutia orchestrátora").
 *
 * Rozloženie (`helpers/f4-layout.ts`): brána (45, 32) rot 270, čakacia plocha (49, 31), rampa (53, 28); cesty tak, že jediné
 * spojenie verejnej cesty s areálom vedie bránou a jediné spojenie výstupu brány s vetvou dvorov vedie čakacou plochou.
 * Testy rozloženia (prvý `describe`) sú overiteľné už teraz (validácia, geometria z defov, vlastné BFS po cestách) a
 * strážia, aby červené testy nižšie zlyhávali kvôli chýbajúcej implementácii, nie kvôli chybe rozloženia.
 *
 * Predpoklady o API (rozhranie z karty, najjednoduchší výklad) sú v hlavičkách `describe` a v odovzdávacej správe karty.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON, type ValidationReason } from '@sim/commands';
import { gateParams, rampParams, waitingAreaParams } from '@sim/defs';
import { connectorOutside, connectorsOf, footprintOf } from '@sim/modules';
import type { SimEvent } from '@sim/events';
import { World } from '@sim/world';
import { roadDistance } from '../helpers/f3';
import {
  ALL_F4_ROAD_CELLS,
  F4_ROAD_CELLS,
  GATE,
  GATE_ENTRY_OUTSIDE,
  GATE_EXIT_OUTSIDE,
  PUBLIC_ROAD_END,
  RAMP,
  RAMP_OUTSIDE_CELLS,
  ROAD_PORTAL,
  WAITING_AREA,
  WAITING_EAST_OUTSIDE,
  WAITING_WEST_OUTSIDE,
  f4Scenario,
  placeLandsideCommand,
  type LandsideKind,
} from '../helpers/f4-layout';
import {
  Recorder4,
  STRADDLES,
  builtWorld,
  defsWithBays,
  defsWithProcessTicks,
  gateCrossingTicks,
  gateOf,
  isRampOperational,
  landsideEvents,
  maxNoWaitingBayPerRampHour,
  minGap,
  rampOf,
  runLateGate,
  timed4,
  trucksOf,
  waitingAreaOf,
  worldWithRoads,
  type LateGateRun,
} from '../helpers/f4';
import { must } from '../helpers/harbor';
import { DEFS, MAP, MAP_GRID } from '../world/world-fixtures';

const ROAD_COST = DEFS.infrastructure.road.costPerCellCents;
const GATE_DEF = DEFS.modules.get('truck_gate');
const WAITING_DEF = DEFS.modules.get('truck_waiting_area');
const RAMP_DEF = DEFS.modules.get('loading_ramp_container');
const PROCESS_TICKS = gateParams(GATE_DEF).processTicks;
const BAYS = waitingAreaParams(WAITING_DEF).bays;
const RAMP_PARAMS = rampParams(RAMP_DEF);

/** Timeout hooku: beh s auditom po každom ticku (jednotky sa prevezú do skladu, potom vyvezú kamiónmi). */
const RUN_TIMEOUT_MS = 180_000;

/** Bunka ako `x,y` pre porovnania množín. */
const key = (cell: { x: number; y: number }): string => `${String(cell.x)},${String(cell.y)}`;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

// ---------------------------------------------------------------------------------------------------------
// Rozloženie je platné (overiteľné už teraz)
// ---------------------------------------------------------------------------------------------------------

describe('rozloženie F4: brána, čakacia plocha a rampa na starter parcele sú platné podľa ARCHITECTURE §8', () => {
  const scenario = f4Scenario('f4_layout', 4004, { vehicles: STRADDLES, units: 120 });
  const placements = scenario.commands.flatMap((entry) => {
    const { command } = entry;
    if (command.type !== 'PlaceModule') return [];
    return [{ defId: command['defId'] as string, x: command['x'] as number, y: command['y'] as number, rotation: command['rotation'] as number, command }];
  });

  it('11 nových buniek ciest, spolu 45 unikátnych; postavia sa za bunky × costPerCellCents', () => {
    expect(F4_ROAD_CELLS).toHaveLength(11);
    expect(new Set(ALL_F4_ROAD_CELLS.map(key)).size).toBe(45);
    const world = worldWithRoads(scenario);
    for (const { x, y } of ALL_F4_ROAD_CELLS) expect(world.grid.at(x, y).road, `(${String(x)}, ${String(y)})`).toBe('road');
    expect(DEFS.economy.startingCashCents - world.cashCents).toBe(45 * ROAD_COST);
  });

  it('nové cesty ležia na pevnine starter parcely (patrí hráčovi) a pod modulmi nie sú; štartová cesta nadväzuje na (44, 34)', () => {
    for (const { x, y } of F4_ROAD_CELLS) {
      const cell = MAP_GRID.at(x, y);
      expect(cell.terrain, `(${String(x)}, ${String(y)})`).toBe('land');
      expect(cell.parcelId, `(${String(x)}, ${String(y)})`).toBe('starter');
    }
    expect(MAP_GRID.at(PUBLIC_ROAD_END.x, PUBLIC_ROAD_END.y).road).toBe('road');
    expect(MAP_GRID.at(PUBLIC_ROAD_END.x, PUBLIC_ROAD_END.y).parcelId).toBeNull();
    expect(MAP_GRID.at(ROAD_PORTAL.x, ROAD_PORTAL.y).road).toBe('road');
  });

  it('PlaceModule.validate je ok pre všetkých 6 modulov (terén, parcela, prekryv, konektory s cestou) za cenu z defu', () => {
    const world = worldWithRoads(scenario);
    expect(placements.map((placement) => placement.defId)).toEqual([
      'vehicle_depot',
      'container_yard_small',
      'container_yard_small',
      'truck_gate',
      'truck_waiting_area',
      'loading_ramp_container',
    ]);
    for (const { defId, x, y, command } of placements) {
      const result = commandFromJSON(command).validate(world);
      expect(result.reasons, `${defId} na (${String(x)}, ${String(y)})`).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.costCents).toBe(DEFS.modules.get(defId).costCents);
    }
  });

  it('stavba rampy bez brány a plochy je povolená: neplatná je len prevádzkovo, nie pri stavbe (rozhodnutie 1, ADR-017)', () => {
    // §8 bod 5 chce len použiteľný konektor; brána a plocha sa môžu postaviť neskôr, v ľubovoľnom poradí.
    const world = worldWithRoads(f4Scenario('f4_ramp_only', 4004, { landside: [] }));
    const result = commandFromJSON(placeLandsideCommand('ramp')).validate(world);
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('footprinty leží na pevnine starter parcely a neprekrývajú sa navzájom, cesty ani berth', () => {
    const taken = new Map<string, string>();
    for (const cell of ALL_F4_ROAD_CELLS) taken.set(key(cell), 'cesta');
    for (const cell of footprintOf(DEFS.modules.get('berth_standard'), 40, 14, 0).cells) taken.set(key(cell), 'root berth');

    for (const { defId, x, y, rotation } of placements) {
      const def = DEFS.modules.get(defId);
      for (const cell of footprintOf(def, x, y, rotation as 0 | 90 | 180 | 270).cells) {
        expect(taken.get(key(cell)), `${defId} (${String(x)}, ${String(y)}) prekrýva ${String(taken.get(key(cell)))} na ${key(cell)}`).toBeUndefined();
        taken.set(key(cell), defId);
        expect(MAP_GRID.at(cell.x, cell.y).terrain).toBe('land');
        expect(MAP_GRID.at(cell.x, cell.y).parcelId).toBe('starter');
      }
    }
  });

  it('konektory z defov (rotácia, footprint): brána 270° w (45, 33) → (44, 33) a e (46, 33) → (47, 33); plocha (48, 33) a (53, 33); rampa (54, 30) a (55, 30)', () => {
    const gate = connectorsOf(GATE_DEF, GATE.origin.x, GATE.origin.y, GATE.rotation);
    expect(gate.map((c) => ({ x: c.x, y: c.y, side: c.side }))).toEqual([
      { x: 45, y: 33, side: 'w' },
      { x: 46, y: 33, side: 'e' },
    ]);
    expect(gate.map(connectorOutside)).toEqual([GATE_ENTRY_OUTSIDE, GATE_EXIT_OUTSIDE]);
    expect(connectorsOf(WAITING_DEF, WAITING_AREA.origin.x, WAITING_AREA.origin.y, WAITING_AREA.rotation).map(connectorOutside)).toEqual([
      WAITING_WEST_OUTSIDE,
      WAITING_EAST_OUTSIDE,
    ]);
    expect(connectorsOf(RAMP_DEF, RAMP.origin.x, RAMP.origin.y, RAMP.rotation).map(connectorOutside)).toEqual([...RAMP_OUTSIDE_CELLS]);
  });

  it('všetky vonkajšie bunky konektorov majú cestu', () => {
    const world = worldWithRoads(scenario);
    for (const cell of [GATE_ENTRY_OUTSIDE, GATE_EXIT_OUTSIDE, WAITING_WEST_OUTSIDE, WAITING_EAST_OUTSIDE, ...RAMP_OUTSIDE_CELLS]) {
      expect(world.grid.at(cell.x, cell.y).road, key(cell)).toBe('road');
    }
  });

  it('cestná sieť (BFS po cestách, bez prechodu modulmi): portál ↔ vstup brány; výstup brány ↔ západ plochy; východ plochy ↔ rampa aj dvory', () => {
    const world = worldWithRoads(scenario);
    const reachable = (from: { x: number; y: number }, to: { x: number; y: number }): boolean => roadDistance(world.grid, from, to) < Infinity;

    expect(reachable(ROAD_PORTAL, GATE_ENTRY_OUTSIDE)).toBe(true);
    expect(roadDistance(world.grid, ROAD_PORTAL, GATE_ENTRY_OUTSIDE)).toBe(30);
    expect(reachable(GATE_EXIT_OUTSIDE, WAITING_WEST_OUTSIDE)).toBe(true);
    for (const outside of RAMP_OUTSIDE_CELLS) expect(reachable(WAITING_EAST_OUTSIDE, outside), key(outside)).toBe(true);
    // Sieť dvorov: vonkajšie bunky depa (47, 30), ďalekého dvora (50, 30) aj berthu (41, 17) sú s rampou v jednej sieti.
    for (const outside of [{ x: 47, y: 30 }, { x: 50, y: 30 }, { x: 41, y: 17 }]) expect(reachable(RAMP_OUTSIDE_CELLS[0], outside), key(outside)).toBe(true);
  });

  it('žiadny obchvat: bez prechodu bránou sa z portálu nedá dostať k výstupu brány, plocha ani rampa; výstup brány nevedie k rampe bez plochy', () => {
    const world = worldWithRoads(scenario);
    const reachable = (from: { x: number; y: number }, to: { x: number; y: number }): boolean => roadDistance(world.grid, from, to) < Infinity;

    for (const target of [GATE_EXIT_OUTSIDE, WAITING_WEST_OUTSIDE, WAITING_EAST_OUTSIDE, ...RAMP_OUTSIDE_CELLS]) {
      expect(reachable(ROAD_PORTAL, target), `portál → ${key(target)} musí viesť len bránou`).toBe(false);
    }
    for (const target of [WAITING_EAST_OUTSIDE, ...RAMP_OUTSIDE_CELLS]) {
      expect(reachable(GATE_EXIT_OUTSIDE, target), `výstup brány → ${key(target)} musí viesť len plochou`).toBe(false);
    }
    expect(reachable(GATE_ENTRY_OUTSIDE, GATE_EXIT_OUTSIDE)).toBe(false);
  });

  it('výdavky na cesty, 6 modulov a 3 vozidlá sú pod štartovou hotovosťou', () => {
    const spend =
      45 * ROAD_COST +
      placements.reduce((sum, { defId }) => sum + DEFS.modules.get(defId).costCents, 0) +
      STRADDLES.length * DEFS.vehicles.get('straddle_carrier').purchaseCents;
    expect(spend).toBeLessThan(DEFS.economy.startingCashCents);
  });

  it('defy, na ktoré sa testy odvolávajú: brána processTicks 18, plocha 6 bays, rampa 2 docks × 2 staging, 6 tickov na jednotku, kamión kapacita 1', () => {
    expect(PROCESS_TICKS).toBe(18);
    expect(BAYS).toBe(6);
    expect(RAMP_PARAMS).toMatchObject({ docks: 2, stagingPerDock: 4, loadTicksPerUnit: 6, category: 'container' });
    expect(DEFS.trucks.get('truck_container').capacityUnits).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Prevádzkovosť rampy (rozhodnutie orchestrátora 1)
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady o API (T04-02):
 *  A1 `World.isRampOperational(ramp)` a `LoadingRamp.operational` / `inoperativeReason` sú zhodné;
 *  A2 rampa je prevádzková, keď existuje cesta portál → vstupná strana brány a výstupná strana brány → plocha → konektor
 *     rampy; brána a plocha sú priechody (telom sa prechádza abstraktne), bez nich cesta nevedie;
 *  A3 `inoperativeReason`: bez brány `no_gate`, s bránou bez plochy `no_waiting_area`, rampa bez cesty k svojim konektorom
 *     `not_connected`; prevádzková rampa má `null`;
 *  A4 `TruckGate.entrySide` je konektor dosiahnuteľný z portálu bez prechodu bránou (tu `w` na (45, 33)), `exitSide` druhý;
 *  A5 stavba je povolená v ľubovoľnom poradí (`PlaceModule.validate` ok), neprevádzková je len rampa.
 */
describe('prevádzkovosť rampy: bez brány (alebo bez cesty k bráne) je rampa neplatná', () => {
  const build = (landside: readonly LandsideKind[], omitRoadCells?: readonly { x: number; y: number }[]): World =>
    builtWorld(f4Scenario('f4_operational', 4204, { landside, omitRoadCells }));

  it('bez brány: rampa aj plocha stoja, ale isRampOperational === false a dôvod je no_gate', () => {
    const world = build(['waiting_area', 'ramp']);
    const ramp = rampOf(world);
    expect(isRampOperational(world, ramp)).toBe(false);
    expect(ramp.operational).toBe(false);
    expect(ramp.inoperativeReason).toBe('no_gate');
  });

  it('s bránou, ale bez čakacej plochy: neprevádzková, dôvod no_waiting_area', () => {
    const world = build(['gate', 'ramp']);
    const ramp = rampOf(world);
    expect(isRampOperational(world, ramp)).toBe(false);
    expect(ramp.operational).toBe(false);
    expect(ramp.inoperativeReason).toBe('no_waiting_area');
  });

  it('brána aj plocha, ale rampa nemá cestu k svojim konektorom: neprevádzková, dôvod not_connected', () => {
    const world = build(['gate', 'waiting_area', 'ramp'], RAMP_OUTSIDE_CELLS);
    const ramp = rampOf(world);
    for (const cell of RAMP_OUTSIDE_CELLS) expect(world.grid.at(cell.x, cell.y).road).toBe('none');
    expect(isRampOperational(world, ramp)).toBe(false);
    expect(ramp.inoperativeReason).toBe('not_connected');
  });

  it('brána bez cesty k portálu (chýba vstupná cesta (44, 33)): rampa je neprevádzková a má dôvod', () => {
    const world = build(['gate', 'waiting_area', 'ramp'], [GATE_ENTRY_OUTSIDE]);
    const ramp = rampOf(world);
    expect(world.grid.at(GATE_ENTRY_OUTSIDE.x, GATE_ENTRY_OUTSIDE.y).road).toBe('none');
    expect(isRampOperational(world, ramp)).toBe(false);
    expect(ramp.operational).toBe(false);
    expect(ramp.inoperativeReason).not.toBeNull();
  });

  it('kompletné rozloženie: rampa je prevádzková a nemá dôvod neprevádzkovosti', () => {
    const world = build(['gate', 'waiting_area', 'ramp']);
    const ramp = rampOf(world);
    expect(isRampOperational(world, ramp)).toBe(true);
    expect(ramp.operational).toBe(true);
    expect(ramp.inoperativeReason).toBeNull();
  });

  it('API modulov: brána mala vstup na (45, 33) west a výstup na (46, 33) east; parametre z defov; plocha 6 bays; rampa 2 docky', () => {
    const world = build(['gate', 'waiting_area', 'ramp']);
    const gate = gateOf(world);
    expect(gate.entrySide).toMatchObject({ x: 45, y: 33, side: 'w' });
    expect(gate.exitSide).toMatchObject({ x: 46, y: 33, side: 'e' });
    expect(gate.params.processTicks).toBe(PROCESS_TICKS);
    expect(gate.queueLength).toBe(0);
    expect(gate.busyTicksLeft).toBe(0);
    expect(gate.trucksProcessed).toBe(0);

    const area = waitingAreaOf(world);
    expect(area.bays).toBe(BAYS);
    expect([area.occupiedBays, area.reservedBays]).toEqual([0, 0]);

    const ramp = rampOf(world);
    expect(ramp.docks).toBe(RAMP_PARAMS.docks);
    for (let dock = 0; dock < ramp.docks; dock++) expect([ramp.stagedAt(dock), ramp.reservedAt(dock)], `dock ${String(dock)}`).toEqual([0, 0]);
  });

  it.each(permutations<LandsideKind>(['gate', 'waiting_area', 'ramp']).map((order) => ({ name: order.join(' → '), order })))(
    'poradie stavby $name: každý PlaceModule prejde a rampa je prevádzková práve vtedy, keď stoja brána aj plocha aj rampa',
    ({ order }) => {
      const world = worldWithRoads(f4Scenario('f4_order', 4204, { landside: [] }));
      const placed: LandsideKind[] = [];
      for (const kind of order) {
        const command = commandFromJSON(placeLandsideCommand(kind));
        const validation = command.validate(world);
        expect(validation.reasons, `PlaceModule ${kind}`).toEqual([]);
        world.enqueue(command);
        const rejected = world.tick().filter((event) => event.type === 'CommandRejected');
        expect(rejected, `PlaceModule ${kind}`).toEqual([]);
        placed.push(kind);

        if (placed.includes('ramp')) {
          const ramp = rampOf(world);
          const complete = placed.length === 3;
          expect(isRampOperational(world, ramp), `po ${placed.join(' → ')}`).toBe(complete);
          expect(ramp.operational, `po ${placed.join(' → ')}`).toBe(complete);
        }
      }
    },
  );

  it('RampOperationalChanged: po dostavaní brány príde práve jedna udalosť operational true (reason null); odstránenie brány vráti false / no_gate', () => {
    const world = worldWithRoads(f4Scenario('f4_operational_events', 4204, { landside: [] }));
    const events: SimEvent[] = [];
    const wrap = (list: readonly SimEvent[]) => list.map((event) => ({ tick: 0, hour: 0, event }));
    const send = (kind: LandsideKind): void => {
      world.enqueue(commandFromJSON(placeLandsideCommand(kind)));
      events.push(...world.tick());
    };
    send('waiting_area');
    send('ramp');
    const rampId = rampOf(world).id;
    const beforeGate = events.length;
    send('gate');

    const changes = landsideEvents(wrap(events), 'RampOperationalChanged');
    const operational = changes.filter((entry) => entry.event.operational);
    expect(operational).toHaveLength(1);
    expect(operational[0].event).toMatchObject({ rampId, operational: true });
    expect(operational[0].event.reason ?? null).toBeNull();
    // Udalosť prišla v tickoch po dostavaní brány (nie skôr) a rampa je od vtedy prevádzková.
    expect(landsideEvents(wrap(events.slice(0, beforeGate)), 'RampOperationalChanged').filter((entry) => entry.event.operational)).toEqual([]);
    expect(isRampOperational(world, rampOf(world))).toBe(true);

    const gateId = gateOf(world).id;
    world.enqueue(commandFromJSON({ type: 'RemoveModule', moduleId: gateId }));
    const removal = world.tick();
    expect(removal.filter((event) => event.type === 'CommandRejected')).toEqual([]);
    const removed = landsideEvents(wrap(removal), 'RampOperationalChanged');
    expect(removed).toHaveLength(1);
    expect(removed[0].event).toMatchObject({ rampId, operational: false, reason: 'no_gate' });
    expect(isRampOperational(world, rampOf(world))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Neprevádzková rampa počas behu: náklad zostáva v sklade, po dostavaní brány sa vyvezie
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady o API (T04-03, T04-04):
 *  B1 outbound job = `in_storage → at_ramp` (`JobCreated.toModuleId` = id rampy, `fromModuleId` = sklad); vzniká len pri
 *     prevádzkovej rampe s voľným staging slotom;
 *  B2 kamión sa spawnuje (`TruckSpawned { truckId, rampId, dock }`) na dock s pripraveným nákladom, len ak je rampa
 *     prevádzková a plocha má voľný bay;
 *  B3 `RampOperationalChanged { rampId, operational, reason }` sa emituje v ticku zmeny prevádzkovosti (na true s `reason`
 *     null alebo bez neho).
 */
describe('neprevádzková rampa počas behu: 12 TEU v sklade čaká na bránu, potom odídu všetky kamiónmi', () => {
  let run: LateGateRun;

  beforeAll(() => {
    run = runLateGate({ units: 12 });
  }, RUN_TIMEOUT_MS);

  const events = (): LateGateRun['recorder']['events'] => run.recorder.events;
  const outboundJobs = () => timed4(events(), 'JobCreated').filter((entry) => entry.event.toModuleId === run.rampId);

  it('jednotky sa najprv uložia do skladu (12), ledger pri tom bežal po každom ticku', () => {
    expect(run.storedAtTick).toBeGreaterThan(0);
    expect(run.recorder.ticksChecked).toBe(run.world.clock.tick);
    expect(timed4(events(), 'CommandRejected')).toEqual([]);
  });

  it('kým brána nestojí, nevznikne outbound job, kamión ani NoWaitingBay; na rampe nie je staged ani reserved žiadna jednotka', () => {
    const until = run.gateSentAtTick;
    expect(outboundJobs().filter((entry) => entry.tick <= until)).toEqual([]);
    expect(landsideEvents(events(), 'TruckSpawned').filter((entry) => entry.tick <= until)).toEqual([]);
    expect(landsideEvents(events(), 'NoWaitingBay').filter((entry) => entry.tick <= until)).toEqual([]);
    expect(landsideEvents(events(), 'RampOperationalChanged').filter((entry) => entry.tick <= until && entry.event.operational)).toEqual([]);
    for (const sample of run.recorder.ramps.filter((entry) => entry.tick <= until)) {
      expect(sample.operational, `tick ${String(sample.tick)}`).toBe(false);
      expect(sample.staged.every((count) => count === 0), `tick ${String(sample.tick)} staged`).toBe(true);
      expect(sample.reserved.every((count) => count === 0), `tick ${String(sample.tick)} reserved`).toBe(true);
    }
    expect([...run.recorder.trucks.values()].flat().filter((sample) => sample.tick <= until)).toEqual([]);
  });

  it('po postavení brány príde práve jedna RampOperationalChanged (operational true) v najbližších dvoch tickoch', () => {
    const changes = landsideEvents(events(), 'RampOperationalChanged').filter((entry) => entry.event.rampId === run.rampId);
    const turnedOn = changes.filter((entry) => entry.event.operational);
    expect(turnedOn).toHaveLength(1);
    expect(turnedOn[0].tick).toBeGreaterThan(run.gateSentAtTick);
    expect(turnedOn[0].tick).toBeLessThanOrEqual(run.gateSentAtTick + 2);
    expect(turnedOn[0].event.reason ?? null).toBeNull();
    const placed = timed4(events(), 'ModulePlaced').filter((entry) => entry.event.defId === 'truck_gate');
    expect(placed).toHaveLength(1);
    expect(Math.abs(turnedOn[0].tick - placed[0].tick)).toBeLessThanOrEqual(1);
  });

  it('outbound joby (sklad → rampa) vzniknú až po zprevádzkovení a pre každú jednotku práve jeden; kamióny sa spawnujú až potom', () => {
    const turnedOnTick = landsideEvents(events(), 'RampOperationalChanged').find((entry) => entry.event.operational)?.tick ?? Infinity;
    const jobs = outboundJobs();
    expect(jobs).toHaveLength(run.units);
    for (const job of jobs) expect(job.tick, `job ${String(job.event.jobId)}`).toBeGreaterThanOrEqual(turnedOnTick);
    const units = jobs.flatMap((job) => job.event.unitIds);
    expect(new Set(units).size).toBe(run.units);
    const spawned = landsideEvents(events(), 'TruckSpawned');
    expect(spawned).toHaveLength(run.units);
    for (const spawn of spawned) expect(spawn.tick).toBeGreaterThanOrEqual(turnedOnTick);
  });

  it('všetkých 12 jednotiek je nakoniec exported, nič sa nestratilo, svet je prázdny (žiadne kamióny, joby ani staging)', () => {
    const { cargo } = run.world;
    expect(cargo.exportedCount).toBe(run.units);
    expect(cargo.createdCount).toBe(run.units);
    expect(cargo.liveCount).toBe(0);
    expect(cargo.createdCount - cargo.liveCount - cargo.exportedCount).toBe(0);
    expect(trucksOf(run.world).size).toBe(0);
    const ramp = rampOf(run.world);
    for (let dock = 0; dock < ramp.docks; dock++) expect([ramp.stagedAt(dock), ramp.reservedAt(dock)]).toEqual([0, 0]);
    expect(ramp.operational).toBe(true);
  });

  it('fyzika a stavy kamiónov držali po každom ticku (poloha, fronta, náklad, odkazy, stojisko)', () => {
    for (const rule of ['truck_position', 'truck_queue_position', 'truck_cargo', 'truck_refs', 'bay_accounting', 'dock_conflict', 'gate_queue'] as const) {
      expect(run.recorder.violationsOf(rule), rule).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Stojisko: kamión sa nespawnuje bez voľného bay
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady o API (T04-04, rozhodnutie orchestrátora 3 a 5):
 *  C1 kamión si pri spawne rezervuje bay čakacej plochy a drží ho v stavoch `to_gate`, `gate_queue`, `to_bay`, `waiting`;
 *     bay uvoľní, keď odíde k rampe (`waiting → to_dock`);
 *  C2 bez voľného bay sa kamión nespawnuje a vznikne `NoWaitingBay { rampId }`, najviac 1× za hernú hodinu;
 *  C3 `WaitingArea.occupiedBays + reservedBays` ≥ počet kamiónov, ktoré bay držia, a ≤ `bays`.
 */
describe('stojisko: pri plných bays (syntetické bays 1) sa ďalší kamión nespawnuje a vznikne NoWaitingBay (≤ 1×/h)', () => {
  let run: LateGateRun;

  beforeAll(() => {
    run = runLateGate({ defs: defsWithBays(1), units: 12 });
  }, RUN_TIMEOUT_MS);

  it('defy majú bays 1', () => {
    expect(waitingAreaOf(run.world).bays).toBe(1);
  });

  it('NoWaitingBay vznikne aspoň raz (obidva docky majú pripravený náklad, bay je jeden) a pre rampu najviac 1× za hernú hodinu', () => {
    const noBay = landsideEvents(run.recorder.events, 'NoWaitingBay');
    expect(noBay.length).toBeGreaterThanOrEqual(1);
    for (const entry of noBay) expect(entry.event.rampId).toBe(run.rampId);
    expect(maxNoWaitingBayPerRampHour(run.recorder.events)).toBeLessThanOrEqual(1);
  });

  it('NoWaitingBay sa emituje len keď bay naozaj drží kamión', () => {
    const areaSamples = run.recorder.areas;
    for (const entry of landsideEvents(run.recorder.events, 'NoWaitingBay')) {
      const holding = areaSamples.filter((sample) => sample.tick === entry.tick || sample.tick === entry.tick - 1).map((sample) => sample.holding);
      expect(Math.max(...holding), `tick ${String(entry.tick)}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('po celý beh drží stojisko najviac 1 kamión (spawn len s voľným bay) a účtovanie bays sedí', () => {
    expect(Math.max(...run.recorder.areas.map((sample) => sample.holding))).toBe(1);
    expect(Math.max(...run.recorder.areas.map((sample) => sample.occupiedBays + sample.reservedBays))).toBeLessThanOrEqual(1);
    expect(run.recorder.violationsOf('bay_accounting')).toEqual([]);
  });

  it('nasledujúci kamión sa spawne až po tom, čo predošlý odíde zo stojiska k rampe (waiting → to_dock)', () => {
    const spawned = landsideEvents(run.recorder.events, 'TruckSpawned');
    expect(spawned).toHaveLength(run.units);
    const releasedAt = new Map<number, number>();
    for (const entry of landsideEvents(run.recorder.events, 'TruckStateChanged')) {
      if (entry.event.from === 'waiting' && entry.event.to === 'to_dock') releasedAt.set(entry.event.truckId, entry.tick);
    }
    for (let i = 1; i < spawned.length; i++) {
      const previousRelease = releasedAt.get(spawned[i - 1].event.truckId);
      expect(previousRelease, `kamión ${String(spawned[i - 1].event.truckId)} nikdy neopustil stojisko`).toBeDefined();
      expect(spawned[i].tick, `spawn #${String(i + 1)}`).toBeGreaterThanOrEqual(must(previousRelease, 'uvoľnenie bay'));
    }
  });

  it('zablokovaný bay nezablokuje systém: všetkých 12 jednotiek sa nakoniec exportuje, žiadna sa nestratí', () => {
    const { cargo } = run.world;
    expect(cargo.exportedCount).toBe(run.units);
    expect(cargo.createdCount - cargo.liveCount - cargo.exportedCount).toBe(0);
    expect(trucksOf(run.world).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Brána: najviac 1 kamión za processTicks
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady o API (T04-04, rozhodnutie orchestrátora 2):
 *  D1 brána má spoločnú FIFO frontu pre oba smery; kamión čaká v `gate_queue` (dnu) alebo `gate_queue_out` (von) na
 *     vonkajšej bunke príslušného konektora a po spracovaní prejde do `to_bay` resp. `to_portal`;
 *  D2 medzi dvoma po sebe idúcimi prechodmi (`TruckStateChanged` z `gate_queue` / `gate_queue_out`) je ≥ `processTicks`;
 *  D3 `TruckGate.queueLength` obsahuje len kamióny v `gate_queue*`, `trucksProcessed` počíta prechody v oboch smeroch.
 * Syntetická brána s `processTicks` 100 vynúti, aby sa kamióny pred bránou naozaj hromadili.
 */
describe('brána: pustí najviac 1 kamión za processTicks (spoločná FIFO fronta oboch smerov)', () => {
  const SLOW = 100;
  let run: LateGateRun;

  beforeAll(() => {
    run = runLateGate({ defs: defsWithProcessTicks(SLOW), units: 12 });
  }, RUN_TIMEOUT_MS);

  it('brána má processTicks 100', () => {
    expect(gateOf(run.world).params.processTicks).toBe(SLOW);
  });

  it('test skutočne zaťažil bránu: aspoň 2 kamióny naraz čakali vo fronte (gate_queue / gate_queue_out)', () => {
    expect(run.recorder.maxTrucksQueued).toBeGreaterThanOrEqual(2);
    expect(Math.max(...run.recorder.gates.map((sample) => sample.queueLength))).toBeGreaterThanOrEqual(1);
  });

  it('medzi dvoma po sebe idúcimi prechodmi bránou je ≥ processTicks tickov (oba smery dokopy)', () => {
    const crossings = gateCrossingTicks(run.recorder.events);
    expect(crossings).toHaveLength(2 * run.units);
    expect(minGap(crossings)).toBeGreaterThanOrEqual(SLOW);
  });

  it('v žiadnom okne dĺžky processTicks neprejdú bránou dva kamióny', () => {
    const crossings = gateCrossingTicks(run.recorder.events);
    for (let i = 0; i < crossings.length; i++) {
      const inWindow = crossings.filter((tick) => tick >= crossings[i] && tick < crossings[i] + SLOW);
      expect(inWindow.length, `okno od ticku ${String(crossings[i])}`).toBe(1);
    }
  });

  it('fronta je FIFO: kamióny opúšťajú frontu v poradí, v akom do nej vstúpili (oba smery spolu)', () => {
    const transitions = landsideEvents(run.recorder.events, 'TruckStateChanged');
    const isQueue = (state: string): boolean => state === 'gate_queue' || state === 'gate_queue_out';
    const entered = transitions.filter((entry) => isQueue(entry.event.to)).map((entry) => `${String(entry.event.truckId)}:${entry.event.to}`);
    const left = transitions.filter((entry) => isQueue(entry.event.from)).map((entry) => `${String(entry.event.truckId)}:${entry.event.from}`);
    expect(left).toEqual(entered);
  });

  it('trucksProcessed = 24 (12 kamiónov × dva prechody), queueLength na konci 0; čakajúci kamión stojí na vonkajšej bunke konektora', () => {
    const gate = gateOf(run.world);
    expect(gate.trucksProcessed).toBe(2 * run.units);
    expect(gate.queueLength).toBe(0);
    expect(gate.busyTicksLeft).toBe(0);
    expect(run.recorder.violationsOf('truck_queue_position')).toEqual([]);
    expect(run.recorder.violationsOf('gate_queue')).toEqual([]);
  });

  it('všetkých 12 jednotiek sa aj tak exportuje (úzke hrdlo spomalí, nezablokuje)', () => {
    expect(run.world.cargo.exportedCount).toBe(run.units);
    expect(run.world.cargo.createdCount - run.world.cargo.liveCount - run.world.cargo.exportedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Odstraňovanie modulov, ktoré používa kamión
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady o API (T04-02, T04-04): `RemoveModule` brány, plochy alebo rampy, ktorú používa kamión, vráti
 * `has_trucks`; rampa s nákladom na docku alebo rezerváciou `has_cargo` (ARCHITECTURE §8 bod 8).
 */
describe('RemoveModule pozemných modulov: kamión alebo náklad na rampe bráni odstráneniu', () => {
  const scenario = f4Scenario('f4_remove', 4304, { vehicles: STRADDLES, units: 12 });
  let world: World;
  let recorder: Recorder4;

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    recorder = new Recorder4(world, scenario);
    recorder.runUntil((w) => trucksOf(w).size > 0, 20000);
  }, RUN_TIMEOUT_MS);

  const removal = (moduleId: number) => commandFromJSON({ type: 'RemoveModule', moduleId }).validate(world);
  const reasonsInclude = (reasons: readonly ValidationReason[], ...expected: string[]): boolean => expected.some((reason) => (reasons as readonly string[]).includes(reason));

  it('kamión existuje a odkazuje na bránu, plochu aj rampu', () => {
    const [truck] = [...trucksOf(world).values()];
    expect(truck.gateId).toBe(gateOf(world).id);
    expect(truck.waitingAreaId).toBe(waitingAreaOf(world).id);
    expect(truck.rampId).toBe(rampOf(world).id);
  });

  it('brána, ktorú kamión používa, sa nedá odstrániť: has_trucks', () => {
    const result = removal(gateOf(world).id);
    expect(result.ok).toBe(false);
    expect(reasonsInclude(result.reasons, 'has_trucks')).toBe(true);
  });

  it('čakacia plocha, ktorú kamión používa, sa nedá odstrániť: has_trucks', () => {
    const result = removal(waitingAreaOf(world).id);
    expect(result.ok).toBe(false);
    expect(reasonsInclude(result.reasons, 'has_trucks')).toBe(true);
  });

  it('rampa, na ktorú kamión smeruje (alebo ktorá drží náklad), sa nedá odstrániť: has_trucks alebo has_cargo', () => {
    const result = removal(rampOf(world).id);
    expect(result.ok).toBe(false);
    expect(reasonsInclude(result.reasons, 'has_trucks', 'has_cargo')).toBe(true);
  });

  it('po vyvezení všetkých jednotiek (žiadny kamión, náklad ani rezervácia) sa brána, plocha aj rampa dajú odstrániť', () => {
    recorder.runUntil((w) => w.cargo.exportedCount === 12, 30000);
    expect(trucksOf(world).size).toBe(0);
    for (const id of [gateOf(world).id, waitingAreaOf(world).id, rampOf(world).id]) {
      const result = removal(id);
      expect(result.reasons, `modul ${String(id)}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  }, RUN_TIMEOUT_MS);
});
