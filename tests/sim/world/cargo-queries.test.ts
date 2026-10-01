// Dotazy nad nákladom pre prezentáciu a metriky F6a (T6A-01, ADR-032): import/export na lodi a v sklade
// (`cargoSplitAt`, `shipCargoSplit`, `storageCargoSplit`) a zoskupenie exportu v skladoch (`exportGroupingShare`).
import { describe, expect, it } from 'vitest';
import { IMPORT_LABELS, type CargoLocation, type CargoUnit } from '@sim/cargo';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import { StoredCargoIndex } from '@sim/logistics';
import { World, exportGroupingShare, shipCargoSplit, storageCargoSplit } from '@sim/world';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS, MAP } from './world-fixtures';

const BOOKING = 4 as ContractId;
const exportUnit = (unitId: number, location: CargoLocation): CargoUnit => ({
  id: unitId as EntityId,
  typeId: 'container_teu',
  contractId: BOOKING,
  ...IMPORT_LABELS,
  direction: 'export',
  voyageId: 2 as VoyageId,
  destinationPort: 'Rotterdam',
  hold: null,
  quantity: 1,
  location,
});
const vehicle: CargoLocation = { kind: 'in_vehicle', vehicleId: 900 as EntityId };
const yard = (moduleId: number): CargoLocation => ({ kind: 'in_storage', moduleId: moduleId as EntityId, slot: 0 });

describe('shipCargoSplit / storageCargoSplit', () => {
  it('vertical slice uprostred vykládky: na lodi len import, v sklade len import; neznámy držiteľ → nuly', () => {
    const scenario = loadScenarioFile('vertical_slice');
    const world = World.create(DEFS, MAP, scenario.seed);
    runScenario(world, scenario, 9_000);
    const [ship] = [...world.ships.values()];
    const aboard = world.cargo.countAt('on_ship', ship.id);
    expect(aboard).toBeGreaterThan(0);
    expect(shipCargoSplit(world, ship.id)).toEqual({ import: aboard, export: 0 });
    const yards = [...world.modules.values()].filter((module) => module.kind === 'storage');
    const stored = yards.reduce((sum, module) => sum + storageCargoSplit(world, module.id).import, 0);
    expect(stored).toBe(world.cargo.countByKind('in_storage'));
    expect(yards.every((module) => storageCargoSplit(world, module.id).export === 0)).toBe(true);
    expect(shipCargoSplit(world, 999_999 as EntityId)).toEqual({ import: 0, export: 0 });
  });
});

describe('exportGroupingShare (metrika exportGroupingPct)', () => {
  it('podiel jednotiek kontraktu v sklade s ich najväčším počtom; bez uskladnených null', () => {
    const index = new StoredCargoIndex();
    const world = { storedCargo: index };
    expect(exportGroupingShare(world, BOOKING)).toBeNull();
    const store = (unitId: number, storageId: number): void => index.cargoMoved(exportUnit(unitId, vehicle), yard(storageId));
    store(1, 30);
    expect(exportGroupingShare(world, BOOKING)).toBe(1);
    store(2, 20);
    store(3, 30);
    store(4, 40);
    // sklady 20: 1, 30: 2, 40: 1 → 2 / 4
    expect(exportGroupingShare(world, BOOKING)).toBe(0.5);
    store(5, 20);
    store(6, 20);
    // 20: 3 z 6
    expect(exportGroupingShare(world, BOOKING)).toBe(0.5);
    index.cargoMoved(exportUnit(4, yard(40)), vehicle);
    expect(exportGroupingShare(world, BOOKING)).toBe(3 / 5);
    expect(exportGroupingShare(world, 99 as ContractId)).toBeNull();
  });
});
