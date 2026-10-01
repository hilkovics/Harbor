import { describe, expect, it } from 'vitest';
import {
  DOCK_CATCH_UP,
  DOCK_LEAVE_MS,
  DOCK_REVERSE_MS,
  DOCK_STOP_MS,
  DockManeuver,
  blendPose,
  dockPose,
  planDockPath,
  shortestDelta,
  smooth,
  type DockPoses,
  type PosePx,
} from '@render/dock-maneuver';
import type { TruckVM } from '@render/view-models';

const CELL = 64;

/** Pózy ako v scéne demo: rampa A (30; 23), dok 0 má stred (31,5; 24,42), vonkajšia bunka konektora (31; 25). */
const DOCK: PosePx = { x: 31.5 * CELL, y: 24.421875 * CELL, angle: 180 };

const angleDiff = (a: number, b: number): number => Math.abs(shortestDelta(a, b));

/** Vzorky krivky po `n` krokoch. */
function sample(path: { at(progress: number): PosePx }, n = 100): PosePx[] {
  return Array.from({ length: n + 1 }, (_, i) => path.at(i / n));
}

function maxStep(poses: readonly PosePx[]): number {
  let largest = 0;
  for (let i = 1; i < poses.length; i++) largest = Math.max(largest, Math.hypot(poses[i].x - poses[i - 1].x, poses[i].y - poses[i - 1].y));
  return largest;
}

function maxTurn(poses: readonly PosePx[]): number {
  let largest = 0;
  for (let i = 1; i < poses.length; i++) largest = Math.max(largest, angleDiff(poses[i - 1].angle, poses[i].angle));
  return largest;
}

describe('pomocné funkcie uhlov a prechodov', () => {
  it('shortestDelta: najkratšia orientovaná zmena v (−180, 180]', () => {
    expect(shortestDelta(270, 180)).toBe(-90);
    expect(shortestDelta(90, 180)).toBe(90);
    expect(shortestDelta(350, 10)).toBe(20);
    expect(shortestDelta(10, 350)).toBe(-20);
    expect(shortestDelta(0, 180)).toBe(180);
    expect(shortestDelta(180, 0)).toBe(180);
  });

  it('smooth: 0 → 0, 1 → 1, symetrická, orezaná mimo [0, 1]', () => {
    expect(smooth(0)).toBe(0);
    expect(smooth(1)).toBe(1);
    expect(smooth(0.5)).toBe(0.5);
    expect(smooth(0.25) + smooth(0.75)).toBeCloseTo(1, 12);
    expect(smooth(-3)).toBe(0);
    expect(smooth(9)).toBe(1);
  });

  it('blendPose: poloha lineárne, uhol najkratším smerom (aj cez 0°)', () => {
    const mid = blendPose({ x: 0, y: 0, angle: 350 }, { x: 10, y: 20, angle: 10 }, 0.5);
    expect(mid).toEqual({ x: 5, y: 10, angle: 0 });
    expect(blendPose({ x: 1, y: 1, angle: 90 }, { x: 9, y: 9, angle: 180 }, 0)).toEqual({ x: 1, y: 1, angle: 90 });
    expect(blendPose({ x: 1, y: 1, angle: 90 }, { x: 9, y: 9, angle: 180 }, 1)).toEqual({ x: 9, y: 9, angle: 180 });
  });

  it('dockPose: bunky → px, bez posunu pruhu', () => {
    expect(dockPose({ x: 31.5, y: 24.5, heading: 180 }, CELL)).toEqual({ x: 31.5 * CELL, y: 24.5 * CELL, angle: 180 });
  });
});

