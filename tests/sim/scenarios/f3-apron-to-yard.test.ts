/**
 * Scenár `apron_to_yard` (T03-07, TDD): feeder so 96 TEU (kapacita dvorov, 2 × 48 TEU) zakotví na Root berthe, Root žeriav ich vyloží na apron a dve
 * vozidlá `straddle_carrier` ich fyzicky prevezú do dvoch kontajnerových dvorov (blízky a ďaleký). Testy idú výlučne
 * cez verejné API a JSON príkazy (`PlaceRoad`, `PlaceModule`, `BuyVehicle`, `SpawnShipDebug`), proti rozhraniu
 * z `docs/tasks/phase-03.md` („Spoločné rozhrania", „Rozhodnutia orchestrátora"). Časové hranice sú horné alebo ±1 tick,
 * kontrolujú sa stavy FSM a polohy, nie konkrétne ticky.
 *
 * Rozloženie (`helpers/f3-layout.ts`): cesty okruhom pri berthe + chrbtica na juh, blízky dvor (42, 18), ďaleký dvor
 * (49, 26), depo (46, 27); depo je prvý `PlaceModule` (id 3), dvory majú 4 a 5. Po každom ticku beží
 * `assertCargoConservation(world)` + nezávislý audit ledgera a jobov (`recordRunF3`).
 *
 * Predpoklady o API sú vypísané v hlavičkách `describe` a v odovzdávacej správe karty.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { craneParams, storageParams } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { footprintOf, type StorageModule, type VehicleDepot } from '@sim/modules';
import { World } from '@sim/world';
import {
  ALL_ROAD_CELLS,
  BERTH_OUTSIDE_CELLS,
  DEPOT_ID,
  DEPOT_ORIGIN,
  DEPOT_OUTSIDE,
  FAR_YARD_ORIGIN,
  FAR_YARD_OUTSIDE,
  NEAR_YARD_ORIGIN,
  NEAR_YARD_OUTSIDE,
  f3Scenario,
} from '../helpers/f3-layout';
import {
  SLACK_TICKS,
  auditLedgerF3,
  boughtVehicleIds,
  cellOfPosition,
  depotOf,
  outsideCellsOf,
  recordRunF3,
  rootBerthOf,
  roadDistance,
  runUntilF3,
  restoreCopy,
  sameCell,
  stayStartTick,
  storageAt,
  timed3,
  travelledCells,
  vehicleFsmViolation,
  vehicleSampleAt,
  vehicleSamples,
  vehiclesOf,
  violationsOf,
  jobStateViolation,
  jobsOf,
  type RunLog3,
} from '../helpers/f3';
import { must, type TimedEvent } from '../helpers/harbor';
import { loadScenarioFile, readRepoJson, stateHash } from '../helpers/scenario';
import { DEFS, MAP, MAP_GRID } from '../world/world-fixtures';

/** Karta T03-07 / akceptácia fázy: po ≤ 15 000 tickoch sú všetky jednotky `in_storage`. */
const RUN_TICKS = 15000;
const UNITS = 96;
/** Timeout hooku: 15 000 tickov s auditom po každom ticku. */
const RUN_TIMEOUT_MS = 120_000;

const scenario = loadScenarioFile('apron_to_yard');
const STRADDLE = DEFS.vehicles.get('straddle_carrier');
const YARD_DEF = DEFS.modules.get('container_yard_small');
/** Fyzická kapacita dvora v TEU (R2, ADR-039): `min(capacityUnits, bays × rows × maxTier)` = 48. */
const YARD_CAPACITY = Math.min(storageParams(YARD_DEF).capacityUnits, (storageParams(YARD_DEF).bays ?? Infinity) * (storageParams(YARD_DEF).rows ?? 1) * (storageParams(YARD_DEF).maxTier ?? 1));
const ROAD_COST = DEFS.infrastructure.road.costPerCellCents;
/** `internalTicks` skladu/berthu nie je v defoch nastavené → platí `logistics.defaultInternalTicks` (rozhodnutie 2). */
const INTERNAL_TICKS = DEFS.logistics.defaultInternalTicks;

type CargoMovedEvent = Extract<SimEvent, { type: 'CargoMoved' }>;

// ---------------------------------------------------------------------------------------------------------
// Scenár ako dáta
// ---------------------------------------------------------------------------------------------------------

