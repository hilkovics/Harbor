import { describe, expect, it } from 'vitest';
import { PlaceRoadCommand, SetGameSpeedCommand } from '@sim/commands';
import type { CellCoord } from '@sim/grid';
import { Camera } from '@render/camera';
import type { GhostCell, GhostView } from '@render/build-layer';
import {
  INPUT_TRANSITIONS,
  InputController,
  isBuildState,
  transition,
  type InputState,
  type InputTrigger,
  type KeyInput,
} from '@app/input-controller';
import { KEY_PAN_MAX_DT_MS, KEY_PAN_PX_PER_SECOND } from '@app/config';
import { createApp } from './app-fixtures';

// ---- pomôcky ----

class FakeGhost implements GhostView {
  cells: readonly GhostCell[] = [];
  setCalls = 0;
  clearCalls = 0;

  setGhost(cells: readonly GhostCell[]): void {
    this.cells = cells;
    this.setCalls += 1;
  }

  clearGhost(): void {
    this.cells = [];
    this.clearCalls += 1;
  }
}

function harness() {
  const { world, bridge, loop } = createApp();
  const camera = new Camera({
    cellPx: 64,
    mapWidth: world.grid.width,
    mapHeight: world.grid.height,
    viewportWidth: 1280,
    viewportHeight: 720,
    zoom: 1,
    focus: { x: 40, y: 18, w: 8, h: 4 },
  });
  const ghost = new FakeGhost();
  const states: InputState[] = [];
  const controller = new InputController({ bridge, camera, ghost, onStateChange: (state) => states.push(state) });
  /** Stred bunky na obrazovke (poloha kurzora v px vzhľadom na mapu). */
  const at = (x: number, y: number): { x: number; y: number } => camera.cellCenterToScreen(x, y);
  const down = (cell: CellCoord, button = 0): boolean => controller.pointerDown({ button, ...at(cell.x, cell.y) });
  const move = (cell: CellCoord): void => {
    const p = at(cell.x, cell.y);
    controller.pointerMove(p.x, p.y);
  };
  const up = (cell: CellCoord, button = 0): void => {
    controller.pointerUp({ button, ...at(cell.x, cell.y) });
  };
  /** Frame bez plynutia času: aplikuje príkazy z fronty a rozpošle udalosti. */
  const frame = (): void => {
    loop.frame(0);
  };
  return { world, bridge, loop, camera, ghost, states, controller, at, down, move, up, frame };
}

const key = (code: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  code,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
});

const c = (x: number, y: number): CellCoord => ({ x, y });

const roadCells = (world: { grid: { width: number; height: number; at(x: number, y: number): { road: string } } }): CellCoord[] => {
  const cells: CellCoord[] = [];
  for (let y = 0; y < world.grid.height; y++) {
    for (let x = 0; x < world.grid.width; x++) if (world.grid.at(x, y).road === 'road') cells.push(c(x, y));
  }
  return cells;
};

/** Riadok 20 v starter parcele (30..57 × 14..33) je pevnina bez ciest → voľné miesto na stavbu. */
const ROW = 20;

// ---- stavový automat ----