describe('planDockPath: cúvanie do docku', () => {
  it('bočný príjazd (kurz 270° popri rampe): začína v póze príjazdu a končí presne v doku s kabínou von', () => {
    const from: PosePx = { x: 31.5 * CELL, y: 25.5 * CELL, angle: 270 };
    const path = planDockPath(from, DOCK, CELL);
    expect(path.at(0)).toEqual({ x: from.x, y: from.y, angle: 270 });
    const end = path.at(1);
    expect(end.x).toBeCloseTo(DOCK.x, 9);
    expect(end.y).toBeCloseTo(DOCK.y, 9);
    expect(end.angle).toBeCloseTo(180, 9);
  });

  it('kurz sa otáča najkratšie a monotónne (270° → 180°: proti smeru hodinových ručičiek)', () => {
    const path = planDockPath({ x: 31.5 * CELL, y: 25.5 * CELL, angle: 270 }, DOCK, CELL);
    const angles = sample(path).map((pose) => pose.angle);
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeLessThanOrEqual(angles[i - 1] + 1e-9);
    expect(angles[0]).toBeCloseTo(270, 9);
    expect(angles[angles.length - 1]).toBeCloseTo(180, 9);
  });

  it('kamión cúva: smer pohybu je opačný než kurz (predok ukazuje tam, odkiaľ sa kamión vzďaľuje)', () => {
    const path = planDockPath({ x: 31.5 * CELL, y: 25.5 * CELL, angle: 270 }, DOCK, CELL);
    const poses = sample(path, 200);
    // na začiatku ide kamión s kurzom 270° (západ) pozadu, teda na východ (+x)
    expect(poses[3].x).toBeGreaterThan(poses[0].x);
    // na konci ide s kurzom 180° (juh) pozadu, teda na sever (−y): do rampy
    expect(poses[200].y).toBeLessThan(poses[197].y);
  });

  it('príjazd popri rampe z východu aj zo západu je zrkadlový', () => {
    const east = planDockPath({ x: 31.5 * CELL, y: 25.5 * CELL, angle: 270 }, DOCK, CELL);
    const west = planDockPath({ x: 31.5 * CELL, y: 25.5 * CELL, angle: 90 }, DOCK, CELL);
    const a = sample(east, 20);
    const b = sample(west, 20);
    for (let i = 0; i <= 20; i++) {
      expect(b[i].x - DOCK.x).toBeCloseTo(-(a[i].x - DOCK.x), 6);
      expect(b[i].y).toBeCloseTo(a[i].y, 6);
      expect(shortestDelta(180, b[i].angle)).toBeCloseTo(-shortestDelta(180, a[i].angle), 6);
    }
  });

  it('príjazd priamo na modul (kurz 0° smeruje do rampy): otočka o 180° po slučke, nie na mieste', () => {
    const from: PosePx = { x: 32.5 * CELL, y: 25.5 * CELL, angle: 0 };
    const dock: PosePx = { x: 32.5 * CELL, y: 24.421875 * CELL, angle: 180 };
    const path = planDockPath(from, dock, CELL);
    const poses = sample(path, 200);
    expect(poses[0]).toEqual(from);
    expect(poses[200].x).toBeCloseTo(dock.x, 9);
    expect(poses[200].y).toBeCloseTo(dock.y, 9);
    expect(poses[200].angle).toBeCloseTo(180, 9);
    // slučka: dráha sa vychýli do boku (vpravo od kurzu príjazdu = východ) a vráti do osi
    const widest = Math.max(...poses.map((pose) => Math.abs(pose.x - from.x)));
    expect(widest).toBeGreaterThan(0.4 * CELL);
    // kurz sa mení spolu s pohybom: v každom kroku sa kamión posunie, keď sa otočí
    for (let i = 1; i < poses.length; i++) {
      const turned = angleDiff(poses[i - 1].angle, poses[i].angle);
      const moved = Math.hypot(poses[i].x - poses[i - 1].x, poses[i].y - poses[i - 1].y);
      if (turned > 0.5) expect(moved).toBeGreaterThan(0.1);
    }
    expect(maxTurn(poses)).toBeLessThan(4); // plynulo: pod 4° na krok zo 200
  });

  it('slučka sa dá viesť vľavo: zrkadlová strana, opačné otáčanie', () => {
    const from: PosePx = { x: 32.5 * CELL, y: 25.5 * CELL, angle: 0 };
    const dock: PosePx = { x: 32.5 * CELL, y: 24.421875 * CELL, angle: 180 };
    const right = sample(planDockPath(from, dock, CELL, 'right'), 50);
    const left = sample(planDockPath(from, dock, CELL, 'left'), 50);
    for (let i = 0; i <= 50; i++) {
      expect(left[i].x - from.x).toBeCloseTo(-(right[i].x - from.x), 6);
      expect(left[i].y).toBeCloseTo(right[i].y, 6);
    }
    expect(right[10].angle).toBeGreaterThan(180); // 0° → 360° → 180°: cez západ (270°)
    expect(left[10].angle).toBeLessThan(180); // cez východ (90°)
    expect(right[50].angle).toBeCloseTo(180, 9);
    expect(left[50].angle).toBeCloseTo(180, 9);
  });

  it.each([
    ['sever', 0],
    ['východ', 90],
    ['juh', 180],
    ['západ', 270],
  ])('plynulosť pre kurz príjazdu %s: bez skoku v polohe a v uhle (rozbeh a dobeh)', (_name, angle) => {
    const path = planDockPath({ x: 31.5 * CELL, y: 25.5 * CELL, angle }, DOCK, CELL);
    const poses = sample(path, 200);
    expect(maxStep(poses)).toBeLessThan(1.6); // px na 1/200 krivky (krivka má niekoľko desiatok px)
    expect(maxTurn(poses)).toBeLessThan(3);
    // dobeh: prvý a posledný krok sú menšie než krok v strede (smoothstep)
    const steps = poses.slice(1).map((pose, i) => Math.hypot(pose.x - poses[i].x, pose.y - poses[i].y));
    expect(steps[0]).toBeLessThan(steps[100]);
    expect(steps[199]).toBeLessThan(steps[100]);
  });

  it('príjazd v uhle zákruty (315°, stojí v strede oblúka) sa napojí bez skoku', () => {
    const from: PosePx = { x: 31.5 * CELL + 10, y: 25.5 * CELL - 10, angle: 315 };
    const path = planDockPath(from, DOCK, CELL);
    expect(path.at(0)).toEqual(from);
    expect(path.at(1).angle).toBeCloseTo(180, 9);
    expect(maxTurn(sample(path, 200))).toBeLessThan(3);
  });
});

