// F6a (T6A-06): exportný (delivery) kamión prichádza naložený, pri rampe cúva rovnakým manévrom ako pri nakládke
// (stav `unloading`), po vyložení odchádza prázdny; pri dual transaction (`unloading` → `loading`) ostáva v doku.
import { describe, expect, it } from 'vitest';
import { DOCKED_STATES, DOCK_LEAVE_MS, DOCK_REVERSE_MS, DOCK_STOP_MS, DockManeuver, type DockPoses, type PosePx } from '@render/dock-maneuver';
import { TruckView } from '@render/truck-view';
import type { TruckVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

/** Rampa A (30; 23): dok 0 má stred (31,5; 24,42), vonkajšia bunka konektora (31; 25). */
const DOCK_Y = 24 + (60 + 62 / 2) / 64 - 1;

let time = 0;
const textures = new StubTextures();

function makeView(vm: TruckVM): TruckView {
  return new TruckView(vm, { cellPx: CELL, palette: ENTITY_PALETTE, textures, now: () => time }, 1);
}

function truck(over: Partial<TruckVM> = {}): TruckVM {
  return { id: 1, defId: 'truck_container', x: 44.5, y: 40.5, prevX: 44.5, prevY: 40.5, heading: 0, loaded: false, state: 'to_gate', ...over };
}

/** Kamión pri doku v stave `state`: cieľ v doku (kabína na juh), sim poloha na vonkajšej bunke s kurzom príjazdu 270°. */
function atDock(state: string, over: Partial<TruckVM> = {}): TruckVM {
  return truck({ x: 31.5, y: DOCK_Y, prevX: 31.5, prevY: DOCK_Y, heading: 180, state, prevState: 'to_dock', approach: { x: 31.5, y: 25.5, heading: 270 }, ...over });
}

const driving = (over: Partial<TruckVM> = {}): TruckVM =>
  truck({ x: 31.5, y: 25.5, prevX: 31.5, prevY: 25.5, heading: 270, state: 'to_dock', prevState: 'to_bay', ...over });

const leaving = (over: Partial<TruckVM> = {}): TruckVM =>
  truck({ x: 31.5, y: 25.5, prevX: 31.5, prevY: 25.5, heading: 90, state: 'to_gate_out', prevState: 'unloading', ...over });

// naloženie kamióna = kontajner na návese (cargoState), nie zámena spritu (R1: kamión je z častí)
const textureOf = (view: TruckView): unknown => view.cargoState;
const loadedTexture = 'full';
const emptyTexture = 'none';

describe('DOCKED_STATES', () => {
  it('kamión vymieňa náklad v doku v stavoch loading (import) a unloading (export)', () => {
    expect([...DOCKED_STATES].sort()).toEqual(['loading', 'unloading']);
  });
});

describe('exportný kamión prichádza naložený (loaded sprite od spawnu)', () => {
  it('view vytvorený v ktoromkoľvek stave pred rampou má sprite `loaded`', () => {
    for (const state of ['to_gate', 'gate_queue', 'at_gate', 'to_bay', 'waiting', 'to_dock']) {
      expect(textureOf(makeView(truck({ loaded: true, state }))), state).toBe(loadedTexture);
    }
  });

  it('pri jazde k rampe zostáva naložený a mení sa až po vykládke', () => {
    time = 0;
    const view = makeView(truck({ loaded: true, state: 'to_gate' }));
    view.update(truck({ loaded: true, state: 'to_bay' }), 1);
    view.update(driving({ loaded: true }), 1);
    expect(textureOf(view)).toBe(loadedTexture);
  });
});

describe('vykládka na rampe: rovnaký manéver ako pri nakládke', () => {
  it('`to_dock` → `unloading`: kamión najprv stojí, potom cúva a skončí v strede docku s kabínou na juh', () => {
    time = 1000;
    const view = makeView(driving({ loaded: true }));
    expect(view.dockPhase).toBe('free');
    const arrived = { x: view.view.x, y: view.view.y, angle: view.view.angle };
    view.update(atDock('unloading', { loaded: true }), 1);
    expect(view.dockPhase).toBe('entering');
    expect([view.view.x, view.view.y, view.view.angle]).toEqual([arrived.x, arrived.y, arrived.angle]); // zastavenie
    time = 1000 + DOCK_STOP_MS + DOCK_REVERSE_MS / 2;
    view.update(atDock('unloading', { loaded: true }), 1);
    expect(Math.hypot(view.view.x - arrived.x, view.view.y - arrived.y)).toBeGreaterThan(5);
    time = 1000 + 5000;
    view.update(atDock('unloading', { loaded: true }), 1);
    expect(view.dockPhase).toBe('docked');
    expect(view.view.x).toBeCloseTo(31.5 * CELL, 9);
    expect(view.view.y).toBeCloseTo(DOCK_Y * CELL, 9);
    expect(view.view.angle).toBeCloseTo(180, 9);
  });

  it('cúvanie pri `unloading` má presne tú istú dráhu ako pri `loading` (jeden manéver)', () => {
    const poses = (state: string): number[][] => {
      time = 0;
      const view = makeView(driving());
      view.update(atDock(state), 1);
      const out: number[][] = [];
      for (const at of [0, 400, 800, 1200, 1600, 3000]) {
        time = at;
        view.update(atDock(state), 1);
        out.push([view.view.x, view.view.y, view.view.angle]);
      }
      return out;
    };
    expect(poses('unloading')).toEqual(poses('loading'));
  });

  it('kamión cúva naložený: sim vyloží skôr (loaded → false), ale sprite zostáva `loaded`, kým neprišiel do docku', () => {
    time = 0;
    const view = makeView(driving({ loaded: true }));
    view.update(atDock('unloading', { loaded: true }), 1);
    time = DOCK_STOP_MS + 100;
    view.update(atDock('unloading', { loaded: false }), 1); // sim: jednotka už na rampe
    expect(view.dockPhase).toBe('entering');
    expect(textureOf(view)).toBe(loadedTexture);
    time = DOCK_STOP_MS + DOCK_REVERSE_MS + 50;
    view.update(atDock('unloading', { loaded: false }), 1);
    expect(view.dockPhase).toBe('docked');
    expect(textureOf(view)).toBe(emptyTexture); // vyložený v doku
  });

  it('sim kamión už odišiel (to_gate_out, prázdny) počas cúvania: cúvanie sa dokončí naložené, potom odchádza prázdny', () => {
    time = 0;
    const view = makeView(driving({ loaded: true }));
    view.update(atDock('unloading', { loaded: true }), 1);
    time = 200;
    view.update(leaving({ loaded: false }), 1);
    expect(view.dockPhase).toBe('entering');
    expect(textureOf(view)).toBe(loadedTexture);
    time = 200 + 2000;
    view.update(leaving({ loaded: false }), 1);
    expect(['leaving', 'free']).toContain(view.dockPhase);
    expect(textureOf(view)).toBe(emptyTexture);
    time = 200 + 2000 + DOCK_LEAVE_MS + 100;
    view.update(leaving({ loaded: false }), 1);
    expect(view.dockPhase).toBe('free');
    expect(view.view.angle).toBeCloseTo(90, 9);
    expect(textureOf(view)).toBe(emptyTexture);
  });

  it('výjazd `unloading` → `to_gate_out` z docku: začína v doku a plynule dobieha pózu zo simu', () => {
    time = 0;
    const view = makeView(driving({ loaded: true }));
    view.update(atDock('unloading', { loaded: true }), 1);
    time = 6000;
    view.update(atDock('unloading', { loaded: false }), 1);
    expect(textureOf(view)).toBe(emptyTexture);
    view.update(leaving({ loaded: false }), 1);
    expect(view.dockPhase).toBe('leaving');
    expect(view.view.y).toBeCloseTo(DOCK_Y * CELL, 6);
    time = 6000 + DOCK_LEAVE_MS + 100;
    view.update(leaving({ loaded: false }), 1);
    expect(view.dockPhase).toBe('free');
  });
});

describe('dual transaction: `unloading` → `loading` v tom istom doku', () => {
  it('kamión nevyjde ani necúva znova; po vyložení je prázdny a po nakládke importu naložený', () => {
    time = 0;
    const view = makeView(driving({ loaded: true }));
    view.update(atDock('unloading', { loaded: true }), 1);
    time = 6000;
    view.update(atDock('unloading', { loaded: false }), 1);
    expect(view.dockPhase).toBe('docked');
    expect(textureOf(view)).toBe(emptyTexture);
    const docked = [view.view.x, view.view.y, view.view.angle];
    view.update(atDock('loading', { loaded: false, prevState: 'unloading' }), 1);
    expect(view.dockPhase).toBe('docked');
    expect([view.view.x, view.view.y, view.view.angle]).toEqual(docked);
    time = 6500;
    view.update(atDock('loading', { loaded: true, prevState: 'unloading' }), 1);
    expect(view.dockPhase).toBe('docked');
    expect(textureOf(view)).toBe(loadedTexture); // odchádza s importom
    view.update(leaving({ loaded: true, prevState: 'loading' }), 1);
    expect(view.dockPhase).toBe('leaving');
  });

  it('prechod `unloading` → `loading` počas cúvania nezačne manéver nanovo', () => {
    time = 0;
    const view = makeView(driving({ loaded: true }));
    view.update(atDock('unloading', { loaded: true }), 1);
    time = DOCK_STOP_MS + 300;
    view.update(atDock('unloading', { loaded: true }), 1);
    const midway = [view.view.x, view.view.y];
    view.update(atDock('loading', { loaded: true, prevState: 'unloading' }), 1);
    expect(view.dockPhase).toBe('entering');
    expect([view.view.x, view.view.y]).toEqual(midway);
  });
});

describe('DockManeuver.displayLoaded', () => {
  const sim: PosePx = { x: 31.5 * CELL, y: 25.5 * CELL, angle: 270 };
  const poses: DockPoses = { sim: () => sim, approach: () => sim };
  const vm = (over: Partial<TruckVM>): TruckVM => atDock('unloading', over);

  it('mimo manévru platí vm.loaded; počas cúvania stav z príchodu; v doku znova vm.loaded', () => {
    let now = 0;
    const maneuver = new DockManeuver(() => now, CELL);
    expect(maneuver.displayLoaded({ loaded: true })).toBe(true);
    maneuver.update(truck({ x: 31.5, y: 25.5, heading: 270, state: 'to_dock' }), poses);
    maneuver.update(vm({ loaded: true }), poses);
    expect(maneuver.currentPhase).toBe('entering');
    expect(maneuver.displayLoaded({ loaded: false })).toBe(true);
    now = DOCK_STOP_MS + DOCK_REVERSE_MS + 10;
    maneuver.update(vm({ loaded: false }), poses);
    expect(maneuver.currentPhase).toBe('docked');
    expect(maneuver.displayLoaded({ loaded: false })).toBe(false);
  });

  it('import: prázdny kamión cúva prázdny aj keď sim už naložil (jednotka sa v ňom presunie skôr než kamión dôjde do docku)', () => {
    const maneuver = new DockManeuver(() => 0, CELL);
    maneuver.update(truck({ x: 31.5, y: 25.5, heading: 270, state: 'to_dock' }), poses);
    maneuver.update(atDock('loading', { loaded: false }), poses);
    expect(maneuver.currentPhase).toBe('entering');
    expect(maneuver.displayLoaded({ loaded: true })).toBe(false);
  });
});