describe('InputState: prechodová tabuľka', () => {
  const STATES: readonly InputState[] = ['idle', 'pan', 'build', 'build_place', 'build_remove', 'build_pan'];
  const TRIGGERS: readonly InputTrigger[] = ['toggle_build', 'cancel', 'primary_down', 'secondary_down', 'middle_down', 'release'];

  /** Všetky povolené prechody; čokoľvek iné sa ignoruje (`null`). */
  const ALLOWED: ReadonlyArray<readonly [InputState, InputTrigger, InputState]> = [
    ['idle', 'toggle_build', 'build'],
    ['idle', 'primary_down', 'pan'],
    ['idle', 'middle_down', 'pan'],
    ['pan', 'release', 'idle'],
    ['pan', 'cancel', 'idle'],
    ['build', 'toggle_build', 'idle'],
    ['build', 'cancel', 'idle'],
    ['build', 'primary_down', 'build_place'],
    ['build', 'secondary_down', 'build_remove'],
    ['build', 'middle_down', 'build_pan'],
    ['build_place', 'release', 'build'],
    ['build_place', 'cancel', 'build'],
    ['build_remove', 'release', 'build'],
    ['build_remove', 'cancel', 'build'],
    ['build_pan', 'release', 'build'],
    ['build_pan', 'cancel', 'build'],
  ];

  it.each(ALLOWED)('%s + %s → %s', (from, trigger, to) => {
    expect(transition(from, trigger)).toBe(to);
  });

  it('všetky ostatné kombinácie sa ignorujú (žiadne skryté prechody)', () => {
    const allowed = new Set(ALLOWED.map(([from, trigger]) => `${from}/${trigger}`));
    for (const from of STATES) {
      for (const trigger of TRIGGERS) {
        if (!allowed.has(`${from}/${trigger}`)) expect(transition(from, trigger), `${from}/${trigger}`).toBeNull();
      }
    }
  });

  it('tabuľka pokrýva všetky stavy a build stavy sú práve tie s prefixom build', () => {
    expect(Object.keys(INPUT_TRANSITIONS).sort()).toEqual([...STATES].sort());
    for (const state of STATES) expect(isBuildState(state)).toBe(state.startsWith('build'));
  });
});

// ---- posun kamery a zoom ----

describe('InputController: kamera', () => {
  it('ľavý ťah mimo build módu posúva kameru s kurzorom a nič neodosiela', () => {
    const h = harness();
    const left = h.camera.left;
    expect(h.controller.pointerDown({ button: 0, x: 100, y: 100 })).toBe(true);
    expect(h.controller.state).toBe('pan');
    h.controller.pointerMove(160, 130);
    expect(h.camera.left).toBeCloseTo(left - 60, 6); // obsah ide s kurzorom → pohľad opačne
    h.controller.pointerUp({ button: 0, x: 160, y: 130 });
    expect(h.controller.state).toBe('idle');
    h.frame();
    expect(roadCells(h.world)).toHaveLength(30); // len starter cesta
  });

  it('stredný ťah v build móde posúva kameru a mód ostáva', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    const top = h.camera.top;
    expect(h.controller.pointerDown({ button: 1, x: 300, y: 300 })).toBe(true);
    expect(h.controller.state).toBe('build_pan');
    h.controller.pointerMove(300, 340);
    expect(h.camera.top).toBeCloseTo(top - 40, 6);
    h.controller.pointerUp({ button: 1, x: 300, y: 340 });
    expect(h.controller.state).toBe('build');
    expect(h.controller.buildMode).toBe(true);
  });

  it('koleso zoomuje s pivotom pod kurzorom (bunka pod kurzorom sa nezmení)', () => {
    const h = harness();
    h.camera.zoomAt(0.5, 640, 360); // nech je kam zoomovať do oboch smerov
    const before = h.camera.screenToCellFloat(500, 250);
    h.controller.wheel({ deltaY: -200, deltaMode: 0, x: 500, y: 250 });
    expect(h.camera.zoom).toBeGreaterThan(0.5);
    const after = h.camera.screenToCellFloat(500, 250);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    h.controller.wheel({ deltaY: 200, deltaMode: 0, x: 500, y: 250 });
    expect(h.camera.zoom).toBeCloseTo(0.5, 6); // opačný krok vráti pôvodný zoom
  });

  it('deltaMode riadky sa prepočíta na px (16×)', () => {
    const a = harness();
    const b = harness();
    a.controller.wheel({ deltaY: -3, deltaMode: 1, x: 100, y: 100 });
    b.controller.wheel({ deltaY: -48, deltaMode: 0, x: 100, y: 100 });
    expect(a.camera.zoom).toBeCloseTo(b.camera.zoom, 10);
  });

  it('WASD: D posúva pohľad doprava, W nahor; rýchlosť v px/s podľa configu', () => {
    const h = harness();
    const { left, top } = h.camera;
    const dtMs = KEY_PAN_MAX_DT_MS / 2;
    const step = (KEY_PAN_PX_PER_SECOND * dtMs) / 1000 / h.camera.zoom;
    h.controller.keyDown(key('KeyD'));
    h.controller.update(dtMs);
    expect(h.camera.left - left).toBeCloseTo(step, 6);
    h.controller.keyUp('KeyD');
    h.controller.update(dtMs);
    expect(h.camera.left - left).toBeCloseTo(step, 6); // po pustení stojí

    h.controller.keyDown(key('KeyW'));
    h.controller.update(dtMs);
    expect(top - h.camera.top).toBeCloseTo(step, 6);
  });

  it('diagonálny posun má rovnakú rýchlosť ako priamy (normalizácia)', () => {
    const h = harness();
    const { left, top } = h.camera;
    const dtMs = KEY_PAN_MAX_DT_MS / 2;
    h.controller.keyDown(key('KeyD'));
    h.controller.keyDown(key('ArrowDown'));
    h.controller.update(dtMs);
    const travelled = Math.hypot(h.camera.left - left, h.camera.top - top) * h.camera.zoom;
    expect(travelled).toBeCloseTo((KEY_PAN_PX_PER_SECOND * dtMs) / 1000, 6);
    expect(h.camera.left).toBeGreaterThan(left);
    expect(h.camera.top).toBeGreaterThan(top);
  });

  it('dlhý dt (neaktívna karta) sa orezá na KEY_PAN_MAX_DT_MS', () => {
    const h = harness();
    const { left } = h.camera;
    h.controller.keyDown(key('KeyD'));
    h.controller.update(60_000);
    expect(h.camera.left - left).toBeCloseTo(((KEY_PAN_PX_PER_SECOND * KEY_PAN_MAX_DT_MS) / 1000) / h.camera.zoom, 6);
  });
});

