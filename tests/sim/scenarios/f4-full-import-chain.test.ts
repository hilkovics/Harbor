/**
 * Scenár `full_import_chain` (T04-05, TDD): feeder so 120 TEU zakotví na Root berthe, Root žeriav ich vyloží na apron,
 * tri vozidlá `straddle_carrier` ich prevezú do dvorov a odtiaľ na rampu, kamióny prídu portálom cez bránu do čakacej
 * plochy, nakladú sa na dockoch rampy a odídu bránou a portálom z mapy — `in_truck → exported`. Testy idú výlučne cez
 * verejné API a JSON príkazy (`PlaceRoad`, `PlaceModule`, `BuyVehicle`, `SpawnShipDebug`) proti rozhraniu z
 * `docs/tasks/phase-04.md` („Akceptácia fázy", „Rozhodnutia orchestrátora", „Spoločné rozhrania"). Časové hranice sú
 * horné alebo ±1 tick, kontrolujú sa stavy FSM, polohy a reťaz pohybov, nie konkrétne ticky.
 *
 * Rozloženie: `helpers/f4-layout.ts` (F3 cesty, depo 3, dvory 4 a 5, brána 6, plocha 7, rampa 8). Po každom ticku beží
 * `assertCargoConservation(world)` + nezávislý audit ledgera a jobov (`Recorder4`), takže porušenie konzervácie zhodí beh
 * hneď v ticku, v ktorom vznikne.
 *
 * Predpoklady o API sú vypísané v hlavičkách `describe` a v odovzdávacej správe karty.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CargoError } from '@sim/cargo';
import { commandFromJSON, refundCents } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { gateParams, rampParams } from '@sim/defs';
import type { StorageModule } from '@sim/modules';
import { WORLD_STATE_VERSION, World, type WorldState } from '@sim/world';
import { ALL_F4_ROAD_CELLS, F4_DEPOT_ID, f4Scenario } from '../helpers/f4-layout';
import { SLACK_TICKS, storageModulesOf, vehicleFsmViolation } from '../helpers/f3';
import {
  Recorder4,
  STRADDLES,
  TRUCK_CYCLE,
  distanceToExitPortal,
  distanceToPortal,
  exportChainViolation,
  gateCrossingTicks,
  gateOf,
  landsideEvents,
  minGap,
  moveChains,
  rampOf,
  timed4,
  trucksById,
  trucksOf,
  truckFsmViolation,
  truckStateChains,
  type Rule4,
} from '../helpers/f4';
import { must } from '../helpers/harbor';
import { PORT_BRIDGE, loadScenarioFile, readRepoJson, stateHash, withPortBridge } from '../helpers/scenario';
import { DEFS, MAP, PORT_MAP, hashState } from '../world/world-fixtures';

const UNITS = 120;
/** Akceptácia fázy: všetky jednotky `exported` do 40 000 tickov. */
const MAX_TICKS = 40_000;
/** Po dosiahnutí exportu sa beh ešte predĺži; nič sa už nesmie pohnúť. */
const SETTLE_TICKS = 500;
/** Timeout hooku: 40 000 tickov s auditom po každom ticku. */
const RUN_TIMEOUT_MS = 300_000;

const scenario = loadScenarioFile('full_import_chain');
const KINDS = DEFS.infrastructure.roadKinds;
/**
 * Čistá cena napojenia na jednosmernú slučku (`PORT_BRIDGE`): prestavba 3 buniek jednosmerka → dvojpruhová (stavba − refundácia starých
 * jednosmeriek) a odstránenie 2 jednosmeriek (refundácia), refundácia raz za príkaz.
 */
const PORT_BRIDGE_NET_CENTS =
  3 * KINDS.two_lane.costPerCellCents -
  refundCents(3 * KINDS.one_way.costPerCellCents, DEFS.economy.removalRefundRate) -
  refundCents(2 * KINDS.one_way.costPerCellCents, DEFS.economy.removalRefundRate);
const ROAD_COST = DEFS.infrastructure.road.costPerCellCents;
const STRADDLE = DEFS.vehicles.get('straddle_carrier');
const TRUCK = DEFS.trucks.get('truck_container');
const PROCESS_TICKS = gateParams(DEFS.modules.get('truck_gate')).processTicks;
const RAMP_PARAMS = rampParams(DEFS.modules.get('loading_ramp_container'));

