// T04-08 B: dev hook `window.__sim` pre kamióny — `entities().trucks` (stavy pre e2e: kamión vo fronte / v stojisku),
// `rendered().trucks` + `truckStates` (bootstrap ich plní z rendereru a z posledných entít) a `world.cargo.exportedCount`
// (export). Kamióny idú zo skutočného ticku celého reťazca.
import { describe, expect, it } from 'vitest';
import type { TruckVM } from '@render/view-models';
import { installDevHook, truckStateCounts, type DevHook, type RenderedCounts } from '@app/dev-hook';
import { buildFullChain, createApp, frameUntil } from './app-fixtures';

describe('truckStateCounts', () => {
  it('spočíta kamióny podľa stavu; stav bez kamiónov kľúč nemá; prázdny zoznam → prázdny objekt', () => {
    expect(truckStateCounts([])).toEqual({});
    expect(truckStateCounts([{ state: 'waiting' }, { state: 'to_gate' }, { state: 'waiting' }, { state: 'loading' }])).toEqual({ waiting: 2, to_gate: 1, loading: 1 });
  });
});

describe('window.__sim: kamióny', () => {
  it('entities().trucks je vždy aktuálne (stavy TruckVM zo simu) a e2e podľa nich počká na frontu, stojisko aj dock', () => {
    const app = createApp();
    buildFullChain(app, { units: 6 });
    const target: { __sim?: DevHook } = {};
    const hook = installDevHook(app.bridge, { enabled: true, target });
    expect(hook?.entities().trucks).toEqual([]);
    for (const state of ['to_gate', 'gate_queue', 'waiting', 'loading'] as const) {
      frameUntil(app, () => hook?.entities().trucks.some((truck) => truck.state === state) === true, 3000);
      const truck = hook?.entities().trucks.find((candidate) => candidate.state === state) as TruckVM;
      expect(app.world.trucks.get(truck.id as never)?.state).toBe(state);
    }
    expect(hook?.entities().trucks).toBe(app.bridge.entities().trucks);
  });

  it('export: po dojazde kamióna na portál rastie world.cargo.exportedCount a kamión zmizne z entities()', () => {
    const app = createApp();
    buildFullChain(app, { units: 3 });
    const hook = installDevHook(app.bridge, { enabled: true, target: {} });
    expect(hook?.world.cargo.exportedCount).toBe(0);
    frameUntil(app, () => hook?.world.cargo.exportedCount === 3, 6000);
    expect(hook?.entities().trucks).toEqual([]);
  });

  it('rendered() nesie počet TruckView a počty stavov (z bootstrapu); JSON-serializovateľné pre page.evaluate', () => {
    const app = createApp();
    buildFullChain(app, { units: 6 });
    frameUntil(app, () => app.world.trucks.size >= 2, 3000);
    const { trucks } = app.bridge.entities();
    const counts: RenderedCounts = {
      modules: 0,
      cranes: 0,
      ships: 0,
      vehicles: 0,
      trucks: trucks.length,
      truckStates: truckStateCounts(trucks),
      ghostCells: 0,
      ghostConnectors: 0,
      ghostArrows: 0,
      selectionRing: false,
    };
    const hook = installDevHook(app.bridge, { enabled: true, target: {}, rendered: () => counts });
    const rendered = hook?.rendered?.();
    expect(rendered?.trucks).toBe(trucks.length);
    expect(Object.values(rendered?.truckStates ?? {}).reduce((sum, count) => sum + count, 0)).toBe(trucks.length);
    expect(JSON.parse(JSON.stringify(rendered))).toEqual(rendered);
  });
});