// ---- stavba cesty ----

describe('InputController: stavba cesty (ťah myšou)', () => {
  it('B zapne build mód a ťah + pustenie odošle PlaceRoad cez bridge; svet sa zmení až vo frame', () => {
    const h = harness();
    const cash = h.world.cashCents;
    expect(h.controller.keyDown(key('KeyB'))).toBe(true);
    expect(h.controller.buildMode).toBe(true);

    expect(h.down(c(30, ROW))).toBe(true);
    expect(h.controller.state).toBe('build_place');
    h.move(c(33, ROW));
    h.up(c(35, ROW));
    expect(h.controller.state).toBe('build');

    expect(roadCells(h.world)).toHaveLength(30); // ešte nič: príkaz čaká vo fronte
    h.frame();
    const built = roadCells(h.world).filter((cell) => cell.y === ROW);
    expect(built.map((cell) => cell.x)).toEqual([30, 31, 32, 33, 34, 35]);
    expect(h.world.cashCents).toBe(cash - 6 * h.world.defs.infrastructure.road.costPerCellCents);
  });

  it('rýchly ťah (jediný veľký skok kurzora) nepreskočí bunky — cesta je 4-súvislá', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(30, ROW));
    h.up(c(36, ROW + 3)); // žiadny pointermove: kurzor sa „teleportoval“ o 6 × 3 buniek
    h.frame();

    const built = roadCells(h.world).filter((cell) => cell.y >= ROW && cell.y <= ROW + 3 && cell.x >= 30 && cell.x <= 36);
    expect(built).toHaveLength(6 + 3 + 1); // |Δx| + |Δy| + 1
    expect(built).toContainEqual(c(30, ROW));
    expect(built).toContainEqual(c(36, ROW + 3));
    const key2 = (cell: CellCoord): string => `${String(cell.x)},${String(cell.y)}`;
    const set = new Set(built.map(key2));
    // súvislosť: z každej bunky (okrem prvej v ťahu) vedie hranou sused
    let connectedNeighbours = 0;
    for (const cell of built) {
      if ([c(cell.x + 1, cell.y), c(cell.x - 1, cell.y), c(cell.x, cell.y + 1), c(cell.x, cell.y - 1)].some((n) => set.has(key2(n)))) {
        connectedNeighbours += 1;
      }
    }
    expect(connectedNeighbours).toBe(built.length);
  });

  it('diagonálny pohyb vyrobí L-krok (žiadny diagonálny skok)', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(30, ROW));
    h.up(c(31, ROW + 1));
    h.frame();
    const built = roadCells(h.world).filter((cell) => cell.y >= ROW && cell.y <= ROW + 1 && cell.x >= 30 && cell.x <= 31);
    expect(built).toEqual([c(30, ROW), c(31, ROW), c(31, ROW + 1)]);
  });

  it('ghost farbí bunky ťahu podľa validácie: platné zelené, neplatné (voda) červené', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(44, 12)); // voda (riadky 0–13), potom nábrežie (14–16)
    h.move(c(44, 15));
    expect(h.ghost.cells.map((cell) => [cell.x, cell.y, cell.valid])).toEqual([
      [44, 12, false],
      [44, 13, false],
      [44, 14, true],
      [44, 15, true],
    ]);
    const feedback = h.controller.feedback();
    expect(feedback?.ok).toBe(false);
    expect(feedback?.reasons).toEqual(['terrain']);
    expect(feedback?.dragging).toBe(true);
  });

  it('ťah s neplatnou bunkou sa pri pustení neodošle (atomický príkaz) a nič sa nezmení', () => {
    const h = harness();
    const cash = h.world.cashCents;
    h.controller.keyDown(key('KeyB'));
    h.down(c(44, 12));
    h.up(c(44, 18));
    h.frame();
    expect(roadCells(h.world)).toHaveLength(30);
    expect(h.world.cashCents).toBe(cash);
    expect(h.ghost.cells).toEqual([{ x: 44, y: 18, valid: true }]); // ťah zmizol; ostal len hover ghost pod kurzorom
  });

  it('parcela na predaj je neplatná (parcel_not_owned) a nedostatok peňazí zafarbí celý ťah', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(10, ROW)); // west_quay, na predaj
    expect(h.controller.feedback()?.reasons).toEqual(['parcel_not_owned']);
    h.controller.pointerCancel();

    h.world.cashCents = h.world.defs.infrastructure.road.costPerCellCents; // stačí na jednu bunku
    h.down(c(30, ROW));
    h.move(c(33, ROW));
    expect(h.controller.feedback()?.reasons).toContain('insufficient_funds');
    expect(h.ghost.cells.every((cell) => !cell.valid)).toBe(true);
    h.up(c(33, ROW));
    h.frame();
    expect(roadCells(h.world)).toHaveLength(30);
  });

  it('bunky mimo mapy sa do ťahu nezbierajú (ťah cez okraj mapy ostane platný)', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(0, ROW)); // hrana mapy, vľavo od nej sú bunky mimo
    h.move(c(-3, ROW));
    h.move(c(2, ROW));
    expect(h.ghost.cells.every((cell) => cell.x >= 0)).toBe(true);
    expect(h.ghost.cells.map((cell) => cell.x)).toEqual([0, 1, 2]);
  });

  it('pravé tlačidlo v build móde = RemoveRoad s refundáciou; ghost platí len na bunkách s cestou', () => {
    const h = harness();
    const cash = h.world.cashCents;
    h.controller.keyDown(key('KeyB'));
    h.down(c(44, 40), 2);
    expect(h.controller.state).toBe('build_remove');
    h.move(c(44, 42));
    expect(h.ghost.cells.every((cell) => cell.valid)).toBe(true);
    expect(h.controller.feedback()?.kind).toBe('remove');
    h.up(c(44, 42), 2);
    h.frame();
    expect(roadCells(h.world)).toHaveLength(27);
    const { costPerCellCents } = h.world.defs.infrastructure.road;
    expect(h.world.cashCents).toBe(cash + Math.floor(3 * costPerCellCents * h.world.defs.economy.removalRefundRate));
  });

  it('odstraňovanie bunky bez cesty je neplatné (no_road)', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(30, ROW), 2);
    expect(h.ghost.cells).toEqual([{ x: 30, y: ROW, valid: false }]);
    expect(h.controller.feedback()?.reasons).toEqual(['no_road']);
    h.up(c(30, ROW), 2);
    h.frame();
    expect(roadCells(h.world)).toHaveLength(30);
  });

  it('druhé tlačidlo počas ťahu sa ignoruje; pustenie cudzieho tlačidla ťah neukončí', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(30, ROW));
    expect(h.down(c(31, ROW), 2)).toBe(false);
    h.up(c(31, ROW), 2);
    expect(h.controller.state).toBe('build_place');
    h.up(c(32, ROW));
    h.frame();
    expect(roadCells(h.world).filter((cell) => cell.y === ROW)).toHaveLength(3);
  });

  it('mimo build módu pravé tlačidlo nič nerobí', () => {
    const h = harness();
    expect(h.down(c(30, ROW), 2)).toBe(false);
    expect(h.controller.state).toBe('idle');
  });
});

