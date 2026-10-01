// F5b (T5B-07): manéver kamióna pri rampe (T5B-03, `DockManeuver`) proti skutočnému toku kamiónov zo simu (ADR-029, T5B-02).
// Celý reťazec ide skutočným tickom (`buildFullChain`); každý kamión má vlastný `DockManeuver` s hodinami riadenými framom
// (1 frame = 1 tick pri rýchlosti 1×) a pózy zo simu nahrádza jednoduchý prepočet bunky na px (pruhy a oblúky sem nepatria).
//  - `waiting → to_dock → loading → to_gate_out` je jediná cesta kamióna k dokom, dock drží kamión len v `to_dock` a `loading`,
//  - cúvanie sa spustí v tom istom frame ako `to_dock → loading`,
//  - `loading` trvá len `loadTicksPerUnit` tickov (kratšie než manéver), zobrazený kamión preto cúvanie dokončí (po odchode zo
//    simu rýchlejšie, `DOCK_CATCH_UP`) a vyjde až po ňom — nikdy skôr, než ho sim pustil z docku, a nie neskôr než po celom manévri,
//  - zobrazené kamióny sa v jednom doku neprekrývajú.
import { describe, expect, it } from 'vitest';
import { DOCK_REVERSE_MS, DOCK_STOP_MS, DockManeuver, type DockPhase, type PosePx } from '@render/dock-maneuver';
import type { TruckVM } from '@render/view-models';
import type { EntityId } from '@sim/core';
import { LoadingRamp } from '@sim/modules';
import { TRUCK_STATE_TRAITS, type TruckState } from '@sim/trucks';
import { buildFullChain, createApp } from './app-fixtures';

const UNITS = 12;
const MAX_FRAMES = 6000;
/** Mierka sveta pre prepočet bunky na px — manéver na nej nezávisí, len ju potrebuje. */
const CELL_PX = 64;

interface Frame {
  readonly frame: number;
  readonly from: string;
  readonly to: string;
}

interface Trace {
  readonly transitions: Frame[];
  /** Fázy manévru v poradí, v akom sa menili (bez opakovania), s framom prvého pozorovania. */
  readonly phases: { readonly frame: number; readonly phase: DockPhase }[];
}

interface Played {
  readonly traces: ReadonlyMap<number, Trace>;
  readonly exported: number;
  readonly tickMs: number;
  /** Najviac zobrazených kamiónov v jednom doku (fáza `entering` alebo `docked`) naraz. */
  readonly maxShownPerDock: number;
}

const simPose = (vm: TruckVM): PosePx => ({ x: vm.x * CELL_PX, y: vm.y * CELL_PX, angle: vm.heading });

function play(): Played {
  const app = createApp();
  buildFullChain(app, { units: UNITS });
  const { world, bridge, loop } = app;
  const traces = new Map<number, Trace>();
  const maneuvers = new Map<number, DockManeuver>();
  let clockMs = 0;
  let maxShownPerDock = 0;
  const traceOf = (id: number): Trace => {
    const known = traces.get(id);
    if (known !== undefined) return known;
    const created: Trace = { transitions: [], phases: [] };
    traces.set(id, created);
    return created;
  };

  for (let frame = 1; frame <= MAX_FRAMES && world.cargo.exportedCount < UNITS; frame += 1) {
    clockMs += loop.tickMs;
    for (const event of loop.frame(loop.tickMs)) {
      if (event.type === 'TruckStateChanged') traceOf(event.truckId).transitions.push({ frame, from: event.from, to: event.to });
    }

    // dock drží kamión len v `to_dock` a `loading` (ADR-029 A2) — oboma smermi
    const holders = new Set<number>();
    for (const module of world.modules.values()) {
      if (!(module instanceof LoadingRamp)) continue;
      for (let dock = 0; dock < module.docks; dock += 1) {
        const holder = module.dockTruck(dock);
        if (holder === null) continue;
        holders.add(holder);
        expect(world.trucks.get(holder)?.state, `frame ${String(frame)}: držiteľ docku`).toMatch(/^(to_dock|loading)$/);
      }
    }
    for (const truck of world.trucks.values()) {
      expect(holders.has(truck.id), `frame ${String(frame)}: kamión #${String(truck.id)} v stave ${truck.state}`).toBe(TRUCK_STATE_TRAITS[truck.state as TruckState].holdsDock);
    }

    const shown = new Map<string, number>();
    for (const vm of bridge.snapshot().trucks) {
      let maneuver = maneuvers.get(vm.id);
      if (maneuver === undefined) {
        maneuver = new DockManeuver(() => clockMs, CELL_PX);
        maneuvers.set(vm.id, maneuver);
      }
      maneuver.update(vm, {
        sim: () => simPose(vm),
        approach: () => (vm.approach === undefined ? null : { x: vm.approach.x * CELL_PX, y: vm.approach.y * CELL_PX, angle: vm.approach.heading }),
      });
      const trace = traceOf(vm.id);
      const last = trace.phases[trace.phases.length - 1];
      if (last?.phase !== maneuver.currentPhase) trace.phases.push({ frame, phase: maneuver.currentPhase });
      if (maneuver.currentPhase === 'entering' || maneuver.currentPhase === 'docked') {
        const truck = world.trucks.get(vm.id as EntityId);
        const key = `${String(truck?.rampId)}:${String(truck?.dock)}`;
        shown.set(key, (shown.get(key) ?? 0) + 1);
      }
    }
    maxShownPerDock = Math.max(maxShownPerDock, ...shown.values(), 0);
  }
  return { traces, exported: world.cargo.exportedCount, tickMs: loop.tickMs, maxShownPerDock };
}

