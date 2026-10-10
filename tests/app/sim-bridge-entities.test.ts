import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import type { SimEvent, SimEventType } from '@sim/events';
import { REVISION_EVENTS } from '@app/sim-bridge';
import { createApp } from './app-fixtures';

/** Vzorové id entity (id sú v simu branded). */
const SAMPLE_ID = 9 as EntityId;
const SAMPLE_CONTRACT = 9 as ContractId;
const SAMPLE_VOYAGE = 9 as VoyageId;

/** Jeden vzorový výskyt každej udalosti, ktorá musí zvyšovať `revision`. */
const REVISION_SAMPLES: readonly SimEvent[] = [
  { type: 'ModulePlaced', moduleId: SAMPLE_ID, defId: 'berth_standard', x: 0, y: 0, rotation: 0, cells: [] },
  { type: 'ModuleRemoved', moduleId: SAMPLE_ID, defId: 'berth_standard', cells: [] },
  { type: 'RoadChanged', cells: [] },
  { type: 'ShipSpawned', shipId: SAMPLE_ID, classId: 'feeder', cargoTypeId: 'container_teu', units: 1 },
  { type: 'ShipDocked', shipId: SAMPLE_ID, berthIds: [] },
  { type: 'ShipUndocked', shipId: SAMPLE_ID },
  { type: 'ShipDeparted', shipId: SAMPLE_ID },
  { type: 'CraneCycleDone', craneId: SAMPLE_ID, unitId: SAMPLE_ID },
  { type: 'CraneBlocked', craneId: SAMPLE_ID, berthId: SAMPLE_ID, reason: 'apron_full' },
  { type: 'CargoMoved', unitId: SAMPLE_ID, from: { kind: 'exported' }, to: { kind: 'exported' }, tick: 1 },
  { type: 'VehicleBought', vehicleId: SAMPLE_ID, defId: 'straddle_carrier', depotId: SAMPLE_ID },
  { type: 'VehicleSold', vehicleId: SAMPLE_ID },
  { type: 'VehicleStateChanged', vehicleId: SAMPLE_ID, from: 'idle', to: 'to_pickup' },
  { type: 'JobCreated', jobId: SAMPLE_ID, unitIds: [], fromModuleId: SAMPLE_ID, toModuleId: SAMPLE_ID },
  { type: 'JobAssigned', jobId: SAMPLE_ID, vehicleId: SAMPLE_ID },
  { type: 'JobDone', jobId: SAMPLE_ID },
  { type: 'NoStorageAvailable', berthId: SAMPLE_ID, cargoTypeId: 'container_teu' },
  { type: 'JobCancelled', jobId: SAMPLE_ID, reason: 'loading_stopped' },
  { type: 'TruckSpawned', truckId: SAMPLE_ID, blockId: SAMPLE_ID },
  { type: 'TruckStateChanged', truckId: SAMPLE_ID, from: 'to_gate', to: 'gate_queue' },
  { type: 'TruckExited', truckId: SAMPLE_ID, units: 1 },
  { type: 'ContractOffered', contractId: SAMPLE_CONTRACT },
  { type: 'ContractAccepted', contractId: SAMPLE_CONTRACT },
  { type: 'ContractStateChanged', contractId: SAMPLE_CONTRACT, from: 'offered', to: 'accepted' },
  { type: 'ContractCompleted', contractId: SAMPLE_CONTRACT, rewardCents: 1, penaltiesCents: 0, xp: 1, onTime: true },
  { type: 'ContractFailed', contractId: SAMPLE_CONTRACT, penaltiesCents: 1 },
  { type: 'ContractExpired', contractId: SAMPLE_CONTRACT, reason: 'timeout' },
  { type: 'PenaltyApplied', contractId: SAMPLE_CONTRACT, kind: 'demurrage', amountCents: 1 },
  { type: 'GameOver', reason: 'bankruptcy', day: 1 },
  // F6a (T6A-07): booking a lashing menia karty kontraktov a inšpektor lode.
  { type: 'ExportArrived', contractId: SAMPLE_CONTRACT, unitId: SAMPLE_ID, truckId: SAMPLE_ID, gateId: SAMPLE_ID },
  { type: 'UnitRolled', contractId: SAMPLE_CONTRACT, unitId: SAMPLE_ID },
  { type: 'VgmHoldStarted', contractId: SAMPLE_CONTRACT, unitId: SAMPLE_ID, untilTick: 10 },
  { type: 'VgmHoldReleased', contractId: SAMPLE_CONTRACT, unitId: SAMPLE_ID },
  { type: 'UnitLoaded', craneId: SAMPLE_ID, shipId: SAMPLE_ID, unitId: SAMPLE_ID, contractId: SAMPLE_CONTRACT, lastMinute: false, outOfOrder: false },
  { type: 'ShipLashingStarted', shipId: SAMPLE_ID, loadedUnits: 1, ticks: 10 },
  { type: 'ExportShipped', shipId: SAMPLE_ID, units: 1 },
  { type: 'BookingPenaltyApplied', contractId: SAMPLE_CONTRACT, kind: 'rolled', units: 1, amountCents: 1 },
  // F6c (T6C-05): prázdne (stav jednotky v depe bez `CargoMoved`) a prekládka menia karty a inšpektor depa.
  { type: 'EmptyReturned', unitId: SAMPLE_ID, lineId: 'blue_anchor', truckId: SAMPLE_ID, gateId: SAMPLE_ID },
  { type: 'EmptyStored', unitId: SAMPLE_ID, lineId: 'blue_anchor', moduleId: SAMPLE_ID, fallback: false },
  { type: 'EmptyDamaged', unitId: SAMPLE_ID, lineId: 'blue_anchor', moduleId: SAMPLE_ID },
  { type: 'EmptyRepairStarted', unitId: SAMPLE_ID, lineId: 'blue_anchor', moduleId: SAMPLE_ID, untilTick: 10 },
  { type: 'EmptyRepaired', unitId: SAMPLE_ID, lineId: 'blue_anchor', moduleId: SAMPLE_ID, costCents: 1 },
  { type: 'EmptyPickedUp', unitId: SAMPLE_ID, lineId: 'blue_anchor', contractId: SAMPLE_CONTRACT, truckId: SAMPLE_ID },
  { type: 'TranshipMissed', contractId: SAMPLE_CONTRACT, units: 1, outVoyageId: SAMPLE_VOYAGE },
  { type: 'TranshipRescued', contractId: SAMPLE_CONTRACT, units: 1, outVoyageId: SAMPLE_VOYAGE },
  { type: 'TranshipSold', contractId: SAMPLE_CONTRACT, units: 1 },
  // R6 (TR6-05): vlak príde / odíde, export po koľaji dorazil.
  { type: 'TrainArrived', trainId: SAMPLE_ID, terminalId: SAMPLE_ID, delayTicks: 0, exportUnits: 0 },
  { type: 'TrainDeparted', trainId: SAMPLE_ID, units: 0, undeliveredUnits: 0, turnaroundTicks: 1 },
  { type: 'TrainExportArrived', contractId: SAMPLE_CONTRACT, unitId: SAMPLE_ID, trainId: SAMPLE_ID },
];