describe('scenár apron_to_yard: súbor', () => {
  it('má očakávaný tvar { id, seed, map, commands } a seed 3003', () => {
    expect(Object.keys(scenario).sort()).toEqual(['commands', 'id', 'map', 'seed']);
    expect(scenario.id).toBe('apron_to_yard');
    expect(scenario.seed).toBe(3003);
    expect(scenario.map).toBe('data/maps/harbor_01.json');
    expect((readRepoJson(scenario.map) as { id: string }).id).toBe(MAP.id);
  });

  it('je zhodný s rozložením z helpers/f3-layout (2× straddle_carrier, feeder 96 TEU)', () => {
    expect(scenario).toEqual(f3Scenario('apron_to_yard', 3003, { vehicles: ['straddle_carrier', 'straddle_carrier'], units: UNITS }));
  });

  it('všetky príkazy idú na tick 0 v poradí: cesty, depo, 2 dvory, 2 nákupy vozidiel, loď', () => {
    expect(scenario.commands.every((entry) => entry.atTick === 0)).toBe(true);
    const types = scenario.commands.map((entry) => entry.command.type);
    expect(types).toEqual([
      ...Array<string>(6).fill('PlaceRoad'),
      'PlaceModule',
      'PlaceModule',
      'PlaceModule',
      'BuyVehicle',
      'BuyVehicle',
      'SpawnShipDebug',
    ]);
    const modules = scenario.commands.filter((entry) => entry.command.type === 'PlaceModule').map((entry) => entry.command['defId']);
    expect(modules).toEqual(['vehicle_depot', 'container_yard_small', 'container_yard_small']);
  });

  it('BuyVehicle odkazuje na depo s id 3 (starter berth 1 + žeriav 2, depo je prvý PlaceModule) a kupuje straddle_carrier', () => {
    const buys = scenario.commands.filter((entry) => entry.command.type === 'BuyVehicle').map((entry) => entry.command);
    expect(buys).toEqual([
      { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID },
      { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID },
    ]);
    expect(DEPOT_ID).toBe(3);
  });

  it('SpawnShipDebug feeder container_teu 96 (kapacita oboch dvorov)', () => {
    const spawn = scenario.commands.find((entry) => entry.command.type === 'SpawnShipDebug')?.command;
    expect(spawn).toEqual({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: UNITS });
    expect(DEFS.ships.get('feeder').capacityUnits).toBeGreaterThanOrEqual(UNITS); // loď vezie toľko, koľko sa zmestí do oboch dvorov (2 × 48 TEU)
  });

  it('každý príkaz prežije commandFromJSON → toJSON bez zmeny (vrátane BuyVehicle)', () => {
    for (const { command } of scenario.commands) {
      expect(commandFromJSON(command).toJSON()).toEqual(command);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Rozloženie je platné (overiteľné už teraz: PlaceRoad + validate, geometria z defov, vlastné BFS)
// ---------------------------------------------------------------------------------------------------------

describe('scenár apron_to_yard: rozloženie je platné podľa ARCHITECTURE §8', () => {
  /** Svet s aplikovanými príkazmi `PlaceRoad` zo scenára (moduly sa stavajú až po T03-02, tu sa len validujú). */
  function worldWithRoads(): World {
    const world = World.create(DEFS, MAP, scenario.seed);
    for (const { command } of scenario.commands) {
      if (command.type === 'PlaceRoad') world.enqueue(commandFromJSON(command));
    }
    const events = world.applyPending();
    expect(events.filter((event) => event.type === 'CommandRejected')).toEqual([]);
    return world;
  }

  const placeModules = scenario.commands.flatMap((entry) => {
    const { command } = entry;
    if (command.type !== 'PlaceModule') return [];
    return [{ defId: command['defId'] as string, x: command['x'] as number, y: command['y'] as number, command }];
  });

  it('33 unikátnych buniek ciest sa postaví za bunky × costPerCellCents', () => {
    const world = worldWithRoads();
    expect(new Set(ALL_ROAD_CELLS.map(({ x, y }) => `${String(x)},${String(y)}`)).size).toBe(33);
    for (const { x, y } of ALL_ROAD_CELLS) expect(world.grid.at(x, y).road, `(${String(x)}, ${String(y)})`).toBe('road');
    expect(DEFS.economy.startingCashCents - world.cashCents).toBe(33 * ROAD_COST);
  });

  it('cesty ležia na pevnine starter parcely (patrí hráčovi) a pod berthom nie sú', () => {
    for (const { x, y } of ALL_ROAD_CELLS) {
      const cell = MAP_GRID.at(x, y);
      expect(cell.terrain, `(${String(x)}, ${String(y)})`).toBe('land');
      expect(cell.parcelId, `(${String(x)}, ${String(y)})`).toBe('starter');
      expect(cell.moduleId).toBeNull();
    }
  });

  it('PlaceModule.validate je ok pre depo a oba dvory (terén, parcela, prekryv, konektory s cestou) za cenu z defu', () => {
    const world = worldWithRoads();
    expect(placeModules).toHaveLength(3);
    for (const { defId, x, y, command } of placeModules) {
      const result = commandFromJSON(command).validate(world);
      expect(result.reasons, `${defId} na (${String(x)}, ${String(y)})`).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.costCents).toBe(DEFS.modules.get(defId).costCents);
    }
  });

  it('footprinty depa a dvorov ležia na pevnine starter parcely a neprekrývajú sa navzájom, cesty ani berth', () => {
    const taken = new Map<string, string>();
    for (const { x, y } of ALL_ROAD_CELLS) taken.set(`${String(x)},${String(y)}`, 'cesta');
    const berthCells = footprintOf(DEFS.modules.get('berth_standard'), 40, 14, 0).cells;
    for (const { x, y } of berthCells) taken.set(`${String(x)},${String(y)}`, 'root berth');

    for (const { defId, x, y } of placeModules) {
      for (const cell of footprintOf(DEFS.modules.get(defId), x, y, 0).cells) {
        const key = `${String(cell.x)},${String(cell.y)}`;
        expect(taken.get(key), `${defId} (${String(x)}, ${String(y)}) prekrýva ${String(taken.get(key))} na ${key}`).toBeUndefined();
        taken.set(key, defId);
        expect(MAP_GRID.at(cell.x, cell.y).terrain).toBe('land');
        expect(MAP_GRID.at(cell.x, cell.y).parcelId).toBe('starter');
      }
    }
  });

  it('konektory: vonkajšie bunky depa (47, 30), blízkeho (43, 22) a ďalekého dvora (50, 30) aj berthu majú cestu', () => {
    const world = worldWithRoads();
    expect(outsideCellsOf(world, 'vehicle_depot', DEPOT_ORIGIN)).toEqual([DEPOT_OUTSIDE]);
    expect(outsideCellsOf(world, 'container_yard_small', NEAR_YARD_ORIGIN)).toEqual([NEAR_YARD_OUTSIDE]);
    expect(outsideCellsOf(world, 'container_yard_small', FAR_YARD_ORIGIN)).toEqual([FAR_YARD_OUTSIDE]);
    // Berth 8 × 4: prvé dva sú južné konektory s cestou; pruhové konektory w / e (6) cestu nemajú.
    expect(outsideCellsOf(world, 'berth_standard', { x: 40, y: 14 }).slice(0, 2)).toEqual([...BERTH_OUTSIDE_CELLS]);
    for (const cell of [DEPOT_OUTSIDE, NEAR_YARD_OUTSIDE, FAR_YARD_OUTSIDE, ...BERTH_OUTSIDE_CELLS]) {
      expect(world.grid.at(cell.x, cell.y).road, `(${String(cell.x)}, ${String(cell.y)})`).toBe('road');
    }
  });

  it('všetky vonkajšie bunky tvoria jednu súvislú cestnú sieť a berth → blízky dvor (6) je bližšie než berth → ďaleký dvor (20)', () => {
    const world = worldWithRoads();
    const fromBerth = (target: typeof NEAR_YARD_OUTSIDE): number =>
      Math.min(...BERTH_OUTSIDE_CELLS.map((cell) => roadDistance(world.grid, cell, target)));
    expect(roadDistance(world.grid, DEPOT_OUTSIDE, BERTH_OUTSIDE_CELLS[0])).toBeLessThan(Infinity);
    expect(roadDistance(world.grid, DEPOT_OUTSIDE, BERTH_OUTSIDE_CELLS[1])).toBeLessThan(Infinity);
    expect(fromBerth(NEAR_YARD_OUTSIDE)).toBe(6);
    expect(fromBerth(FAR_YARD_OUTSIDE)).toBe(20);
  });

  it('okruh: po odstránení dolnej bunky západnej nohy existuje obchádzka cez západnú obchádzku (10 krokov)', () => {
    const world = worldWithRoads();
    world.grid.at(41, 22).road = 'none'; // len tento zahodený svet, nie scenár
    expect(roadDistance(world.grid, BERTH_OUTSIDE_CELLS[0], NEAR_YARD_OUTSIDE)).toBe(10);
  });

  it('výdavky na cesty, 3 moduly a 2 vozidlá sú pod štartovou hotovosťou', () => {
    const spend =
      33 * ROAD_COST +
      placeModules.reduce((sum, { defId }) => sum + DEFS.modules.get(defId).costCents, 0) +
      2 * STRADDLE.purchaseCents;
    expect(spend).toBeLessThan(DEFS.economy.startingCashCents);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Beh scenára: 15 000 tickov
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady o API (rozhranie z karty, najjednoduchší výklad):
 *  A1 `world.vehicles`/`world.jobs` sú mapy podľa id; `Vehicle` má `state`, `x`, `y` (stred bunky = x + 0,5), `jobId`;
 *  A2 vozidlo po `BuyVehicle` stojí `idle` na vonkajšej bunke konektora depa (47,5; 30,5) a `VehicleDepot.vehicleIds` ho drží;
 *  A3 job nesie jednotky (kapacita vozidla 1 → 1 jednotka), zdroj = apron Root berthu, cieľ `in_storage(sklad, slot)`;
 *  A4 nakladá sa na vonkajšej bunke konektora berthu, vykladá na vonkajšej bunke konektora cieľového dvora;
 *  A5 alokátor: najbližší sklad s voľnou kapacitou (`stored + reserved < capacity`), takže blízky dvor sa naplní pred ďalekým;
 *  A6 vo F3 nie je economySystem (údržba/mzdy) → po ticku príkazov nevznikne žiadna `MoneyChanged`.
 */
describe('scenár apron_to_yard: beh 15 000 tickov', () => {
  let world: World;
  let log: RunLog3;
  let rootBerthId: EntityId;
  let nearYard: StorageModule;
  let farYard: StorageModule;
  let depot: VehicleDepot;
  let vehicleIds: EntityId[];
  const trafficViolations: string[] = [];

  beforeAll(() => {
    world = World.create(DEFS, MAP, scenario.seed);
    rootBerthId = rootBerthOf(world).id;
    log = recordRunF3(world, scenario, RUN_TICKS, {
      onTick: (w) => {
        // Krok 11 (rozhodnutie 9): bunka pod jazdiacim vozidlom má traffic ≥ 1 (po decay najmenej 0,9).
        for (const vehicle of vehiclesOf(w).values()) {
          if (vehicle.state !== 'to_pickup' && vehicle.state !== 'to_dropoff') continue;
          const cell = cellOfPosition(vehicle.x, vehicle.y);
          if (w.grid.at(cell.x, cell.y).traffic < 0.5) {
            trafficViolations.push(`tick ${String(w.clock.tick)}: vozidlo ${String(vehicle.id)} na (${String(cell.x)}, ${String(cell.y)}) má traffic ${String(w.grid.at(cell.x, cell.y).traffic)}`);
          }
        }
      },
    });
    nearYard = storageAt(world, NEAR_YARD_ORIGIN);
    farYard = storageAt(world, FAR_YARD_ORIGIN);
    depot = depotOf(world);
    vehicleIds = boughtVehicleIds(log);
  }, RUN_TIMEOUT_MS);

  const moves = (): TimedEvent<CargoMovedEvent>[] => timed3(log, 'CargoMoved');

  /** Pohyby jednotiek po jednotkách v poradí vzniku. */
  const chains = (): Map<number, TimedEvent<CargoMovedEvent>[]> => {
    const byUnit = new Map<number, TimedEvent<CargoMovedEvent>[]>();
    for (const move of moves()) byUnit.set(move.event.unitId, [...(byUnit.get(move.event.unitId) ?? []), move]);
    return byUnit;
  };

  it('hodiny stoja na 15 000 a invarianty (ledger, joby) bežali po každom ticku', () => {
    expect(world.clock.tick).toBe(RUN_TICKS);
    expect(log.ticksChecked).toBe(RUN_TICKS);
  });

  it('žiadny príkaz nebol odmietnutý (cesty, moduly, nákupy aj loď prešli validáciou)', () => {
    expect(timed3(log, 'CommandRejected')).toEqual([]);
  });

  it('stavba: depo má id 3, dvory ďalšie id; ModulePlaced pre depo a oba dvory', () => {
    expect(depot.def.id).toBe('vehicle_depot');
    expect(depot.id).toBe(DEPOT_ID);
    expect(nearYard.def.id).toBe('container_yard_small');
    expect(farYard.def.id).toBe('container_yard_small');
    expect(new Set([DEPOT_ID, nearYard.id, farYard.id]).size).toBe(3);
    expect(timed3(log, 'ModulePlaced').map((entry) => entry.event.defId)).toEqual(['vehicle_depot', 'container_yard_small', 'container_yard_small']);
  });

  it('nákup: dve VehicleBought(straddle_carrier, depo 3) a vozidlá začínajú idle na vonkajšej bunke depa', () => {
    const bought = timed3(log, 'VehicleBought');
    expect(bought).toHaveLength(2);
    for (const entry of bought) expect(entry.event).toMatchObject({ defId: 'straddle_carrier', depotId: DEPOT_ID });
    expect(vehicleIds).toHaveLength(2);
    expect(new Set(vehicleIds).size).toBe(2);
    expect(depot.vehicleIds).toEqual(vehicleIds);
    expect(world.vehicles.size).toBe(2);

    for (const id of vehicleIds) {
      const vehicle = must(world.vehicles.get(id), `vozidlo ${String(id)}`);
      expect(vehicle.defId).toBe('straddle_carrier');
      expect(vehicle.depotId).toBe(DEPOT_ID);
      expect(vehicle.purchaseCostCents).toBe(STRADDLE.purchaseCents);
      const first = vehicleSamples(log, id)[0];
      expect(first.state).toBe('parked');
      expect(first.jobId).toBeNull();
      expect([first.x, first.y]).toEqual([DEPOT_OUTSIDE.x + 0.5, DEPOT_OUTSIDE.y + 0.5]);
    }
  });

  it('výdavky ticku príkazov = 33 buniek ciest + 3 moduly + 2 vozidlá (kategórie road/module/vehicle_capex), potom len údržba a mzdy pri DayClosed', () => {
    const money = timed3(log, 'MoneyChanged');
    const first = money.filter((entry) => entry.tick <= 1);
    const spend = 33 * ROAD_COST + DEFS.modules.get('vehicle_depot').costCents + 2 * YARD_DEF.costCents + 2 * STRADDLE.purchaseCents;
    expect(first.reduce((sum, entry) => sum + entry.event.deltaCents, 0)).toBe(0 - spend);
    expect(first.filter((entry) => entry.event.reason === 'vehicle_capex').map((entry) => entry.event.deltaCents)).toEqual([
      0 - STRADDLE.purchaseCents,
      0 - STRADDLE.purchaseCents,
    ]);
    // ADR-025: po stavbe už len krok 9 pri uzavretí dňa (15 000 tickov = 1 DayClosed v ticku 8 640) — údržba všetkých
    // modulov (Root berth + žeriav + depo + 2 dvory) a mzdy (žeriav + 2 straddle carriers).
    const maintenance = [...world.modules.values()].reduce((sum, module) => sum + module.def.maintenancePerDayCents, 0);
    const wages = craneParams(DEFS.modules.get('crane_container_gantry')).wagePerDayCents + 2 * STRADDLE.wagePerDayCents;
    expect([maintenance, wages]).toEqual([285_000, 61_000]);
    const day = world.clock.ticksPerDay;
    expect(money.filter((entry) => entry.tick > 1).map((entry) => [entry.tick, entry.event.reason, entry.event.deltaCents])).toEqual([
      [day, 'maintenance', -maintenance],
      [day, 'wages', -wages],
    ]);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents - spend - maintenance - wages);
  });

  it('loď pripláva, zakotví na Root berthe a odpláva (ShipSpawned, ShipDocked, ShipDeparted po raz); world.ships je prázdne', () => {
    expect(timed3(log, 'ShipSpawned')).toHaveLength(1);
    const docked = timed3(log, 'ShipDocked');
    expect(docked).toHaveLength(1);
    expect(docked[0].event.berthIds).toEqual([rootBerthId]);
    expect(timed3(log, 'ShipDeparted')).toHaveLength(1);
    expect(world.ships.size).toBe(0);
  });

  it('všetkých 96 jednotiek skončilo v sklade: in_storage 96, nič na aprone/lodi/v žeriave/vo vozidle, lostUnits 0', () => {
    const { cargo } = world;
    expect(cargo.createdCount).toBe(UNITS);
    expect(cargo.countByKind('in_storage')).toBe(UNITS);
    for (const kind of ['on_ship', 'in_crane', 'on_apron', 'in_vehicle'] as const) expect(cargo.countByKind(kind), kind).toBe(0);
    expect(cargo.exportedCount).toBe(0);
    expect(cargo.liveCount).toBe(UNITS);
    const audit = auditLedgerF3(world);
    expect(audit.inStorage).toBe(UNITS);
    expect(cargo.createdCount - cargo.liveCount - cargo.exportedCount).toBe(0);
  });

  it('oba dvory majú náklad a bližší viac alebo rovnako (karta); oba dvory (48 TEU) sa naplnia', () => {
    const near = world.cargo.countAt('in_storage', nearYard.id);
    const far = world.cargo.countAt('in_storage', farYard.id);
    expect(near + far).toBe(UNITS);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThanOrEqual(far);
    // 96 jednotiek = kapacita oboch dvorov (R2: plánovač rozkladá import po prázdnych stohoch bližšieho aj ďalekého dvora).
    expect(near).toBe(YARD_CAPACITY);
    expect(far).toBe(UNITS - YARD_CAPACITY);
  });

  it('počítadlá skladov: storedCount = ledger, reserved 0, freeCount = kapacita − stored, unitsIn = stored, unitsOut 0', () => {
    for (const yard of [nearYard, farYard]) {
      const stored = world.cargo.countAt('in_storage', yard.id);
      expect(yard.storedCount).toBe(stored);
      expect(yard.reservedCount).toBe(0);
      expect(yard.capacity).toBe(YARD_CAPACITY);
      expect(yard.freeCount).toBe(YARD_CAPACITY - stored);
      expect(yard.unitsIn).toBe(stored);
      expect(yard.unitsOut).toBe(0);
    }
  });

  it('joby: 96 JobCreated (každá jednotka v práve jednom jobe), každý job má práve jedno JobAssigned a JobDone; vozidlo nevezie viac než unesie', () => {
    const created = timed3(log, 'JobCreated');
    const assigned = timed3(log, 'JobAssigned');
    const done = timed3(log, 'JobDone');
    expect(created).toHaveLength(UNITS);
    expect(assigned).toHaveLength(UNITS);
    expect(done).toHaveLength(UNITS);
    expect(new Set(created.map((entry) => entry.event.jobId)).size).toBe(UNITS);
    expect(new Set(assigned.map((entry) => entry.event.jobId)).size).toBe(UNITS);
    expect(new Set(done.map((entry) => entry.event.jobId)).size).toBe(UNITS);

    const units = created.flatMap((entry) => entry.event.unitIds);
    expect(units).toHaveLength(UNITS);
    expect(new Set(units).size).toBe(UNITS);
    for (const entry of created) {
      expect(entry.event.unitIds.length).toBeLessThanOrEqual(STRADDLE.capacityUnits);
      expect(entry.event.fromModuleId).toBe(rootBerthId);
      expect([nearYard.id, farYard.id]).toContain(entry.event.toModuleId);
    }
    for (const entry of assigned) expect(vehicleIds).toContain(entry.event.vehicleId);
    expect(log.jobs.size).toBe(UNITS);
    for (const trace of log.jobs.values()) expect(jobStateViolation(trace.states), `job ${String(trace.jobId)}`).toBeNull();
  });

  it('na konci sú všetky joby done, vozidlá zaparkované v depe bez jobu a nákladu (mimo cesty)', () => {
    expect([...jobsOf(world).values()].filter((job) => job.state !== 'done')).toEqual([]);
    for (const id of vehicleIds) {
      const vehicle = must(world.vehicles.get(id), `vozidlo ${String(id)}`);
      expect(vehicle.state).toBe('parked');
      expect(vehicle.jobId).toBeNull();
      expect(world.cargo.countAt('in_vehicle', id)).toBe(0);
      const cell = cellOfPosition(vehicle.x, vehicle.y);
      expect([cell.x, cell.y]).toEqual([DEPOT_OUTSIDE.x, DEPOT_OUTSIDE.y]); // prístupová bunka depa
      expect(world.grid.at(cell.x, cell.y).road).toBe('road');
      expect(vehicle.body).toEqual([]); // zaparkované vozidlo nedrží žiadny slot
    }
  });

  it('obe vozidlá prevážajú (každé aspoň jeden job) a prvý job dostane vozidlo s menším id (remíza: obe stoja na jednej bunke)', () => {
    const assigned = timed3(log, 'JobAssigned');
    for (const id of vehicleIds) expect(assigned.filter((entry) => entry.event.vehicleId === id).length, `vozidlo ${String(id)}`).toBeGreaterThan(0);
    expect(assigned[0].event.vehicleId).toBe(Math.min(...vehicleIds));
  });

  it('reťaz každej jednotky: on_ship → in_crane → on_apron → in_vehicle → in_storage; vozidlo a sklad zodpovedajú jobu, slot je ten rezervovaný', () => {
    const jobOfUnit = new Map<number, number>();
    for (const entry of timed3(log, 'JobCreated')) for (const unitId of entry.event.unitIds) jobOfUnit.set(unitId, entry.event.jobId);
    const assignedVehicle = new Map<number, number>();
    for (const entry of timed3(log, 'JobAssigned')) assignedVehicle.set(entry.event.jobId, entry.event.vehicleId);

    const byUnit = chains();
    expect(byUnit.size).toBe(UNITS);
    for (const [unitId, chain] of byUnit) {
      const label = `jednotka ${String(unitId)}`;
      expect(chain.map((entry) => [entry.event.from.kind, entry.event.to.kind]), label).toEqual([
        ['on_ship', 'in_crane'],
        ['in_crane', 'on_apron'],
        ['on_apron', 'in_vehicle'],
        ['in_vehicle', 'in_storage'],
      ]);
      // reťaz nadväzuje: `from` ďalšieho pohybu je `to` predošlého
      for (let i = 1; i < chain.length; i++) expect(chain[i].event.from, label).toEqual(chain[i - 1].event.to);

      const load = chain[2].event;
      const store = chain[3].event;
      if (load.to.kind !== 'in_vehicle' || store.to.kind !== 'in_storage') throw new Error(`${label}: neočakávané lokácie`);
      const jobId = must(jobOfUnit.get(unitId), `job jednotky ${String(unitId)}`);
      const trace = must(log.jobs.get(jobId as EntityId), `životopis jobu ${String(jobId)}`);
      expect(load.to.vehicleId, `${label}: vozidlo v ledgeri = vozidlo priradené jobu`).toBe(assignedVehicle.get(jobId));
      expect(store.to.moduleId, `${label}: sklad = cieľ jobu`).toBe(trace.toModuleId);
      if (trace.to.kind !== 'in_storage') throw new Error(`job ${String(jobId)}: cieľ nie je in_storage`);
      expect(store.to.slot, `${label}: rezervovaný slot`).toBe(trace.to.slot);
      expect(store.from, label).toEqual({ kind: 'in_vehicle', vehicleId: load.to.vehicleId });
    }
  });

  it('poradie udalostí každej jednotky: príchod na apron ≤ JobCreated ≤ JobAssigned ≤ naloženie ≤ uloženie a JobDone v rovnakom ticku (±1)', () => {
    const createdTicks = new Map<number, number>();
    const assignedTicks = new Map<number, number>();
    const doneTicks = new Map<number, number>();
    for (const entry of timed3(log, 'JobCreated')) createdTicks.set(entry.event.jobId, entry.tick);
    for (const entry of timed3(log, 'JobAssigned')) assignedTicks.set(entry.event.jobId, entry.tick);
    for (const entry of timed3(log, 'JobDone')) doneTicks.set(entry.event.jobId, entry.tick);
    const created = new Map<number, number>();
    for (const entry of timed3(log, 'JobCreated')) for (const unitId of entry.event.unitIds) created.set(unitId, entry.event.jobId);

    for (const [unitId, chain] of chains()) {
      const jobId = must(created.get(unitId), `job jednotky ${String(unitId)}`);
      const [, atApron, loaded, stored] = chain.map((entry) => entry.tick);
      const createdTick = must(createdTicks.get(jobId), `JobCreated pre job ${String(jobId)}`);
      const assignedTick = must(assignedTicks.get(jobId), `JobAssigned pre job ${String(jobId)}`);
      const doneTick = must(doneTicks.get(jobId), `JobDone pre job ${String(jobId)}`);
      const label = `jednotka ${String(unitId)}, job ${String(jobId)}`;
      expect(createdTick, label).toBeGreaterThanOrEqual(atApron);
      expect(assignedTick, label).toBeGreaterThanOrEqual(createdTick);
      expect(loaded, label).toBeGreaterThanOrEqual(assignedTick);
      expect(stored, label).toBeGreaterThan(loaded);
      expect(Math.abs(doneTick - stored), label).toBeLessThanOrEqual(SLACK_TICKS);
    }
  });

  it('nič sa neteleportuje: nakladá sa na vonkajšej bunke konektora berthu, vykladá na vonkajšej bunke konektora cieľového dvora', () => {
    let loads = 0;
    let stores = 0;
    for (const { tick, event } of moves()) {
      if (event.from.kind === 'on_apron' && event.to.kind === 'in_vehicle') {
        const sample = vehicleSampleAt(log, event.to.vehicleId, tick);
        const cell = cellOfPosition(sample.x, sample.y);
        expect(BERTH_OUTSIDE_CELLS.some((outside) => sameCell(outside, cell)), `naloženie jednotky ${String(event.unitId)}, tick ${String(tick)}, bunka (${String(cell.x)}, ${String(cell.y)})`).toBe(true);
        expect(['loading', 'to_dropoff']).toContain(sample.state);
        loads += 1;
      }
      if (event.from.kind === 'in_vehicle' && event.to.kind === 'in_storage') {
        const sample = vehicleSampleAt(log, event.from.vehicleId, tick);
        const cell = cellOfPosition(sample.x, sample.y);
        const expected = event.to.moduleId === nearYard.id ? NEAR_YARD_OUTSIDE : FAR_YARD_OUTSIDE;
        expect(sameCell(expected, cell), `uloženie jednotky ${String(event.unitId)}, tick ${String(tick)}, bunka (${String(cell.x)}, ${String(cell.y)}), očakávaná (${String(expected.x)}, ${String(expected.y)})`).toBe(true);
        expect(['unloading', 'idle']).toContain(sample.state);
        stores += 1;
      }
    }
    expect(loads).toBe(UNITS);
    expect(stores).toBe(UNITS);
  });

  it('pobyt v module: vozidlo stojí na mieste internalTicks + loadTicks (naloženie) / internalTicks + unloadTicks (uloženie), kým sa jednotka presunie (±1 tick)', () => {
    let checked = 0;
    for (const { tick, event } of moves()) {
      const load = event.from.kind === 'on_apron' && event.to.kind === 'in_vehicle';
      const store = event.from.kind === 'in_vehicle' && event.to.kind === 'in_storage';
      if (!load && !store) continue;
      const vehicleId = event.to.kind === 'in_vehicle' ? event.to.vehicleId : event.from.kind === 'in_vehicle' ? event.from.vehicleId : null;
      const samples = vehicleSamples(log, must(vehicleId, `vozidlo presunu jednotky ${String(event.unitId)}`));
      // Vozidlo stálo na mieste až do ticku pred presunom (v ticku presunu sa môže už rozbiehať).
      const stay = tick - 1 - stayStartTick(samples, tick - 1) + 1;
      const expected = INTERNAL_TICKS + (load ? STRADDLE.loadTicks : STRADDLE.unloadTicks);
      expect(stay, `${load ? 'naloženie' : 'uloženie'} jednotky ${String(event.unitId)}, tick ${String(tick)}`).toBeGreaterThanOrEqual(expected - SLACK_TICKS);
      checked += 1;
    }
    expect(checked).toBe(2 * UNITS);
  });

  it('FSM vozidla: parked → depot_exit → to_pickup → loading → to_dropoff → unloading → idle → to_depot → parked; VehicleStateChanged nadväzujú a každé vozidlo prešlo celým cyklom', () => {
    expect(vehicleFsmViolation(log.events)).toBeNull();
    const changes = timed3(log, 'VehicleStateChanged');
    for (const id of vehicleIds) {
      const own = changes.filter((entry) => entry.event.vehicleId === id);
      const visited = new Set(own.map((entry) => entry.event.to));
      for (const state of ['depot_exit', 'to_pickup', 'loading', 'to_dropoff', 'unloading', 'idle', 'to_depot', 'parked'] as const) expect(visited.has(state), `vozidlo ${String(id)} nikdy nebolo v ${state}`).toBe(true);
      // posledný stav z udalostí = skutočný stav vozidla, každý vzorkovaný stav vznikol z nejakej udalosti
      expect(own.at(-1)?.event.to).toBe(world.vehicles.get(id)?.state);
      for (const sample of vehicleSamples(log, id)) expect(sample.state === 'idle' || visited.has(sample.state), `stav ${sample.state}, tick ${String(sample.tick)}`).toBe(true);
    }
  });

  it('bez zmeny ciest nie je žiadne vozidlo bez cesty: nikdy no_path', () => {
    for (const id of vehicleIds) expect(vehicleSamples(log, id).filter((sample) => sample.state === 'no_path')).toEqual([]);
  });

  it('vozidlá stoja vždy na bunke s cestou a v mape (aj počas pobytu v module)', () => {
    expect(violationsOf(log, 'out_of_map')).toEqual([]);
    expect(violationsOf(log, 'off_road')).toEqual([]);
  });

  it('nič sa neteleportuje: vozidlo sa za tick posunie najviac o speedCellsPerTick (Manhattan)', () => {
    expect(violationsOf(log, 'teleport')).toEqual([]);
  });

  it('vozidlo v to_pickup/to_dropoff sa v každom ticku pohne alebo zmení stav (žiadne to_* bez cesty)', () => {
    expect(violationsOf(log, 'stuck')).toEqual([]);
  });

  it('vozidlá reálne jazdia (spolu > 96 buniek) a vezú náklad (aspoň jedna vzorka to_dropoff s jednotkou vo vozidle)', () => {
    const total = vehicleIds.reduce((sum, id) => sum + travelledCells(vehicleSamples(log, id)), 0);
    expect(total).toBeGreaterThan(96);
    const loaded = vehicleIds.flatMap((id) => vehicleSamples(log, id)).filter((sample) => sample.state === 'to_dropoff');
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.every((sample) => sample.unitsInside === 1)).toBe(true);
    const empty = vehicleIds.flatMap((id) => vehicleSamples(log, id)).filter((sample) => sample.state === 'idle' || sample.state === 'to_pickup');
    expect(empty.every((sample) => sample.unitsInside === 0)).toBe(true);
  });

  it('traffic: bunka pod jazdiacim vozidlom má traffic ≥ 0,5 v každom ticku (krok 11)', () => {
    expect(trafficViolations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Determinizmus a save/load
// ---------------------------------------------------------------------------------------------------------

describe('scenár apron_to_yard: determinizmus', () => {
  it('dva svety so seedom 3003 majú po 5 000 tickoch rovnaký hash stavu aj rovnaký prúd udalostí', () => {
    const initial = stateHash(World.create(DEFS, MAP, scenario.seed));
    const a = World.create(DEFS, MAP, scenario.seed);
    const b = World.create(DEFS, MAP, scenario.seed);
    const logA = recordRunF3(a, scenario, 5000);
    const logB = recordRunF3(b, scenario, 5000);

    expect(stateHash(a)).not.toBe(initial); // hash je citlivý: svet sa reálne zmenil
    expect(stateHash(b)).toBe(stateHash(a));
    expect(logB.events).toEqual(logA.events);
    expect(logA.events.length).toBeGreaterThan(0);
    expect(vehiclesOf(a).size).toBe(2);
  }, RUN_TIMEOUT_MS);
});

describe('scenár apron_to_yard: save/load roundtrip uprostred jazdy a pobytu', () => {
  const MOMENTS: readonly {
    readonly name: string;
    readonly ready: (world: World) => boolean;
    readonly check: (world: World) => void;
  }[] = [
    {
      name: 'vozidlo ide k vyzdvihnutiu (to_pickup)',
      ready: (world) => [...vehiclesOf(world).values()].some((vehicle) => vehicle.state === 'to_pickup'),
      check: (world) => expect([...vehiclesOf(world).values()].some((vehicle) => vehicle.state === 'to_pickup')).toBe(true),
    },
    {
      name: 'vozidlo stojí v berthe a nakladá (loading, jednotka ešte na aprone)',
      ready: (world) => [...vehiclesOf(world).values()].some((vehicle) => vehicle.state === 'loading'),
      check: (world) => expect(world.cargo.countByKind('on_apron')).toBeGreaterThan(0),
    },
    {
      name: 'vozidlo jazdí s nákladom (to_dropoff)',
      ready: (world) => [...vehiclesOf(world).values()].some((vehicle) => vehicle.state === 'to_dropoff'),
      check: (world) => expect(world.cargo.countByKind('in_vehicle')).toBeGreaterThan(0),
    },
    {
      name: 'vozidlo vykladá v dvore (unloading)',
      ready: (world) => [...vehiclesOf(world).values()].some((vehicle) => vehicle.state === 'unloading'),
      check: (world) => expect(world.cargo.countByKind('in_vehicle')).toBeGreaterThan(0),
    },
    {
      name: 'v dvore je aspoň 10 jednotiek a vozidlá jazdia (uprostred vykládky)',
      ready: (world) => world.cargo.countByKind('in_storage') >= 10,
      check: (world) => expect(world.cargo.countByKind('on_ship')).toBeGreaterThan(0),
    },
  ];

  it.each(MOMENTS)('deserialize(serialize()) $name → rovnaký hash a rovnaký priebeh o ďalších 500 tickov', ({ ready, check }) => {
    const original = World.create(DEFS, MAP, scenario.seed);
    runUntilF3(original, scenario, ready, 8000);
    check(original);

    // Cez JSON, aby sa overilo, že stav je čistý JSON (žiadne Map/Set/triedy).
    const restored = restoreCopy(original);
    expect(stateHash(restored)).toBe(stateHash(original));
    expect(restored.modules.size).toBe(original.modules.size);
    expect(restored.cargo.createdCount).toBe(original.cargo.createdCount);
    for (const kind of ['on_apron', 'in_vehicle', 'in_storage'] as const) {
      expect(restored.cargo.countByKind(kind), kind).toBe(original.cargo.countByKind(kind));
    }
    expect(jobsOf(restored).size).toBe(jobsOf(original).size);
    expect(vehiclesOf(restored).size).toBe(vehiclesOf(original).size);
    for (const vehicle of vehiclesOf(original).values()) {
      const copy = must(vehiclesOf(restored).get(vehicle.id), `vozidlo ${String(vehicle.id)} po obnove`);
      expect([copy.state, copy.x, copy.y, copy.heading, copy.jobId]).toEqual([vehicle.state, vehicle.x, vehicle.y, vehicle.heading, vehicle.jobId]);
    }

    const logOriginal = recordRunF3(original, scenario, original.clock.tick + 500);
    const logRestored = recordRunF3(restored, scenario, restored.clock.tick + 500);
    expect(stateHash(restored)).toBe(stateHash(original));
    expect(logRestored.events).toEqual(logOriginal.events);
    expect(logRestored.events.length).toBeGreaterThan(0);
  }, RUN_TIMEOUT_MS);
});