/** TruckVM v stave `loading` s cieľom v doku (`DOCK`) a sim polohou (31,5; 25,5). */
function loadingVm(over: Partial<TruckVM> = {}): TruckVM {
  return {
    id: 1,
    defId: 'truck_container',
    x: DOCK.x / CELL,
    y: DOCK.y / CELL,
    prevX: DOCK.x / CELL,
    prevY: DOCK.y / CELL,
    heading: 180,
    loaded: false,
    state: 'loading',
    prevState: 'to_dock',
    approach: { x: 31.5, y: 25.5, heading: 270 },
    ...over,
  };
}

const APPROACH: PosePx = { x: 31.5 * CELL, y: 25.5 * CELL, angle: 270 };

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
}

/** Pózy pre `DockManeuver`: sim póza sa dá meniť (kamión sa po výjazde rozbehne po ceste). */
function poses(sim: () => PosePx, approach: PosePx | null = APPROACH): DockPoses {
  return { sim, approach: () => approach };
}

describe('DockManeuver: zastavenie → cúvanie → nakládka → výjazd', () => {
  const driving: TruckVM = loadingVm({ state: 'to_dock', prevState: 'gate_queue', x: 31.5, y: 25.5, heading: 270, approach: undefined });

  it('mimo docku vracia bežnú pózu zo simu a fáza je `free`', () => {
    const time = clock();
    const maneuver = new DockManeuver(time.now, CELL);
    const sim: PosePx = { x: 100, y: 200, angle: 90 };
    expect(maneuver.update(driving, poses(() => sim))).toBe(sim);
    expect(maneuver.currentPhase).toBe('free');
  });

  it('po `to_dock` → `loading`: kamión najprv stojí (DOCK_STOP_MS), potom cúva a skončí v doku', () => {
    const time = clock(1000);
    const maneuver = new DockManeuver(time.now, CELL);
    const sim = (): PosePx => APPROACH;
    maneuver.update(driving, poses(sim));
    // príchod do nakládky
    const start = maneuver.update(loadingVm(), poses(sim));
    expect(maneuver.currentPhase).toBe('entering');
    expect(start).toEqual(APPROACH);
    time.set(1000 + DOCK_STOP_MS - 1);
    expect(maneuver.update(loadingVm(), poses(sim))).toEqual(APPROACH); // ešte stojí
    time.set(1000 + DOCK_STOP_MS + DOCK_REVERSE_MS / 2);
    const middle = maneuver.update(loadingVm(), poses(sim));
    expect(Math.hypot(middle.x - APPROACH.x, middle.y - APPROACH.y)).toBeGreaterThan(5);
    expect(Math.hypot(middle.x - DOCK.x, middle.y - DOCK.y)).toBeGreaterThan(5);
    time.set(1000 + DOCK_STOP_MS + DOCK_REVERSE_MS);
    const docked = maneuver.update(loadingVm(), poses(sim));
    expect(maneuver.currentPhase).toBe('docked');
    expect(docked).toEqual({ x: DOCK.x, y: DOCK.y, angle: 180 });
  });

  it('nový view už v `loading` po práve dokončenej jazde (`prevState` = to_dock) cúva; bez nej stojí hneď v doku', () => {
    const time = clock(500);
    const fresh = new DockManeuver(time.now, CELL);
    fresh.update(loadingVm({ prevState: 'to_dock' }), poses(() => APPROACH));
    expect(fresh.currentPhase).toBe('entering');
    const loaded = new DockManeuver(time.now, CELL);
    const pose = loaded.update(loadingVm({ prevState: 'loading' }), poses(() => APPROACH));
    expect(loaded.currentPhase).toBe('docked');
    expect(pose).toEqual({ x: DOCK.x, y: DOCK.y, angle: 180 });
  });

  it('`loading` bez `approach` (nie je z čoho cúvať) sa zobrazí ako doteraz: póza zo simu', () => {
    const time = clock();
    const maneuver = new DockManeuver(time.now, CELL);
    const sim: PosePx = { x: DOCK.x, y: DOCK.y, angle: 180 };
    expect(maneuver.update(loadingVm({ approach: undefined }), poses(() => sim))).toBe(sim);
    expect(maneuver.currentPhase).toBe('free');
  });

  it('výjazd (`to_gate_out`): póza sa plynule približuje od docku k pohybujúcej sa póze zo simu a končí na nej', () => {
    const time = clock(0);
    const maneuver = new DockManeuver(time.now, CELL);
    maneuver.update(driving, poses(() => APPROACH));
    maneuver.update(loadingVm(), poses(() => APPROACH));
    time.set(DOCK_STOP_MS + DOCK_REVERSE_MS + 10);
    maneuver.update(loadingVm(), poses(() => APPROACH)); // zadokovaný
    // nakládka skončila; sim kamión ide z vonkajšej bunky na východ (kurz 90°)
    const leavingAt = 5000;
    const simAt = (ms: number): PosePx => ({ x: APPROACH.x + (ms - leavingAt) * 0.03, y: APPROACH.y, angle: 90 });
    const out = loadingVm({ state: 'to_gate_out', prevState: 'loading', approach: undefined, x: 31.5, y: 25.5, heading: 90 });
    const samples: PosePx[] = [];
    let lastMs = leavingAt;
    for (let ms = leavingAt; ms <= leavingAt + DOCK_LEAVE_MS + 200; ms += 30) {
      lastMs = ms;
      time.set(ms);
      samples.push(maneuver.update(out, poses(() => simAt(ms))));
      if (ms === leavingAt) expect(maneuver.currentPhase).toBe('leaving');
    }
    expect(samples[0]).toEqual({ x: DOCK.x, y: DOCK.y, angle: 180 }); // výjazd začína v doku, nie na vonkajšej bunke
    expect(maneuver.currentPhase).toBe('free');
    const last = samples[samples.length - 1];
    expect(last).toEqual(simAt(lastMs));
    expect(maxStep(samples)).toBeLessThan(0.15 * CELL); // plynulé približovanie, žiadny skok
    expect(maxTurn(samples)).toBeLessThan(25);
  });

  it('sim kamión odíde z docku uprostred cúvania (loading trvá kratšie než manéver): cúvanie sa dokončí v doku rýchlejšie, až potom výjazd (bez skoku)', () => {
    const time = clock(0);
    const maneuver = new DockManeuver(time.now, CELL);
    const staying = new DockManeuver(time.now, CELL); // porovnanie: kamión, ktorý zostal v `loading` počas celého cúvania
    for (const m of [maneuver, staying]) {
      m.update(driving, poses(() => APPROACH));
      m.update(loadingVm(), poses(() => APPROACH));
    }
    const out = loadingVm({ state: 'to_gate_out', prevState: 'loading', approach: undefined, x: 31.5, y: 25.5, heading: 90 });
    const leaveSim = (ms: number): PosePx => ({ x: APPROACH.x + (ms - DOCK_STOP_MS) * 0.03, y: APPROACH.y, angle: 90 });
    const switchAt = DOCK_STOP_MS + DOCK_REVERSE_MS * 0.4; // sim ukončil nakládku, kým kamión ešte cúva
    const reverseEnd = switchAt + (DOCK_REVERSE_MS * 0.6) / DOCK_CATCH_UP; // zvyšok cúvania ide DOCK_CATCH_UP-krát rýchlejšie
    const samples: PosePx[] = [];
    for (let ms = DOCK_STOP_MS; ms < switchAt; ms += 20) {
      time.set(ms);
      samples.push(staying.update(loadingVm(), poses(() => APPROACH)));
      expect(maneuver.update(loadingVm(), poses(() => APPROACH))).toEqual(samples[samples.length - 1]);
    }
    time.set(switchAt);
    const reference = staying.update(loadingVm(), poses(() => APPROACH));
    expect(maneuver.update(out, poses(() => leaveSim(switchAt)))).toEqual(reference); // v okamihu odchodu bez skoku
    let lastDistance = Number.POSITIVE_INFINITY;
    for (let ms = switchAt + 20; ms < reverseEnd; ms += 20) {
      time.set(ms);
      const shown = maneuver.update(out, poses(() => leaveSim(ms)));
      expect(maneuver.currentPhase, `ms ${String(ms)}`).toBe('entering'); // kamión ešte cúva do docku, nevyšiel
      const distance = Math.hypot(shown.x - DOCK.x, shown.y - DOCK.y);
      expect(distance).toBeLessThan(lastDistance); // približuje sa k doku
      lastDistance = distance;
      samples.push(shown);
    }
    // dokončené cúvanie → kamión stojí v doku a od nasledujúceho okamihu vyjde predkom k póze zo simu
    time.set(reverseEnd);
    const atDock = maneuver.update(out, poses(() => leaveSim(reverseEnd)));
    expect(atDock).toEqual({ x: DOCK.x, y: DOCK.y, angle: 180 });
    expect(maneuver.currentPhase).toBe('leaving');
    samples.push(atDock);
    for (let ms = reverseEnd + 20; ms <= reverseEnd + DOCK_LEAVE_MS + 200; ms += 20) {
      time.set(ms);
      samples.push(maneuver.update(out, poses(() => leaveSim(ms))));
    }
    expect(maneuver.currentPhase).toBe('free');
    expect(samples[samples.length - 1]).toEqual(leaveSim(reverseEnd + DOCK_LEAVE_MS + 200));
    expect(maxTurn(samples)).toBeLessThan(25);
  });

  it('keď sim kamión zostane v `loading` až do konca cúvania, nič sa nezrýchľuje a fáza `docked` je pozorovateľná', () => {
    const time = clock(0);
    const maneuver = new DockManeuver(time.now, CELL);
    maneuver.update(driving, poses(() => APPROACH));
    maneuver.update(loadingVm(), poses(() => APPROACH));
    time.set(DOCK_STOP_MS + DOCK_REVERSE_MS);
    expect(maneuver.update(loadingVm(), poses(() => APPROACH))).toEqual({ x: DOCK.x, y: DOCK.y, angle: 180 });
    expect(maneuver.currentPhase).toBe('docked');
    const out = loadingVm({ state: 'to_gate_out', prevState: 'loading', approach: undefined });
    maneuver.update(out, poses(() => APPROACH));
    expect(maneuver.currentPhase).toBe('leaving');
  });

  it('po výjazde je fáza znova `free` a nový príchod do nakládky (ďalší kamión na tom istom view sa nepoužíva) spustí cúvanie', () => {
    const time = clock(0);
    const maneuver = new DockManeuver(time.now, CELL);
    const still = (): PosePx => APPROACH;
    maneuver.update(driving, poses(still));
    maneuver.update(loadingVm(), poses(still));
    time.set(3000);
    maneuver.update(loadingVm(), poses(still));
    const out = loadingVm({ state: 'to_gate_out', prevState: 'loading', approach: undefined });
    maneuver.update(out, poses(still));
    time.set(3000 + DOCK_LEAVE_MS + 1);
    maneuver.update(out, poses(still));
    expect(maneuver.currentPhase).toBe('free');
    maneuver.update(driving, poses(still));
    maneuver.update(loadingVm(), poses(still));
    expect(maneuver.currentPhase).toBe('entering');
  });
});