/** Udalosti, ktoré štruktúru nemenia (čas a peniaze majú vlastné polia snapshotu). */
const NEUTRAL_SAMPLES: readonly SimEvent[] = [
  { type: 'TickAdvanced', tick: 1 },
  { type: 'HourClosed', tick: 1 },
  { type: 'DayClosed', tick: 1 },
  { type: 'MonthClosed', tick: 1 },
  { type: 'MoneyChanged', cashCents: 0, deltaCents: 0, reason: 'road_capex' },
  { type: 'GameSpeedChanged', speed: 1 },
  { type: 'CommandRejected', commandType: 'PlaceRoad', reasons: [] },
  { type: 'DayClosedSummary', day: 0, summary: { day: 0, incomeCents: {}, expenseCents: {}, cashEndCents: 0 } },
  { type: 'MonthlyReport', month: 0, summary: { month: 0, incomeCents: {}, expenseCents: {}, cashEndCents: 0 } },
  // F6a: cut-off sa na kartách odpočítava z ticku, ostatné sú čisto pohybové (kamión / žeriav).
  { type: 'CutoffWarning', contractId: SAMPLE_CONTRACT, cutoffTick: 10 },
  { type: 'CutoffPassed', contractId: SAMPLE_CONTRACT, arrivedUnits: 1, bookedUnits: 2 },
  { type: 'DualCycle', craneId: SAMPLE_ID, shipId: SAMPLE_ID, loadedUnitId: SAMPLE_ID, unloadedUnitId: SAMPLE_ID },
  { type: 'TruckUnloaded', truckId: SAMPLE_ID, blockId: SAMPLE_ID, unitId: SAMPLE_ID, dualTransaction: false },
  // F6c: kamión po prázdny kontajner odišiel prázdny — počítadlá kariet sa nehýbu (toast ide z udalosti).
  { type: 'EmptyPickupMissed', lineId: 'blue_anchor', contractId: SAMPLE_CONTRACT, truckId: SAMPLE_ID },
];

