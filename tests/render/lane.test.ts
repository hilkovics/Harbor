import { readFileSync } from 'node:fs';
import { Container, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROAD_KIND, ROAD_KINDS, ROAD_KIND_TRAITS, loadBundledMap, type RoadKind } from '@sim/grid';
import { MANIFEST_CELL_PX } from '@render/entity-assets';
import {
  LANE_CENTER_PX,
  LANE_OFFSET_CELLS,
  LANE_WIDTH_PX,
  ROAD_ASPHALT_PX,
  VEHICLE_BODY_WIDTH_PX,
  VEHICLE_OFFSET_CELLS,
  VEHICLE_OFFSET_PX,
  VEHICLE_SCALE,
  VEHICLE_WIDTH_PX,
  createRoadKindAt,
  createRoadMaskAt,
  defaultRoadKindAt,
  laneMagnitude,
  laneOffset,
  noRoadMaskAt,
  roadKindOfCell,
} from '@render/lane';
import { VehicleView } from '@render/vehicle-view';
import type { VehicleVM, ViewRotation } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const HEADINGS: readonly ViewRotation[] = [0, 90, 180, 270];
const KINDS: readonly RoadKind[] = ROAD_KINDS;

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

  it.each(['empty', 'loaded'])('sprite `straddle_carrier_%s.svg`: obsah má šírku 48 px (x 8–56) a stred na x 32', (state) => {
    const rects = svgRects(readAsset(`entities/straddle_carrier_${state}.svg`));
    const left = Math.min(...rects.map((rect) => rect.x));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    expect(right - left).toBe(VEHICLE_BODY_WIDTH_PX);
    expect((left + right) / 2).toBe(MANIFEST_CELL_PX / 2);
  });

  it.each(['empty', 'loaded'])('sprite `truck_container_%s.svg`: kolesá x 10–54 (44 px, najviac šírka carriera) a stred na x 32', (state) => {
    const rects = svgRects(readAsset(`entities/truck_container_${state}.svg`));
    const left = Math.min(...rects.map((rect) => rect.x));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    expect(right - left).toBe(44);
    expect(right - left).toBeLessThanOrEqual(VEHICLE_BODY_WIDTH_PX);
    expect((left + right) / 2).toBe(MANIFEST_CELL_PX / 2);
  });

  it('mierka vozidiel je jedna (1 : 1 voči nákladu): šírka vozidla = šírka obsahu, posun od osi = rezerva asfaltu', () => {
    expect(VEHICLE_SCALE).toBe(1);
    expect(VEHICLE_WIDTH_PX).toBe(VEHICLE_BODY_WIDTH_PX * VEHICLE_SCALE);
    expect(VEHICLE_OFFSET_PX).toBe((ROAD_ASPHALT_PX - VEHICLE_WIDTH_PX) / 2); // 2 px: vozidlo nečnie z asfaltu
    expect(VEHICLE_OFFSET_CELLS).toBe(VEHICLE_OFFSET_PX / MANIFEST_CELL_PX);
    expect(VEHICLE_OFFSET_PX).toBeLessThanOrEqual(LANE_CENTER_PX);
  });
});

