import { describe, expect, it } from 'vitest';
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, CAMERA_START_ZOOM, Camera, type CameraOptions } from '@render/camera';

const CELL_PX = 64;

/** Mapa 96×64 buniek, obrazovka 1280×720 (rozmery ako `harbor_01`; hodnoty sú vstup testu, nie kódu). */
function options(overrides: Partial<CameraOptions> = {}): CameraOptions {
  return {
    cellPx: CELL_PX,
    mapWidth: 96,
    mapHeight: 64,
    viewportWidth: 1280,
    viewportHeight: 720,
    ...overrides,
  };
}

/** Kamera uprostred mapy pri danom zoome (bod bez clampu na okrajoch). */
function centered(zoom: number, overrides: Partial<CameraOptions> = {}): Camera {
  return new Camera(options({ zoom, focus: { x: 40, y: 28, w: 16, h: 8 }, ...overrides }));
}

describe('Camera: limity a úvodný stav', () => {
  it('zoom 0,25–2,0 a úvodný zoom 0,5', () => {
    expect(CAMERA_MIN_ZOOM).toBe(0.25);
    expect(CAMERA_MAX_ZOOM).toBe(2);
    expect(CAMERA_START_ZOOM).toBe(0.5);
    expect(new Camera(options()).zoom).toBe(CAMERA_START_ZOOM);
  });

  it('úvodná pozícia: stred `focus` obdĺžnika (starter parcela) je v strede obrazovky', () => {
    const starter = { x: 30, y: 14, w: 28, h: 20 };
    const camera = new Camera(options({ focus: starter }));
    expect(camera.zoom).toBe(0.5);
    const center = camera.cellToScreen(starter.x + starter.w / 2, starter.y + starter.h / 2);
    expect(center.x).toBeCloseTo(640, 6);
    expect(center.y).toBeCloseTo(360, 6);
  });

  it('bez `focus` je úvodný pohľad na strede mapy', () => {
    const camera = new Camera(options());
    const center = camera.cellToScreen(96 / 2, 64 / 2);
    expect(center.x).toBeCloseTo(640, 6);
    expect(center.y).toBeCloseTo(360, 6);
  });

  it('neplatné vstupy → RangeError', () => {
    expect(() => new Camera(options({ cellPx: 0 }))).toThrow(RangeError);
    expect(() => new Camera(options({ mapWidth: 0 }))).toThrow(RangeError);
    expect(() => new Camera(options({ viewportHeight: -1 }))).toThrow(RangeError);
    expect(() => new Camera(options({ minZoom: 2, maxZoom: 1 }))).toThrow(RangeError);
  });
});