const spawnFeeder = (bridge: ReturnType<typeof createApp>['bridge'], units = 4): void => {
  bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units }));
};

describe('WorldSnapshot v2: speeds a defs', () => {
  it('speeds sú time.speeds zo simu (rovnaká referencia, nie natvrdo v UI)', () => {
    const { world, bridge } = createApp();
    expect(bridge.snapshot().speeds).toBe(world.defs.time.speeds);
    expect(bridge.snapshot().speeds).toEqual([0, 1, 2, 4, 8]);
  });

  it('bridge.defs sú defy sveta', () => {
    const { world, bridge } = createApp();
    expect(bridge.defs).toBe(world.defs);
  });
});

describe('WorldSnapshot v2: revision', () => {
  it('REVISION_EVENTS obsahuje presne udalosti z kariet T02-09, T03-10, T04-08, T05-07 a T6C-05 (vrátane Truck*, udalostí kontraktov, prázdnych a prekládky) a vzorky ich pokrývajú', () => {
    const expected: SimEventType[] = [
      'ModulePlaced',
      'ModuleRemoved',
      'RoadChanged',
      'ShipSpawned',
      'ShipDocked',
      'ShipUndocked',
      'ShipDeparted',
      'CraneCycleDone',
      'CraneBlocked',
      'CargoMoved',
      'VehicleBought',
      'VehicleSold',
      'VehicleStateChanged',
      'JobCreated',
      'JobAssigned',
      'JobDone',
      'NoStorageAvailable',
      'JobCancelled',
      'TruckSpawned',
      'TruckStateChanged',
      'TruckExited',
      'ContractOffered',
      'ContractAccepted',
      'ContractStateChanged',
      'ContractCompleted',
      'ContractFailed',
      'ContractExpired',
      'PenaltyApplied',
      'GameOver',
      'ExportArrived',
      'UnitRolled',
      'VgmHoldStarted',
      'VgmHoldReleased',
      'UnitLoaded',
      'ShipLashingStarted',
      'ExportShipped',
      'BookingPenaltyApplied',
      'EmptyReturned',
      'EmptyStored',
      'EmptyDamaged',
      'EmptyRepairStarted',
      'EmptyRepaired',
      'EmptyPickedUp',
      'TranshipMissed',
      'TranshipRescued',
      'TranshipSold',
      'TrainArrived',
      'TrainDeparted',
      'TrainExportArrived',
    ];
    expect([...REVISION_EVENTS].sort()).toEqual([...expected].sort());
    expect(REVISION_SAMPLES.map((event) => event.type).sort()).toEqual([...expected].sort());
  });

  it('nový bridge má revision 0', () => {
    expect(createApp().bridge.snapshot().revision).toBe(0);
  });

  it.each(REVISION_SAMPLES.map((event) => [event.type, event] as const))('udalosť %s zvýši revision o 1', (_type, event) => {
    const { bridge } = createApp();
    bridge.publish([event]);
    expect(bridge.snapshot().revision).toBe(1);
  });

  it.each(NEUTRAL_SAMPLES.map((event) => [event.type, event] as const))('udalosť %s revision nemení', (_type, event) => {
    const { bridge } = createApp();
    bridge.publish([event]);
    expect(bridge.snapshot().revision).toBe(0);
  });

  it('každá udalosť z frame sa počíta zvlášť', () => {
    const { bridge } = createApp();
    bridge.publish([REVISION_SAMPLES[0] as SimEvent, REVISION_SAMPLES[2] as SimEvent, NEUTRAL_SAMPLES[0] as SimEvent, REVISION_SAMPLES[9] as SimEvent]);
    // (poradie vzoriek: ModulePlaced, ModuleRemoved, RoadChanged, …, CargoMoved na indexe 9)
    expect(bridge.snapshot().revision).toBe(3);
  });

  it('zmena revision vytvorí nový snapshot aj bez zmeny ticku, rýchlosti a hotovosti; potom je referencia stabilná', () => {
    const { bridge } = createApp();
    const before = bridge.snapshot();
    bridge.publish([{ type: 'RoadChanged', cells: [] }]);
    const after = bridge.snapshot();
    expect(after).not.toBe(before);
    expect(after.tick).toBe(before.tick);
    expect(bridge.snapshot()).toBe(after);
  });

  it('odberatelia snapshotu sa dozvedia o zmene revision (aj bez ticku)', () => {
    const { bridge } = createApp();
    let notified = 0;
    bridge.subscribe(() => notified++);
    bridge.publish([]);
    expect(notified).toBe(0);
    bridge.publish([{ type: 'RoadChanged', cells: [] }]);
    expect(notified).toBe(1);
  });

  it('cez GameLoop: spawn lode a jej vykládka zvyšujú revision (ShipSpawned, CargoMoved, CraneCycleDone…)', () => {
    const { world, bridge, loop } = createApp();
    spawnFeeder(bridge);
    loop.frame(0);
    expect(bridge.snapshot().revision).toBe(1); // ShipSpawned
    for (let i = 0; i < 300; i++) loop.frame(loop.tickMs);
    // ShipSpawned + ShipDocked + 4 × (2 × CargoMoved + CraneCycleDone) + ShipUndocked + ShipDeparted
    // + NoStorageAvailable (apron má jednotky a vo svete nie je žiadny sklad; najviac 1× za hernú hodinu)
    // + ContractOffered za každú ponuku, ktorú pool doplní v prvom ticku (F5)
    expect(bridge.snapshot().revision).toBe(1 + 1 + 4 * 3 + 1 + 1 + 1 + world.defs.economy.offersPerDay);
  });
});

