// T6C-05: inšpektor depa prázdnych (prázdne podľa linky a stavu, opravárenské miesta), rozdelenie podľa štyroch smerov v sklade
// a na lodi pri kotvisku nad živým svetom, do ktorého sa prázdne a prekládka vložia cez ledger (správanie dodá sim T6C-02 / T6C-03).
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { EmptyDepot } from '@sim/modules';
import type { Ship } from '@sim/ships';
import { BERTH_STATE_LASHING, emptyDepotData, inspectorData } from '@app/inspector-data';
import { YARD_ID, buildLogistics, createApp, runCommands, type App } from './app-fixtures';
import { moveChain, toShipChain } from './f6a-fixtures';
import { TEU, acceptContract, addTranshipOffer, createEmptyUnit, storeEmptyUnit } from './f6c-fixtures';

const ROOT_BERTH = 1 as EntityId;
/** Depo prázdnych postavené po depe vozidiel (3) a dvoroch (4, 5): id 6. */
const EMPTY_DEPOT_ID = 6 as EntityId;

function appWithDepot(): App {
  const app = createApp();
  buildLogistics(app);
  runCommands(app, [{ type: 'PlaceModule', defId: 'empty_depot', x: 34, y: 18, rotation: 0 }]);
  expect(app.world.modules.get(EMPTY_DEPOT_ID)).toBeInstanceOf(EmptyDepot);
  return app;
}

describe('inspectorData: depo prázdnych', () => {
  it('prázdne depo: všetky linky z lines.json v poradí defu s nulami, opravárenské miesta z defu a štyri smery v rozdelení', () => {
    const app = appWithDepot();
    const data = inspectorData(app.bridge, EMPTY_DEPOT_ID);
    expect(data).toMatchObject({ defId: 'empty_depot', displayName: 'Depo prázdnych kontajnerov', kind: 'storage' });
    expect(data?.emptyDepot).toEqual({
      repairBays: 2,
      lines: [
        { lineId: 'blue_anchor', label: 'Blue Anchor Lines', colorToken: 'line-blue', available: 0, damaged: 0, inRepair: 0 },
        { lineId: 'northern_star', label: 'Northern Star Shipping', colorToken: 'line-amber', available: 0, damaged: 0, inRepair: 0 },
        { lineId: 'golden_wave', label: 'Golden Wave Container', colorToken: 'line-teal', available: 0, damaged: 0, inRepair: 0 },
      ],
    });
    expect(data?.storage).toMatchObject({ stored: 0, capacity: 96, unitLabel: 'TEU', split: { import: 0, export: 0, tranship: 0, empty: 0 } });
  });

  it('uložené prázdne sa rozdelia podľa linky a stavu (dostupné / poškodené / v oprave); súčet = uložené jednotky', () => {
    const app = appWithDepot();
    const { world } = app;
    let slot = 0;
    const store = (lineId: string): ReturnType<typeof storeEmptyUnit> => storeEmptyUnit(world, lineId, EMPTY_DEPOT_ID, slot++);
    for (let i = 0; i < 3; i += 1) store('blue_anchor');
    world.cargo.setStatus(store('blue_anchor').id, 'damaged', null);
    world.cargo.setStatus(store('northern_star').id, 'in_repair', world.clock.tick + 50);
    store('golden_wave');
    store('golden_wave');
    const data = inspectorData(app.bridge, EMPTY_DEPOT_ID);
    expect(data?.emptyDepot?.lines.map((line) => [line.lineId, line.available, line.damaged, line.inRepair])).toEqual([
      ['blue_anchor', 3, 1, 0],
      ['northern_star', 0, 0, 1],
      ['golden_wave', 2, 0, 0],
    ]);
    expect(data?.storage).toMatchObject({ stored: 7, split: { import: 0, export: 0, tranship: 0, empty: 7 } });
  });

  it('zmena stavu jednotky (setStatus) sa v inšpektore prejaví hneď po novom čítaní — dáta sa skladajú zo živého ledgera', () => {
    const app = appWithDepot();
    const unit = storeEmptyUnit(app.world, 'blue_anchor', EMPTY_DEPOT_ID, 0);
    expect(inspectorData(app.bridge, EMPTY_DEPOT_ID)?.emptyDepot?.lines[0]).toMatchObject({ available: 1, damaged: 0 });
    app.world.cargo.setStatus(unit.id, 'damaged', null);
    expect(inspectorData(app.bridge, EMPTY_DEPOT_ID)?.emptyDepot?.lines[0]).toMatchObject({ available: 0, damaged: 1 });
    app.world.cargo.setStatus(unit.id, 'in_repair', app.world.clock.tick + 10);
    expect(inspectorData(app.bridge, EMPTY_DEPOT_ID)?.emptyDepot?.lines[0]).toMatchObject({ damaged: 0, inRepair: 1 });
    app.world.cargo.setStatus(unit.id, 'available', null);
    expect(inspectorData(app.bridge, EMPTY_DEPOT_ID)?.emptyDepot?.lines[0]).toMatchObject({ inRepair: 0, available: 1 });
  });

  it('emptyDepotData je čistá funkcia nad svetom: rovnaký výsledok ako inšpektor', () => {
    const app = appWithDepot();
    storeEmptyUnit(app.world, 'golden_wave', EMPTY_DEPOT_ID, 0);
    const depot = app.world.modules.get(EMPTY_DEPOT_ID);
    if (!(depot instanceof EmptyDepot)) throw new Error('depo chýba');
    expect(emptyDepotData(app.world, depot)).toEqual(inspectorData(app.bridge, EMPTY_DEPOT_ID)?.emptyDepot);
  });

  it('bežný dvor nemá `emptyDepot`; prázdne uložené do dvora ako záložný sklad sú v jeho štyroch smeroch', () => {
    const app = appWithDepot();
    storeEmptyUnit(app.world, 'blue_anchor', YARD_ID, 0);
    storeEmptyUnit(app.world, 'blue_anchor', YARD_ID, 1);
    const data = inspectorData(app.bridge, YARD_ID);
    expect(data).not.toHaveProperty('emptyDepot');
    expect(data?.storage?.split).toEqual({ import: 0, export: 0, tranship: 0, empty: 2 });
  });

  it('depo vozidiel a ostatné moduly `emptyDepot` nemajú', () => {
    const app = appWithDepot();
    expect(inspectorData(app.bridge, 3 as EntityId)).not.toHaveProperty('emptyDepot');
    expect(inspectorData(app.bridge, ROOT_BERTH)).not.toHaveProperty('emptyDepot');
  });
});

