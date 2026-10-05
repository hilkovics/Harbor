// T6C-06a: nákladové polia render VM pre prázdne kontajnery a prekládku (ADR-034) nad živým svetom s nákladom presunutým cez ledger:
// náklad lode (`cargoSplit.empty`, prekládka do importu na lodi A a do exportu na lodi B, `unitsOnBoard` = súčet), apron (`empty`,
// `lineToken`), rampa (`stagedEmpty`), depo (`depot`), žeriav (`holding.empty`), vozidlo a kamión (`carriesEmpty`), `lastStorageOp.empty`.
// Skutočný tok prázdnych (návrat, depo, M&R, výdaj) overuje `f6c-real-sim.test.ts`; repositioning a prekládku sim dodá T6C-03,
// preto tu idú ako ručne vložené kontrakty a jednotky (ako `helpers/f6a.ts` pri exporte).
import { describe, expect, it } from 'vitest';
import type { CargoUnit, CargoUnitLabelsInput } from '@sim/cargo';
import { commandFromJSON } from '@sim/commands';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { CraneModule, EmptyDepot, LoadingRamp } from '@sim/modules';
import type { Ship } from '@sim/ships';
import { EntitiesVMBuilder, craneVMs, moduleVMs, shipVMs, vehicleVMs } from '@app/entities-vm';
import { ShipSplitCache, emptiesPerDock, lineTokenOf, shipDeckSplit, truckCarriesEmpty } from '@app/cargo-vm';
import { StorageOpTracker } from '@app/storage-ops';
import { RAMP_ID, YARD_ID, buildLandside, buildLogistics, buyVehicles, createApp, runCommands, type App } from './app-fixtures';
import { TEU, addRoundtripOffer, createExportUnit, moveChain, toShipChain } from './f6a-fixtures';
import { addTranshipOffer, createEmptyUnit, emptyLabels, storeEmptyUnit } from './f6c-fixtures';

const ROOT_BERTH = 1 as EntityId;
const ROOT_CRANE = 2 as EntityId;
const EMPTY_DEPOT_ID = 6 as EntityId;

function tickUntil(app: App, done: () => boolean, limit = 4000): void {
  for (let i = 0; i < limit && !done(); i += 1) app.world.tick();
  expect(done(), 'podmienka sa do limitu tickov nesplnila').toBe(true);
}

/** Feeder (4 TEU importu), ktorý dopláva a zakotví pri Root kotvisku. */
function dockedFeeder(app: App): Ship {
  app.bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
  tickUntil(app, () => [...app.world.ships.values()].some((ship) => ship.state === 'docked'));
  const ship = [...app.world.ships.values()].find((candidate) => candidate.state === 'docked');
  if (ship === undefined) throw new Error('loď chýba');
  return ship;
}

/** Aplikácia s dvormi, vozidlami a depom prázdnych (id 6). */
function depotApp(): App {
  const app = createApp();
  buildLogistics(app);
  runCommands(app, [{ type: 'PlaceModule', defId: 'empty_depot', x: 34, y: 18, rotation: 0 }]);
  return app;
}

/** Tranship jednotka (privezená lodou A, voyage A) na palube lode `shipId`. */
function transhipOnShip(app: App, contractId: number, shipId: EntityId, labels: CargoUnitLabelsInput): CargoUnit {
  return app.world.cargo.create(TEU, { kind: 'on_ship', shipId }, contractId as ContractId, labels);
}