describe('WorldSnapshot v2: moduly, žeriavy, lode', () => {
  it('nový svet: Root berth a žeriav na nábreží, žiadna loď — hneď (bez udalosti ModulePlaced)', () => {
    const { bridge } = createApp();
    const snapshot = bridge.snapshot();
    expect(snapshot.modules.map((module) => [module.id, module.defId, module.x, module.y])).toEqual([[1, 'berth_standard', 40, 14]]);
    expect(snapshot.cranes.map((crane) => [crane.id, crane.berthId, crane.x, crane.y, crane.state])).toEqual([[2, 1, 43, 14, 'idle']]);
    expect(snapshot.ships).toEqual([]);
  });

  it('pole modulov má stabilnú referenciu cez ticky bez udalostí; žeriavy a lode sa skladajú s každým tickom', () => {
    const { bridge, loop } = createApp();
    loop.frame(loop.tickMs); // prvý tick doplní pool ponúk (ContractOffered → revision); ďalšie ticky už bez udalostí
    const first = bridge.snapshot();
    loop.frame(loop.tickMs);
    const second = bridge.snapshot();
    expect(second).not.toBe(first);
    expect(second.modules).toBe(first.modules);
    expect(second.cranes).not.toBe(first.cranes);
  });

  it('po zmene revision sa moduly prepočítajú: apron ukáže vyložené jednotky', () => {
    const { bridge, loop } = createApp();
    const before = bridge.snapshot().modules;
    spawnFeeder(bridge);
    for (let i = 0; i < 300; i++) loop.frame(loop.tickMs);
    const after = bridge.snapshot().modules;
    expect(after).not.toBe(before);
    expect(after[0]?.apron?.units).toHaveLength(4);
    expect(before[0]?.apron?.units).toHaveLength(0);
  });

  it('PlaceModule cez dispatch: nový modul je v snapshote po publish (ModulePlaced zvýši revision)', () => {
    const { bridge, loop } = createApp();
    bridge.dispatch(commandFromJSON({ type: 'PlaceModule', defId: 'berth_standard', x: 48, y: 14, rotation: 0 }));
    loop.frame(0);
    const snapshot = bridge.snapshot();
    expect(snapshot.modules.map((module) => module.x)).toEqual([40, 48]);
    expect(snapshot.revision).toBeGreaterThanOrEqual(1);
    expect(snapshot.cashCents).toBe(120_000_000 - 40_000_000);
  });

  it('RemoveModule starter berthu bez refundu (hotovosť sa nezmení) — snapshot sa aj tak zmení cez revision', () => {
    const { world, bridge, loop } = createApp();
    // žeriav najprv (berth so žeriavom nejde odstrániť), potom berth
    bridge.dispatch(commandFromJSON({ type: 'RemoveModule', moduleId: 2 }));
    loop.frame(0);
    expect(bridge.snapshot().cranes).toEqual([]);
    const cash = world.cashCents;
    bridge.dispatch(commandFromJSON({ type: 'RemoveModule', moduleId: 1 }));
    loop.frame(0);
    expect(world.cashCents).toBe(cash); // starter modul nič nevráti (purchaseCostCents 0)
    expect(bridge.snapshot().modules).toEqual([]);
  });
});

