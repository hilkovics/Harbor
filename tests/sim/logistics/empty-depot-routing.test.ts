// Depo prázdnych a empty handler v rozhodovaní logistiky (T6C-01, ADR-034): plánovač skladu (`YardPlanner`, TR2-06b nahradil alokátory) pre import a export depo
// preskočí (prijíma len `empty`), prázdny ho nájde, empty handler nikdy nedostane job importu
// (`vehicleCarries`) a dotazy snapshotu (`depotCargoSplit`, `terminalEmptySplit`) rozdelia prázdne podľa linky a stavu.
import { describe, expect, it } from 'vitest';
import { EMPTY_WEIGHT_CLASS, IMPORT_LABELS, type CargoLocation, type CargoUnitLabelsInput } from '@sim/cargo';
import type { EntityId, VoyageId } from '@sim/core';
import { assignOpenJobs, chooseVehicle, chooseYardSlot, vehicleCarries } from '@sim/logistics';
import { exportLandsideReadiness } from '@sim/logistics/export-readiness';
import { EmptyDepot, LoadingRamp, StorageModule, type BerthModule } from '@sim/modules';
import { depotCargoSplit, terminalEmptySplit, type World } from '@sim/world';
import { acceptedBooking, exportWorld } from '../helpers/f6a';
import { ROOT_BERTH_ID, YARD_F, YARD_W, buyVehicle, dispatchWorld, execute, placeYard, tickEvents, unitsOnApron } from './dispatch-fixtures';
import { exportLabels, newUnit } from './yard-fixtures';

const EMPTY_HANDLER = 'empty_handler';
const STRADDLE = 'straddle_carrier';

function placeDepot(world: World, cell: { x: number; y: number }, rotation: 0 | 180 = 180): EmptyDepot {
  execute(world, { type: 'PlaceModule', defId: 'empty_depot', x: cell.x, y: cell.y, rotation });
  const depot = world.moduleAt(cell.x, cell.y);
  if (!(depot instanceof EmptyDepot)) throw new Error('empty_depot nie je EmptyDepot');
  return depot;
}

const berthOf = (world: World): BerthModule => world.modules.get(ROOT_BERTH_ID) as BerthModule;

const emptyLabels = (lineId: string): CargoUnitLabelsInput => ({ direction: 'empty', voyageId: null, lineId, destinationPort: null, weightClass: EMPTY_WEIGHT_CLASS });

/** Prázdny kontajner linky `lineId` v sklade `storage` na `slot`, so stavom kvality `status` (cez ledger, ako ho uloží vozidlo). */
function storeEmpty(world: World, storage: StorageModule, slot: number, lineId: string, status: 'available' | 'damaged' | 'in_repair' = 'available'): EntityId {
  const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 800 as EntityId }, null, emptyLabels(lineId));
  const path: CargoLocation[] = [{ kind: 'at_ramp', rampId: 801 as EntityId, dock: 0 }, { kind: 'in_vehicle', vehicleId: 802 as EntityId }, { kind: 'in_storage', moduleId: storage.id, slot }];
  for (const location of path) world.cargo.move(unit.id, location);
  if (status === 'damaged') world.cargo.setStatus(unit.id, 'damaged', null);
  if (status === 'in_repair') {
    world.cargo.setStatus(unit.id, 'damaged', null);
    world.cargo.setStatus(unit.id, 'in_repair', 5_000);
  }
  return unit.id;
}