const firstFrame = (trace: Trace, from: string, to: string): number => {
  const found = trace.transitions.find((entry) => entry.from === from && entry.to === to);
  if (found === undefined) throw new Error(`prechod ${from} → ${to} chýba`);
  return found.frame;
};

describe('manéver kamióna pri rampe proti skutočnému toku simu (ADR-029)', () => {
  const played = play();
  const trucks = [...played.traces.entries()];

  it('reťazec exportuje všetkých 12 TEU 12 kamiónmi, každý prešiel waiting → to_dock → loading → to_gate_out v tomto poradí', () => {
    expect(played.exported).toBe(UNITS);
    expect(trucks).toHaveLength(UNITS);
    for (const [id, trace] of trucks) {
      const visited = trace.transitions.map((entry) => `${entry.from}>${entry.to}`);
      const wanted = ['waiting>to_dock', 'to_dock>loading', 'loading>to_gate_out'];
      const at = wanted.map((step) => visited.indexOf(step));
      expect(at.every((index) => index >= 0), `kamión #${String(id)}: ${visited.join(', ')}`).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    }
  });

  it('fázy manévru každého kamióna idú free → entering → leaving → free (`docked` sa neukáže: sim kamión pustí z docku skôr, než dôjde)', () => {
    for (const [id, trace] of trucks) {
      expect(trace.phases.map((entry) => entry.phase), `kamión #${String(id)}`).toEqual(['free', 'entering', 'leaving', 'free']);
    }
  });

  it('cúvanie sa začne v tom istom frame ako `to_dock → loading`; k výjazdu dôjde až po odchode zo `loading` a po dokončení cúvania', () => {
    const fullManeuverFrames = Math.ceil((DOCK_STOP_MS + DOCK_REVERSE_MS) / played.tickMs);
    for (const [id, trace] of trucks) {
      const arrived = firstFrame(trace, 'to_dock', 'loading');
      const departed = firstFrame(trace, 'loading', 'to_gate_out');
      const frameOf = (phase: DockPhase): number => trace.phases.find((entry) => entry.phase === phase && entry.frame >= arrived)?.frame ?? Number.NaN;
      expect(frameOf('entering'), `kamión #${String(id)} cúvanie`).toBe(arrived);
      expect(frameOf('leaving')).toBeGreaterThanOrEqual(departed); // nikdy skôr, než sim kamión pustil z docku
      expect(frameOf('leaving')).toBeLessThanOrEqual(arrived + fullManeuverFrames); // a nie neskôr než po celom manévri
    }
  });

  it('loading je kratší než manéver (preto sa cúvanie dokončuje po odchode zo simu) a zobrazené kamióny sa v jednom doku neprekrývajú', () => {
    const reverseFrames = Math.ceil((DOCK_STOP_MS + DOCK_REVERSE_MS) / played.tickMs);
    const loadingFrames = trucks.map(([, trace]) => firstFrame(trace, 'loading', 'to_gate_out') - firstFrame(trace, 'to_dock', 'loading'));
    expect(Math.max(...loadingFrames)).toBeLessThan(reverseFrames);
    expect(played.maxShownPerDock).toBe(1);
  });
});
