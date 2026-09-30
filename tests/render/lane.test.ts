import { readFileSync } from 'node:fs';
import { Container, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { loadBundledMap } from '@sim/grid';
import { MANIFEST_CELL_PX } from '@render/entity-assets';
import {
  DEFAULT_ROAD_KIND,
  LANE_CENTER_PX,
  LANE_OFFSET_CELLS,
  LANE_WIDTH_PX,
  ROAD_ASPHALT_PX,
  VEHICLE_CONTENT_WIDTH_PX,
  VEHICLE_LANE_SCALE,
  createRoadKindAt,
  defaultRoadKindAt,
  laneOffset,
  roadKindOfCell,
  type RoadKind,
} from '@render/lane';
import { VehicleView } from '@render/vehicle-view';
import type { VehicleVM, ViewRotation } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const HEADINGS: readonly ViewRotation[] = [0, 90, 180, 270];
const KINDS: readonly RoadKind[] = ['two_lane', 'one_lane', 'one_way'];

function readAsset(path: string): string {
  return readFileSync(new URL(`../../assets/${path}`, import.meta.url), 'utf8');
}

interface SvgRect {
  readonly x: number;
  readonly width: number;
}

/** Všetky `<rect x=… width=…>` z SVG (súradnice v px zdroja). */
function svgRects(svg: string): SvgRect[] {
  return [...svg.matchAll(/<rect\s+x="(-?[\d.]+)"[^>]*?\swidth="([\d.]+)"/g)].map((match) => ({
    x: Number(match[1]),
    width: Number(match[2]),
  }));
}

describe('geometria pruhu je odvodená zo spritov (assets/)', () => {
  const road = readAsset('infra/road_straight.svg');

  it('manifest: bunka má 64 px', () => {
    expect(MANIFEST_CELL_PX).toBe(64);
  });

  it('asfalt `road_straight.svg` má x 6–58 (52 px) a je vycentrovaný na osi x 32', () => {
    const asphalt = svgRects(road)[0];
    expect(asphalt.x).toBe(6);
    expect(asphalt.width).toBe(ROAD_ASPHALT_PX);
    expect(asphalt.x + asphalt.width / 2).toBe(MANIFEST_CELL_PX / 2);
  });

  it('stredová čiara je na x 32, okraje na x 7 a 57', () => {
    expect(road).toContain('d="M32 0V64"');
    expect(road).toContain('d="M7 0V64M57 0V64"');
  });

  it('pruh má 26 px a jeho stred je 13 px od osi (stredy pruhov na x 19 a x 45)', () => {
    expect(LANE_WIDTH_PX).toBe(26);
    expect(LANE_CENTER_PX).toBe(13);
    expect(MANIFEST_CELL_PX / 2 - LANE_CENTER_PX).toBe(19);
    expect(MANIFEST_CELL_PX / 2 + LANE_CENTER_PX).toBe(45);
    expect(LANE_OFFSET_CELLS).toBe(13 / 64);
  });

  it.each(['empty', 'loaded'])('sprite `straddle_carrier_%s.svg`: obsah má šírku 56 px (x 4–60) a stred na x 32', (state) => {
    const rects = svgRects(readAsset(`entities/straddle_carrier_${state}.svg`));
    const left = Math.min(...rects.map((rect) => rect.x));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    expect(right - left).toBe(VEHICLE_CONTENT_WIDTH_PX);
    expect((left + right) / 2).toBe(MANIFEST_CELL_PX / 2);
  });

  it('mierka vozidla: šírka obsahu × mierka = šírka pruhu', () => {
    expect(VEHICLE_CONTENT_WIDTH_PX * VEHICLE_LANE_SCALE).toBeCloseTo(LANE_WIDTH_PX, 12);
    expect(VEHICLE_LANE_SCALE).toBeCloseTo(26 / 56, 12);
  });
});

describe('laneOffset (pravostranná premávka, posun v bunkách kolmo na smer jazdy)', () => {
  it.each([
    [0, 13 / 64, 0],
    [90, 0, 13 / 64],
    [180, -13 / 64, 0],
    [270, 0, -13 / 64],
  ] as const)('two_lane, kurz %i°: (%f; %f)', (heading, x, y) => {
    expect(laneOffset('two_lane', heading)).toEqual({ x, y });
  });

  it('kurz 0° (sever) → východ (+x), 90° (východ) → juh (+y), 180° (juh) → západ (−x), 270° (západ) → sever (−y)', () => {
    expect(laneOffset('two_lane', 0).x).toBeGreaterThan(0);
    expect(laneOffset('two_lane', 90).y).toBeGreaterThan(0);
    expect(laneOffset('two_lane', 180).x).toBeLessThan(0);
    expect(laneOffset('two_lane', 270).y).toBeLessThan(0);
  });

  it.each(['one_lane', 'one_way'] as const)('%s: vozidlo jazdí v strede (0; 0), aj bez znamienka −0', (kind) => {
    for (const heading of HEADINGS) expect(laneOffset(kind, heading)).toEqual({ x: 0, y: 0 });
  });

  it('posun je kolmý na smer jazdy a má veľkosť 13/64 (two_lane)', () => {
    const forward: Record<ViewRotation, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
    for (const heading of HEADINGS) {
      const offset = laneOffset('two_lane', heading);
      const [fx, fy] = forward[heading];
      expect(offset.x * fx + offset.y * fy).toBeCloseTo(0, 12);
      expect(Math.hypot(offset.x, offset.y)).toBeCloseTo(13 / 64, 12);
    }
  });

  it('protismerné vozidlá na dvojpruhovej ceste sú od seba 26/64 bunky (jeden pruh)', () => {
    for (const [a, b] of [
      [0, 180],
      [90, 270],
    ] as const) {
      const first = laneOffset('two_lane', a);
      const second = laneOffset('two_lane', b);
      expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeCloseTo(26 / 64, 12);
    }
  });

  it('nealokuje: opakované volanie vráti ten istý objekt', () => {
    for (const kind of KINDS) for (const heading of HEADINGS) expect(laneOffset(kind, heading)).toBe(laneOffset(kind, heading));
  });
});

describe('typ cesty pod vozidlom (`roadKindAt`)', () => {
  const map = loadBundledMap();

  it('predvolená funkcia vráti všade dvojpruhovú cestu (sim zatiaľ nemá `roadKind`)', () => {
    expect(DEFAULT_ROAD_KIND).toBe('two_lane');
    expect(defaultRoadKindAt(3, 4)).toBe('two_lane');
    expect(defaultRoadKindAt(-1, 9999)).toBe('two_lane');
  });

  it('bunka s cestou = two_lane, bunka bez cesty a koľaj = stred (one_lane)', () => {
    expect(roadKindOfCell({ road: 'road' })).toBe('two_lane');
    expect(roadKindOfCell({ road: 'none' })).toBe('one_lane');
    expect(roadKindOfCell({ road: 'rail' })).toBe('one_lane');
  });

  it('`createRoadKindAt` číta živú mriežku: nová cesta je two_lane hneď, mimo mapy stred', () => {
    const grid = map.createGrid();
    const roadKindAt = createRoadKindAt(grid);
    const { x, y } = map.starter.roads[0];
    grid.at(x, y).road = 'none';
    expect(roadKindAt(x, y)).toBe('one_lane');
    grid.at(x, y).road = 'road';
    expect(roadKindAt(x, y)).toBe('two_lane');
    expect(roadKindAt(-1, 0)).toBe('one_lane');
    expect(roadKindAt(grid.width, grid.height)).toBe('one_lane');
  });
});

describe('sprite vozidla leží v jednom pruhu (± 2 px)', () => {
  /** Vozidlo v strede bunky (10; 10), kurz `heading`. */
  function carrier(heading: ViewRotation): VehicleVM {
    return {
      id: 1,
      defId: 'straddle_carrier',
      x: 10.5,
      y: 10.5,
      prevX: 10.5,
      prevY: 10.5,
      heading,
      loaded: false,
      state: 'to_pickup',
    };
  }

  /** Pravá strana od smeru jazdy pre kurz (os pruhov). */
  const right: Record<ViewRotation, readonly [number, number]> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

  /**
   * Bočný rozsah obsahu spritu vo „dlaždici cesty“: px zdroja (64 px na bunku), os pruhov x 32, kladný smer = vpravo od
   * jazdy. Rozsah obsahu v súbore (x 4–60) sa premieta cez skutočnú transformáciu view (posun + rotácia).
   */
  function lateralExtent(heading: ViewRotation): { min: number; max: number } {
    const view = new VehicleView(carrier(heading), { cellPx: CELL, palette: ENTITY_PALETTE, textures: new StubTextures() });
    const root = new Container();
    root.addChild(view.view);
    const sprite = view.view.children[0] as Sprite;
    const spriteSize = sprite.width; // čtvorcový sprite, anchor 0,5
    const [rx, ry] = right[heading];
    const lateral = (contentX: number): number => {
      const local = (contentX / MANIFEST_CELL_PX - 0.5) * spriteSize; // bod na osi X spritu
      const world = view.view.toGlobal({ x: local, y: 0 });
      const dx = ((world.x - 10.5 * CELL) * MANIFEST_CELL_PX) / CELL;
      const dy = ((world.y - 10.5 * CELL) * MANIFEST_CELL_PX) / CELL;
      return MANIFEST_CELL_PX / 2 + dx * rx + dy * ry;
    };
    // pri rotácii o 180° sa sprite prevráti, preto min/max z oboch krajov
    const ends = [lateral(4), lateral(60)];
    return { min: Math.min(...ends), max: Math.max(...ends) };
  }

  // pravý pruh road sprite: od stredovej čiary x 32 po okraj asfaltu x 58
  const laneMin = MANIFEST_CELL_PX / 2;
  const laneMax = 6 + ROAD_ASPHALT_PX;

  it.each(HEADINGS)('kurz %i°: obsah spritu je v pravom pruhu x 32–58 (± 2 px)', (heading) => {
    const { min, max } = lateralExtent(heading);
    expect(min).toBeGreaterThanOrEqual(laneMin - 2);
    expect(max).toBeLessThanOrEqual(laneMax + 2);
    expect(max - min).toBeCloseTo(LANE_WIDTH_PX, 6);
    // a neprekračuje stredovú čiaru do protismerného pruhu
    expect(min).toBeGreaterThanOrEqual(laneMin - 1e-6);
  });

  it('protismerné vozidlá v jednej bunke sa nepretínajú: ich pruhy sa dotýkajú len na stredovej čiare', () => {
    const across = (heading: ViewRotation): { min: number; max: number } => {
      const view = new VehicleView(carrier(heading), { cellPx: CELL, palette: ENTITY_PALETTE, textures: new StubTextures() });
      const root = new Container();
      root.addChild(view.view);
      const size = (view.view.children[0] as Sprite).width;
      // svetová súradnica kolmo na cestu (os y pre východ/západ, os x pre sever/juh) v px zdroja od začiatku bunky
      const axis = heading === 90 || heading === 270 ? 'y' : 'x';
      const ends = [-28, 28].map((half) => {
        const world = view.view.toGlobal({ x: (half / MANIFEST_CELL_PX) * size, y: 0 }); // krajné body obsahu na osi šírky spritu
        return ((axis === 'y' ? world.y : world.x) / CELL - 10) * MANIFEST_CELL_PX;
      });
      return { min: Math.min(...ends), max: Math.max(...ends) };
    };
    for (const [a, b] of [
      [90, 270],
      [0, 180],
    ] as const) {
      const first = across(a);
      const second = across(b);
      const [low, high] = first.min < second.min ? [first, second] : [second, first];
      expect(low.max).toBeLessThanOrEqual(high.min + 1e-6); // bez prekrytia
      expect(high.min - low.max).toBeLessThan(1e-6); // a bez medzery: pruhy hraničia na osi cesty
      expect(low.max).toBeCloseTo(MANIFEST_CELL_PX / 2, 6);
    }
  });
});