describe('YardPlanner — smer jednotky', () => {
  const choiceOf = (world: World, labels: CargoUnitLabelsInput, contractId: number | null = null) => chooseYardSlot(world, newUnit(world, labels, contractId), berthOf(world))?.moduleId;

  it('import ide do dvora, aj keď je depo bližšie; prázdny do depa, aj keď je dvor bližšie', () => {
    const { world } = dispatchWorld();
    const depot = placeDepot(world, YARD_W); // bližšie k berthu (vzdialenosť 4)
    const farYard = placeYard(world, YARD_F); // ďalej (9)
    expect(choiceOf(world, IMPORT_LABELS)).toBe(farYard.id);
    expect(choiceOf(world, exportLabels(1, 'medium'), 7)).toBe(farYard.id);
    expect(choiceOf(world, emptyLabels('northern_star'))).toBe(depot.id);
    const nearYard = placeYard(world, { x: 48, y: 19 }); // vzdialenosť 4, ale väčšie id než depo
    expect(choiceOf(world, emptyLabels('northern_star'))).toBe(depot.id);
    expect([depot.id < nearYard.id]).toEqual([true]);
  });

  it('bez dvora import nemá sklad (depo ho neprijme) — dispatcher job nevytvorí a oznámi NoStorageAvailable', () => {
    const { world } = dispatchWorld();
    placeDepot(world, YARD_W);
    const [apronUnit] = unitsOnApron(world, [0]);
    expect(chooseYardSlot(world, world.cargo.get(apronUnit) as never, berthOf(world))).toBeNull();
    const events = world.tick();
    expect(events.filter((event) => event.type === 'JobCreated')).toEqual([]);
    expect(events.filter((event) => event.type === 'NoStorageAvailable')).toHaveLength(1);
    expect(world.jobs.size).toBe(0);
  });

  it('inbound job importu v dispatcheri skončí v dvore, nie v bližšom depe', () => {
    const { world } = dispatchWorld();
    const depot = placeDepot(world, YARD_W);
    const farYard = placeYard(world, YARD_F);
    unitsOnApron(world, [0, 1]);
    const created = tickEvents(world, 'JobCreated');
    expect(created.map((event) => event.toModuleId)).toEqual([farYard.id, farYard.id]);
    expect([depot.reservedCount, farYard.reservedCount]).toEqual([0, 2]);
  });
});

describe('export — depo nie je cieľom ani podmienkou pripravenosti', () => {
  const depotAt = { type: 'PlaceModule' as const, defId: 'empty_depot', x: 42, y: 18, rotation: 0 as const };

  it('exportLandsideReadiness: s depom bez dvora no_storage, s dvorom ready', () => {
    const onlyDepot = exportWorld({ yards: [], extra: [{ atTick: 0, command: depotAt }] });
    expect([...onlyDepot.modules.values()].some((module) => module instanceof EmptyDepot)).toBe(true);
    expect(exportLandsideReadiness(onlyDepot, 'container')).toBe('no_storage');
    const withYard = exportWorld({ yards: ['far'], extra: [{ atTick: 0, command: depotAt }] });
    expect(exportLandsideReadiness(withYard, 'container')).toBe('ready');
  });

  it('plánovač pre export z rampy vyberie dvor, nie bližšie depo', () => {
    const world = exportWorld({ vehicles: [], yards: ['far'], extra: [{ atTick: 0, command: depotAt }] });
    const { exportContract } = acceptedBooking(world, { kind: 'export', booked: 4 });
    const ramp = [...world.modules.values()].find((module): module is LoadingRamp => module instanceof LoadingRamp) as LoadingRamp;
    const labels = { direction: 'export' as const, voyageId: exportContract.voyageId as VoyageId, lineId: exportContract.lineId, destinationPort: exportContract.booking.destinationPort, weightClass: 'medium' as const };
    const unit = world.cargo.create('container_teu', { kind: 'in_truck', truckId: 900 as EntityId }, exportContract.id, labels);
    world.cargo.move(unit.id, { kind: 'at_ramp', rampId: ramp.id, dock: 0 });
    const chosen = world.modules.get(chooseYardSlot(world, world.cargo.get(unit.id) as never, ramp)?.moduleId as EntityId);
    expect(chosen).toBeInstanceOf(StorageModule);
    expect(chosen instanceof EmptyDepot).toBe(false);
  });
});

