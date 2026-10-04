// T6A-07: inšpektor skladu (rozdelenie import / export) a inšpektor lode pri kotvisku (náklad na palube podľa smeru, lashing
// s progresom) nad živým svetom, do ktorého sa export vloží cez ledger (správanie exportu dodá sim T6A-04/05).
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { Ship } from '@sim/ships';
import { BERTH_STATE_DOCKED, BERTH_STATE_LASHING, inspectorData } from '@app/inspector-data';
import { lashingTotalTicks } from '@app/lashing';
import { YARD_2_ID, YARD_ID, buildLogistics, buyVehicles, createApp, frameUntil, runCommands, type App } from './app-fixtures';
import { acceptRoundtrip, addRoundtripOffer, createExportUnit, moveChain, toShipChain, toStorageChain } from './f6a-fixtures';

const ROOT_BERTH = 1 as EntityId;

function tickUntil(app: App, done: () => boolean, limit = 4000): void {
  for (let i = 0; i < limit && !done(); i += 1) app.world.tick();
  expect(done(), 'podmienka sa do limitu ticků nesplnila').toBe(true);
}

describe('inspectorData: sklad — rozdelenie import / export', () => {
  it('prázdny dvor: split 0 / 0; uložené exporty a importy sa rozdelia podľa smeru (súčet = počet jednotiek v sklade)', () => {
    const app = createApp();
    buildLogistics(app);
    expect(inspectorData(app.bridge, YARD_ID)?.storage?.split).toEqual({ import: 0, export: 0 });

    const roundtrip = addRoundtripOffer(app.world);
    acceptRoundtrip(app.world, roundtrip);
    for (const slot of [0, 1, 2]) {
      const unit = createExportUnit(app.world, roundtrip.exportContract);
      moveChain(app.world, unit.id, toStorageChain(YARD_ID, slot));
    }
    const imported = app.world.cargo.create('container_teu', { kind: 'on_ship', shipId: 9100 as EntityId });
    moveChain(app.world, imported.id, [
      { kind: 'in_crane', craneId: 9101 as EntityId },
      { kind: 'on_apron', berthId: 9102 as EntityId, slot: 0 },
      { kind: 'in_vehicle', vehicleId: 9103 as EntityId },
      { kind: 'in_storage', moduleId: YARD_ID, slot: 3 },
    ]);
    const split = inspectorData(app.bridge, YARD_ID)?.storage?.split;
    expect(split).toEqual({ import: 1, export: 3 });
    expect(app.world.cargo.countAt('in_storage', YARD_ID)).toBe(4);
  });

  it('sklad bez exportu: všetky jednotky sú import (vertical slice po vykládke)', () => {
    const app = createApp();
    buildLogistics(app);
    buyVehicles(app, 2);
    runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }]);
    frameUntil(app, () => app.world.cargo.countByKind('in_storage') === 4, 12000);
    const storages = [YARD_ID, YARD_2_ID].map((id) => inspectorData(app.bridge, id)?.storage?.split ?? { import: 0, export: 0 });
    expect(storages.reduce((sum, split) => sum + split.import, 0)).toBe(4);
    expect(storages.every((split) => split.export === 0)).toBe(true);
  });
});

describe('inspectorData: zakotvená loď — náklad podľa smeru a lashing', () => {
  function dockedFeeder(app: App): Ship {
    app.bridge.dispatch(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
    tickUntil(app, () => app.world.ships.size === 1 && [...app.world.ships.values()][0]?.state === 'docked');
    const [ship] = [...app.world.ships.values()];
    if (ship === undefined) throw new Error('loď chýba');
    return ship;
  }

  it('import + naložený export na palube: cargoSplit a unitsOnBoard zodpovedajú ledgeru', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    const before = inspectorData(app.bridge, ROOT_BERTH)?.dockedShip;
    expect(before?.cargoSplit).toEqual({ import: before?.unitsOnBoard, export: 0 });

    const roundtrip = addRoundtripOffer(app.world);
    acceptRoundtrip(app.world, roundtrip);
    for (let i = 0; i < 2; i += 1) {
      const unit = createExportUnit(app.world, roundtrip.exportContract);
      moveChain(app.world, unit.id, toShipChain(ship.id));
    }
    const after = inspectorData(app.bridge, ROOT_BERTH)?.dockedShip;
    expect(after?.cargoSplit).toEqual({ import: before?.cargoSplit?.import, export: 2 });
    expect(after?.unitsOnBoard).toBe((before?.unitsOnBoard ?? 0) + 2);
    expect(after).not.toHaveProperty('lashing');
  });

  it('loď v stave lashing nesie zostávajúce ticky, mierku času a celkovú dobu z defu (6 ticků na exportnú jednotku + papiere)', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    expect(inspectorData(app.bridge, ROOT_BERTH)?.stateLabel).toBe(BERTH_STATE_DOCKED);
    const roundtrip = addRoundtripOffer(app.world);
    acceptRoundtrip(app.world, roundtrip);
    for (let i = 0; i < 3; i += 1) moveChain(app.world, createExportUnit(app.world, roundtrip.exportContract).id, toShipChain(ship.id));
    ship.transition('lashing');
    ship.lashingTicksLeft = 300;
    expect(inspectorData(app.bridge, ROOT_BERTH)?.stateLabel).toBe(BERTH_STATE_LASHING);
    const lashing = inspectorData(app.bridge, ROOT_BERTH)?.dockedShip?.lashing;
    expect(lashing).toEqual({
      ticksLeft: 300,
      totalTicks: ship.def.lashingTicksPerUnit * 3 + ship.def.paperworkTicks,
      scale: { ticksPerHour: app.world.clock.ticksPerHour, ticksPerDay: app.world.clock.ticksPerDay },
    });
  });

  it('celková doba lashingu zo ShipLashingStarted má prednosť pred vzorcom z defu a zabudne sa po odsune lode', () => {
    const app = createApp();
    const ship = dockedFeeder(app);
    ship.transition('lashing');
    ship.lashingTicksLeft = 300;
    app.bridge.publish([{ type: 'ShipLashingStarted', shipId: ship.id, loadedUnits: 0, ticks: 777 }]);
    expect(inspectorData(app.bridge, ROOT_BERTH)?.dockedShip?.lashing?.totalTicks).toBe(777);
    app.bridge.publish([{ type: 'ShipUndocked', shipId: ship.id }]);
    expect(inspectorData(app.bridge, ROOT_BERTH)?.dockedShip?.lashing?.totalTicks).toBe(ship.def.paperworkTicks);
  });
});

describe('lashingTotalTicks', () => {
  it('lashingTicksPerUnit × naložený export + paperworkTicks (ADR-032 bod 12)', () => {
    expect(lashingTotalTicks({ lashingTicksPerUnit: 6, paperworkTicks: 360 }, 8)).toBe(408);
    expect(lashingTotalTicks({ lashingTicksPerUnit: 0, paperworkTicks: 540 }, 12)).toBe(540);
  });

  it('bez exportu na palube ostanú len papiere; zodpovedá defom feeder a handy', () => {
    const { defs } = createApp().world;
    expect(lashingTotalTicks(defs.ships.get('feeder'), 0)).toBe(360);
    expect(lashingTotalTicks(defs.ships.get('feeder'), 24)).toBe(24 * 6 + 360);
    expect(lashingTotalTicks(defs.ships.get('handy'), 10)).toBe(10 * 6 + 540);
  });
});