describe('laneOffset (pravostranná premávka, posun v bunkách kolmo na smer jazdy)', () => {
  const V = VEHICLE_OFFSET_CELLS;

  it.each([
    [0, V, 0],
    [90, 0, V],
    [180, -V, 0],
    [270, 0, -V],
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

  it('posun je kolmý na smer jazdy a má veľkosť `VEHICLE_OFFSET_CELLS` (two_lane)', () => {
    const forward: Record<ViewRotation, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
    for (const heading of HEADINGS) {
      const offset = laneOffset('two_lane', heading);
      const [fx, fy] = forward[heading];
      expect(offset.x * fx + offset.y * fy).toBeCloseTo(0, 12);
      expect(Math.hypot(offset.x, offset.y)).toBeCloseTo(V, 12);
    }
  });

  it('protismerné vozidlá na dvojpruhovej ceste sú od seba 2 × `VEHICLE_OFFSET_CELLS` (vozidlo 1 : 1 je širšie než pruh)', () => {
    for (const [a, b] of [
      [0, 180],
      [90, 270],
    ] as const) {
      const first = laneOffset('two_lane', a);
      const second = laneOffset('two_lane', b);
      expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeCloseTo(2 * V, 12);
    }
  });

  it('nealokuje: opakované volanie vráti ten istý objekt', () => {
    for (const kind of KINDS) for (const heading of HEADINGS) expect(laneOffset(kind, heading)).toBe(laneOffset(kind, heading));
  });
});

describe('typ cesty pod vozidlom (`roadKindAt`)', () => {
  const map = loadBundledMap();

  it('predvolená funkcia vráti všade dvojpruhovú cestu (renderer bez mriežky)', () => {
    expect(DEFAULT_ROAD_KIND).toBe('two_lane');
    expect(defaultRoadKindAt(3, 4)).toBe('two_lane');
    expect(defaultRoadKindAt(-1, 9999)).toBe('two_lane');
  });

  it('bunka s cestou čerpá typ z `Cell.roadKind`, bunka bez cesty a koľaj = stred (one_lane)', () => {
    for (const roadKind of ROAD_KINDS) expect(roadKindOfCell({ road: 'road', roadKind })).toBe(roadKind);
    expect(roadKindOfCell({ road: 'none', roadKind: 'two_lane' })).toBe('one_lane');
    expect(roadKindOfCell({ road: 'rail', roadKind: 'two_lane' })).toBe('one_lane');
  });

  it('`createRoadKindAt` číta živú mriežku: štartová cesta je two_lane, prestavba na iný typ sa prejaví hneď, mimo mapy stred', () => {
    const grid = map.createGrid();
    const roadKindAt = createRoadKindAt(grid);
    const { x, y } = map.starter.roads[0];
    expect(roadKindAt(x, y)).toBe('two_lane');
    grid.at(x, y).road = 'none';
    expect(roadKindAt(x, y)).toBe('one_lane');
    grid.at(x, y).road = 'road';
    expect(roadKindAt(x, y)).toBe('two_lane');
    grid.at(x, y).roadKind = 'one_way';
    grid.at(x, y).roadDir = 'N';
    expect(roadKindAt(x, y)).toBe('one_way');
    grid.at(x, y).roadKind = 'one_lane';
    grid.at(x, y).roadDir = null;
    expect(roadKindAt(x, y)).toBe('one_lane');
    expect(roadKindAt(-1, 0)).toBe('one_lane');
    expect(roadKindAt(grid.width, grid.height)).toBe('one_lane');
  });

  it('počet pruhov typu je zo simu (`ROAD_KIND_TRAITS.lanes`): posun od osi je len pri dvoch pruhoch', () => {
    for (const kind of ROAD_KINDS) {
      expect(laneMagnitude(kind)).toBe(ROAD_KIND_TRAITS[kind].lanes === 2 ? VEHICLE_OFFSET_CELLS : 0);
    }
  });
});

describe('maska susedov cestnej bunky (`roadMaskAt`, tvar zákrut)', () => {
  const map = loadBundledMap();

  it('bez mriežky nemá žiadna bunka susedov', () => {
    expect(noRoadMaskAt(3, 4)).toBe(0);
  });

  it('`createRoadMaskAt`: N = 1, E = 2, S = 4, W = 8 len pre cestné bunky; mimo mapy a bez cesty 0', () => {
    const grid = map.createGrid();
    const cells = [
      [40, 20],
      [41, 20],
      [40, 21],
    ] as const;
    for (const [x, y] of cells) grid.at(x, y).road = 'road';
    const maskAt = createRoadMaskAt(grid);
    expect(maskAt(40, 20)).toBe(2 | 4); // zákruta: východ + juh
    expect(maskAt(41, 20)).toBe(8);
    expect(maskAt(40, 21)).toBe(1);
    expect(maskAt(50, 20)).toBe(0); // bez cesty
    expect(maskAt(-1, 0)).toBe(0);
    expect(maskAt(grid.width, grid.height)).toBe(0);
    grid.at(41, 20).road = 'rail'; // koľaj sa s cestou nespája
    expect(maskAt(40, 20)).toBe(4);
  });
});

describe('sprite vozidla leží na asfalte cesty (± 2 px)', () => {
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
   * Bočný rozsah obsahu spritu vo „dlaždici cesty“: px zdroja (64 px na bunku), os cesty x 32, kladný smer = vpravo od
   * jazdy. Rozsah obsahu v súbore (x 8–56) sa premieta cez skutočnú transformáciu view (posun + rotácia).
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
    const left = 32 - VEHICLE_BODY_WIDTH_PX / 2;
    const ends = [lateral(left), lateral(left + VEHICLE_BODY_WIDTH_PX)];
    return { min: Math.min(...ends), max: Math.max(...ends) };
  }

  it.each(HEADINGS)('kurz %i°: obsah spritu je na asfalte x 6–58 (± 2 px) a široký %i px zdroja', (heading) => {
    const { min, max } = lateralExtent(heading);
    expect(min).toBeGreaterThanOrEqual(6 - 2);
    expect(max).toBeLessThanOrEqual(6 + ROAD_ASPHALT_PX + 2);
    expect(max - min).toBeCloseTo(VEHICLE_WIDTH_PX, 6);
    // stred vozidla je od osi cesty vpravo o `VEHICLE_OFFSET_PX`
    expect((min + max) / 2).toBeCloseTo(MANIFEST_CELL_PX / 2 + VEHICLE_OFFSET_PX, 6);
  });

  it('protismerné vozidlá v jednej bunke: stredy sú od seba 2 × `VEHICLE_OFFSET_PX` kolmo na cestu', () => {
    const center = (heading: ViewRotation): { x: number; y: number } => {
      const view = new VehicleView(carrier(heading), { cellPx: CELL, palette: ENTITY_PALETTE, textures: new StubTextures() });
      return { x: view.view.x, y: view.view.y };
    };
    const gap = (a: ViewRotation, b: ViewRotation): number => {
      const first = center(a);
      const second = center(b);
      return (Math.hypot(first.x - second.x, first.y - second.y) / CELL) * MANIFEST_CELL_PX;
    };
    expect(gap(90, 270)).toBeCloseTo(2 * VEHICLE_OFFSET_PX, 6);
    expect(gap(0, 180)).toBeCloseTo(2 * VEHICLE_OFFSET_PX, 6);
  });
});