describe('prevX/prevY lodí (interpolácia)', () => {
  it('prvý tick po spawne: prev = spawn, curr = spawn posunutý o rýchlosť lode', () => {
    const { world, bridge, loop } = createApp();
    spawnFeeder(bridge);
    loop.frame(loop.tickMs); // applyPending (spawn) + 1 tick
    const ship = bridge.snapshot().ships[0];
    const spawn = world.map.seaLane[0];
    expect(ship).toBeDefined();
    expect(spawn).toBeDefined();
    expect(ship?.prevX).toBe((spawn?.x ?? NaN) + 0.5);
    expect(ship?.prevY).toBe((spawn?.y ?? NaN) + 0.5);
    const moved = Math.hypot((ship?.x ?? 0) - (ship?.prevX ?? 0), (ship?.y ?? 0) - (ship?.prevY ?? 0));
    expect(moved).toBeCloseTo(world.defs.ships.get('feeder').speedCellsPerTick, 10);
  });

  it('prev je poloha PRED posledným tickom, aj keď frame vykoná viac tickov', () => {
    const { world, bridge, loop } = createApp();
    spawnFeeder(bridge);
    loop.frame(loop.tickMs * 2);
    const ship = [...world.ships.values()][0];
    const vm = bridge.snapshot().ships[0];
    expect(ship).toBeDefined();
    // Loď na prvom úseku seaLane ide jedným smerom stálou rýchlosťou: prev = curr − 1 krok.
    const step = world.defs.ships.get('feeder').speedCellsPerTick;
    const dx = (vm?.x ?? 0) - (vm?.prevX ?? 0);
    const dy = (vm?.y ?? 0) - (vm?.prevY ?? 0);
    expect(Math.hypot(dx, dy)).toBeCloseTo(step, 10);
    expect(vm?.x).toBe(ship?.x);
    expect(vm?.y).toBe(ship?.y);
  });

  it('lode sa medzi tickami ďalej posúvajú: prev nasledujúceho snapshotu = curr predchádzajúceho', () => {
    const { bridge, loop } = createApp();
    spawnFeeder(bridge);
    loop.frame(loop.tickMs);
    const a = bridge.snapshot().ships[0];
    loop.frame(loop.tickMs);
    const b = bridge.snapshot().ships[0];
    expect(b?.prevX).toBe(a?.x);
    expect(b?.prevY).toBe(a?.y);
  });

  it('pauza: loď spawnutá počas pauzy nemá predchodcu (prev = curr) a po obnove sa rozbehne', () => {
    const { bridge, loop, world } = createApp();
    world.clock.setSpeed(0);
    spawnFeeder(bridge);
    loop.frame(1000);
    const paused = bridge.snapshot().ships[0];
    expect(paused?.prevX).toBe(paused?.x);
    expect(paused?.prevY).toBe(paused?.y);
    world.clock.setSpeed(1);
    loop.frame(loop.tickMs);
    const running = bridge.snapshot().ships[0];
    expect(running?.prevY).toBe(paused?.y);
    expect(running?.y).not.toBe(paused?.y);
  });

  it('po odplávaní lode sa záznam zabudne a nová loď začína s prev = curr', () => {
    const { world, bridge, loop } = createApp();
    spawnFeeder(bridge);
    for (let i = 0; i < 400; i++) loop.frame(loop.tickMs);
    expect(world.ships.size).toBe(0);
    expect(bridge.snapshot().ships).toEqual([]);
    world.clock.setSpeed(0);
    spawnFeeder(bridge);
    loop.frame(0);
    const vm = bridge.snapshot().ships[0];
    expect(vm).toBeDefined();
    expect(vm?.prevX).toBe(vm?.x);
    expect(vm?.prevY).toBe(vm?.y);
  });
});

