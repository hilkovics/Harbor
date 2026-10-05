// VehicleSystem — krok 6 (T03-06; ARCHITECTURE §6, §7.3 bod 4; ADR-011, ADR-019): jazda po trase k prístupovej bunke,
// pobyt internalTicks + loadTicks/unloadTicks (tick vstupu = nultý tick), presun jednotky až po manipulácii, JobDone
// v ticku uloženia, no_path s novým pokusom každých repathIntervalTicks, preplánovanie po zmene ciest (aj po načítaní
// save s čakajúcim príznakom), vozidlo stojí na ceste. Rozloženie: tests/sim/logistics/dispatch-fixtures.ts.
import { APRON_MODULES as modulesJson } from '../helpers/apron-modules';
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { StorageModule } from '@sim/modules';
import { World } from '@sim/world';
import { DEFS, MAP, RAW_DEFS } from '../world/world-fixtures';
import { BERTH_ACCESS, YARD_W, YARD_W_ACCESS, buyVehicle, dispatchWorld, execute, placeYard, unitsOnApron } from '../logistics/dispatch-fixtures';
import { itR1Interim } from '../helpers/r1-interim';

interface Timed {
  readonly tick: number;
  readonly event: SimEvent;
}

const STRADDLE = DEFS.vehicles.get('straddle_carrier');
const INTERNAL = DEFS.logistics.defaultInternalTicks;
const REPATH = DEFS.logistics.repathIntervalTicks;

function run(world: World, ticks: number, log: Timed[] = []): Timed[] {
  for (let i = 0; i < ticks; i++) for (const event of world.tick()) log.push({ tick: world.clock.tick, event });
  return log;
}

const tickOf = (log: readonly Timed[], predicate: (event: SimEvent) => boolean): number => {
  const found = log.find((entry) => predicate(entry.event));
  if (found === undefined) throw new Error('udalosť nenastala');
  return found.tick;
};

const stateChange = (vehicleId: EntityId, to: string) => (event: SimEvent): boolean =>
  event.type === 'VehicleStateChanged' && event.vehicleId === vehicleId && event.to === to;

/** Svet: dvor W, jedno vozidlo v depe, jedna jednotka na aprone (job vznikne a priradí sa v prvom ticku). */
function oneJobWorld(defs: DefRegistry = DEFS): { world: World; vehicleId: EntityId; unit: EntityId; yard: StorageModule } {
  const { world, depot } = dispatchWorld(defs);
  const yard = placeYard(world, YARD_W);
  const vehicleId = buyVehicle(world, depot);
  const [unit] = unitsOnApron(world, [0]);
  return { world, vehicleId, unit, yard };
}

