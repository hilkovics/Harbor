// MetricsSystem — krok 11 (T03-06; ARCHITECTURE §6, §7.6; docs/tasks/phase-03.md rozhodnutie 9; ADR-019): traffic += 1 za
// vozidlo na bunke po pohybe (aj viac vozidiel na jednej bunke, aj idle), pri HourClosed traffic × trafficDecayPerHour
// a pod TRAFFIC_ZERO_THRESHOLD 0; traffic ide do save a obnoví sa.
import { describe, expect, it } from 'vitest';
import { MetricsSystem, TRAFFIC_PER_VEHICLE_TICK, TRAFFIC_ZERO_THRESHOLD } from '@sim/systems';
import { World } from '@sim/world';
import { DEFS, MAP } from '../world/world-fixtures';
import { DEPOT_ACCESS, buyVehicle, dispatchWorld } from '../logistics/dispatch-fixtures';

const DECAY = DEFS.logistics.congestion.trafficDecayPerHour;

describe('MetricsSystem', () => {
  it('konštanty: príspevok 1 za vozidlo a tick, hranica vynulovania 1e-3', () => {
    expect(TRAFFIC_PER_VEHICLE_TICK).toBe(1);
    expect(TRAFFIC_ZERO_THRESHOLD).toBe(1e-3);
  });

  it('dve nečinné vozidlá na jednej bunke: traffic += 2 za tick; iné bunky 0', () => {
    const { world, depot } = dispatchWorld();
    buyVehicle(world, depot);
    buyVehicle(world, depot);
    for (let i = 0; i < 5; i++) world.tick();
    const cell = world.grid.at(DEPOT_ACCESS.x, DEPOT_ACCESS.y);
    expect(cell.traffic).toBe(10);
    expect(world.grid.at(DEPOT_ACCESS.x + 1, DEPOT_ACCESS.y).traffic).toBe(0);
  });

  it('pri HourClosed sa traffic všetkých buniek vynásobí decay (po pripočítaní ticku); pod hranicou 0', () => {
    const { world } = dispatchWorld();
    const metrics = new MetricsSystem();
    world.grid.at(40, 17).traffic = 10;
    world.grid.at(41, 17).traffic = TRAFFIC_ZERO_THRESHOLD; // × 0,9 < hranica → 0
    world.grid.at(42, 17).traffic = 2 * TRAFFIC_ZERO_THRESHOLD;
    metrics.tick(world, false);
    expect(world.grid.at(40, 17).traffic).toBe(10);
    metrics.tick(world, true);
    expect(world.grid.at(40, 17).traffic).toBe(10 * DECAY);
    expect(world.grid.at(41, 17).traffic).toBe(0);
    expect(world.grid.at(42, 17).traffic).toBe(2 * TRAFFIC_ZERO_THRESHOLD * DECAY);
  });

  it('počas behu: v ticku hodiny (násobok ticksPerHour) sa uplatní decay; traffic sa uloží a obnoví (riedke, len > 0)', () => {
    const { world, depot } = dispatchWorld();
    buyVehicle(world, depot);
    const hour = world.clock.ticksPerHour;
    const cell = world.grid.at(DEPOT_ACCESS.x, DEPOT_ACCESS.y);
    while (world.clock.tick < hour - 1) world.tick();
    expect(cell.traffic).toBe(hour - 1);
    world.tick();
    expect(cell.traffic).toBe(hour * DECAY);
    const state = world.serialize();
    expect(state.traffic).toEqual([[world.grid.index(DEPOT_ACCESS.x, DEPOT_ACCESS.y), hour * DECAY]]);
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(state)));
    expect(restored.grid.at(DEPOT_ACCESS.x, DEPOT_ACCESS.y).traffic).toBe(hour * DECAY);
  });
});