describe('ShipVM.cargoSplit: prázdne a prekládka', () => {
  it('prázdne na palube (repositioning): `cargoSplit.empty`, `unitsOnBoard` je súčet import + export + empty; bez prázdnych pole `empty` nie je', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    expect(shipVMs(app.world)[0]?.cargoSplit).toEqual({ import: 4, export: 0 });
    for (let i = 0; i < 3; i += 1) moveChain(app.world, createEmptyUnit(app.world, 'blue_anchor').id, toShipChain(ship.id));
    const [vm] = shipVMs(app.world);
    expect(vm?.cargoSplit).toEqual({ import: 4, export: 0, empty: 3 });
    expect(vm?.unitsOnBoard).toBe(7);
    expect(vm?.unitsOnBoard).toBe(app.world.cargo.countAt('on_ship', ship.id));
  });

  it('prekládka na lodi A (privezie) sa zarátava do importu, na lodi B (odvezie) do exportu; unitsOnBoard ostáva súčtom', () => {
    const asA = createApp();
    const shipA = dockedFeeder(asA);
    const tranship = addTranshipOffer(asA.world);
    tranship.shipId = shipA.id;
    const labels: CargoUnitLabelsInput = { direction: 'tranship', voyageId: tranship.voyageId, lineId: tranship.lineId, destinationPort: tranship.destinationPort, weightClass: 'medium' };
    for (let i = 0; i < 3; i += 1) transhipOnShip(asA, tranship.id, shipA.id, labels);
    const [vmA] = shipVMs(asA.world);
    expect(vmA?.cargoSplit).toEqual({ import: 4 + 3, export: 0 });
    expect(vmA?.unitsOnBoard).toBe(7);

    const asB = createApp();
    const shipB = dockedFeeder(asB);
    const out = addTranshipOffer(asB.world);
    out.outShipId = shipB.id;
    const outLabels: CargoUnitLabelsInput = { direction: 'tranship', voyageId: out.voyageId, lineId: out.lineId, destinationPort: out.destinationPort, weightClass: 'medium' };
    for (let i = 0; i < 3; i += 1) transhipOnShip(asB, out.id, shipB.id, outLabels);
    const [vmB] = shipVMs(asB.world);
    expect(vmB?.cargoSplit).toEqual({ import: 4, export: 3 });
    expect(vmB?.unitsOnBoard).toBe(7);
    expect(shipDeckSplit(asB.world, shipB)).toEqual({ import: 4, export: 3, empty: 0 });
  });

  it('export, prekládka na lodi B a prázdne spolu: každý smer sa započíta raz', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const roundtrip = addRoundtripOffer(app.world);
    for (let i = 0; i < 2; i += 1) moveChain(app.world, createExportUnit(app.world, roundtrip.exportContract).id, toShipChain(ship.id));
    const tranship = addTranshipOffer(app.world);
    tranship.outShipId = ship.id;
    const labels: CargoUnitLabelsInput = { direction: 'tranship', voyageId: tranship.voyageId, lineId: tranship.lineId, destinationPort: tranship.destinationPort, weightClass: 'light' };
    for (let i = 0; i < 2; i += 1) transhipOnShip(app, tranship.id, ship.id, labels);
    moveChain(app.world, createEmptyUnit(app.world, 'golden_wave').id, toShipChain(ship.id));
    const [vm] = shipVMs(app.world);
    expect(vm?.cargoSplit).toEqual({ import: 4, export: 2 + 2, empty: 1 });
    expect(vm?.unitsOnBoard).toBe(9);
  });

  it('lashing bez zapamätanej doby: odchádzajúce jednotky = export (aj prekládka na B) + prázdne', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const tranship = addTranshipOffer(app.world);
    tranship.outShipId = ship.id;
    const labels: CargoUnitLabelsInput = { direction: 'tranship', voyageId: tranship.voyageId, lineId: tranship.lineId, destinationPort: tranship.destinationPort, weightClass: 'light' };
    for (let i = 0; i < 2; i += 1) transhipOnShip(app, tranship.id, ship.id, labels);
    moveChain(app.world, createEmptyUnit(app.world, 'golden_wave').id, toShipChain(ship.id));
    ship.transition('lashing');
    ship.lashingTicksLeft = 50;
    expect(shipVMs(app.world)[0]?.lashing).toEqual({ ticksLeft: 50, ticksTotal: Math.max(50, ship.def.lashingTicksPerUnit * 3 + ship.def.paperworkTicks) });
  });

  it('loď bez kontraktu (voyage neznáma) nie je loď A prekládky: jednotka sa zarátava do exportu', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const labels: CargoUnitLabelsInput = { direction: 'tranship', voyageId: 99 as VoyageId, lineId: 'golden_wave', destinationPort: 'Hamburg', weightClass: 'light' };
    transhipOnShip(app, 7, ship.id, labels);
    expect(shipDeckSplit(app.world, ship)).toEqual({ import: 4, export: 1, empty: 0 });
  });
});