describe('cyklus vozidla: depo → apron → dvor', () => {
  it('jazda k najbližšej prístupovej bunke berthu, pobyt 6 + 3 ticky, naloženie, jazda do dvora, pobyt 6 + 3, uloženie + JobDone, idle na mieste', () => {
    const { world, vehicleId, unit, yard } = oneJobWorld();
    const log = run(world, 120);
    const vehicle = world.vehicles.get(vehicleId);
    const arrivedPickup = tickOf(log, stateChange(vehicleId, 'loading'));
    const loaded = tickOf(log, (event) => event.type === 'CargoMoved' && event.unitId === unit && event.to.kind === 'in_vehicle');
    const arrivedDrop = tickOf(log, stateChange(vehicleId, 'unloading'));
    const stored = tickOf(log, (event) => event.type === 'CargoMoved' && event.unitId === unit && event.to.kind === 'in_storage');
    const done = tickOf(log, (event) => event.type === 'JobDone');

    expect(tickOf(log, stateChange(vehicleId, 'to_pickup'))).toBe(1);
    expect(arrivedPickup).toBe(1 + Math.ceil(9 / STRADDLE.speedCellsPerTick) - 1); // (32, 17) → (41, 17): 9 buniek, pohyb od ticku 1
    expect(loaded - arrivedPickup).toBe(INTERNAL + STRADDLE.loadTicks);
    expect(tickOf(log, stateChange(vehicleId, 'to_dropoff'))).toBe(loaded);
    expect(arrivedDrop - loaded).toBe(Math.ceil(4 / STRADDLE.speedCellsPerTick)); // (41, 17) → (37, 17), pohyb od ďalšieho ticku
    expect(stored - arrivedDrop).toBe(INTERNAL + STRADDLE.unloadTicks);
    expect(done).toBe(stored);
    expect(tickOf(log, stateChange(vehicleId, 'idle'))).toBe(stored);

    expect([vehicle?.state, vehicle?.jobId, vehicle?.x, vehicle?.y]).toEqual(['idle', null, YARD_W_ACCESS.x + 0.5, YARD_W_ACCESS.y + 0.5]);
    expect(world.jobs.size).toBe(0);
    expect([yard.storedCount, yard.reservedCount, yard.unitsIn]).toEqual([1, 0, 1]);
    expect(world.cargo.get(unit)?.location).toEqual({ kind: 'in_storage', moduleId: yard.id, slot: 0 });
  });

  it('počas nakladania stojí vozidlo na prístupovej bunke berthu a jednotka je až do konca pobytu na aprone', () => {
    const { world, vehicleId, unit } = oneJobWorld();
    const log: Timed[] = [];
    while (world.vehicles.get(vehicleId)?.state !== 'loading') run(world, 1, log);
    const vehicle = world.vehicles.get(vehicleId);
    expect([vehicle?.x, vehicle?.y]).toEqual([BERTH_ACCESS[0].x + 0.5, BERTH_ACCESS[0].y + 0.5]);
    for (let i = 0; i < INTERNAL + STRADDLE.loadTicks - 1; i++) {
      run(world, 1, log);
      expect(world.cargo.get(unit)?.location.kind).toBe('on_apron');
      expect(vehicle?.state).toBe('loading');
    }
    run(world, 1, log);
    expect(world.cargo.get(unit)?.location).toEqual({ kind: 'in_vehicle', vehicleId });
    expect([vehicle?.state, world.jobs.get(vehicle?.jobId ?? (0 as EntityId))?.state]).toEqual(['to_dropoff', 'moving']);
  });

  it('params.internalTicks skladu prepíše logistics.defaultInternalTicks (pobyt v dvore 2 + 3), berth bez neho ostane 6 + 3', () => {
    const items = modulesJson.items.map((item) => (item.id === 'container_yard_small' ? { ...item, params: { ...item.params, internalTicks: 2 } } : item));
    const defs = DefRegistry.fromRaw({ ...RAW_DEFS, modules: { ...modulesJson, items } });
    const { world, vehicleId, unit } = oneJobWorld(defs);
    const log = run(world, 120);
    const loaded = tickOf(log, (event) => event.type === 'CargoMoved' && event.unitId === unit && event.to.kind === 'in_vehicle');
    const stored = tickOf(log, (event) => event.type === 'CargoMoved' && event.unitId === unit && event.to.kind === 'in_storage');
    expect(loaded - tickOf(log, stateChange(vehicleId, 'loading'))).toBe(INTERNAL + STRADDLE.loadTicks);
    expect(stored - tickOf(log, stateChange(vehicleId, 'unloading'))).toBe(2 + STRADDLE.unloadTicks);
  });

  it('dvor s prístupovou bunkou spoločnou s berthom: jazda k cieľu má nulovú trasu, príchod v ďalšom ticku (krok 12 platí)', () => {
    const { world, depot } = dispatchWorld();
    const shared = placeYard(world, { x: 39, y: 18 }); // rot 180 → vonkajšia bunka (41, 17) = prístupová bunka berthu
    const vehicleId = buyVehicle(world, depot);
    const [unit] = unitsOnApron(world, [0]);
    const log = run(world, 80);
    const loaded = tickOf(log, (event) => event.type === 'CargoMoved' && event.unitId === unit && event.to.kind === 'in_vehicle');
    expect(tickOf(log, stateChange(vehicleId, 'unloading'))).toBe(loaded + 1);
    expect(world.cargo.get(unit)?.location).toEqual({ kind: 'in_storage', moduleId: shared.id, slot: 0 });
    expect(world.vehicles.get(vehicleId)?.state).toBe('idle');
  });

  itR1Interim('dve vozidlá, dve jednotky: obe vozidlá jazdia súčasne, každá jednotka skončí v sklade, joby zmiznú', () => {
    const { world, depot } = dispatchWorld();
    const yard = placeYard(world, YARD_W);
    const ids = [buyVehicle(world, depot), buyVehicle(world, depot)];
    unitsOnApron(world, [0, 1]);
    run(world, 200);
    expect([yard.storedCount, yard.reservedCount, world.jobs.size]).toEqual([2, 0, 0]);
    for (const id of ids) expect(world.vehicles.get(id)?.state).toBe('idle');
  });
});

