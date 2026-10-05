/**
 * Dispatcher, alokátor, vozidlá a preplánovanie ciest (T03-07, TDD) — cez verejné API a JSON príkazy
 * (`PlaceRoad`, `PlaceModule`, `BuyVehicle`, `SellVehicle`, `RemoveRoad`, `RemoveModule`, `SpawnShipDebug`),
 * `world.vehicles`, `world.jobs`, `world.modules`, `world.cargo` a udalosti. Rozloženie (cesty, depo, dvory) je
 * `helpers/f3-layout.ts`; scenáre sú malé (4–7 TEU), variácie defov (kapacita dvora, nekompatibilné vozidlo, málo
 * hotovosti) idú cez syntetický `DefRegistry` z `RAW_DEFS`.
 *
 * Pokryté (karta T03-07): bližší z dvoch skladov dostane prvý job a rezervácie sa rátajú, plný sklad sa preskočí,
 * bez (pripojeného) skladu vzniká `NoStorageAvailable` najviac 1× za hernú hodinu na berth, vozidlo bez kompatibilnej
 * kategórie job nedostane, dispatcher volí najbližšie voľné vozidlo, po `RemoveRoad` sa vozidlo preplánuje (cache
 * ciest sa zneplatní), bez cesty prejde do `no_path` a po obnove cesty pokračuje; `RemoveRoad` odmietne obsadenú
 * bunku; nákup/predaj vozidla a odstránenie depa/dvora s obsahom.
 *
 * Predpoklady o API sú v hlavičkách `describe`. Časové hranice sú horné, stavy sa čítajú z FSM, nie z presných tickov.
 */
import { describe, expect, it } from 'vitest';
import { commandFromJSON, refundCents, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry, depotParams } from '@sim/defs';
import { World } from '@sim/world';
import {
  DEPOT_ID,
  DEPOT_OUTSIDE,
  FAR_YARD_ORIGIN,
  FAR_YARD_OUTSIDE,
  NEAR_YARD_ORIGIN,
  NEAR_YARD_OUTSIDE,
  ROAD_SEGMENTS,
  f3Scenario,
  type F3Options,
} from '../helpers/f3-layout';
import {
  BULK_VEHICLE_ID,
  SLACK_TICKS,
  boughtVehicleIds,
  cellOfPosition,
  defsWithBulkVehicle,
  defsWithYardCapacity,
  depotOf,
  jobStateViolation,
  jobsOf,
  maxNoStoragePerBerthHour,
  recordRunF3,
  restoreCopy,
  rootBerthOf,
  runUntilF3,
  sameCell,
  storageAt,
  timed3,
  vehicleFsmViolation,
  vehicleSamples,
  vehicleStates,
  vehiclesById,
  vehiclesOf,
  violationsOf,
} from '../helpers/f3';
import { must } from '../helpers/harbor';
import { eventsOfType, stateHash, type Scenario, type ScenarioEntry } from '../helpers/scenario';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';

const STRADDLE = 'straddle_carrier';
const TWO_STRADDLES: readonly string[] = [STRADDLE, STRADDLE];
const STRADDLE_DEF = DEFS.vehicles.get(STRADDLE);
const ROAD_COST = DEFS.infrastructure.road.costPerCellCents;
const REPATH_TICKS = DEFS.logistics.repathIntervalTicks;
const TICKS_PER_HOUR = World.create(DEFS, MAP, 1).clock.ticksPerHour;
/** Vozidlo v `no_path` skúša znova každých `repathIntervalTicks`; po obnove cesty pokračuje najneskôr o toľko (+ slack na hranice ticku). */
const RESUME_DEADLINE_TICKS = REPATH_TICKS + SLACK_TICKS + 4;

const buyCommand = (vehicleDefId: string, depotId: number = DEPOT_ID): SerializedCommand => ({ type: 'BuyVehicle', vehicleDefId, depotId });
const sellCommand = (vehicleId: number): SerializedCommand => ({ type: 'SellVehicle', vehicleId });
const removeRoadCommand = (cells: readonly { x: number; y: number }[]): SerializedCommand => ({ type: 'RemoveRoad', cells });
const placeRoadCommand = (cells: readonly { x: number; y: number }[]): SerializedCommand => ({ type: 'PlaceRoad', cells });
const spawnCommand = (units: number): SerializedCommand => ({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units });
const entry = (atTick: number, command: SerializedCommand): ScenarioEntry => ({ atTick, command });

/** Svet s vykonanými príkazmi ticku 0 (`recordRunF3` do ticku 1) — bez čakania na loď. */
function layoutWorld(id: string, seed: number, options: F3Options = {}, defs: DefRegistry = DEFS): { world: World; scenario: Scenario } {
  const scenario = f3Scenario(id, seed, options);
  const world = World.create(defs, MAP, seed);
  recordRunF3(world, scenario, 1);
  return { world, scenario };
}

/** Enqueue + `applyPending` (bez tickov): udalosti príkazu. */
function execute(world: World, command: SerializedCommand): ReturnType<World['applyPending']> {
  world.enqueue(commandFromJSON(command));
  return world.applyPending();
}

const validateReasons = (world: World, command: SerializedCommand): readonly string[] => commandFromJSON(command).validate(world).reasons;