const ALL_RULES: readonly Rule4[] = ['truck_position', 'truck_queue_position', 'truck_cargo', 'truck_refs', 'bay_accounting', 'dock_conflict', 'gate_queue'];

// ---------------------------------------------------------------------------------------------------------
// Scenár ako dáta
// ---------------------------------------------------------------------------------------------------------

describe('scenár full_import_chain: súbor', () => {
  it('má očakávaný tvar { id, seed, map, commands } a seed 4004', () => {
    expect(Object.keys(scenario).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect(scenario.id).toBe('full_import_chain');
    expect(scenario.seed).toBe(4004);
    expect(scenario.map).toBe('data/maps/harbor_01.json');
    expect((readRepoJson(scenario.map) as { id: string }).id).toBe(PORT_MAP.id);
  });

  it('je zhodný s rozložením z helpers/f4-layout (F3 + brána, plocha, rampa; 3× straddle_carrier, feeder 120 TEU)', () => {
    expect(scenario).toEqual(withPortBridge(f4Scenario('full_import_chain', 4004, { vehicles: STRADDLES, units: UNITS })));
  });

  it('všetky príkazy idú na tick 0 v poradí: 10 úsekov ciest, 6 modulov, 3 nákupy vozidiel, loď, napojenie na jednosmernú slučku (PlaceRoad + RemoveRoad)', () => {
    expect(scenario.commands.every((entry) => entry.atTick === 0)).toBe(true);
    expect(scenario.commands.map((entry) => entry.command.type)).toEqual([
      ...Array<string>(10).fill('PlaceRoad'),
      ...Array<string>(6).fill('PlaceModule'),
      ...Array<string>(3).fill('BuyVehicle'),
      'SpawnShipDebug',
      'PlaceRoad',
      'RemoveRoad',
    ]);
    const modules = scenario.commands.filter((entry) => entry.command.type === 'PlaceModule').map((entry) => entry.command['defId']);
    expect(modules).toEqual(['vehicle_depot', 'container_yard_small', 'container_yard_small', 'truck_gate', 'truck_waiting_area', 'loading_ramp_container']);
    const roadCells = scenario.commands.filter((entry) => entry.command.type === 'PlaceRoad').slice(0, 10).flatMap((entry) => entry.command['cells'] as unknown[]);
    expect(roadCells).toHaveLength(ALL_F4_ROAD_CELLS.length);
  });

  it('BuyVehicle odkazuje na depo s id 3 (starter berth 1 + žeriav 2, depo je prvý PlaceModule) a kupuje straddle_carrier', () => {
    const buys = scenario.commands.filter((entry) => entry.command.type === 'BuyVehicle').map((entry) => entry.command);
    expect(buys).toEqual(STRADDLES.map((vehicleDefId) => ({ type: 'BuyVehicle', vehicleDefId, depotId: F4_DEPOT_ID })));
    expect(F4_DEPOT_ID).toBe(3);
  });

  it('SpawnShipDebug feeder container_teu 120 (celá kapacita feedera)', () => {
    const spawn = scenario.commands.find((entry) => entry.command.type === 'SpawnShipDebug')?.command;
    expect(spawn).toEqual({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: UNITS });
    expect(DEFS.ships.get('feeder').capacityUnits).toBe(UNITS);
  });

  it('každý príkaz prežije commandFromJSON → toJSON bez zmeny', () => {
    for (const { command } of scenario.commands) expect(commandFromJSON(command).toJSON()).toEqual(command);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Beh scenára: 120 TEU až po export
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady o API (rozhranie z karty, najjednoduchší výklad):
 *  E1 `world.trucks` je mapa podľa id; `Truck` má `state`, `x`, `y` (stred bunky = x + 0,5), `rampId`, `dock`,
 *     `waitingAreaId`, `gateId`, `def`; kamión existuje od `TruckSpawned` po `TruckExited` a potom zmizne z `world.trucks`;
 *  E2 kamión sa spawnuje na road portáli (44, 63) v stave `to_gate`, do fronty brány sa zaradí na vonkajšej bunke jej
 *     vstupného konektora (`gate_queue`), po spracovaní ide `to_bay` → `waiting` → `to_dock` → `loading` → `to_gate_out`
 *     → `gate_queue_out` (výstupná vonkajšia bunka) → `to_portal` → z mapy;
 *  E3 `loading` trvá `loadTicksPerUnit × units`; `at_ramp → in_truck` po jednotke; pri výjazde z portálu `in_truck →
 *     exported` a `TruckExited { truckId, units }` v tom istom ticku;
 *  E4 každý prechod bránou (oba smery) prejde spoločnou frontou, medzi dvoma je ≥ `processTicks` (18) tickov;
 *  E5 outbound job = `in_storage → in_vehicle → at_ramp` (`JobCreated.toModuleId` = rampa); po ňom inbound;
 *  E6 dvory evidujú `unitsIn` aj `unitsOut` (`recordTaken`), rampa `stagedAt(dock)` / `reservedAt(dock)`.
 */
describe('scenár full_import_chain: beh 120 TEU až po export', () => {
  let world: World;
  let recorder: Recorder4;
  let exportedAt: number;
  let rampId: EntityId;

  beforeAll(() => {
    world = World.create(DEFS, PORT_MAP, scenario.seed);
    recorder = new Recorder4(world, scenario);
    recorder.runTo(MAX_TICKS, (w) => w.cargo.exportedCount === UNITS);
    exportedAt = world.clock.tick;
    recorder.runTo(exportedAt + SETTLE_TICKS);
    rampId = rampOf(world).id;
  }, RUN_TIMEOUT_MS);

  const events = () => recorder.events;
  const moves = () => timed4(events(), 'CargoMoved');

  it('všetkých 120 jednotiek je exported do 40 000 tickov; nič nie je na lodi, v žeriave, na aprone, vo vozidle, v sklade, na rampe ani v kamióne', () => {
    const { cargo } = world;
    expect(exportedAt).toBeLessThanOrEqual(MAX_TICKS);
    expect(cargo.exportedCount).toBe(UNITS);
    expect(cargo.createdCount).toBe(UNITS);
    expect(cargo.liveCount).toBe(0);
    for (const kind of ['on_ship', 'in_crane', 'on_apron', 'in_vehicle', 'in_storage', 'at_ramp', 'in_truck', 'in_pipeline', 'in_train'] as const) {
      expect(cargo.countByKind(kind), kind).toBe(0);
    }
    expect(cargo.countByKind('exported')).toBe(UNITS);
  });

  it('konzervácia platila po každom ticku (assertCargoConservation + audit ledgera a jobov) a lostUnits = 0', () => {
    expect(recorder.ticksChecked).toBe(world.clock.tick);
    expect(world.clock.tick).toBe(exportedAt + SETTLE_TICKS);
    expect(() => world.cargo.assertConservation()).not.toThrow();
    expect(() => world.assertInvariants()).not.toThrow();
    expect(world.cargo.createdCount - world.cargo.liveCount - world.cargo.exportedCount).toBe(0);
  });

  it('žiadny príkaz nebol odmietnutý (cesty, moduly, nákupy aj loď prešli validáciou)', () => {
    expect(timed4(events(), 'CommandRejected')).toEqual([]);
  });

  it('stavba: brána, plocha a rampa s id 6, 7, 8; ModulePlaced v poradí depo, 2 dvory, brána, plocha, rampa', () => {
    expect(timed4(events(), 'ModulePlaced').map((entry) => entry.event.defId)).toEqual([
      'vehicle_depot',
      'container_yard_small',
      'container_yard_small',
      'truck_gate',
      'truck_waiting_area',
      'loading_ramp_container',
    ]);
    expect([gateOf(world).id, rampOf(world).id]).toEqual([6, 8]);
    expect([...world.modules.values()].filter((module) => module.kind === 'waiting_area').map((module) => module.id)).toEqual([7]);
  });

  it('výdavky ticku príkazov = 45 buniek ciest + 6 modulov + 3 vozidlá a rampa je od začiatku prevádzková', () => {
    const spend =
      45 * ROAD_COST +
      ['vehicle_depot', 'container_yard_small', 'container_yard_small', 'truck_gate', 'truck_waiting_area', 'loading_ramp_container'].reduce(
        (sum, defId) => sum + DEFS.modules.get(defId).costCents,
        0,
      ) +
      STRADDLES.length * STRADDLE.purchaseCents +
      PORT_BRIDGE_NET_CENTS;
    const first = timed4(events(), 'MoneyChanged').filter((entry) => entry.tick <= 1);
    expect(first.reduce((sum, entry) => sum + entry.event.deltaCents, 0)).toBe(0 - spend);
    expect(Number.isSafeInteger(world.cashCents)).toBe(true);
    for (const sample of recorder.ramps) expect(sample.operational, `tick ${String(sample.tick)}`).toBe(true);
  });

  it('reťaz pohybov každej z 120 jednotiek je presne on_ship → in_crane → on_apron → in_vehicle → in_storage → in_vehicle → at_ramp → in_truck → exported', () => {
    const chains = moveChains(events());
    expect(chains.size).toBe(UNITS);
    for (const [unitId, chain] of chains) {
      expect(chain, `jednotka ${String(unitId)}`).toHaveLength(8);
      expect(exportChainViolation(unitId, chain)).toBeNull();
    }
  });

  it('držitelia v reťazi: at_ramp je na našej rampe a docku v rozsahu, in_truck je kamión z TruckSpawned, in_vehicle kúpené vozidlo', () => {
    const vehicleIds = timed4(events(), 'VehicleBought').map((entry) => entry.event.vehicleId);
    const spawned = new Set(landsideEvents(events(), 'TruckSpawned').map((entry) => entry.event.truckId));
    expect(vehicleIds).toHaveLength(STRADDLES.length);
    for (const { event } of moves()) {
      if (event.to.kind === 'at_ramp') {
        expect(event.to.rampId).toBe(rampId);
        expect(event.to.dock).toBeGreaterThanOrEqual(0);
        expect(event.to.dock).toBeLessThan(RAMP_PARAMS.docks);
      }
      if (event.to.kind === 'in_truck') expect(spawned.has(event.to.truckId), `kamión ${String(event.to.truckId)}`).toBe(true);
      if (event.to.kind === 'in_vehicle') expect(vehicleIds).toContain(event.to.vehicleId);
    }
  });

  it('exported je konečný stav: nikdy sa nevyskytne CargoMoved z exported, po dosiahnutí 120 sa už nič nepohne a ledger jednotky nepozná', () => {
    expect(moves().filter((entry) => entry.event.from.kind === 'exported')).toEqual([]);
    expect(moves().filter((entry) => entry.tick > exportedAt)).toEqual([]);
    expect(landsideEvents(events(), 'TruckSpawned').filter((entry) => entry.tick > exportedAt)).toEqual([]);
    expect(timed4(events(), 'JobCreated').filter((entry) => entry.tick > exportedAt)).toEqual([]);
    const unitIds = [...moveChains(events()).keys()] as EntityId[];
    for (const unitId of unitIds) expect(world.cargo.get(unitId), `jednotka ${String(unitId)}`).toBeUndefined();
    const sample = must(unitIds[0], 'exportovaná jednotka');
    const before = stateHash(world);
    expect(() => world.cargo.move(sample, { kind: 'in_vehicle', vehicleId: 3 as EntityId })).toThrow(CargoError);
    expect(() => world.cargo.move(sample, { kind: 'exported' })).toThrow(CargoError);
    expect(stateHash(world)).toBe(before);
  });

  it('kamióny: 120 TruckSpawned a 120 TruckExited po 1 jednotke, na našu rampu a dock v rozsahu; world.trucks je na konci prázdne', () => {
    const spawned = landsideEvents(events(), 'TruckSpawned');
    const exited = landsideEvents(events(), 'TruckExited');
    expect(spawned).toHaveLength(UNITS);
    expect(exited).toHaveLength(UNITS);
    expect(new Set(spawned.map((entry) => entry.event.truckId)).size).toBe(UNITS);
    expect(new Set(exited.map((entry) => entry.event.truckId))).toEqual(new Set(spawned.map((entry) => entry.event.truckId)));
    for (const entry of spawned) {
      expect(entry.event.rampId).toBe(rampId);
      expect(entry.event.dock).toBeGreaterThanOrEqual(0);
      expect(entry.event.dock).toBeLessThan(RAMP_PARAMS.docks);
    }
    for (const entry of exited) expect(entry.event.units).toBe(TRUCK.capacityUnits);
    expect(exited.reduce((sum, entry) => sum + entry.event.units, 0)).toBe(UNITS);
    expect(trucksOf(world).size).toBe(0);
  });

  it('životný cyklus každého kamióna: to_gate → gate_queue → to_bay → waiting → to_dock → loading → to_gate_out → gate_queue_out → to_portal (bez no_path)', () => {
    expect(truckFsmViolation(events())).toBeNull();
    const chains = truckStateChains(events());
    expect(chains.size).toBe(UNITS);
    for (const [truckId, chain] of chains) {
      const withoutExit = chain.at(-1) === 'exited' ? chain.slice(0, -1) : chain;
      expect(withoutExit, `kamión ${String(truckId)}`).toEqual([...TRUCK_CYCLE]);
    }
    expect(landsideEvents(events(), 'TruckStateChanged').filter((entry) => entry.event.to === 'no_path')).toEqual([]);
  });

  it('TruckExited a export jednotky nastanú v tom istom ticku a z toho istého kamióna (in_truck → exported)', () => {
    const exportMoves = moves().filter((entry) => entry.event.to.kind === 'exported');
    expect(exportMoves).toHaveLength(UNITS);
    const exitTicks = new Map(landsideEvents(events(), 'TruckExited').map((entry) => [entry.event.truckId as number, entry.tick]));
    for (const { event, tick } of exportMoves) {
      expect(event.from.kind).toBe('in_truck');
      const truckId = event.from.kind === 'in_truck' ? event.from.truckId : -1;
      expect(exitTicks.get(truckId), `kamión ${String(truckId)}`).toBe(tick);
    }
  });

  it('nakládka trvá loadTicksPerUnit × units (±1 tick) a at_ramp → in_truck prebehne počas loading', () => {
    const changes = landsideEvents(events(), 'TruckStateChanged');
    const startedLoading = new Map<number, number>();
    const finishedLoading = new Map<number, number>();
    for (const entry of changes) {
      if (entry.event.to === 'loading') startedLoading.set(entry.event.truckId, entry.tick);
      if (entry.event.from === 'loading') finishedLoading.set(entry.event.truckId, entry.tick);
    }
    const loadMoves = moves().filter((entry) => entry.event.to.kind === 'in_truck');
    expect(loadMoves).toHaveLength(UNITS);
    for (const [truckId, start] of startedLoading) {
      const end = must(finishedLoading.get(truckId), `koniec nakládky kamióna ${String(truckId)}`);
      expect(end - start, `kamión ${String(truckId)}`).toBeGreaterThanOrEqual(RAMP_PARAMS.loadTicksPerUnit * TRUCK.capacityUnits - SLACK_TICKS);
    }
    for (const { event, tick } of loadMoves) {
      const truckId = event.to.kind === 'in_truck' ? event.to.truckId : -1;
      expect(tick).toBeGreaterThanOrEqual(must(startedLoading.get(truckId), `začiatok nakládky kamióna ${String(truckId)}`));
      expect(tick).toBeLessThanOrEqual(must(finishedLoading.get(truckId), `koniec nakládky kamióna ${String(truckId)}`));
    }
  });

  it('kamión vzniká na vjazde (44, 63) a mizne na výjazde (45, 63): prvá vzorka je najviac o krok od portálu, posledná najviac o dva', () => {
    const speed = TRUCK.speedCellsPerTick;
    expect(recorder.trucks.size).toBe(UNITS);
    for (const [truckId, samples] of recorder.trucks) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      expect(first.state, `kamión ${String(truckId)}`).toBe('to_gate');
      expect(distanceToPortal(first.x, first.y), `spawn kamióna ${String(truckId)}`).toBeLessThanOrEqual(speed + 1e-6);
      expect(distanceToExitPortal(last.x, last.y), `výjazd kamióna ${String(truckId)} (posledný stav ${last.state})`).toBeLessThanOrEqual(2 * speed + 1e-6);
      expect(['to_portal', 'exited']).toContain(last.state);
    }
  });

  it('brána: 240 prechodov (120 kamiónov × dnu aj von), medzi dvoma ≥ processTicks; trucksProcessed = 240, fronta prázdna', () => {
    const crossings = gateCrossingTicks(events());
    expect(crossings).toHaveLength(2 * UNITS);
    expect(minGap(crossings)).toBeGreaterThanOrEqual(PROCESS_TICKS);
    const gate = gateOf(world);
    expect(gate.trucksProcessed).toBe(2 * UNITS);
    expect(gate.queueLength).toBe(0);
    expect(gate.busyTicksLeft).toBe(0);
  });

  it('fyzika a stavy kamiónov držali po každom ticku (poloha na ceste, krok ≤ rýchlosť, fronta na vonkajšej bunke, náklad podľa stavu, odkazy, stojisko, dock)', () => {
    for (const rule of ALL_RULES) expect(recorder.violationsOf(rule), rule).toEqual([]);
  });

  it('joby: 120 inbound (apron → sklad) a 120 outbound (sklad → rampa), každý raz priradený a hotový; každá jednotka má práve jeden outbound job', () => {
    const created = timed4(events(), 'JobCreated');
    expect(created).toHaveLength(2 * UNITS);
    expect(timed4(events(), 'JobAssigned')).toHaveLength(2 * UNITS);
    expect(timed4(events(), 'JobDone')).toHaveLength(2 * UNITS);
    const yards = new Set(storageModulesOf(world).map((module) => module.id as number));
    const outbound = created.filter((entry) => entry.event.toModuleId === rampId);
    const inbound = created.filter((entry) => entry.event.toModuleId !== rampId);
    expect(outbound).toHaveLength(UNITS);
    expect(inbound).toHaveLength(UNITS);
    for (const entry of outbound) expect(yards.has(entry.event.fromModuleId), `outbound job ${String(entry.event.jobId)}`).toBe(true);
    for (const entry of inbound) expect(yards.has(entry.event.toModuleId), `inbound job ${String(entry.event.jobId)}`).toBe(true);
    expect(new Set(outbound.flatMap((entry) => entry.event.unitIds)).size).toBe(UNITS);
    expect(new Set(inbound.flatMap((entry) => entry.event.unitIds)).size).toBe(UNITS);
    expect(world.jobs.size).toBe(0);
  });

  it('vozidlá: FSM ide len povolenými prechodmi a na konci sú všetky zaparkované bez jobu a nákladu', () => {
    expect(vehicleFsmViolation(events())).toBeNull();
    expect(world.vehicles.size).toBe(STRADDLES.length);
    for (const vehicle of world.vehicles.values()) {
      expect(vehicle.state).toBe('parked');
      expect(vehicle.jobId).toBeNull();
      expect(world.cargo.countAt('in_vehicle', vehicle.id)).toBe(0);
    }
  });

  it('dvory: náklad prešiel cez ne (unitsIn = unitsOut = 120), na konci prázdne bez rezervácií', () => {
    const yards = storageModulesOf(world) as StorageModule[];
    expect(yards.reduce((sum, yard) => sum + yard.unitsIn, 0)).toBe(UNITS);
    expect(yards.reduce((sum, yard) => sum + yard.unitsOut, 0)).toBe(UNITS);
    for (const yard of yards) {
      expect(yard.storedCount).toBe(0);
      expect(yard.reservedCount).toBe(0);
    }
  });

  it('rampa: staging na docku nikdy nepresiahol stagingPerDock, bol využitý a na konci je prázdny bez rezervácií', () => {
    let peak = 0;
    for (const sample of recorder.ramps) {
      sample.staged.forEach((count, dock) => {
        peak = Math.max(peak, count);
        expect(count, `tick ${String(sample.tick)}, dock ${String(dock)}`).toBeLessThanOrEqual(RAMP_PARAMS.stagingPerDock);
        expect(count + sample.reserved[dock], `tick ${String(sample.tick)}, dock ${String(dock)}: staged + reserved`).toBeLessThanOrEqual(RAMP_PARAMS.stagingPerDock);
      });
    }
    expect(peak).toBeGreaterThan(0);
    const ramp = rampOf(world);
    for (let dock = 0; dock < RAMP_PARAMS.docks; dock++) expect([ramp.stagedAt(dock), ramp.reservedAt(dock)]).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Determinizmus a save/load uprostred reťazca (menší scenár: 12 TEU)
// ---------------------------------------------------------------------------------------------------------

const SMALL_UNITS = 12;
const smallScenario = f4Scenario('f4_small_chain', 4004, { vehicles: STRADDLES, units: SMALL_UNITS });
const SMALL_MAX_TICKS = 20_000;

describe('determinizmus: dva behy s rovnakým seedom a príkazmi dávajú rovnaké udalosti aj stavy', () => {
  interface Run {
    readonly world: World;
    readonly recorder: Recorder4;
    readonly hashes: string[];
  }

  function run(): Run {
    const world = World.create(DEFS, MAP, smallScenario.seed);
    const hashes: string[] = [];
    const recorder = new Recorder4(world, smallScenario, {
      onTick: (w) => {
        if (w.clock.tick % 250 === 0) hashes.push(`${String(w.clock.tick)}:${hashState(w.serialize())}`);
      },
    });
    recorder.runTo(SMALL_MAX_TICKS, (w) => w.cargo.exportedCount === SMALL_UNITS);
    return { world, recorder, hashes };
  }

  let a: Run;
  let b: Run;

  beforeAll(() => {
    a = run();
    b = run();
  }, RUN_TIMEOUT_MS);

  it('oba behy exportujú všetkých 12 jednotiek a skončia v tom istom ticku', () => {
    expect(a.world.cargo.exportedCount).toBe(SMALL_UNITS);
    expect(b.world.cargo.exportedCount).toBe(SMALL_UNITS);
    expect(a.world.clock.tick).toBe(b.world.clock.tick);
  });

  it('prúd udalostí je bitovo rovnaký (vrátane Truck* udalostí) a stav sveta sa zhoduje každých 250 tickov aj na konci', () => {
    expect(landsideEvents(a.recorder.events, 'TruckSpawned')).toHaveLength(SMALL_UNITS);
    expect(JSON.stringify(a.recorder.events)).toBe(JSON.stringify(b.recorder.events));
    expect(a.hashes.length).toBeGreaterThan(0);
    expect(a.hashes).toEqual(b.hashes);
    expect(stateHash(a.world)).toBe(stateHash(b.world));
  });
});

/**
 * Predpoklady o API (T04-04, rozhodnutie orchestrátora 7): `WorldState` v4 = v3 + `trucks` (pole záznamov) + stav brány
 * a rezervácie bay/dock, ak sa nedajú odvodiť; obnova pokračuje bez zmeny správania — z uloženého stavu vznikne svet,
 * ktorý dá rovnaké udalosti a rovnaký koncový stav ako pôvodný beh.
 */
describe('save/load uprostred reťazca: obnovený svet pokračuje rovnako ako pôvodný (WorldState v4)', () => {
  /**
   * Malý scenár s prerušením verejnej cesty (44, 40) v ticku `CUT_AT` a obnovou v `RESTORE_AT` (review T04-11 h):
   * kamióny na verejnej ceste vtedy prejdú do `no_path` (sonda „no_path s resume"). Bunka v tých tickoch nie je pod
   * kamiónom (inak by príkaz odmietlo `occupied`); prvý kamión prejde (44, 40) okolo ticku 570 a 610 (od R1, ADR-037, jazdí po slotoch; pred R1 okolo 553; rez v ticku 604 by odmietlo `occupied`).
   */
  const CUT_AT = 600;
  const RESTORE_AT = 700;
  const CUT_CELL = { x: 44, y: 40 };
  const probeScenario = f4Scenario('f4_small_chain_cut', 4004, {
    vehicles: STRADDLES,
    units: SMALL_UNITS,
    extra: [
      { atTick: CUT_AT, command: { type: 'RemoveRoad', cells: [CUT_CELL] } },
      { atTick: RESTORE_AT, command: { type: 'PlaceRoad', cells: [CUT_CELL] } },
    ],
  });
  const liveTrucks = (w: World) => [...w.trucks.values()];
  const PROBES: readonly { readonly name: string; readonly when: (world: World) => boolean }[] = [
    { name: 'kamión čaká vo fronte brány (gate_queue)', when: (w) => trucksById(w).some((truck) => truck.state === 'gate_queue') },
    { name: 'kamión stojí v stojisku (waiting)', when: (w) => trucksById(w).some((truck) => truck.state === 'waiting') },
    { name: 'kamión nakladá (loading)', when: (w) => trucksById(w).some((truck) => truck.state === 'loading') },
    { name: 'plný kamión čaká vo fronte brány von (gate_queue_out)', when: (w) => trucksById(w).some((truck) => truck.state === 'gate_queue_out') },
    { name: 'plný kamión ide k portálu (to_portal)', when: (w) => trucksById(w).some((truck) => truck.state === 'to_portal') },
    { name: 'kamión jazdí uprostred úseku (progress > 0)', when: (w) => liveTrucks(w).some((truck) => truck.progress > 0 && truck.state.startsWith('to_')) },
    { name: 'brána počas prechodu (busyTicksLeft > 0)', when: (w) => gateOf(w).busyTicksLeft > 0 },
    { name: 'kamión bez cesty v no_path s resume', when: (w) => liveTrucks(w).some((truck) => truck.state === 'no_path' && truck.resume !== null) },
  ];

  interface Fork {
    readonly name: string;
    readonly tick: number;
    readonly saved: WorldState;
    readonly hash: string;
    readonly trucks: readonly [number, string][];
    readonly unitsInTrucks: number;
    readonly eventsBefore: number;
  }

  let base: World;
  let baseRecorder: Recorder4;
  let forks: Fork[];
  let finalTick: number;
  let finalHash: string;

  beforeAll(() => {
    base = World.create(DEFS, MAP, probeScenario.seed);
    baseRecorder = new Recorder4(base, probeScenario);
    forks = [];
    for (const probe of PROBES) {
      baseRecorder.runUntil(probe.when, SMALL_MAX_TICKS);
      forks.push({
        name: probe.name,
        tick: base.clock.tick,
        saved: JSON.parse(JSON.stringify(base.serialize())) as WorldState,
        hash: stateHash(base),
        trucks: trucksById(base).map((truck): [number, string] => [truck.id, truck.state]),
        unitsInTrucks: base.cargo.countByKind('in_truck'),
        eventsBefore: baseRecorder.events.length,
      });
    }
    baseRecorder.runUntil((w) => w.cargo.exportedCount === SMALL_UNITS, SMALL_MAX_TICKS);
    finalTick = base.clock.tick;
    finalHash = stateHash(base);
  }, RUN_TIMEOUT_MS);

  it('sondy pokryli no_path s resume po prerušení cesty (bez CommandRejected), jazdu uprostred úseku aj bránu počas prechodu', () => {
    expect(timed4(baseRecorder.events, 'CommandRejected')).toEqual([]);
    const noPath = forks.find((fork) => fork.name.includes('no_path'));
    expect(noPath?.tick).toBeGreaterThan(CUT_AT);
    expect(noPath?.trucks.some(([, state]) => state === 'no_path')).toBe(true);
    const gateFork = forks.find((fork) => fork.name.includes('busyTicksLeft'));
    const gateRuntime = gateFork?.saved.modules.find((entry) => entry.defId === 'truck_gate')?.runtime as { busyTicksLeft: number } | undefined;
    expect(gateRuntime?.busyTicksLeft).toBeGreaterThan(0);
    const moving = forks.find((fork) => fork.name.includes('progress'));
    const savedTrucks = (moving?.saved as unknown as { trucks: { progress: number }[] } | undefined)?.trucks ?? [];
    expect(savedTrucks.some((truck) => truck.progress > 0)).toBe(true);
  });

  it('uložený stav má aktuálnu verziu s poľom trucks a čistým JSON-om (JSON.parse(JSON.stringify(s)) sa rovná s)', () => {
    expect(forks).toHaveLength(PROBES.length);
    for (const fork of forks) {
      expect(fork.saved.version, fork.name).toBe(WORLD_STATE_VERSION);
      const trucks = (fork.saved as unknown as Record<string, unknown>)['trucks'];
      expect(Array.isArray(trucks), `${fork.name}: trucks`).toBe(true);
      expect((trucks as unknown[]).length, `${fork.name}: počet kamiónov v save`).toBe(fork.trucks.length);
      expect(JSON.parse(JSON.stringify(fork.saved))).toEqual(fork.saved);
    }
  });

  it.each(PROBES.map((probe, index) => ({ name: probe.name, index })))('$name: obnova dá rovnaký stav, kamióny s rovnakým stavom a náklad v kamiónoch', ({ index }) => {
    const fork = forks[index];
    const clone = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(fork.saved)) as WorldState);
    expect(stateHash(clone)).toBe(fork.hash);
    expect(clone.clock.tick).toBe(fork.tick);
    expect(trucksById(clone).map((truck): [number, string] => [truck.id, truck.state])).toEqual(fork.trucks);
    expect(clone.cargo.countByKind('in_truck')).toBe(fork.unitsInTrucks);
    expect(() => clone.assertInvariants()).not.toThrow();
  });

  it.each(PROBES.map((probe, index) => ({ name: probe.name, index })))(
    '$name: obnovený svet dobehne do rovnakého koncového stavu a rovnakých udalostí ako pôvodný (audit po každom ticku)',
    ({ index }) => {
      const fork = forks[index];
      const clone = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(fork.saved)) as WorldState);
      const recorder = new Recorder4(clone, probeScenario);
      recorder.runTo(finalTick);
      expect(clone.clock.tick).toBe(finalTick);
      expect(stateHash(clone)).toBe(finalHash);
      expect(clone.cargo.exportedCount).toBe(SMALL_UNITS);
      const expected = baseRecorder.events.slice(fork.eventsBefore).map((entry) => JSON.stringify(entry));
      expect(recorder.events.map((entry) => JSON.stringify(entry))).toEqual(expected);
      for (const rule of ALL_RULES) expect(recorder.violationsOf(rule), `${fork.name}: ${rule}`).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );
});