describe('no_path a preplánovanie', () => {
  it('odstránenie cesty pred vozidlom: no_path v tom istom ticku, stojí na mieste, skúša každých repathIntervalTicks; po obnove cesty pokračuje', () => {
    const { world, vehicleId } = oneJobWorld();
    run(world, 3);
    const vehicle = world.vehicles.get(vehicleId);
    expect(vehicle?.state).toBe('to_pickup');
    const log: Timed[] = [];
    execute(world, { type: 'RemoveRoad', cells: [{ x: 39, y: 17 }] });
    expect(vehicle?.replanPending).toBe(true);
    run(world, 1, log);
    expect(vehicle?.state).toBe('no_path');
    expect([vehicle?.waitTicks, vehicle?.replanPending, vehicle?.cellsAhead]).toEqual([REPATH, false, vehicle?.progress === 0 ? 0 : 1]);
    const halted = [vehicle?.x, vehicle?.y];
    run(world, 2 * REPATH, log);
    expect(vehicle?.state).toBe('no_path');
    expect([vehicle?.x, vehicle?.y]).toEqual(halted);
    expect(log.filter((entry) => entry.event.type === 'VehicleStateChanged')).toHaveLength(1); // len to_pickup → no_path
    execute(world, { type: 'PlaceRoad', cells: [{ x: 39, y: 17 }] });
    const repairedAt = world.clock.tick;
    run(world, REPATH, log);
    const resumed = tickOf(log, stateChange(vehicleId, 'to_pickup'));
    expect(resumed - repairedAt).toBeLessThanOrEqual(REPATH);
    run(world, 200, log);
    expect(world.jobs.size).toBe(0);
    expect(world.vehicles.get(vehicleId)?.state).toBe('idle');
  });

  it('RemoveRoad odmietne bunku pod vozidlom aj cieľovú bunku rozbehnutého úseku (occupied); bunku za vozidlom a mimo neho nie', () => {
    const { world, vehicleId } = oneJobWorld();
    run(world, 2); // vozidlo medzi (32, 17) a (33, 17)
    const vehicle = world.vehicles.get(vehicleId);
    expect(vehicle?.progress).toBeGreaterThan(0);
    const cellOf = (index: number | undefined): { x: number; y: number } => world.grid.coordOf(index ?? -1);
    const reasons = (cell: { x: number; y: number }): readonly string[] => commandFromJSON({ type: 'RemoveRoad', cells: [cell] }).validate(world).reasons;
    expect(cellOf(vehicle?.cell)).toEqual({ x: 32, y: 17 });
    expect(reasons(cellOf(vehicle?.cell))).toEqual(['occupied']);
    expect(reasons(cellOf(vehicle?.nextCell))).toEqual(['occupied']);
    expect(reasons({ x: 31, y: 17 })).toEqual([]);
    expect(reasons({ x: 40, y: 17 })).toEqual([]);
  });

  it('príznak preplánovania dostanú len jazdiace vozidlá; save s čakajúcim príznakom (applyPending bez ticku) sa obnoví a pokračuje rovnako', () => {
    const { world, depot } = dispatchWorld();
    placeYard(world, YARD_W);
    const driving = buyVehicle(world, depot);
    const idle = buyVehicle(world, depot);
    unitsOnApron(world, [0]);
    run(world, 3);
    execute(world, { type: 'PlaceRoad', cells: [{ x: 45, y: 18 }] }); // nová bunka mimo trasy — len zmena siete
    expect([world.vehicles.get(driving)?.replanPending, world.vehicles.get(idle)?.replanPending]).toEqual([true, false]);
    const saved = JSON.parse(JSON.stringify(world.serialize()));
    expect(saved.vehicles.map((entry: { replan: boolean }) => entry.replan)).toEqual([true, false]);
    const restored = World.deserialize(DEFS, MAP, saved);
    expect(restored.vehicles.get(driving)?.replanPending).toBe(true);
    const a = run(world, 150);
    const b = run(restored, 150);
    expect(b).toEqual(a);
    expect(JSON.stringify(restored.serialize())).toBe(JSON.stringify(world.serialize()));
  });
});