// ---------------------------------------------------------------------------------------------------------
// Nákup a predaj vozidla, odstránenie depa
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady: `BuyVehicle` validuje v poradí dôvodov z karty (`unknown_vehicle_def`, `unknown_depot`, `depot_full`,
 * `not_connected`, `insufficient_funds`); modul, ktorý nie je depo, je `unknown_depot`. `SellVehicle` povolí len `idle`
 * vozidlo bez jobu a nákladu (`vehicle_busy`), refund = `refundCents(purchaseCostCents, removalRefundRate)`.
 */
describe('vozidlá: nákup, predaj a odstránenie depa', () => {
  it('BuyVehicle: neznáma def → unknown_vehicle_def, neznáme depo aj modul, ktorý nie je depo → unknown_depot', () => {
    const { world } = layoutWorld('f3_buy_reasons', 3101);
    const yard = storageAt(world, NEAR_YARD_ORIGIN);
    expect(validateReasons(world, buyCommand('neexistujuce_vozidlo'))).toEqual(['unknown_vehicle_def']);
    expect(validateReasons(world, buyCommand(STRADDLE, 999))).toEqual(['unknown_depot']);
    expect(validateReasons(world, buyCommand(STRADDLE, yard.id))).toEqual(['unknown_depot']);
  });

  it('BuyVehicle: depo bez cesty pred konektorom → not_connected', () => {
    const { world } = layoutWorld('f3_buy_unconnected', 3102, { omitRoadCells: [DEPOT_OUTSIDE] });
    expect(world.grid.at(DEPOT_OUTSIDE.x, DEPOT_OUTSIDE.y).road).toBe('none');
    expect(validateReasons(world, buyCommand(STRADDLE))).toEqual(['not_connected']);
  });

  it('BuyVehicle: nedostatok hotovosti → insufficient_funds', () => {
    const poor = DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, startingCashCents: 34 * ROAD_COST + DEFS.modules.get('vehicle_depot').costCents + 1_000_000 } });
    const { world } = layoutWorld('f3_buy_poor', 3103, { yards: [] }, poor);
    expect(world.cashCents).toBe(1_000_000);
    expect(STRADDLE_DEF.purchaseCents).toBeGreaterThan(world.cashCents);
    expect(validateReasons(world, buyCommand(STRADDLE))).toEqual(['insufficient_funds']);
  });

  it('BuyVehicle: platný nákup — cena z defu, vozidlo idle na vonkajšej bunke depa, VehicleBought + MoneyChanged(vehicle_capex)', () => {
    const { world } = layoutWorld('f3_buy_ok', 3104);
    const depot = depotOf(world);
    const validation = commandFromJSON(buyCommand(STRADDLE)).validate(world);
    expect(validation.ok).toBe(true);
    expect(validation.costCents).toBe(STRADDLE_DEF.purchaseCents);

    const cashBefore = world.cashCents;
    const events = execute(world, buyCommand(STRADDLE));
    expect(eventsOfType(events, 'CommandRejected')).toEqual([]);
    const bought = eventsOfType(events, 'VehicleBought');
    expect(bought).toHaveLength(1);
    expect(bought[0]).toMatchObject({ defId: STRADDLE, depotId: DEPOT_ID });
    const money = eventsOfType(events, 'MoneyChanged');
    expect(money).toHaveLength(1);
    expect(money[0]).toMatchObject({ reason: 'vehicle_capex', deltaCents: 0 - STRADDLE_DEF.purchaseCents });
    expect(world.cashCents).toBe(cashBefore - STRADDLE_DEF.purchaseCents);

    const vehicle = must(world.vehicles.get(bought[0].vehicleId as EntityId), 'nové vozidlo');
    expect(vehicle.state).toBe('idle');
    expect(vehicle.jobId).toBeNull();
    expect(vehicle.depotId).toBe(DEPOT_ID);
    expect([vehicle.x, vehicle.y]).toEqual([DEPOT_OUTSIDE.x + 0.5, DEPOT_OUTSIDE.y + 0.5]);
    expect(depot.vehicleIds).toEqual([vehicle.id]);
  });

  it('BuyVehicle: depo má stojiská podľa defu (capacity) — po naplnení je ďalší nákup depot_full', () => {
    const capacity = depotParams(DEFS.modules.get('vehicle_depot')).capacity;
    const { world } = layoutWorld('f3_buy_full', 3105, { vehicles: Array<string>(capacity).fill(STRADDLE) });
    expect(world.vehicles.size).toBe(capacity);
    expect(depotOf(world).vehicleIds).toHaveLength(capacity);
    expect(validateReasons(world, buyCommand(STRADDLE))).toEqual(['depot_full']);
  });

  it('SellVehicle: neznáme id → unknown_vehicle; idle vozidlo sa predá s refundom, VehicleSold + MoneyChanged(vehicle_sale) a zmizne z depa', () => {
    const { world } = layoutWorld('f3_sell', 3106, { vehicles: TWO_STRADDLES });
    const [first, second] = vehiclesById(world);
    const depot = depotOf(world);
    expect(validateReasons(world, sellCommand(999))).toEqual(['unknown_vehicle']);

    const refund = refundCents(first.purchaseCostCents, DEFS.economy.removalRefundRate);
    expect(refund).toBeGreaterThan(0);
    const cashBefore = world.cashCents;
    const events = execute(world, sellCommand(first.id));
    expect(eventsOfType(events, 'CommandRejected')).toEqual([]);
    expect(eventsOfType(events, 'VehicleSold').map((event) => event.vehicleId)).toEqual([first.id]);
    expect(eventsOfType(events, 'MoneyChanged').map((event) => [event.reason, event.deltaCents])).toEqual([['vehicle_sale', refund]]);
    expect(world.cashCents).toBe(cashBefore + refund);
    expect(world.vehicles.has(first.id)).toBe(false);
    expect(depot.vehicleIds).toEqual([second.id]);
  });

  it('RemoveModule: depo s vozidlami → has_vehicles; po predaji všetkých vozidiel sa dá odstrániť', () => {
    const { world } = layoutWorld('f3_remove_depot', 3107, { vehicles: TWO_STRADDLES });
    const remove: SerializedCommand = { type: 'RemoveModule', moduleId: DEPOT_ID };
    expect(validateReasons(world, remove)).toEqual(['has_vehicles']);
    for (const vehicle of vehiclesById(world)) execute(world, sellCommand(vehicle.id));
    expect(world.vehicles.size).toBe(0);
    expect(validateReasons(world, remove)).toEqual([]);
  });

  it('SellVehicle: vozidlo s jobom alebo nákladom (to_pickup, loading, to_dropoff, unloading) → vehicle_busy; po dokončení všetkého ho predať možno', () => {
    const scenario = f3Scenario('f3_sell_busy', 3108, { vehicles: [STRADDLE], units: 4 });
    const world = World.create(DEFS, MAP, scenario.seed);
    recordRunF3(world, scenario, 1);
    const vehicleId = vehiclesById(world)[0].id;
    expect(validateReasons(world, sellCommand(vehicleId))).toEqual([]); // idle a bez jobu → predať sa dá

    for (const state of ['to_pickup', 'loading', 'to_dropoff', 'unloading'] as const) {
      runUntilF3(world, scenario, (w) => vehiclesOf(w).get(vehicleId)?.state === state, 8000);
      expect(validateReasons(world, sellCommand(vehicleId)), `stav ${state}`).toEqual(['vehicle_busy']);
    }
    runUntilF3(world, scenario, (w) => w.cargo.countByKind('in_storage') === 4 && vehiclesOf(w).get(vehicleId)?.state === 'idle', 8000);
    expect(validateReasons(world, sellCommand(vehicleId))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Alokátor a tvorba jobov (bez vozidiel: joby ostanú `open` a rezervácie sú vidieť)
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady: pre každú jednotku `on_apron` bez jobu (FIFO) vznikne job `open` s rezervovaným slotom v sklade
 * (`StorageAllocator`: pripojený, kompatibilný, `stored + reserved < capacity`, najbližší od berthu, remíza = menšie id);
 * bez vozidla ostáva job `open` a rezervácia trvá (`reservedCount`).
 */
describe('alokátor: bližší dvor dostane prvý job a rezervácie sa rátajú (bez vozidiel)', () => {
  it('so 4 jednotkami na aprone dostane všetky 4 joby blízky dvor; joby sú open, majú rôzne sloty a rezerváciu (reservedCount 4)', () => {
    const scenario = f3Scenario('f3_alloc_near', 3110, { units: 4 });
    const world = World.create(DEFS, MAP, scenario.seed);
    const log = recordRunF3(world, scenario, 3000);
    const near = storageAt(world, NEAR_YARD_ORIGIN);
    const far = storageAt(world, FAR_YARD_ORIGIN);
    const berth = rootBerthOf(world);

    const created = timed3(log, 'JobCreated');
    expect(created).toHaveLength(4);
    expect(created[0].event.toModuleId).toBe(near.id); // bližší z dvoch dostane prvý job
    for (const item of created) {
      expect(item.event.toModuleId).toBe(near.id);
      expect(item.event.fromModuleId).toBe(berth.id);
    }
    expect(timed3(log, 'JobAssigned')).toEqual([]);
    expect(timed3(log, 'CommandRejected')).toEqual([]);

    const jobs = [...jobsOf(world).values()];
    expect(jobs).toHaveLength(4);
    expect(jobs.every((job) => job.state === 'open' && job.vehicleId === null)).toBe(true);
    const slots = jobs.map((job) => (job.to.kind === 'in_storage' ? job.to.slot : -1));
    expect(new Set(slots).size).toBe(4);
    expect(slots.every((slot) => slot >= 0 && slot < near.capacity)).toBe(true);

    expect([near.reservedCount, near.storedCount]).toEqual([4, 0]);
    expect([far.reservedCount, far.storedCount]).toEqual([0, 0]);
    expect(world.cargo.countByKind('on_apron')).toBe(4); // bez vozidla nič neodíde z apronu
  });

  it('joby vznikajú v poradí príchodu jednotiek na apron (FIFO) a každá jednotka je v práve jednom jobe', () => {
    const scenario = f3Scenario('f3_alloc_fifo', 3111, { units: 4 });
    const world = World.create(DEFS, MAP, scenario.seed);
    const log = recordRunF3(world, scenario, 3000);
    const arrivals = timed3(log, 'CargoMoved')
      .filter((move) => move.event.to.kind === 'on_apron')
      .map((move) => move.event.unitId);
    const jobUnits = timed3(log, 'JobCreated').flatMap((item) => item.event.unitIds);
    expect(jobUnits).toEqual(arrivals);
    expect(new Set(jobUnits).size).toBe(4);
  });

  it('kapacita dvora 3: rezervácie plnia blízky dvor (3), štvrtá jednotka ide do ďalekého, hoci nič nie je uložené (rešpektuje reserved)', () => {
    const scenario = f3Scenario('f3_alloc_reserved', 3112, { units: 4 });
    const world = World.create(defsWithYardCapacity(3), MAP, scenario.seed);
    const log = recordRunF3(world, scenario, 3000);
    const near = storageAt(world, NEAR_YARD_ORIGIN);
    const far = storageAt(world, FAR_YARD_ORIGIN);

    expect(near.capacity).toBe(3);
    expect(timed3(log, 'JobCreated').map((item) => item.event.toModuleId)).toEqual([near.id, near.id, near.id, far.id]);
    expect([near.storedCount, near.reservedCount, near.freeCount]).toEqual([0, 3, 0]);
    expect([far.storedCount, far.reservedCount, far.freeCount]).toEqual([0, 1, 2]);
    expect(timed3(log, 'NoStorageAvailable')).toEqual([]); // sklad je, len rezervovaný — nie je to „chýba sklad"
  });
});

// ---------------------------------------------------------------------------------------------------------
// NoStorageAvailable
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady: `NoStorageAvailable { berthId, cargoTypeId }` sa emituje, keď jednotka na aprone nemá kam ísť (žiadny
 * sklad, sklad nepripojený k ceste, alebo všetky plné), najviac 1× za hernú hodinu na berth; aspoň raz, kým podmienka
 * trvá. Jednotka ostáva na aprone (nič sa nestratí).
 */
describe('NoStorageAvailable: chýbajúci, nepripojený alebo plný sklad', () => {
  const RUN_TICKS = 3000;

  it('bez skladov: NoStorageAvailable (berth Root, container_teu) najviac 1× za hodinu, žiadny job, 4 jednotky ostávajú na aprone', () => {
    const scenario = f3Scenario('f3_no_yard', 3120, { yards: [], units: 4 });
    const world = World.create(DEFS, MAP, scenario.seed);
    const log = recordRunF3(world, scenario, RUN_TICKS);
    const berth = rootBerthOf(world);

    const events = timed3(log, 'NoStorageAvailable');
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const item of events) expect(item.event).toMatchObject({ berthId: berth.id, cargoTypeId: 'container_teu' });
    expect(maxNoStoragePerBerthHour(log.events)).toBeLessThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(Math.ceil(RUN_TICKS / TICKS_PER_HOUR) + 1);

    expect(timed3(log, 'JobCreated')).toEqual([]);
    expect(jobsOf(world).size).toBe(0);
    expect(world.cargo.countByKind('on_apron')).toBe(4);
    expect(world.cargo.createdCount).toBe(4);
  });

  it('dvor nepripojený k ceste sa ignoruje (NoStorageAvailable, žiadny job); po dobudovaní cesty sa všetko odvezie do dvora', () => {
    const CONNECT_TICK = 2600;
    const scenario = f3Scenario('f3_unconnected_yard', 3121, {
      yards: ['far'],
      vehicles: [STRADDLE],
      units: 4,
      omitRoadCells: [FAR_YARD_OUTSIDE],
      extra: [entry(CONNECT_TICK, placeRoadCommand([FAR_YARD_OUTSIDE]))],
    });
    const world = World.create(DEFS, MAP, scenario.seed);
    const before = recordRunF3(world, scenario, CONNECT_TICK - 100);
    const berth = rootBerthOf(world);
    const far = storageAt(world, FAR_YARD_ORIGIN);

    expect(timed3(before, 'CommandRejected')).toEqual([]);
    expect(timed3(before, 'NoStorageAvailable').length).toBeGreaterThanOrEqual(1);
    expect(timed3(before, 'NoStorageAvailable')[0].event.berthId).toBe(berth.id);
    expect(maxNoStoragePerBerthHour(before.events)).toBeLessThanOrEqual(1);
    expect(timed3(before, 'JobCreated')).toEqual([]);
    expect(jobsOf(world).size).toBe(0);
    expect(world.cargo.countByKind('on_apron')).toBe(4);
    expect(far.reservedCount).toBe(0);
    for (const vehicle of vehiclesById(world)) expect(vehicle.state).toBe('idle'); // žiadny job → vozidlo stojí v depe

    const after = recordRunF3(world, scenario, CONNECT_TICK + 4000);
    expect(timed3(after, 'CommandRejected')).toEqual([]);
    expect(timed3(after, 'JobCreated')).toHaveLength(4);
    for (const item of timed3(after, 'JobCreated')) {
      expect(item.tick).toBeGreaterThanOrEqual(CONNECT_TICK);
      expect(item.event.toModuleId).toBe(far.id);
    }
    expect(world.cargo.countAt('in_storage', far.id)).toBe(4);
    expect(world.cargo.countByKind('on_apron')).toBe(0);
    expect(timed3(after, 'NoStorageAvailable').filter((item) => item.tick > CONNECT_TICK + SLACK_TICKS + 5)).toEqual([]);
    expect(violationsOf(after, 'off_road')).toEqual([]);
  });

  it('plné dvory: 2 dvory s kapacitou 3 prijmú 6 jednotiek, siedma ostane na aprone a hlási sa NoStorageAvailable (≤ 1× za hodinu)', () => {
    const scenario = f3Scenario('f3_yards_full', 3122, { vehicles: TWO_STRADDLES, units: 7 });
    const world = World.create(defsWithYardCapacity(3), MAP, scenario.seed);
    const log = recordRunF3(world, scenario, 7000);
    const near = storageAt(world, NEAR_YARD_ORIGIN);
    const far = storageAt(world, FAR_YARD_ORIGIN);
    const berth = rootBerthOf(world);

    expect(timed3(log, 'CommandRejected')).toEqual([]);
    expect(world.cargo.countAt('in_storage', near.id)).toBe(3);
    expect(world.cargo.countAt('in_storage', far.id)).toBe(3);
    expect(world.cargo.countByKind('on_apron')).toBe(1);
    expect(world.cargo.countByKind('in_vehicle')).toBe(0);
    expect(world.cargo.createdCount).toBe(7);
    for (const yard of [near, far]) {
      expect([yard.storedCount, yard.reservedCount, yard.freeCount]).toEqual([3, 0, 0]);
    }

    expect(timed3(log, 'JobCreated')).toHaveLength(6);
    expect(timed3(log, 'JobDone')).toHaveLength(6);
    expect(timed3(log, 'ShipDeparted')).toHaveLength(1); // aj s jednotkou na aprone loď odpláva (vyložená)

    const events = timed3(log, 'NoStorageAvailable');
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const item of events) expect(item.event).toMatchObject({ berthId: berth.id, cargoTypeId: 'container_teu' });
    expect(maxNoStoragePerBerthHour(log.events)).toBeLessThanOrEqual(1);
  });

  it('RemoveModule: dvor s uloženým nákladom → has_cargo', () => {
    const scenario = f3Scenario('f3_remove_yard', 3123, { vehicles: TWO_STRADDLES, units: 4 });
    const world = World.create(DEFS, MAP, scenario.seed);
    recordRunF3(world, scenario, 4000);
    const near = storageAt(world, NEAR_YARD_ORIGIN);
    const far = storageAt(world, FAR_YARD_ORIGIN);
    expect(near.storedCount).toBe(4);
    expect(validateReasons(world, { type: 'RemoveModule', moduleId: near.id })).toEqual(['has_cargo']);
    expect(validateReasons(world, { type: 'RemoveModule', moduleId: far.id })).toEqual([]); // prázdny dvor ide odstrániť
  });
});

// ---------------------------------------------------------------------------------------------------------
// Priradenie vozidla: kompatibilita a najbližšie voľné vozidlo
// ---------------------------------------------------------------------------------------------------------

/**
 * Predpoklady: `BuyVehicle` nekontroluje kompatibilitu s nákladom (vozidlo `flatbed_bulk` s kategóriou `bulk` sa dá
 * kúpiť); dispatcher priradí job len vozidlu s `cargoCategories` obsahujúcim kategóriu nákladu; bez kompatibilného
 * vozidla ostáva job `open` a vozidlo `idle` na mieste.
 */
describe('dispatcher: vozidlo bez kompatibilnej kategórie job nedostane', () => {
  it('nekompatibilné vozidlo s nižším id ostane idle; všetky joby dostane straddle_carrier a 4 jednotky skončia v sklade', () => {
    const scenario = f3Scenario('f3_compat', 3130, { vehicles: [BULK_VEHICLE_ID, STRADDLE], units: 4 });
    const world = World.create(defsWithBulkVehicle(), MAP, scenario.seed);
    const log = recordRunF3(world, scenario, 4000);
    const [bulkId, straddleId] = boughtVehicleIds(log);

    expect(timed3(log, 'CommandRejected')).toEqual([]);
    expect(must(world.vehicles.get(bulkId), 'flatbed').defId).toBe(BULK_VEHICLE_ID);
    expect(must(world.vehicles.get(straddleId), 'straddle').defId).toBe(STRADDLE);
    expect(bulkId).toBeLessThan(straddleId);

    const assigned = timed3(log, 'JobAssigned');
    expect(assigned).toHaveLength(4);
    for (const item of assigned) expect(item.event.vehicleId).toBe(straddleId);
    expect(world.cargo.countByKind('in_storage')).toBe(4);

    const bulk = vehicleSamples(log, bulkId);
    expect(bulk.every((sample) => sample.state === 'idle' && sample.jobId === null && sample.unitsInside === 0)).toBe(true);
    expect(new Set(bulk.map((sample) => `${String(sample.x)},${String(sample.y)}`)).size).toBe(1);
    expect(timed3(log, 'VehicleStateChanged').filter((item) => item.event.vehicleId === bulkId)).toEqual([]);
  });

  it('len nekompatibilné vozidlo: joby vznikajú, ale ostávajú open bez vozidla; jednotky ostávajú na aprone a nehlási sa chýbajúci sklad', () => {
    const scenario = f3Scenario('f3_compat_none', 3131, { vehicles: [BULK_VEHICLE_ID], units: 4 });
    const world = World.create(defsWithBulkVehicle(), MAP, scenario.seed);
    const log = recordRunF3(world, scenario, 3000);
    const [bulkId] = boughtVehicleIds(log);

    expect(timed3(log, 'CommandRejected')).toEqual([]);
    expect(timed3(log, 'JobAssigned')).toEqual([]);
    expect(log.jobs.size).toBeGreaterThanOrEqual(1);
    expect(log.jobs.size).toBeLessThanOrEqual(4);
    for (const trace of log.jobs.values()) {
      expect(trace.states, `job ${String(trace.jobId)}`).toEqual(['open']);
      expect(trace.vehicleIds).toEqual([]);
    }
    expect(world.cargo.countByKind('on_apron')).toBe(4);
    expect(world.cargo.countByKind('in_vehicle')).toBe(0);
    expect(timed3(log, 'NoStorageAvailable')).toEqual([]);
    expect(must(world.vehicles.get(bulkId), 'flatbed').state).toBe('idle');
    expect(vehicleFsmViolation(log.events)).toBeNull();
  });
});

/**
 * Predpoklad: dispatcher vyberie voľné vozidlo s najmenšou cenou cesty k vyzdvihnutiu, pri zhode menšie id
 * (rozhodnutie 6). Scenár: dvory s kapacitou 2, feeder s 3 TEU (job 1, 2 → blízky dvor, job 3 → ďaleký), vozidlá skončia
 * na rôznych miestach (jedno pri blízkom, druhé pri ďalekom dvore) a druhá loď s 1 TEU (tick 3 000) sa priradí tomu
 * pri blízkom dvore — bez ohľadu na to, ktoré má menšie id.
 */
describe('dispatcher: priradí najbližšie voľné vozidlo (nie najmenšie id)', () => {
  it('po tom, čo jedno vozidlo skončí pri ďalekom a druhé pri blízkom dvore, dostane nový job to pri blízkom dvore', () => {
    const SECOND_SHIP_TICK = 3000;
    const scenario = f3Scenario('f3_closest', 3140, { vehicles: TWO_STRADDLES, units: 3, extra: [entry(SECOND_SHIP_TICK, spawnCommand(1))] });
    const world = World.create(defsWithYardCapacity(2), MAP, scenario.seed);
    const first = recordRunF3(world, scenario, SECOND_SHIP_TICK);
    const near = storageAt(world, NEAR_YARD_ORIGIN);
    const far = storageAt(world, FAR_YARD_ORIGIN);

    // Predpoklad scenára: 3 jednotky uložené (2 blízky, 1 ďaleký), vozidlá idle na dvoch rôznych miestach.
    expect([world.cargo.countAt('in_storage', near.id), world.cargo.countAt('in_storage', far.id)]).toEqual([2, 1]);
    const vehicles = vehiclesById(world);
    expect(vehicles.map((vehicle) => vehicle.state)).toEqual(['idle', 'idle']);
    const atNear = vehicles.filter((vehicle) => sameCell(cellOfPosition(vehicle.x, vehicle.y), NEAR_YARD_OUTSIDE));
    const atFar = vehicles.filter((vehicle) => sameCell(cellOfPosition(vehicle.x, vehicle.y), FAR_YARD_OUTSIDE));
    expect(atNear).toHaveLength(1);
    expect(atFar).toHaveLength(1);
    expect(timed3(first, 'JobCreated')).toHaveLength(3);

    const second = recordRunF3(world, scenario, SECOND_SHIP_TICK + 3000);
    expect(timed3(second, 'CommandRejected')).toEqual([]);
    const created = timed3(second, 'JobCreated');
    expect(created).toHaveLength(1);
    const assigned = timed3(second, 'JobAssigned').filter((item) => item.event.jobId === created[0].event.jobId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0].event.vehicleId).toBe(atNear[0].id);
    expect(world.cargo.countByKind('in_storage')).toBe(4);
  }, 60_000);

  it('pri zhode cien (obe vozidlá stoja na jednej bunke) dostane prvý job vozidlo s menším id, druhý job druhé vozidlo', () => {
    const scenario = f3Scenario('f3_tie', 3141, { vehicles: TWO_STRADDLES, units: 2 });
    const world = World.create(DEFS, MAP, scenario.seed);
    const log = recordRunF3(world, scenario, 3000);
    const ids = boughtVehicleIds(log);
    const assigned = timed3(log, 'JobAssigned').map((item) => item.event);
    expect(assigned).toHaveLength(2);
    expect(assigned[0].vehicleId).toBe(Math.min(...ids));
    expect(assigned[1].vehicleId).toBe(Math.max(...ids));
    expect(assigned.map((item) => item.jobId)).toEqual([...assigned.map((item) => item.jobId)].sort((a, b) => a - b)); // FIFO podľa vzniku jobov
    for (const trace of log.jobs.values()) expect(jobStateViolation(trace.states)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// A* a cache ciest cez verejné API: RemoveRoad → preplánovanie, no_path, obnova
// ---------------------------------------------------------------------------------------------------------

/** Vozidlo, ktoré práve vezie jednotku po nohe berthu (x = 41 alebo 46, y 18–20), a jeho noha. */
interface LegMoment {
  readonly vehicleId: EntityId;
  readonly jobId: EntityId;
  readonly legX: number;
  /** Dolná bunka nohy (napojenie na priečku); jej odstránenie zablokuje priamu trasu k dvoru. */
  readonly bottom: { x: number; y: number };
  /** Bunka hornej spojky susediaca s vonkajšou bunkou berthu na tejto nohe. */
  readonly topNext: { x: number; y: number };
}

/** Vzdialenosť (Manhattan, v bunkách) stredu vozidla od stredu bunky. */
const distanceToCell = (vehicle: { readonly x: number; readonly y: number }, cell: { readonly x: number; readonly y: number }): number =>
  Math.abs(vehicle.x - (cell.x + 0.5)) + Math.abs(vehicle.y - (cell.y + 0.5));

/**
 * Minimálny odstup ostatných vozidiel od buniek rezu: viac než jedna bunka, aby žiadne vozidlo nestálo na bunke rezu
 * ani nemierilo do nej (`RemoveRoad` odmietne len bunku, na ktorej vozidlo stojí — `occupied`).
 */
const CUT_CLEARANCE_CELLS = 1.6;

/**
 * Nájde okamih, keď je vozidlo v `to_dropoff` na bunke (41|46, 18–20) a žiadne vozidlo nie je blízko buniek rezu
 * (`bottom`, `topNext`). Bunka `bottom` je pred vozidlom aspoň 2 bunky, takže na nej ani nestojí, ani nemieri.
 */
function loadedOnLeg(world: World): LegMoment | null {
  const all = vehiclesById(world);
  for (const vehicle of all) {
    if (vehicle.state !== 'to_dropoff' || vehicle.jobId === null) continue;
    const cell = cellOfPosition(vehicle.x, vehicle.y);
    if ((cell.x !== 41 && cell.x !== 46) || cell.y < 18 || cell.y > 20) continue;
    const bottom = { x: cell.x, y: 22 };
    const topNext = cell.x === 41 ? { x: 42, y: 17 } : { x: 45, y: 17 };
    const clear = all.every((other) => distanceToCell(other, bottom) >= CUT_CLEARANCE_CELLS && distanceToCell(other, topNext) >= CUT_CLEARANCE_CELLS);
    if (clear) return { vehicleId: vehicle.id, jobId: vehicle.jobId, legX: cell.x, bottom, topNext };
  }
  return null;
}

/** Scenár + dodatočné príkazy (originál sa nemení). */
const withEntries = (base: Scenario, ...extra: readonly ScenarioEntry[]): Scenario => ({ ...base, commands: [...base.commands, ...extra] });

/** Svet, ktorý beží po okamih `loadedOnLeg` (jednotka vo vozidle na nohe berthu). */
function worldAtLegMoment(id: string, seed: number): { world: World; scenario: Scenario; moment: LegMoment } {
  const scenario = f3Scenario(id, seed, { vehicles: TWO_STRADDLES, units: 4 });
  const world = World.create(DEFS, MAP, scenario.seed);
  runUntilF3(world, scenario, (w) => loadedOnLeg(w) !== null, 8000);
  return { world, scenario, moment: must(loadedOnLeg(world), 'vozidlo s nákladom na nohe berthu') };
}

const TOP_LINK = ROAD_SEGMENTS.topLink;
const onTopLink = (x: number, y: number): boolean => TOP_LINK.some((cell) => sameCell(cell, cellOfPosition(x, y)));

/**
 * Predpoklady: `RemoveRoad` zmení `roadVersion` a cache ciest sa zneplatní (vozidlo nikdy nejazdí po odstránenej
 * bunke); pri existujúcej obchádzke sa vozidlo preplánuje bez `no_path`; bez cesty prejde do `no_path` do
 * `NO_PATH_DEADLINE_TICKS` a stojí, po obnove cesty pokračuje do `repathIntervalTicks + slack` s nákladom vo vozidle.
 */
describe('preplánovanie ciest: RemoveRoad → obchádzka, no_path a obnova', () => {
  const NO_PATH_DEADLINE_TICKS = 10;
  const REPAIR_AFTER_TICKS = 200;
  const RUN_AFTER_TICKS = 5000;

  it('po RemoveRoad dolnej bunky nohy sa vozidlo preplánuje cez hornú spojku (nikdy no_path), nejazdí po odstránenej bunke a job dokončí', () => {
    const { world, scenario, moment } = worldAtLegMoment('f3_reroute', 3201);
    const t0 = world.clock.tick;
    const cut = withEntries(scenario, entry(t0, removeRoadCommand([moment.bottom])));
    const initial = vehicleStates(world);
    const log = recordRunF3(world, cut, t0 + RUN_AFTER_TICKS);

    expect(timed3(log, 'CommandRejected')).toEqual([]);
    expect(timed3(log, 'RoadChanged').some((item) => item.event.cells.some((cell) => sameCell(cell, moment.bottom)))).toBe(true);
    expect(world.grid.at(moment.bottom.x, moment.bottom.y).road).toBe('none');

    const samples = vehicleSamples(log, moment.vehicleId);
    expect(samples.filter((sample) => sample.state === 'no_path')).toEqual([]); // obchádzka existuje → hneď nové trasy
    expect(samples.some((sample) => onTopLink(sample.x, sample.y))).toBe(true); // obchádza hornou spojkou
    expect(samples.some((sample) => sameCell(cellOfPosition(sample.x, sample.y), moment.bottom))).toBe(false);
    expect(timed3(log, 'JobDone').some((item) => item.event.jobId === moment.jobId)).toBe(true);

    // Cache je zneplatnená pre všetky vozidlá: nikto nejazdí po odstránenej bunke, ani v ďalších jobov.
    expect(violationsOf(log, 'off_road')).toEqual([]);
    expect(violationsOf(log, 'teleport')).toEqual([]);
    expect(violationsOf(log, 'stuck')).toEqual([]);
    expect(vehicleFsmViolation(log.events, initial)).toBeNull();
    expect(world.cargo.countByKind('in_storage')).toBe(4);
    expect(world.cargo.countByKind('in_vehicle')).toBe(0);
  }, 60_000);

  it('bez obchádzky prejde vozidlo do no_path, stojí s nákladom a po obnove cesty pokračuje do dvora', () => {
    const { world, scenario, moment } = worldAtLegMoment('f3_no_path', 3202);
    const t0 = world.clock.tick;
    const cells = [moment.bottom, moment.topNext];
    const repairTick = t0 + REPAIR_AFTER_TICKS;
    const scenarioWithCut = withEntries(scenario, entry(t0, removeRoadCommand(cells)), entry(repairTick, placeRoadCommand(cells)));
    const initial = vehicleStates(world);
    const log = recordRunF3(world, scenarioWithCut, t0 + RUN_AFTER_TICKS);

    expect(timed3(log, 'CommandRejected')).toEqual([]);
    const samples = vehicleSamples(log, moment.vehicleId);

    // 1. Do no_path do niekoľkých tickov po zrušení ciest.
    const stuckAt = must(samples.find((sample) => sample.state === 'no_path'), 'vozidlo v stave no_path');
    expect(stuckAt.tick).toBeLessThanOrEqual(t0 + NO_PATH_DEADLINE_TICKS);

    // 2. Kým cesta chýba, vozidlo stojí na mieste, drží jednotku aj job a job sa nedokončí.
    const waiting = samples.filter((sample) => sample.tick >= stuckAt.tick && sample.tick <= repairTick);
    expect(waiting.length).toBeGreaterThan(50);
    for (const sample of waiting) {
      expect(sample.state, `tick ${String(sample.tick)}`).toBe('no_path');
      expect([sample.x, sample.y], `tick ${String(sample.tick)}`).toEqual([stuckAt.x, stuckAt.y]);
      expect(sample.unitsInside).toBe(1);
      expect(sample.jobId).toBe(moment.jobId);
    }
    expect(timed3(log, 'JobDone').filter((item) => item.event.jobId === moment.jobId && item.tick <= repairTick)).toEqual([]);

    // 3. Po obnove cesty opustí no_path do repathIntervalTicks (+ slack) a vráti sa do to_dropoff.
    const resumed = must(samples.find((sample) => sample.tick > repairTick && sample.state !== 'no_path'), 'vozidlo po obnove cesty');
    expect(resumed.tick).toBeLessThanOrEqual(repairTick + RESUME_DEADLINE_TICKS);
    expect(resumed.state).toBe('to_dropoff');
    expect(timed3(log, 'JobDone').some((item) => item.event.jobId === moment.jobId)).toBe(true);

    // 4. Celkovo: nič sa nestratilo, nič sa neteleportovalo, všetko skončilo v sklade.
    expect(violationsOf(log, 'off_road')).toEqual([]);
    expect(violationsOf(log, 'teleport')).toEqual([]);
    expect(violationsOf(log, 'stuck')).toEqual([]);
    expect(vehicleFsmViolation(log.events, initial)).toBeNull();
    expect(world.cargo.countByKind('in_storage')).toBe(4);
    expect(world.cargo.countByKind('in_vehicle')).toBe(0);
    for (const vehicle of vehiclesById(world)) expect(vehicle.state).toBe('idle');
  }, 60_000);

  it('save/load uprostred no_path: obnovený svet má rovnaký hash a po obnove cesty rovnaký priebeh', () => {
    const { world, scenario, moment } = worldAtLegMoment('f3_no_path_save', 3203);
    const t0 = world.clock.tick;
    const cells = [moment.bottom, moment.topNext];
    const repairTick = t0 + REPAIR_AFTER_TICKS;
    const scenarioWithCut = withEntries(scenario, entry(t0, removeRoadCommand(cells)), entry(repairTick, placeRoadCommand(cells)));

    recordRunF3(world, scenarioWithCut, t0 + 60);
    expect(must(world.vehicles.get(moment.vehicleId), 'vozidlo').state).toBe('no_path');

    const restored = restoreCopy(world);
    expect(stateHash(restored)).toBe(stateHash(world));
    const copy = must(restored.vehicles.get(moment.vehicleId), 'vozidlo po obnove');
    expect(copy.state).toBe('no_path');
    expect(copy.jobId).toBe(moment.jobId);
    expect(restored.cargo.countAt('in_vehicle', moment.vehicleId)).toBe(1);

    const untilTick = repairTick + 1500;
    const logOriginal = recordRunF3(world, scenarioWithCut, untilTick);
    const logRestored = recordRunF3(restored, scenarioWithCut, untilTick);
    expect(stateHash(restored)).toBe(stateHash(world));
    expect(logRestored.events).toEqual(logOriginal.events);
    expect(must(restored.vehicles.get(moment.vehicleId), 'vozidlo').state).not.toBe('no_path');
  }, 60_000);

  it('RemoveRoad odmietne bunku, na ktorej stojí vozidlo (occupied); bunka aj hotovosť ostanú; voľná bunka sa dá odstrániť', () => {
    const { world } = layoutWorld('f3_occupied', 3204, { vehicles: TWO_STRADDLES });
    const parked = vehiclesById(world);
    expect(parked.every((vehicle) => sameCell(cellOfPosition(vehicle.x, vehicle.y), DEPOT_OUTSIDE))).toBe(true);

    expect(validateReasons(world, removeRoadCommand([DEPOT_OUTSIDE]))).toEqual(['occupied']);
    const cashBefore = world.cashCents;
    const events = execute(world, removeRoadCommand([DEPOT_OUTSIDE]));
    expect(eventsOfType(events, 'CommandRejected').map((event) => [event.commandType, event.reasons])).toEqual([['RemoveRoad', ['occupied']]]);
    expect(world.grid.at(DEPOT_OUTSIDE.x, DEPOT_OUTSIDE.y).road).toBe('road');
    expect(world.cashCents).toBe(cashBefore);

    // Voľná bunka (nikto na nej nestojí) sa odstrániť dá — len validácia, svet sa nemení.
    expect(commandFromJSON(removeRoadCommand([FAR_YARD_OUTSIDE])).validate(world).ok).toBe(true);
  });
});