describe('SimBridge.entities()', () => {
  it('vracia moduly, žeriavy, lode, vozidlá a kamióny aktuálneho snapshotu (rovnaké polia), bez grid a parcels', () => {
    const { bridge, loop } = createApp();
    spawnFeeder(bridge);
    loop.frame(loop.tickMs);
    const snapshot = bridge.snapshot();
    const entities = bridge.entities();
    expect(entities.modules).toBe(snapshot.modules);
    expect(entities.cranes).toBe(snapshot.cranes);
    expect(entities.ships).toBe(snapshot.ships);
    expect(entities.vehicles).toBe(snapshot.vehicles);
    expect(entities.trucks).toBe(snapshot.trucks);
    expect(Object.keys(entities).sort()).toEqual(['cranes', 'crossings', 'machines', 'modules', 'ships', 'trains', 'trucks', 'vehicles']);
  });

  it('referencia je stabilná, kým sa snapshot nezmení; potom sa obnoví', () => {
    const { bridge, loop } = createApp();
    const first = bridge.entities();
    expect(bridge.entities()).toBe(first);
    loop.frame(loop.tickMs);
    expect(bridge.entities()).not.toBe(first);
  });

  it('je serializovateľné (window.__sim.entities() z Playwrightu)', () => {
    const { bridge, loop } = createApp();
    spawnFeeder(bridge);
    loop.frame(loop.tickMs);
    const entities = bridge.entities();
    expect(JSON.parse(JSON.stringify(entities))).toEqual(entities);
  });

  it('aktuálne aj bez publish: po priamom world.tick() (snapshot sa obnoví podľa ticku)', () => {
    const { world, bridge } = createApp();
    world.enqueue(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
    world.applyPending();
    world.tick();
    expect(bridge.entities().ships).toHaveLength(1);
  });
});
