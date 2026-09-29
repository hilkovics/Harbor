import { describe, expect, it } from 'vitest';
import {
  APP_MAP_ID,
  GAME_SEED,
  KEY_PAN_MAX_DT_MS,
  KEY_PAN_PX_PER_SECOND,
  START_SHORE_SCREEN_FRACTION,
  WHEEL_ZOOM_PER_PX,
  createAppWorld,
  loadAppMap,
  shoreRow,
  startViewCenter,
} from '@app/config';
import { Camera, CAMERA_START_ZOOM } from '@render/camera';
import { starterParcelRect } from '@render/world-renderer';
import { isWater } from '@sim/grid';

describe('config aplikácie', () => {
  it('seed je uint32 (Rng ho prijme) a mapa aplikácie je harbor_01', () => {
    expect(Number.isInteger(GAME_SEED) && GAME_SEED >= 0 && GAME_SEED <= 0xffff_ffff).toBe(true);
    expect(APP_MAP_ID).toBe('harbor_01');
    expect(loadAppMap().id).toBe(APP_MAP_ID);
  });

  it('createAppWorld: nová hra z defs a mapy, východiskový seed; ten istý seed = rovnaký svet', () => {
    const a = createAppWorld();
    const b = createAppWorld(GAME_SEED);
    expect(a.map.id).toBe(APP_MAP_ID);
    expect(a.clock.tick).toBe(0);
    expect(a.cashCents).toBe(a.defs.economy.startingCashCents);
    expect(JSON.stringify(a.serialize())).toBe(JSON.stringify(b.serialize()));
    expect(a.serialize().seed).toBe(GAME_SEED);
  });

  it('živá mriežka sveta je samostatná kópia (šablóna mapy sa nemení)', () => {
    const world = createAppWorld();
    expect(world.grid).not.toBe(world.map.createGrid());
    expect(world.map.createGrid()).not.toBe(world.map.createGrid());
  });

  it('ladiace konštanty ovládania sú kladné', () => {
    expect(KEY_PAN_PX_PER_SECOND).toBeGreaterThan(0);
    expect(KEY_PAN_MAX_DT_MS).toBeGreaterThan(0);
    expect(WHEEL_ZOOM_PER_PX).toBeGreaterThan(0);
  });

  describe('úvodný pohľad kamery', () => {
    const map = loadAppMap();
    const focus = starterParcelRect(map);
    const grid = map.createGrid();
    const CELL_PX = 64; // token --cell (design/tokens.css)

    it('pobrežie starter parcely je horný riadok nábrežia a nad ním je voda', () => {
      const shore = shoreRow(grid, focus);
      expect(isWater(grid.at(focus.x, shore).terrain)).toBe(false);
      expect(shore).toBeGreaterThan(0);
      expect(isWater(grid.at(focus.x, shore - 1).terrain)).toBe(true);
    });

    it('obdĺžnik samej vody nemá pobrežie → horný riadok', () => {
      expect(shoreRow(grid, { x: 0, y: 0, w: 4, h: 4 })).toBe(0);
    });

    it.each([
      [1280, 720],
      [1920, 1080],
    ])('na %i×%i je v úvodnom pohľade pod HUD vidno vodu, nábrežie aj starter parcelu', (width, height) => {
      const camera = new Camera({ cellPx: CELL_PX, mapWidth: map.width, mapHeight: map.height, viewportWidth: width, viewportHeight: height });
      const visibleRows = height / (CAMERA_START_ZOOM * CELL_PX);
      const center = startViewCenter(grid, focus, visibleRows);
      camera.centerOn(center.x, center.y);
      const shore = shoreRow(grid, focus);
      const shoreScreenY = camera.cellToScreen(focus.x, shore).y;
      const hudHeightPx = 48; // --hud-top-h
      // pobrežie leží na podiele výšky obrazovky, teda hlboko pod HUD; nad ním je aspoň 4 riadky vody vo výške
      expect(shoreScreenY / height).toBeCloseTo(START_SHORE_SCREEN_FRACTION, 5);
      expect(shoreScreenY - hudHeightPx).toBeGreaterThanOrEqual(4 * CAMERA_START_ZOOM * CELL_PX);
      // parcela sa zobrazí aspoň do polovice svojej výšky a jej stred je vo vodorovnom pohľade
      expect(camera.cellToScreen(focus.x, focus.y + focus.h / 2).y).toBeLessThanOrEqual(height);
      const centerX = camera.cellToScreen(focus.x + focus.w / 2, shore).x;
      expect(Math.abs(centerX - width / 2)).toBeLessThan(1);
    });
  });
});
