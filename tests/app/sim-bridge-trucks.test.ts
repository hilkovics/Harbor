// T04-08 B: napojenie kamiónov na SimBridge — `revision` z udalostí Truck* a cache modulov. Cache modulov je
// podľa `revision` (stabilné pole), okrem brány, ktorej VM sa porovnáva so živým modulom, lebo sa môže zmeniť
// aj bez udalosti (závora po prestavbe ciest). Celý reťazec ide skutočným tickom (`buildFullChain`), nie fiktívnymi id.
import { describe, expect, it } from 'vitest';
import type { ModuleVM } from '@render/view-models';
import { commandFromJSON } from '@sim/commands';
import type { SimEvent } from '@sim/events';
import { TruckGate } from '@sim/modules';
import { moduleVMs } from '@app/entities-vm';
import { REVISION_EVENTS } from '@app/sim-bridge';
import { CHAIN_GATE_ID, buildFullChain, createPortApp, frameUntil, type App } from './app-fixtures';

const UNITS = 12;

function chainApp(units = UNITS, vehicles?: number): App {
  const app = createPortApp();
  buildFullChain(app, { units, vehicles });
  return app;
}

/** Pruh brány z VM modulov: `busy` = pruh práve spracúva kamión (má krok), `step` = id kroku. */
const gateVm = (modules: readonly ModuleVM[]): { readonly busy: boolean; readonly step: string | undefined } | undefined => {
  const lane = modules.find((vm) => vm.id === CHAIN_GATE_ID)?.gateLane;
  return lane === undefined ? undefined : { busy: lane.step !== undefined, step: lane.step };
};

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

describe('SimBridge: cache modulov s bránou', () => {
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

  it('pole modulov je pri rovnakej revision tá istá referencia, kým sa hodnoty brány nezmenia; nové je len pri zmene', () => {
    const app = chainApp();
    const { world, bridge, loop } = app;
    let stable = 0;
    let replaced = 0;
    let previous = bridge.snapshot();
    for (let i = 0; i < 6000 && world.cargo.exportedCount < UNITS; i += 1) {
      loop.frame(loop.tickMs);
      const now = bridge.snapshot();
      if (now.revision === previous.revision) {
        // bez udalosti sa pole modulov nahradí len pri skutočnej zmene živých polí (krok pruhu brány, TP, státia); inak tá istá referencia, aj keď kamióny idú
        if (now.modules === previous.modules) stable += 1;
        else {
          expect(JSON.stringify(now.modules)).not.toBe(JSON.stringify(previous.modules));
          replaced += 1;
        }
      } else if (now.modules !== previous.modules) {
        replaced += 1;
      }
      previous = now;
    }
    expect(stable).toBeGreaterThan(500);
    expect(replaced).toBeGreaterThan(20);
  });

  it('pruh brány sa vo VM mení s kamiónmi (krok a stav obsluhy zo simu)', () => {
    const app = chainApp();
    const { world, bridge } = app;
    const gate = world.modules.get(CHAIN_GATE_ID) as TruckGate;
    const seen = { busy: false, free: false };
    frameUntil(
      app,
      () => {
        const vm = gateVm(bridge.snapshot().modules);
        expect(vm?.busy).toBe(gate.currentStep() !== null);
        expect(vm?.step).toBe(gate.currentStep()?.id);
        if (vm?.busy === true) seen.busy = true;
        else seen.free = true;
        return world.cargo.exportedCount === UNITS;
      },
      6000,
    );
    expect(seen).toEqual({ busy: true, free: true });
  });

  // Závora sa po odstránení výstupnej cesty dopočíta z prechodu, ktorý už beží; či jej zníženie padne do ticku s inou
  // revíznou udalosťou (pohyb vozidla, kamión vo fronte), závisí od toku ostatných entít (ADR-029 zmenil jeho načasovanie).
  // Test preto beží reťazec s 1…6 vozidlami (každý v čerstvom, deterministickom behu, prechod číslo 1 začne v inom ticku)
  // a vyžaduje, aby aspoň jedno zníženie prebehlo bez revíznej udalosti — inak by sa „tichá" vetva cache nikdy neoverila.
  const POST_REMOVAL_FRAMES = 60;
  const VEHICLE_COUNTS = [1, 2, 3, 4, 5, 6];

  interface Flips {
    /** Zníženie závory `open → closed` v ticku bez revíznej udalosti (VM sa musí obnoviť porovnaním so živým modulom). */
    readonly silent: number;
    /** Zníženie závory v ticku, v ktorom revíznu udalosť (a teda novú revíziu) vyvolala iná entita. */
    readonly withEvent: number;
  }

  /** Reťazec s `vehicles` vozidlami: odstráni výstupnú cestu brány na začiatku prvého prechodu a spočíta zníženia závory v okne po ňom. */
  function flipsAfterExitRemoval(vehicles: number): Flips {
    const app = chainApp(30, vehicles);
    const { world, bridge, loop } = app;
    const gate = world.modules.get(CHAIN_GATE_ID) as TruckGate;
    frameUntil(app, () => gate.currentStep() !== null, 3000);
    // výstupná strana brány zanikne počas prechodu: kamión ostane na čele fronty a prechod sa nedokončí
    const removal = commandFromJSON({ type: 'RemoveRoad', cells: [{ x: 44, y: 29 }] });
    expect(bridge.validate(removal).reasons).toEqual([]);
    bridge.dispatch(removal);
    loop.frame(0);
    expect(gate.exitSide).toBeNull();
    let silent = 0;
    let withEvent = 0;
    for (let i = 0; i < POST_REMOVAL_FRAMES; i += 1) {
      const before = bridge.snapshot();
      const events = loop.frame(loop.tickMs);
      const now = bridge.snapshot();
      // revision-only cache by pri tichom znížení nechala `open: true` až do najbližšej udalosti; porovnanie so živým modulom to opraví
      expect(gateVm(now.modules)?.busy).toBe(gate.currentStep() !== null);
      if (gateVm(before.modules)?.busy !== true || gateVm(now.modules)?.busy !== false) continue;
      if (events.some((event) => REVISION_EVENTS.has(event.type))) {
        withEvent += 1;
        continue;
      }
      silent += 1;
      expect(now.revision).toBe(before.revision);
      expect(now.modules).not.toBe(before.modules); // pole modulov sa nahradilo zmenou hodnôt, nie revíziou
    }
    return { silent, withEvent };
  }

  it('závora sa vypne aj bez udalosti: prechod dobehne po odstránení výstupnej cesty (bez revision), VM brány sa aj tak obnoví', () => {
    const results = VEHICLE_COUNTS.map(flipsAfterExitRemoval);
    for (const flips of results) expect(flips.silent + flips.withEvent).toBe(1); // každý prechod dobehne práve raz
    expect(results.reduce((sum, flips) => sum + flips.silent, 0)).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