describe('Camera.zoomAt', () => {
  it.each([
    [1.25, 400, 300],
    [0.8, 900, 200],
    [2, 640, 360],
    [0.5, 10, 700],
  ])('faktor %f: bod pod kurzorom (%i, %i) ostáva na mieste', (factor, sx, sy) => {
    const camera = centered(1);
    const before = camera.screenToCellFloat(sx, sy);
    camera.zoomAt(factor, sx, sy);
    const after = camera.screenToCellFloat(sx, sy);
    expect(camera.zoom).toBeCloseTo(factor, 9);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('opakované približovanie drží pivot a zastaví sa na maxime', () => {
    const camera = centered(0.5);
    const pivot = { x: 333, y: 444 };
    const anchor = camera.screenToCellFloat(pivot.x, pivot.y);
    for (let i = 0; i < 20; i++) camera.zoomAt(1.2, pivot.x, pivot.y);
    expect(camera.zoom).toBe(CAMERA_MAX_ZOOM);
    const after = camera.screenToCellFloat(pivot.x, pivot.y);
    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });

  it('zoom sa orezáva na 0,25–2,0', () => {
    const camera = centered(1);
    camera.zoomAt(1000, 640, 360);
    expect(camera.zoom).toBe(CAMERA_MAX_ZOOM);
    camera.zoomAt(0.0001, 640, 360);
    expect(camera.zoom).toBe(CAMERA_MIN_ZOOM);
  });

  it('neplatný faktor → RangeError', () => {
    const camera = centered(1);
    expect(() => camera.zoomAt(0, 0, 0)).toThrow(RangeError);
    expect(() => camera.zoomAt(-1, 0, 0)).toThrow(RangeError);
    expect(() => camera.zoomAt(Number.NaN, 0, 0)).toThrow(RangeError);
  });

  it('1 bunka = `cellPx` obrazovkových px pri zoome 1 a `cellPx × zoom` inak', () => {
    const camera = centered(1);
    const a = camera.cellToScreen(40, 28);
    const b = camera.cellToScreen(41, 28);
    expect(b.x - a.x).toBeCloseTo(CELL_PX, 9);
    camera.zoomAt(0.5, 640, 360);
    const c = camera.cellToScreen(40, 28);
    const d = camera.cellToScreen(41, 28);
    expect(d.x - c.x).toBeCloseTo(CELL_PX * 0.5, 9);
  });
});

describe('Camera.pan a clamp na mapu', () => {
  it('pan posunie obsah o dx, dy obrazovkových px (ťah myšou)', () => {
    const camera = centered(1);
    const before = camera.cellToScreen(40, 28);
    camera.pan(30, -20);
    const after = camera.cellToScreen(40, 28);
    expect(after.x - before.x).toBeCloseTo(30, 9);
    expect(after.y - before.y).toBeCloseTo(-20, 9);
  });

  it('pan pri zoome škáluje: rovnaký ťah je vo svete 1/zoom', () => {
    const camera = centered(2);
    const before = camera.screenToWorld(0, 0);
    camera.pan(100, 0);
    const after = camera.screenToWorld(0, 0);
    expect(before.x - after.x).toBeCloseTo(50, 9);
  });

  it('nedovolí odísť za ľavý/horný okraj mapy', () => {
    const camera = centered(1);
    camera.pan(1e6, 1e6);
    expect(camera.cellToScreen(0, 0).x).toBeCloseTo(0, 9);
    expect(camera.cellToScreen(0, 0).y).toBeCloseTo(0, 9);
  });

  it('nedovolí odísť za pravý/dolný okraj mapy', () => {
    const camera = centered(1);
    camera.pan(-1e6, -1e6);
    expect(camera.cellToScreen(96, 64).x).toBeCloseTo(1280, 9);
    expect(camera.cellToScreen(96, 64).y).toBeCloseTo(720, 9);
  });

  it('zoomAt tiež rešpektuje clamp (pivot pri okraji mapy)', () => {
    const camera = centered(1);
    camera.pan(1e6, 1e6);
    camera.zoomAt(0.5, 0, 0);
    expect(camera.cellToScreen(0, 0).x).toBeCloseTo(0, 9);
    expect(camera.cellToScreen(0, 0).y).toBeCloseTo(0, 9);
    camera.zoomAt(0.5, 1279, 719);
    // pri zoome 0,25 je mapa 96×64 buniek (1536×1024 px) väčšia než 1280×720 obrazovka? Nie: 1536 > 1280, 1024 > 720
    const topLeft = camera.cellToScreen(0, 0);
    const bottomRight = camera.cellToScreen(96, 64);
    expect(topLeft.x).toBeLessThanOrEqual(1e-9);
    expect(topLeft.y).toBeLessThanOrEqual(1e-9);
    expect(bottomRight.x).toBeGreaterThanOrEqual(1280 - 1e-9);
    expect(bottomRight.y).toBeGreaterThanOrEqual(720 - 1e-9);
  });

  it('mapa menšia než obrazovka sa vycentruje (zoom 0,25 na veľkej obrazovke)', () => {
    const camera = new Camera(options({ viewportWidth: 3840, viewportHeight: 2160, zoom: CAMERA_MIN_ZOOM }));
    // mapa 96×64 buniek pri zoome 0,25 = 1536×1024 px
    const topLeft = camera.cellToScreen(0, 0);
    const bottomRight = camera.cellToScreen(96, 64);
    expect(topLeft.x).toBeCloseTo((3840 - 1536) / 2, 6);
    expect(topLeft.y).toBeCloseTo((2160 - 1024) / 2, 6);
    expect(bottomRight.x).toBeCloseTo(3840 - (3840 - 1536) / 2, 6);
    camera.pan(500, -500);
    expect(camera.cellToScreen(0, 0).x).toBeCloseTo((3840 - 1536) / 2, 6);
    expect(camera.cellToScreen(0, 0).y).toBeCloseTo((2160 - 1024) / 2, 6);
  });
});

describe('Camera: screen ↔ cell', () => {
  it.each([CAMERA_MIN_ZOOM, 0.5, 1, 1.5, CAMERA_MAX_ZOOM])('roundtrip stredov buniek pri zoome %f', (zoom) => {
    const camera = centered(zoom);
    const { left, top } = camera;
    for (let y = 0; y < 64; y += 3) {
      for (let x = 0; x < 96; x += 5) {
        const screen = camera.cellCenterToScreen(x, y);
        // bunky mimo obrazovky sa preskočia — roundtrip je matematický, ale over ho aj na viditeľných
        expect(camera.screenToCell(screen.x, screen.y)).toEqual({ x, y });
        const back = camera.screenToCellFloat(screen.x, screen.y);
        expect(back.x).toBeCloseTo(x + 0.5, 9);
        expect(back.y).toBeCloseTo(y + 0.5, 9);
      }
    }
    expect(Number.isFinite(left) && Number.isFinite(top)).toBe(true);
  });

  it('roundtrip zlomkových súradníc buniek', () => {
    const camera = centered(0.75);
    for (const [cx, cy] of [
      [40.25, 28.75],
      [0.1, 63.9],
      [95.99, 0],
    ]) {
      const screen = camera.cellToScreen(cx, cy);
      const back = camera.screenToCellFloat(screen.x, screen.y);
      expect(back.x).toBeCloseTo(cx, 9);
      expect(back.y).toBeCloseTo(cy, 9);
    }
  });

  it('screenToCell používa floor (záporné súradnice mimo mapy dávajú záporné bunky)', () => {
    const camera = new Camera(options({ zoom: 1, viewportWidth: 6144, viewportHeight: 4096 }));
    expect(camera.screenToCell(0, 0)).toEqual({ x: 0, y: 0 });
    expect(camera.screenToCell(CELL_PX - 0.001, CELL_PX)).toEqual({ x: 0, y: 1 });
    expect(camera.screenToCell(-1, -1)).toEqual({ x: -1, y: -1 });
  });

  it('screenToWorld ↔ worldToScreen', () => {
    const camera = centered(1.3);
    const world = camera.screenToWorld(123, 456);
    const screen = camera.worldToScreen(world.x, world.y);
    expect(screen.x).toBeCloseTo(123, 9);
    expect(screen.y).toBeCloseTo(456, 9);
  });
});

describe('Camera: resize, centerOn, verzia', () => {
  it('resize drží stred pohľadu', () => {
    const camera = centered(1);
    const center = camera.screenToCellFloat(640, 360);
    camera.resize(1920, 1080);
    const after = camera.screenToCellFloat(960, 540);
    expect(after.x).toBeCloseTo(center.x, 9);
    expect(after.y).toBeCloseTo(center.y, 9);
  });

  it('centerOn dá bunku do stredu obrazovky bez zmeny zoomu', () => {
    const camera = centered(1);
    camera.centerOn(50.5, 30.5);
    const center = camera.screenToCellFloat(640, 360);
    expect(camera.zoom).toBe(1);
    expect(center.x).toBeCloseTo(50.5, 9);
    expect(center.y).toBeCloseTo(30.5, 9);
  });

  it('transform() zodpovedá worldToScreen: bod (0, 0) sveta je na (x, y) a mierka je zoom', () => {
    const camera = centered(0.5);
    const { x, y, scale } = camera.transform();
    const origin = camera.worldToScreen(0, 0);
    expect(scale).toBe(0.5);
    expect(x).toBeCloseTo(origin.x, 9);
    expect(y).toBeCloseTo(origin.y, 9);
  });

  it('verzia rastie iba pri skutočnej zmene pohľadu', () => {
    const camera = centered(1);
    const v0 = camera.version;
    camera.pan(10, 0);
    expect(camera.version).toBeGreaterThan(v0);
    const v1 = camera.version;
    camera.pan(0, 0);
    expect(camera.version).toBe(v1);
    camera.zoomAt(1, 100, 100);
    expect(camera.version).toBe(v1);
    camera.resize(1280, 720);
    expect(camera.version).toBe(v1);
  });
});
