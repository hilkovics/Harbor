import { describe, expect, it } from 'vitest';
import { ROTATIONS, rotateLocalCell, type Rotation } from '@sim/grid';
import {
  DEMO_CRANE_DEF,
  MAIN_SCENE,
  ROTATED_SCENE,
  SCENES,
  SCENE_VIEW,
  berthVM,
  craneVM,
  mainGhost,
  moduleGhost,
  rotateSide,
} from '@render/__demo__/f2-render.fixtures';
import { moduleSprite } from '@render/entity-assets';
import type { ModuleVM, ShipVM, ViewSide } from '@render/view-models';

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

/** Svetové bunky modulu `defId` s ľavým horným rohom (x, y) po rotácii. */
function worldCells(defId: string, x: number, y: number, rotation: Rotation): Set<string> {
  const footprint = moduleSprite(defId)?.footprint ?? { w: 0, h: 0 };
  const cells = new Set<string>();
  for (let cy = 0; cy < footprint.h; cy += 1) {
    for (let cx = 0; cx < footprint.w; cx += 1) {
      const cell = rotateLocalCell(cx, cy, footprint.w, footprint.h, rotation);
      cells.add(key(x + cell.x, y + cell.y));
    }
  }
  return cells;
}

/** Obdĺžnik lode (bunky): stred ± polovica rozmerov podľa kurzu. */
function shipRect(ship: ShipVM): { left: number; top: number; right: number; bottom: number } {
  const sideways = ship.heading === 90 || ship.heading === 270;
  const w = sideways ? ship.lengthCells : ship.widthCells;
  const h = sideways ? ship.widthCells : ship.lengthCells;
  return { left: ship.x - w / 2, top: ship.y - h / 2, right: ship.x + w / 2, bottom: ship.y + h / 2 };
}

/** Loď leží na strane `side` berthu tesne pri jeho hrane (voda), s presahom pozdĺž nábrežia. */
function touchesBerthOn(ship: ShipVM, berth: ModuleVM, side: ViewSide): boolean {
  const rect = shipRect(ship);
  const along = (a1: number, a2: number, b1: number, b2: number): boolean => a1 < b2 && a2 > b1;
  switch (side) {
    case 'n':
      return rect.bottom === berth.y && along(rect.left, rect.right, berth.x, berth.x + berth.w);
    case 's':
      return rect.top === berth.y + berth.h && along(rect.left, rect.right, berth.x, berth.x + berth.w);
    case 'w':
      return rect.right === berth.x && along(rect.top, rect.bottom, berth.y, berth.y + berth.h);
    case 'e':
      return rect.left === berth.x + berth.w && along(rect.top, rect.bottom, berth.y, berth.y + berth.h);
  }
}

describe('scéna main (karta T02-07)', () => {
  it('berth (40, 14), žeriav (43, 14) grabbing 0,5, loď feeder docked (43; 13) kurz 90°, 2 kontajnery na aprone', () => {
    const [berth] = MAIN_SCENE.modules;
    expect([berth.x, berth.y, berth.w, berth.h, berth.rotation]).toEqual([40, 14, 8, 4, 0]);
    expect(berth.apron?.units).toHaveLength(2);
    const [crane] = MAIN_SCENE.cranes;
    expect([crane.x, crane.y, crane.state, crane.progress]).toEqual([43, 14, 'grabbing', 0.5]);
    const [ship] = MAIN_SCENE.ships;
    expect([ship.classId, ship.state, ship.x, ship.y, ship.heading]).toEqual(['feeder', 'docked', 43, 13, 90]);
  });

  it('ghost druhého berthu (48, 14) s ôsmimi konektormi vo svetových bunkách (2 južné + 6 pruhových w / e)', () => {
    const ghost = mainGhost(true);
    expect([ghost.x, ghost.y, ghost.w, ghost.h]).toEqual([48, 14, 8, 4]);
    expect(ghost.connectors).toEqual([
      { x: 49, y: 17, side: 's' },
      { x: 54, y: 17, side: 's' },
      { x: 48, y: 15, side: 'w' },
      { x: 48, y: 16, side: 'w' },
      { x: 48, y: 17, side: 'w' },
      { x: 55, y: 15, side: 'e' },
      { x: 55, y: 16, side: 'e' },
      { x: 55, y: 17, side: 'e' },
    ]);
    expect(mainGhost(false).valid).toBe(false);
  });
});

describe('žeriav stojí na bunkách berthu pri každej rotácii', () => {
  it.each(ROTATIONS)('rot %i: všetky bunky žeriava ležia vo footprinte berthu', (rotation) => {
    const berth = berthVM(1, 20, 30, rotation, []);
    const crane = craneVM(2, berth);
    const berthCells = worldCells(berth.defId, berth.x, berth.y, rotation);
    const craneCells = worldCells(DEMO_CRANE_DEF, crane.x, crane.y, rotation);
    expect(craneCells.size).toBe(6);
    for (const cell of craneCells) expect(berthCells.has(cell), cell).toBe(true);
  });
});

describe('rotateSide / ghost konektory', () => {
  it('strana sa otáča v smere hodinových ručičiek', () => {
    expect(rotateSide('n', 90)).toBe('e');
    expect(rotateSide('s', 90)).toBe('w');
    expect(rotateSide('s', 180)).toBe('n');
    expect(rotateSide('e', 270)).toBe('n');
    expect(rotateSide('w', 0)).toBe('w');
  });

  it.each(ROTATIONS)('rot %i: konektory ghostu ležia vo footprinte a smerujú von z modulu na okraji', (rotation) => {
    const ghost = moduleGhost('berth_standard', 10, 10, rotation, true);
    const cells = worldCells('berth_standard', 10, 10, rotation);
    for (const connector of ghost.connectors) {
      expect(cells.has(key(connector.x, connector.y))).toBe(true);
      // sused v smere `side` (von z modulu) už do footprintu nepatrí
      const outside = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[connector.side];
      expect(cells.has(key(connector.x + outside[0], connector.y + outside[1]))).toBe(false);
    }
  });
});

describe('scéna rotated: lode ležia na vodnej strane berthov', () => {
  const [east, south] = ROTATED_SCENE.modules;
  const [eastShip, southShip] = ROTATED_SCENE.ships;

  it('berth 90° má vodu na východe, berth 180° na juhu — loď tesne pri tej hrane', () => {
    expect(rotateSide('n', east.rotation)).toBe('e');
    expect(rotateSide('n', south.rotation)).toBe('s');
    expect(touchesBerthOn(eastShip, east, 'e')).toBe(true);
    expect(touchesBerthOn(southShip, south, 's')).toBe(true);
  });

  it('žeriavy: placing s kontajnerom a blocked', () => {
    const [placing, blocked] = ROTATED_SCENE.cranes;
    expect(placing.state).toBe('placing');
    expect(placing.holding?.typeId).toBe('container_teu');
    expect(blocked.state).toBe('blocked');
    expect(blocked.holding).toBeNull();
  });

  it('každá scéna má svoj pohľad kamery', () => {
    expect(Object.keys(SCENES).sort()).toEqual(Object.keys(SCENE_VIEW).sort());
  });
});