describe('inspectorData: zakotvená loď — štyri smery', () => {
  function dockedFeeder(app: App): Ship {
    app.bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 2 }));
    for (let i = 0; i < 4000 && !(app.world.ships.size === 1 && [...app.world.ships.values()][0]?.state === 'docked'); i += 1) app.world.tick();
    const [ship] = [...app.world.ships.values()];
    if (ship === undefined) throw new Error('loď chýba');
    return ship;
  }

  it('prekládka (loď A privezie) a prázdne (repositioning) na palube: cargoSplit má štyri smery a unitsOnBoard je ich súčet', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const base = inspectorData(app.bridge, ROOT_BERTH)?.dockedShip;
    const imports = base?.cargoSplit?.import ?? 0;
    const tranship = addTranshipOffer(app.world, { volumeUnits: 3 });
    acceptContract(app.world, tranship);
    for (let i = 0; i < 3; i += 1) {
      app.world.cargo.create(TEU, { kind: 'on_ship', shipId: ship.id }, tranship.id, tranship.spawnLabels);
    }
    for (let i = 0; i < 2; i += 1) moveChain(app.world, createEmptyUnit(app.world, 'blue_anchor').id, toShipChain(ship.id));
    const docked = inspectorData(app.bridge, ROOT_BERTH)?.dockedShip;
    expect(docked?.cargoSplit).toEqual({ import: imports, export: 0, tranship: 3, empty: 2 });
    expect(docked?.unitsOnBoard).toBe(imports + 3 + 2);
  });

  it('lashing sa počíta z odchádzajúcich jednotiek — export, prekládka na lodi B a prázdne', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const tranship = addTranshipOffer(app.world, { volumeUnits: 2 });
    acceptContract(app.world, tranship);
    for (let i = 0; i < 2; i += 1) app.world.cargo.create(TEU, { kind: 'on_ship', shipId: ship.id }, tranship.id, tranship.spawnLabels);
    moveChain(app.world, createEmptyUnit(app.world, 'blue_anchor').id, toShipChain(ship.id));
    ship.transition('lashing');
    ship.lashingTicksLeft = 100;
    const data = inspectorData(app.bridge, ROOT_BERTH);
    expect(data?.stateLabel).toBe(BERTH_STATE_LASHING);
    expect(data?.dockedShip?.lashing?.totalTicks).toBe(ship.def.lashingTicksPerUnit * 3 + ship.def.paperworkTicks);
  });
});
