// R6 / TR6-05: VM vlakov a priecestí (`trainVMs`, `crossingVMs`), dáta inšpektora železničného terminálu a cestovný poriadok z `world.rail`.
import { describe, expect, it } from 'vitest';
import { crossingVMs, trainVMs } from '@app/entities-vm';
import { railInspectorData, trainTimetableRows } from '@app/rail-inspector-data';
import { railWorld } from '../sim/helpers/r6-rail';

describe('trainVMs', () => {
  it('lokomotíva + vagóny od hlavy, uhol v konvencii renderu (0 = hore), stav a plánovaný odchod', () => {
    const { world, terminal } = railWorld({ timetable: { firstArrivalHour: 0, dwellMinutes: 30 } });
    for (let i = 0; i < 3000 && ![...world.trains.values()].some((train) => train.state === 'dwelling'); i++) world.tick();
    const [vm] = trainVMs(world);
    expect(vm).toBeDefined();
    expect(vm.state).toBe('dwelling');
    expect(vm.cars.map((car) => car.kind)).toEqual(['loco', 'wagon', 'wagon', 'wagon', 'wagon']);
    for (const car of vm.cars) {
      expect(car.angle).toBeGreaterThanOrEqual(0);
      expect(car.angle).toBeLessThan(360);
    }
    expect(vm.departureTick).toBeGreaterThan(world.clock.tick);
    expect(railInspectorData(world, terminal.id)?.currentTrain?.wagons).toHaveLength(4);
    expect(trainTimetableRows(world).some((row) => row.status === 'loading')).toBe(true);
  });

  it('bez vlakov sú VM prázdne, závory otvorené; inšpektor nie-terminálu je null', () => {
    const { world } = railWorld();
    expect(trainVMs(world)).toEqual([]);
    expect(crossingVMs(world).every((crossing) => crossing.barrier === 'open')).toBe(true);
    expect(railInspectorData(world, 999999)).toBeNull();
  });
});