describe('ShipSplitCache', () => {
  it('rozdelenie platí pre revíziu a počet jednotiek: rovnaký kľúč → rovnaký objekt, iná revízia alebo počet → prepočet', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const cache = new ShipSplitCache();
    const first = cache.split(app.world, ship, 1);
    expect(first).toEqual({ import: 4, export: 0, empty: 0 });
    expect(cache.split(app.world, ship, 1)).toBe(first);
    moveChain(app.world, createEmptyUnit(app.world, 'blue_anchor').id, toShipChain(ship.id));
    expect(cache.split(app.world, ship, 1), 'zmena počtu jednotiek bez udalosti').toEqual({ import: 4, export: 0, empty: 1 });

    // zmena, ktorá počet jednotiek nemení (loď B ↔ A prekládky), sa prejaví až s novou revíziou
    const tranship = addTranshipOffer(app.world);
    tranship.shipId = ship.id;
    const labels: CargoUnitLabelsInput = { direction: 'tranship', voyageId: tranship.voyageId, lineId: tranship.lineId, destinationPort: tranship.destinationPort, weightClass: 'light' };
    transhipOnShip(app, tranship.id, ship.id, labels);
    const asImport = cache.split(app.world, ship, 1);
    expect(asImport).toEqual({ import: 5, export: 0, empty: 1 });
    tranship.shipId = undefined;
    tranship.outShipId = ship.id;
    expect(cache.split(app.world, ship, 1), 'rovnaká revízia: cache').toBe(asImport);
    expect(cache.split(app.world, ship, 2)).toEqual({ import: 4, export: 1, empty: 1 });
  });

  it('prune zabudne zaniknuté lode (živá ostáva v cache); `EntitiesVMBuilder` pri rovnakej revízii zachytí zmenu počtu jednotiek na palube', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const cache = new ShipSplitCache();
    const kept = cache.split(app.world, ship, 1);
    cache.prune(app.world);
    expect(cache.split(app.world, ship, 1), 'loď vo svete ostáva v cache').toBe(kept);
    cache.prune({ ships: new Map() });
    const recomputed = cache.split(app.world, ship, 1);
    expect(recomputed, 'zaniknutá loď sa zabudla').not.toBe(kept);
    expect(recomputed).toEqual(kept);

    const builder = new EntitiesVMBuilder();
    expect(builder.build(app.world, 1).ships[0]?.cargoSplit).toEqual({ import: 4, export: 0 });
    moveChain(app.world, createEmptyUnit(app.world, 'blue_anchor').id, toShipChain(ship.id));
    expect(builder.build(app.world, 1).ships[0]?.cargoSplit).toEqual({ import: 4, export: 0, empty: 1 });
  });
});

