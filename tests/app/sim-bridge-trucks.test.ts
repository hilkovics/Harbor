// T04-08 B: napojenie kamiónov na SimBridge — `revision` z udalostí Truck*/NoWaitingBay a cache modulov. Cache modulov je
// podľa `revision` (stabilné pole), okrem brány a stojiska, ktorých VM sa porovnáva so živým modulom, lebo sa môže zmeniť
// aj bez udalosti (závora po prestavbe ciest). Celý reťazec ide skutočným tickom (`buildFullChain`), nie fiktívnymi id.
import { describe, expect, it } from 'vitest';
import type { ModuleVM } from '@render/view-models';
import { commandFromJSON } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import { TruckGate } from '@sim/modules';
import { moduleVMs } from '@app/entities-vm';
import { REVISION_EVENTS } from '@app/sim-bridge';
import { CHAIN_GATE_ID, buildFullChain, createApp, frameUntil, type App } from './app-fixtures';

const UNITS = 12;

function chainApp(units = UNITS): App {
  const app = createApp();
  buildFullChain(app, { units });
  return app;
}

const gateVm = (modules: readonly ModuleVM[]): ModuleVM['gate'] => modules.find((vm) => vm.id === CHAIN_GATE_ID)?.gate;

describe('SimBridge: revision a kamióny', () => {
  it('každá udalosť z REVISION_EVENTS (aj TruckSpawned/TruckStateChanged/TruckExited) zvýši revision o 1; iné ho nemenia', () => {
    const app = chainApp();
    const { world, bridge, loop } = app;
    const seen = new Set<string>();
    let bumped = 0;
    for (let i = 0; i < 6000 && world.cargo.exportedCount < UNITS; i += 1) {
      const before = bridge.snapshot().revision;
      const events: readonly SimEvent[] = loop.frame(loop.tickMs);
      const expected = events.filter((event) => REVISION_EVENTS.has(event.type)).length;
      expect(bridge.snapshot().revision - before).toBe(expected);
      bumped += expected;
      for (const event of events) seen.add(event.type);
    }
    expect(world.cargo.exportedCount).toBe(UNITS);
    expect(bumped).toBeGreaterThan(0);
    expect([...seen]).toEqual(expect.arrayContaining(['TruckSpawned', 'TruckStateChanged', 'TruckExited']));
  });

  it('kamióny sa v snapshote objavia a zmiznú so svojimi udalosťami (TruckSpawned / TruckExited)', () => {
    const app = chainApp(2);
    const { world, bridge, loop } = app;
    const live = new Set<number>();
    for (let i = 0; i < 4000 && world.cargo.exportedCount < 2; i += 1) {
      const events = loop.frame(loop.tickMs);
      for (const event of events) {
        if (event.type === 'TruckSpawned') live.add(event.truckId);
        if (event.type === 'TruckExited') live.delete(event.truckId);
      }
      expect(new Set(bridge.snapshot().trucks.map((vm) => vm.id))).toEqual(live);
    }
    expect(live.size).toBe(0);
  });
});

describe('SimBridge: cache modulov s bránou a stojiskom', () => {
  it('celý beh: VM modulov v snapshote sú v každom frame rovnaké ako čerstvo zložené zo sveta (žiadna zastaraná závora ani fronta)', () => {
    const app = chainApp();
    const { world, bridge } = app;
    frameUntil(
      app,
      () => {
        // `lastStorageOp` skladá bridge z udalostí (sim ju nevedie), porovnáva sa zvyšok VM
        const withoutOp = bridge.snapshot().modules.map((vm) => ({ ...vm, lastStorageOp: undefined }));
        expect(JSON.stringify(withoutOp)).toBe(JSON.stringify(moduleVMs(world)));
        return world.cargo.exportedCount === UNITS;
      },
      6000,
    );
  });

  it('pole modulov je pri rovnakej revision tá istá referencia, kým sa hodnoty brány a stojiska nezmenia; nové je len pri zmene', () => {
    const app = chainApp();
    const { world, bridge, loop } = app;
    let stable = 0;
    let replaced = 0;
    let previous = bridge.snapshot();
    for (let i = 0; i < 6000 && world.cargo.exportedCount < UNITS; i += 1) {
      loop.frame(loop.tickMs);
      const now = bridge.snapshot();
      if (now.revision === previous.revision) {
        // bez udalosti sa v bežnej prevádzke nemení žiadny VM modulu → tá istá referencia, aj keď kamióny idú
        expect(now.modules).toBe(previous.modules);
        stable += 1;
      } else if (now.modules !== previous.modules) {
        replaced += 1;
      }
      previous = now;
    }
    expect(stable).toBeGreaterThan(500);
    expect(replaced).toBeGreaterThan(20);
  });

  it('brána sa vo VM otvára a fronta rastie a klesá s kamiónmi (queueLength a open zo simu)', () => {
    const app = chainApp();
    const { world, bridge } = app;
    const gate = world.modules.get(CHAIN_GATE_ID) as TruckGate;
    const seen = { open: false, closed: false, queued: false };
    frameUntil(
      app,
      () => {
        const vm = gateVm(bridge.snapshot().modules);
        expect(vm).toMatchObject({ queueLength: gate.queueLength, open: gate.isOpen });
        if (vm?.open === true) seen.open = true;
        else seen.closed = true;
        if ((vm?.queueLength ?? 0) > 0) seen.queued = true;
        return world.cargo.exportedCount === UNITS;
      },
      6000,
    );
    expect(seen).toEqual({ open: true, closed: true, queued: true });
  });

  it('závora sa vypne aj bez udalosti: prechod dobehne po odstránení výstupnej cesty (bez revision), VM brány sa aj tak obnoví', () => {
    const app = chainApp(30);
    const { world, bridge, loop } = app;
    const gate = world.modules.get(CHAIN_GATE_ID) as TruckGate;
    frameUntil(app, () => gate.isOpen && gate.busyTicksLeft >= 10, 3000);
    // výstupná strana brány zanikne počas prechodu: kamión ostane na čele fronty a prechod sa nedokončí
    const removal = commandFromJSON({ type: 'RemoveRoad', cells: [{ x: 47, y: 33 }, { x: 48, y: 33 }] });
    expect(bridge.validate(removal).ok).toBe(true);
    bridge.dispatch(removal);
    loop.frame(0);
    expect(gate.exitSide).toBeNull();
    let silentFlips = 0;
    for (let i = 0; i < 60; i += 1) {
      const before = bridge.snapshot();
      const events = loop.frame(loop.tickMs);
      const now = bridge.snapshot();
      expect(gateVm(now.modules)).toMatchObject({ queueLength: gate.queueLength, open: gate.isOpen });
      if (gateVm(before.modules)?.open === true && gateVm(now.modules)?.open === false && !events.some((event) => REVISION_EVENTS.has(event.type))) {
        silentFlips += 1;
        expect(now.revision).toBe(before.revision);
        expect(now.modules).not.toBe(before.modules); // pole modulov sa nahradilo zmenou hodnôt, nie revíziou
      }
    }
    // revision-only cache by tu nechala `open: true` až do najbližšej udalosti; porovnanie so živým modulom to opraví
    expect(silentFlips).toBe(1);
  });
});