describe('empty handler — vozidlo len pre prázdne kontajnery', () => {
  it('vehicleCarries: empty_handler len smer empty, straddle carrier každý smer (cargoDirections chýba)', () => {
    const { world, depot } = dispatchWorld();
    const handler = world.vehicles.get(buyVehicle(world, depot, EMPTY_HANDLER));
    const straddle = world.vehicles.get(buyVehicle(world, depot, STRADDLE));
    if (handler === undefined || straddle === undefined) throw new Error('vozidlá sa nekúpili');
    expect(handler.def.cargoDirections).toEqual(['empty']);
    expect(straddle.def.cargoDirections).toBeUndefined();
    expect(vehicleCarries(handler, 'container', 'empty')).toBe(true);
    for (const direction of ['import', 'export', 'tranship'] as const) {
      expect([direction, vehicleCarries(handler, 'container', direction)]).toEqual([direction, false]);
      expect([direction, vehicleCarries(straddle, 'container', direction)]).toEqual([direction, true]);
    }
    expect(vehicleCarries(straddle, 'container', 'empty')).toBe(true);
    expect(vehicleCarries(handler, 'bulk', 'empty')).toBe(false);
  });

  it('job importu empty handler nedostane (zostane open), straddle carrier ho prevezme', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const handlerId = buyVehicle(world, depot, EMPTY_HANDLER);
    unitsOnApron(world, [0]);
    world.tick();
    const [job] = [...world.jobs.values()];
    expect(job.state).toBe('open');
    expect(chooseVehicle(world, job)).toBeUndefined();
    assignOpenJobs(world);
    expect(world.jobs.get(job.id)?.vehicleId).toBeNull();
    const straddleId = buyVehicle(world, depot, STRADDLE);
    expect(chooseVehicle(world, job)?.id).toBe(straddleId);
    expect(straddleId).not.toBe(handlerId);
  });
});

describe('snapshot — prázdne v sklade a v prístave', () => {
  it('depotCargoSplit: prázdne podľa linky (poradie lines.json) a stavu kvality, ostatné jednotky zvlášť', () => {
    const { world } = dispatchWorld();
    const depot = placeDepot(world, YARD_W);
    const yard = placeYard(world, YARD_F);
    storeEmpty(world, depot, 0, 'golden_wave');
    storeEmpty(world, depot, 1, 'blue_anchor');
    storeEmpty(world, depot, 2, 'blue_anchor', 'damaged');
    storeEmpty(world, depot, 3, 'blue_anchor', 'in_repair');
    storeEmpty(world, depot, 4, 'blue_anchor');
    expect(depotCargoSplit(world, depot.id)).toEqual({
      lines: [
        { lineId: 'blue_anchor', available: 2, damaged: 1, in_repair: 1 },
        { lineId: 'northern_star', available: 0, damaged: 0, in_repair: 0 },
        { lineId: 'golden_wave', available: 1, damaged: 0, in_repair: 0 },
      ],
      other: 0,
    });
    const [imported] = unitsOnApron(world, [0]);
    world.cargo.move(imported, { kind: 'in_vehicle', vehicleId: 803 as EntityId });
    world.cargo.move(imported, { kind: 'in_storage', moduleId: yard.id, slot: 0 });
    storeEmpty(world, yard, 1, 'northern_star'); // záložné uloženie prázdneho vo dvore
    expect(depotCargoSplit(world, yard.id)).toEqual({
      lines: [
        { lineId: 'blue_anchor', available: 0, damaged: 0, in_repair: 0 },
        { lineId: 'northern_star', available: 1, damaged: 0, in_repair: 0 },
        { lineId: 'golden_wave', available: 0, damaged: 0, in_repair: 0 },
      ],
      other: 1,
    });
    expect(depotCargoSplit(world, 999_999 as EntityId)).toEqual({ lines: expect.any(Array), other: 0 });
  });

  it('terminalEmptySplit: len uskladnené prázdne celého prístavu; prázdne mimo skladu a import sa nerátajú', () => {
    const { world } = dispatchWorld();
    expect(terminalEmptySplit(world).map((line) => line.lineId)).toEqual(['blue_anchor', 'northern_star', 'golden_wave']);
    const depot = placeDepot(world, YARD_W);
    const yard = placeYard(world, YARD_F);
    storeEmpty(world, depot, 0, 'blue_anchor');
    storeEmpty(world, depot, 1, 'blue_anchor', 'damaged');
    storeEmpty(world, yard, 0, 'golden_wave', 'in_repair');
    world.cargo.create('container_teu', { kind: 'in_truck', truckId: 804 as EntityId }, null, emptyLabels('northern_star')); // ešte v kamióne
    unitsOnApron(world, [0]);
    expect(terminalEmptySplit(world)).toEqual([
      { lineId: 'blue_anchor', available: 1, damaged: 1, in_repair: 0 },
      { lineId: 'northern_star', available: 0, damaged: 0, in_repair: 0 },
      { lineId: 'golden_wave', available: 0, damaged: 0, in_repair: 1 },
    ]);
  });
});