describe('ModuleVM.apron: prázdne kontajnery', () => {
  it('prázdny na aprone nesie `empty` a `lineToken` linky z lines.json; import a export bez týchto polí', () => {
    const app = createApp();
    const { world } = app;
    const empty = createEmptyUnit(world, 'northern_star');
    const exportUnit = createExportUnit(world, addRoundtripOffer(world).exportContract);
    moveChain(world, empty.id, [
      { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 0 },
      { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
      { kind: 'on_apron', berthId: ROOT_BERTH, slot: 0 },
    ]);
    moveChain(world, exportUnit.id, [
      { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 0 },
      { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
      { kind: 'on_apron', berthId: ROOT_BERTH, slot: 1 },
    ]);
    const berth = moduleVMs(world).find((vm) => vm.id === ROOT_BERTH);
    const token = world.defs.lines.get('northern_star').colorToken;
    expect(token).toMatch(/^line-/);
    expect(berth?.apron?.units).toEqual([
      { slot: 0, unitId: empty.id, typeId: TEU, empty: true, lineToken: token },
      { slot: 1, unitId: exportUnit.id, typeId: TEU },
    ]);
  });

  it('lineTokenOf: jednotka bez linky alebo s linkou, ktorú lines.json nepozná, token nemá', () => {
    const app = createApp();
    const known = createEmptyUnit(app.world, 'blue_anchor');
    expect(lineTokenOf(app.world, known)).toBe(app.world.defs.lines.get('blue_anchor').colorToken);
    expect(lineTokenOf(app.world, { ...known, lineId: 'unknown_line' })).toBeUndefined();
    expect(lineTokenOf(app.world, { ...known, lineId: null })).toBeUndefined();
  });
});

describe('CraneVM.holding: prázdny kontajner', () => {
  it('žeriav s prázdnym kontajnerom v háku: `holding.empty`; s importom bez neho', () => {
    const app = createApp();
    const { world } = app;
    const crane = world.modules.get(ROOT_CRANE);
    if (!(crane instanceof CraneModule)) throw new Error('žeriav chýba');
    const empty = createEmptyUnit(world, 'golden_wave');
    moveChain(world, empty.id, [
      { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 0 },
      { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
      { kind: 'on_apron', berthId: ROOT_BERTH, slot: 0 },
      { kind: 'in_crane', craneId: ROOT_CRANE },
    ]);
    crane.heldUnitId = empty.id;
    expect(craneVMs(world)[0]?.holding).toEqual({ unitId: empty.id, typeId: TEU, empty: true });

    const exportUnit = createExportUnit(world, addRoundtripOffer(world).exportContract);
    moveChain(world, exportUnit.id, [
      { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 1 },
      { kind: 'in_vehicle', vehicleId: 9003 as EntityId },
      { kind: 'on_apron', berthId: ROOT_BERTH, slot: 1 },
      { kind: 'in_crane', craneId: ROOT_CRANE },
    ]);
    crane.heldUnitId = exportUnit.id;
    expect(craneVMs(world)[0]?.holding).toEqual({ unitId: exportUnit.id, typeId: TEU });
  });
});

describe('ModuleVM.ramp: prázdne kontajnery na doku', () => {
  it('prázdny na doku sa zarátava do `staged` a vyčísli v `stagedEmpty` (sim ho do `stagedAt` nepočíta); bez prázdnych pole nie je', () => {
    const app = createApp();
    buildLandside(app);
    const { world } = app;
    const ramp = world.modules.get(RAMP_ID);
    if (!(ramp instanceof LoadingRamp)) throw new Error('rampa chýba');
    const rampVM = (): ReturnType<typeof moduleVMs>[number]['ramp'] => moduleVMs(world).find((vm) => vm.id === RAMP_ID)?.ramp;
    expect(rampVM()).toEqual({ docks: 2, staged: [0, 0], operational: true });
    expect(emptiesPerDock(world, ramp)).toBeNull();

    const empty = createEmptyUnit(world, 'blue_anchor');
    world.cargo.move(empty.id, { kind: 'at_ramp', rampId: RAMP_ID, dock: 1 });
    const second = createEmptyUnit(world, 'blue_anchor');
    world.cargo.move(second.id, { kind: 'at_ramp', rampId: RAMP_ID, dock: 1 });
    const imported = world.cargo.create(TEU, { kind: 'on_ship', shipId: 900 as EntityId }).id;
    world.cargo.move(imported, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(imported, { kind: 'on_apron', berthId: ROOT_BERTH, slot: 0 });
    world.cargo.move(imported, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    ramp.reserve(1);
    world.cargo.move(imported, { kind: 'at_ramp', rampId: RAMP_ID, dock: 1 });
    ramp.commit(1, imported);

    expect(ramp.stagedAt(1)).toBe(1); // sim: len import
    expect(emptiesPerDock(world, ramp)).toEqual([0, 2]);
    expect(rampVM()).toEqual({ docks: 2, staged: [0, 3], operational: true, stagedEmpty: [0, 2] });
  });
});

describe('ModuleVM.depot: depo prázdnych', () => {
  it('dostupné, poškodené a v oprave zo `depotCargoSplit` cez linky, `repairBays` z modulu; bežný dvor `depot` nemá', () => {
    const app = depotApp();
    const { world } = app;
    const depot = world.modules.get(EMPTY_DEPOT_ID);
    if (!(depot instanceof EmptyDepot)) throw new Error('depo chýba');
    const units = [
      storeEmptyUnit(world, 'blue_anchor', EMPTY_DEPOT_ID, 0),
      storeEmptyUnit(world, 'blue_anchor', EMPTY_DEPOT_ID, 1),
      storeEmptyUnit(world, 'golden_wave', EMPTY_DEPOT_ID, 2),
      storeEmptyUnit(world, 'northern_star', EMPTY_DEPOT_ID, 3),
      storeEmptyUnit(world, 'northern_star', EMPTY_DEPOT_ID, 4),
    ];
    world.cargo.setStatus(units[0].id, 'damaged', null);
    world.cargo.setStatus(units[3].id, 'in_repair', world.clock.tick + 100);
    world.cargo.setStatus(units[4].id, 'damaged', null);
    const vms = moduleVMs(world);
    expect(vms.find((vm) => vm.id === EMPTY_DEPOT_ID)?.depot).toEqual({ available: 2, damaged: 2, inRepair: 1, repairBays: depot.repairBays });
    expect(vms.find((vm) => vm.id === YARD_ID)?.depot).toBeUndefined();
    expect(vms.find((vm) => vm.id === YARD_ID)?.storage).toBeDefined();
  });

  it('záložne uložené prázdne v bežnom dvore depo nevytvárajú; cache VM sa prepočíta len pri zmene revízie, `EmptyDamaged` / `EmptyRepaired` ju zmenia', () => {
    const app = depotApp();
    const { world, bridge } = app;
    const unit = storeEmptyUnit(world, 'blue_anchor', EMPTY_DEPOT_ID, 0);
    storeEmptyUnit(world, 'blue_anchor', YARD_ID, 0);
    bridge.publish([{ type: 'EmptyStored', unitId: unit.id, lineId: 'blue_anchor', moduleId: EMPTY_DEPOT_ID, fallback: false }]);
    const depotVm = () => bridge.snapshot().modules.find((vm) => vm.id === EMPTY_DEPOT_ID)?.depot;
    expect(depotVm()).toMatchObject({ available: 1, damaged: 0, inRepair: 0 });
    expect(bridge.snapshot().modules.find((vm) => vm.id === YARD_ID)?.depot).toBeUndefined();

    world.cargo.setStatus(unit.id, 'damaged', null); // zmena stavu nemá CargoMoved
    expect(depotVm(), 'bez udalosti cache').toMatchObject({ available: 1, damaged: 0 });
    const event = { type: 'EmptyDamaged', unitId: unit.id, lineId: 'blue_anchor', moduleId: EMPTY_DEPOT_ID } satisfies SimEvent;
    bridge.publish([event]);
    expect(depotVm()).toMatchObject({ available: 0, damaged: 1, inRepair: 0 });
    world.cargo.setStatus(unit.id, 'in_repair', world.clock.tick + 10);
    bridge.publish([{ type: 'EmptyRepairStarted', unitId: unit.id, lineId: 'blue_anchor', moduleId: EMPTY_DEPOT_ID, untilTick: world.clock.tick + 10 }]);
    expect(depotVm()).toMatchObject({ available: 0, damaged: 0, inRepair: 1 });
    world.cargo.setStatus(unit.id, 'available', null);
    bridge.publish([{ type: 'EmptyRepaired', unitId: unit.id, lineId: 'blue_anchor', moduleId: EMPTY_DEPOT_ID, costCents: 12_000 }]);
    expect(depotVm()).toMatchObject({ available: 1, damaged: 0, inRepair: 0 });
  });
});

describe('VehicleVM.carriesEmpty', () => {
  it('vozidlo s prázdnym kontajnerom ho nesie, vozidlo s exportom nie, vozidlo bez nákladu nemá ani `loaded`', () => {
    const app = depotApp();
    buyVehicles(app, 2);
    const { world } = app;
    const [first, second, idle] = [...world.vehicles.keys()];
    expect(first).toBeDefined();
    const empty = createEmptyUnit(world, 'blue_anchor');
    moveChain(world, empty.id, [
      { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 0 },
      { kind: 'in_vehicle', vehicleId: first as EntityId },
    ]);
    const exportUnit = createExportUnit(world, addRoundtripOffer(world).exportContract);
    moveChain(world, exportUnit.id, [
      { kind: 'at_ramp', rampId: 9002 as EntityId, dock: 1 },
      { kind: 'in_vehicle', vehicleId: second as EntityId },
    ]);
    const vms = vehicleVMs(world);
    expect(vms.find((vm) => vm.id === first)).toMatchObject({ loaded: true, carriesEmpty: true });
    expect(vms.find((vm) => vm.id === second)).toMatchObject({ loaded: true });
    expect(vms.find((vm) => vm.id === second)).not.toHaveProperty('carriesEmpty');
    expect(idle).toBeUndefined();
  });
});

describe('truckCarriesEmpty', () => {
  const TRUCK = 9001 as EntityId;

  it('kým kamión nesie jednotku, rozhoduje jej smer (pamäť sa ignoruje); bez jednotky platí pamäť, bez pamäte `false`', () => {
    const app = createApp();
    const { world } = app;
    expect(truckCarriesEmpty(world, TRUCK, undefined)).toBe(false);
    expect(truckCarriesEmpty(world, TRUCK, false)).toBe(false);
    expect(truckCarriesEmpty(world, TRUCK, true)).toBe(true); // vyložil prázdny: kontajner z príchodu ešte kreslí manéver pri doku

    const empty = createEmptyUnit(world, 'blue_anchor'); // vzniká `in_truck` kamióna 9001
    expect(truckCarriesEmpty(world, TRUCK, false)).toBe(true);
    world.cargo.move(empty.id, { kind: 'at_ramp', rampId: RAMP_ID, dock: 0 });
    expect(truckCarriesEmpty(world, TRUCK, true)).toBe(true);

    const exportUnit = createExportUnit(world, addRoundtripOffer(world).exportContract); // neprázdny náklad v kamióne prepíše pamäť
    expect(truckCarriesEmpty(world, TRUCK, true)).toBe(false);
    expect(exportUnit.direction).toBe('export');
  });

  it('prázdny kontajner má štítky bez kontraktu, voyage a prístavu (ADR-034), takže `emptyLabels` sedí s ledgerom', () => {
    expect(emptyLabels('golden_wave')).toEqual({ direction: 'empty', voyageId: null, lineId: 'golden_wave', destinationPort: null, weightClass: 'light' });
  });
});

describe('StorageOpTracker: prázdny kontajner', () => {
  const inVehicle = { kind: 'in_vehicle', vehicleId: 20 as EntityId } as const;
  const inStorage = (moduleId: number, slot: number) => ({ kind: 'in_storage', moduleId: moduleId as EntityId, slot }) as const;

  it('`isEmpty` rozhodne o `empty` (put aj take); neznáma jednotka a presun mimo skladu ho nenesú', () => {
    const tracker = new StorageOpTracker();
    const put = (unitId: number, moduleId: number, slot: number, tick: number): SimEvent => ({ type: 'CargoMoved', unitId: unitId as EntityId, from: inVehicle, to: inStorage(moduleId, slot), tick });
    const take = (unitId: number, moduleId: number, slot: number, tick: number): SimEvent => ({ type: 'CargoMoved', unitId: unitId as EntityId, from: inStorage(moduleId, slot), to: inVehicle, tick });
    const isEmpty = (unitId: EntityId): boolean => unitId === 7;
    tracker.record([put(7, 4, 3, 10), put(8, 5, 1, 10)], isEmpty);
    expect(tracker.view.get(4)).toEqual({ slot: 3, tick: 10, kind: 'put', empty: true });
    expect(tracker.view.get(5)).toEqual({ slot: 1, tick: 10, kind: 'put' });
    tracker.record([take(7, 4, 3, 20)], isEmpty);
    expect(tracker.view.get(4)).toEqual({ slot: 3, tick: 20, kind: 'take', empty: true });
    tracker.record([put(8, 4, 0, 30)], isEmpty);
    expect(tracker.view.get(4)).toEqual({ slot: 0, tick: 30, kind: 'put' });
    tracker.record([put(7, 6, 2, 40)]); // bez rozlišovača nikdy `empty`
    expect(tracker.view.get(6)).toEqual({ slot: 2, tick: 40, kind: 'put' });
  });

  it('SimBridge: operácia s prázdnym kontajnerom v ledgeri nesie `empty` vo `ModuleVM.lastStorageOp`, import nie', () => {
    const app = depotApp();
    const { world, bridge } = app;
    const empty = storeEmptyUnit(world, 'blue_anchor', EMPTY_DEPOT_ID, 8); // vrstva 0 druhého stĺpca depa (maxTier 8, ADR-039)
    const imported = world.cargo.create(TEU, { kind: 'on_ship', shipId: 900 as EntityId });
    const loc = (unitId: EntityId) => world.cargo.get(unitId)?.location;
    const moveEvent = (unitId: EntityId, moduleId: EntityId, slot: number): SimEvent => ({
      type: 'CargoMoved',
      unitId,
      from: inVehicle,
      to: { kind: 'in_storage', moduleId, slot },
      tick: world.clock.tick,
    });
    expect(loc(empty.id)?.kind).toBe('in_storage');
    bridge.publish([moveEvent(empty.id, EMPTY_DEPOT_ID, 8)]);
    expect(bridge.snapshot().modules.find((vm) => vm.id === EMPTY_DEPOT_ID)?.lastStorageOp).toEqual({ slot: 8, tick: world.clock.tick, kind: 'put', empty: true });
    bridge.publish([moveEvent(imported.id, YARD_ID, 2)]);
    expect(bridge.snapshot().modules.find((vm) => vm.id === YARD_ID)?.lastStorageOp).toEqual({ slot: 2, tick: world.clock.tick, kind: 'put' });
    bridge.publish([moveEvent(99_999 as EntityId, YARD_ID, 5)]); // jednotka, ktorá z ledgera zmizla (exported)
    expect(bridge.snapshot().modules.find((vm) => vm.id === YARD_ID)?.lastStorageOp).toEqual({ slot: 5, tick: world.clock.tick, kind: 'put' });
  });
});