describe('InputController: Esc, hover ghost a spätná väzba', () => {
  it('Esc počas ťahu zruší ťah (nič sa neodošle) a ostane build mód; druhý Esc mód vypne', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(30, ROW));
    h.move(c(34, ROW));
    expect(h.controller.keyDown(key('Escape'))).toBe(true);
    expect(h.controller.state).toBe('build');
    h.up(c(34, ROW)); // neskoršie pustenie tlačidla už nič neodošle
    h.frame();
    expect(roadCells(h.world)).toHaveLength(30);

    expect(h.controller.keyDown(key('Escape'))).toBe(true);
    expect(h.controller.state).toBe('idle');
    expect(h.controller.keyDown(key('Escape'))).toBe(false); // v idle Esc nerobí nič
  });

  it('hover v build móde ukáže ghost jednej bunky s cenou; mimo build módu žiadny ghost', () => {
    const h = harness();
    h.move(c(30, ROW));
    expect(h.ghost.cells).toEqual([]);

    h.controller.keyDown(key('KeyB'));
    h.move(c(30, ROW));
    expect(h.ghost.cells).toEqual([{ x: 30, y: ROW, valid: true }]);
    expect(h.controller.feedback()).toMatchObject({
      kind: 'place',
      ok: true,
      cellCount: 1,
      costCents: h.world.defs.infrastructure.road.costPerCellCents,
      dragging: false,
    });

    h.controller.keyDown(key('KeyB')); // vypnutie módu ghost zruší
    expect(h.ghost.cells).toEqual([]);
    expect(h.controller.feedback()).toBeNull();
  });

  it('hover nad hotovou cestou nič neukazuje; po dokončení ťahu sa ghost zastaralej bunky zruší (RoadChanged)', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.move(c(44, 40)); // starter cesta
    expect(h.ghost.cells).toEqual([]);
    expect(h.controller.feedback()).toBeNull();

    h.move(c(30, ROW));
    expect(h.ghost.cells).toHaveLength(1);
    h.bridge.dispatch(new PlaceRoadCommand([c(30, ROW)])); // príkaz mimo ovládania (napr. skript)
    h.frame(); // RoadChanged → ghost sa prepočíta: bunka už má cestu
    expect(h.ghost.cells).toEqual([]);
  });

  it('kurzor opustil mapu → hover ghost zmizne', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.move(c(30, ROW));
    expect(h.ghost.cells).toHaveLength(1);
    h.controller.pointerLeave();
    expect(h.ghost.cells).toEqual([]);
  });

  it('subscribeFeedback: odberateľ dostane oznam pri zmene a nie po odhlásení', () => {
    const h = harness();
    let notifications = 0;
    const stop = h.controller.subscribeFeedback(() => {
      notifications += 1;
    });
    h.controller.keyDown(key('KeyB'));
    h.move(c(30, ROW));
    expect(notifications).toBeGreaterThan(0);
    stop();
    const before = notifications;
    h.move(c(31, ROW));
    expect(notifications).toBe(before);
  });

  it('onStateChange sa volá len pri skutočnej zmene stavu', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.down(c(30, ROW));
    h.up(c(31, ROW));
    h.controller.keyDown(key('Escape'));
    expect(h.states).toEqual(['build', 'build_place', 'build', 'idle']);
  });
});

// ---- rýchlosť ----

describe('InputController: rýchlosť (Space, 1–4)', () => {
  it('1–4 nastavia rýchlosti podľa poradia nenulových hodnôt v time.speeds', () => {
    const h = harness();
    const running = h.world.defs.time.speeds.filter((speed) => speed !== 0);
    running.forEach((speed, index) => {
      expect(h.controller.keyDown(key(`Digit${String(index + 1)}`))).toBe(true);
      h.frame();
      expect(h.world.clock.speed).toBe(speed);
    });
    expect(running).toEqual([1, 2, 4, 8]);
    expect(h.controller.keyDown(key('Digit5'))).toBe(false); // mimo zoznamu rýchlostí
    expect(h.controller.keyDown(key('Numpad3'))).toBe(true);
    h.frame();
    expect(h.world.clock.speed).toBe(4);
  });

  it('Space pauzuje a druhý Space obnoví poslednú nenulovú rýchlosť', () => {
    const h = harness();
    h.controller.keyDown(key('Digit3')); // 4×
    h.frame();
    h.controller.keyDown(key('Space'));
    h.frame();
    expect(h.world.clock.speed).toBe(0);
    h.controller.keyDown(key('Space'));
    h.frame();
    expect(h.world.clock.speed).toBe(4);
  });

  it('Space si pamätá aj rýchlosť nastavenú mimo ovládania (klik v HUD = SetGameSpeed cez bridge)', () => {
    const h = harness();
    h.bridge.dispatch(new SetGameSpeedCommand(8));
    h.frame();
    h.bridge.dispatch(new SetGameSpeedCommand(0)); // pauza cez HUD
    h.frame();
    h.controller.keyDown(key('Space'));
    h.frame();
    expect(h.world.clock.speed).toBe(8);
  });

  it('Space bez predošlej zmeny rýchlosti: pauza a obnova východiskovej rýchlosti', () => {
    const h = harness();
    const initial = h.world.clock.speed;
    h.controller.keyDown(key('Space'));
    h.frame();
    expect(h.world.clock.speed).toBe(0);
    h.controller.keyDown(key('Space'));
    h.frame();
    expect(h.world.clock.speed).toBe(initial);
  });

  it('opakovaný Space (auto-repeat) nezapína pauzu opakovane', () => {
    const h = harness();
    expect(h.controller.keyDown(key('Space', { repeat: true }))).toBe(true); // spotrebovaný (žiadny scroll)
    h.frame();
    expect(h.world.clock.speed).toBe(1);
  });

  it('klávesy s Ctrl/Alt/Meta sa ignorujú (prehliadačové skratky)', () => {
    const h = harness();
    expect(h.controller.keyDown(key('KeyB', { ctrlKey: true }))).toBe(false);
    expect(h.controller.keyDown(key('Space', { metaKey: true }))).toBe(false);
    expect(h.controller.keyDown(key('Digit2', { altKey: true }))).toBe(false);
    expect(h.controller.buildMode).toBe(false);
  });
});

// ---- životný cyklus ----

describe('InputController: blur a dispose', () => {
  it('blur zabudne pridržané klávesy a zruší rozpracovaný ťah', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.controller.keyDown(key('KeyD'));
    h.down(c(30, ROW));
    h.controller.blur();
    expect(h.controller.state).toBe('build');
    const { left } = h.camera;
    h.controller.update(100);
    expect(h.camera.left).toBe(left);
    h.up(c(34, ROW));
    h.frame();
    expect(roadCells(h.world)).toHaveLength(30);
  });

  it('dispose odhlási poslucháča udalostí a skryje ghost', () => {
    const h = harness();
    h.controller.keyDown(key('KeyB'));
    h.move(c(30, ROW));
    expect(h.ghost.cells).toHaveLength(1);
    h.controller.dispose();
    expect(h.ghost.cells).toEqual([]);
    const calls = h.ghost.setCalls + h.ghost.clearCalls;
    h.bridge.dispatch(new PlaceRoadCommand([c(31, ROW)]));
    h.frame(); // RoadChanged už ovládanie nezaujíma
    expect(h.ghost.setCalls + h.ghost.clearCalls).toBe(calls);
  });
});
