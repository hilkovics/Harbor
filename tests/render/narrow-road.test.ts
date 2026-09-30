import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTOTILE_SHAPE_BASE_MASK, type AutotileShape } from '@render/autotile';
import { MANIFEST_CELL_PX } from '@render/entity-assets';
import { ROAD_ASPHALT_PX, VEHICLE_WIDTH_PX } from '@render/lane';
import {
  FLARE_DEPTH_PX,
  NARROW_ASPHALT_PX,
  ROAD_EDGE_PX,
  ROAD_FILLET_PX,
  narrowRoadPaths,
  type PathOp,
} from '@render/narrow-road';
import { parseCssColor } from '@render/tokens';
import { PALETTE } from './stub-textures';

const SHAPES = Object.keys(AUTOTILE_SHAPE_BASE_MASK) as AutotileShape[];
const CELL = MANIFEST_CELL_PX;
const WIDE_HALF = ROAD_ASPHALT_PX / 2;
/** Okraje asfaltu úzkej cesty v základnej orientácii: stred bunky ± polovica šírky (12 a 52 px). */
const LOW = CELL / 2 - NARROW_ASPHALT_PX / 2;
const HIGH = CELL / 2 + NARROW_ASPHALT_PX / 2;

function readAsset(path: string): string {
  return readFileSync(new URL(`../../assets/${path}`, import.meta.url), 'utf8');
}

type P = readonly [number, number];

/** Rozloží cestu na body (oblúky vzorkuje po 4°), pre kontrolu pokrytia a rozsahu. */
function flatten(ops: readonly PathOp[]): P[] {
  const points: P[] = [];
  for (const op of ops) {
    if (op.op === 'M' || op.op === 'L') points.push([op.x, op.y]);
    else if (op.op === 'A') {
      const steps = Math.max(4, Math.ceil((Math.abs(op.to - op.from) * 180) / Math.PI / 4));
      for (let i = 0; i <= steps; i++) {
        const angle = op.from + ((op.to - op.from) * i) / steps;
        points.push([op.cx + op.r * Math.cos(angle), op.cy + op.r * Math.sin(angle)]);
      }
    }
  }
  return points;
}

/** Bod v mnohouholníku (párne-nepárne pravidlo). */
function inPolygon(polygon: readonly P[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Je bod pokrytý asfaltom (zjednotenie všetkých výplní)? */
function covered(shape: AutotileShape, x: number, y: number, flareMask = 0, wideHalf = WIDE_HALF): boolean {
  return narrowRoadPaths(shape, flareMask, wideHalf).fills.some((fill) => inPolygon(flatten(fill), x, y));
}

describe('rozmery úzkej cesty sú odvodené zo spritov (assets/infra/road_*.svg)', () => {
  it('asfalt je o 8 px užší než vozidlo (40 px pri vozidle 48 px; dvojpruhová cesta 52 px), okraj 2 px, zaoblenie 6 px', () => {
    expect(NARROW_ASPHALT_PX).toBe(40);
    expect(NARROW_ASPHALT_PX).toBe(VEHICLE_WIDTH_PX - 8);
    expect(NARROW_ASPHALT_PX).toBeLessThan(ROAD_ASPHALT_PX);
    expect(readAsset('infra/road_straight.svg')).toContain(`stroke-width="${String(ROAD_EDGE_PX)}"`);
    expect(readAsset('infra/road_t.svg')).toContain(`A${String(ROAD_FILLET_PX)} ${String(ROAD_FILLET_PX)}`);
    expect(readAsset('infra/road_cross.svg')).toContain(`A${String(ROAD_FILLET_PX)} ${String(ROAD_FILLET_PX)}`);
  });

  it('hĺbka lievika = vzdialenosť, kde sa v T a kríži začína zaoblenie (okraj asfaltu 12 − 6) = rozdiel polšírok širokej a úzkej cesty', () => {
    expect(FLARE_DEPTH_PX).toBe((CELL - NARROW_ASPHALT_PX) / 2 - ROAD_FILLET_PX);
    expect(FLARE_DEPTH_PX).toBe((ROAD_ASPHALT_PX - NARROW_ASPHALT_PX) / 2);
  });

  it('asfalt a okraj majú farby sprite: `--road-base` = #4B5058, okraj = #101113 (z `--road-base`, bez tokenu)', () => {
    const straight = readAsset('infra/road_straight.svg');
    const asphalt = /fill="(#[0-9A-Fa-f]{6})"/.exec(straight)?.[1] ?? '';
    const edge = /stroke="(#101113)"/.exec(straight)?.[1] ?? '';
    expect(PALETTE.road.base.color).toBe(parseCssColor(asphalt).color);
    expect(PALETTE.road.edge.color).toBe(parseCssColor(edge).color);
    expect(PALETTE.road.edge.alpha).toBe(1);
  });
});

describe('narrowRoadPaths: tvar úzkej dlaždice (základná orientácia, bez lievikov)', () => {
  it('nemá stredovú čiaru: čiary sú len okraje 1 px vnútri asfaltu', () => {
    // v strede cesty (x 32) nejde pri žiadnom tvare zvislá ani vodorovná čiara cez celú bunku
    for (const shape of SHAPES) {
      for (const stroke of narrowRoadPaths(shape).strokes) {
        for (const [x, y] of flatten(stroke)) {
          const onAxis = Math.abs(x - CELL / 2) < 1e-9 || Math.abs(y - CELL / 2) < 1e-9;
          const runsAlongAxis = flatten(stroke).every(([px, py]) => Math.abs(px - CELL / 2) < 1e-9 || Math.abs(py - CELL / 2) < 1e-9);
          expect(onAxis && runsAlongAxis, `${shape}: čiara na osi`).toBe(false);
        }
      }
    }
  });

  it('straight: pás x 12–52 cez celú výšku, okraje na x 13 a 51', () => {
    for (const y of [0.5, 32, 63.5]) {
      expect(covered('straight', LOW + 0.5, y)).toBe(true);
      expect(covered('straight', HIGH - 0.5, y)).toBe(true);
      expect(covered('straight', LOW - 0.5, y)).toBe(false);
      expect(covered('straight', HIGH + 0.5, y)).toBe(false);
    }
    const lines = narrowRoadPaths('straight').strokes.map((stroke) => flatten(stroke));
    expect(lines.map((line) => line[0][0]).sort((a, b) => a - b)).toEqual([LOW + 1, HIGH - 1]);
    for (const line of lines) expect(line.map(([, y]) => y)).toEqual([0, 64]);
  });

  it('end: rameno na sever x 12–52 a polkruh polomeru 20 okolo stredu bunky', () => {
    expect(covered('end', 32, 1)).toBe(true);
    expect(covered('end', 32, HIGH - 0.5)).toBe(true);
    expect(covered('end', 32, HIGH + 0.5)).toBe(false);
    expect(covered('end', LOW + 1, HIGH - 1)).toBe(false); // mimo polkruhu
    expect(covered('end', 32, 60)).toBe(false); // juh je zatvorený
    expect(covered('end', LOW - 0.5, 10)).toBe(false);
  });

  it('corner: štvrťkruhový pás okolo rohu (64; 0), polomery 12–52', () => {
    const at = (radius: number, degrees: number): P => [64 + radius * Math.cos((degrees * Math.PI) / 180), radius * Math.sin((degrees * Math.PI) / 180)];
    for (const degrees of [92, 110, 135, 160, 178]) {
      expect(covered('corner', ...at(LOW + 1, degrees)), `polomer ${String(LOW + 1)}, ${String(degrees)}°`).toBe(true);
      expect(covered('corner', ...at(HIGH - 1, degrees))).toBe(true);
      expect(covered('corner', ...at(LOW - 1, degrees))).toBe(false);
      expect(covered('corner', ...at(HIGH + 1, degrees))).toBe(false);
    }
    expect(covered('corner', LOW + 1, 0.5)).toBe(true); // hrana N: x 12–52
    expect(covered('corner', 63.5, LOW + 1)).toBe(true); // hrana E: y 12–52
    expect(covered('corner', 32, 63)).toBe(false); // juh a západ nie sú pripojené
    expect(covered('corner', 1, 32)).toBe(false);
  });

  it('t: vodorovný pás y 12–52 a rameno N, juh zatvorený, zaoblenie 6 px vo vnútorných rohoch', () => {
    expect(covered('t', 1, 32)).toBe(true);
    expect(covered('t', 63, 32)).toBe(true);
    expect(covered('t', 32, 1)).toBe(true);
    expect(covered('t', 32, HIGH + 2)).toBe(false);
    expect(covered('t', 5, 10)).toBe(false);
    expect(covered('t', 5, HIGH + 5)).toBe(false);
    expect(covered('t', LOW - 0.5, LOW - 0.5)).toBe(true); // výplň zaoblenia pri rohu (12; 12)
    expect(covered('t', LOW - 2, LOW - 2)).toBe(false); // mimo výplne (v kruhu zaoblenia)
    expect(covered('t', HIGH + 1, LOW - 0.5)).toBe(true);
  });

  it('cross: všetky štyri ramená a zaoblenie vo všetkých štyroch rohoch', () => {
    for (const [x, y] of [
      [32, 1],
      [32, 63],
      [1, 32],
      [63, 32],
      [LOW - 0.5, LOW - 0.5],
      [HIGH + 0.5, LOW - 0.5],
      [LOW - 0.5, HIGH + 0.5],
      [HIGH + 0.5, HIGH + 0.5],
    ] as const) {
      expect(covered('cross', x, y), `${String(x)}; ${String(y)}`).toBe(true);
    }
    expect(covered('cross', 5, 5)).toBe(false);
    expect(covered('cross', LOW - 2, LOW - 2)).toBe(false);
    expect(covered('cross', HIGH + 2, HIGH + 2)).toBe(false);
  });

  it.each(SHAPES)('%s: všetky body ležia v bunke 0–64', (shape) => {
    for (const mask of [0, 1, 2, 4, 8, 15]) {
      const { fills, strokes } = narrowRoadPaths(shape, mask);
      for (const [x, y] of [...fills, ...strokes].flatMap((ops) => flatten(ops))) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(CELL + 1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(CELL + 1e-9);
      }
    }
  });

  it.each(SHAPES)('%s: asfalt neprechádza mimo ramená tvaru (hrana bunky je pokrytá práve v pripojených smeroch)', (shape) => {
    const armMask = AUTOTILE_SHAPE_BASE_MASK[shape];
    const edgeSamples: Record<'n' | 'e' | 's' | 'w', P[]> = {
      n: [[24, 0.4], [32, 0.4], [40, 0.4]],
      e: [[63.6, 24], [63.6, 32], [63.6, 40]],
      s: [[24, 63.6], [32, 63.6], [40, 63.6]],
      w: [[0.4, 24], [0.4, 32], [0.4, 40]],
    };
    const bits = { n: 1, e: 2, s: 4, w: 8 } as const;
    for (const arm of ['n', 'e', 's', 'w'] as const) {
      // pri zákrute je stred hrany na polomere 32 od rohu, teda vo vnútri pásu 19–45 → pokrytý; pri zvyšku tvarov tiež
      const hit = edgeSamples[arm].filter(([x, y]) => covered(shape, x, y)).length;
      expect(hit > 0, `${shape} ${arm}`).toBe((armMask & bits[arm]) !== 0);
    }
  });
});

describe('narrowRoadPaths: lievik pri širokom susedovi', () => {
  it('rameno bez lievika má na hrane asfalt len x 12–52; s lievikom x 6–58 (šírka sprite širokej cesty)', () => {
    expect(covered('straight', 7, 0.3)).toBe(false);
    expect(covered('straight', 7, 0.3, 1)).toBe(true);
    expect(covered('straight', 57, 0.3, 1)).toBe(true);
    expect(covered('straight', 5.5, 0.3, 1)).toBe(false); // mimo šírky sprite
    expect(covered('straight', 58.5, 0.3, 1)).toBe(false);
    expect(covered('straight', 7, 8, 1)).toBe(false); // lievik sa zužuje smerom do bunky (45°)
    expect(covered('straight', 18.5, 12, 1)).toBe(true);
    expect(covered('straight', 32, 63.5, 1)).toBe(true); // druhé rameno tým nie je dotknuté
    expect(covered('straight', 7, 63.7, 1)).toBe(false);
  });

  it('lievik na hrane lícuje so šírkou širokej cesty, ktorú dostane: x 6–58 (sprite), x 8–56 (dočasné kreslenie)', () => {
    for (const [half, left, right] of [
      [26, 6, 58],
      [24, 8, 56],
    ] as const) {
      expect(covered('straight', left + 0.6, 0.2, 1, half)).toBe(true);
      expect(covered('straight', left - 0.6, 0.2, 1, half)).toBe(false);
      expect(covered('straight', right - 0.6, 0.2, 1, half)).toBe(true);
      expect(covered('straight', right + 0.6, 0.2, 1, half)).toBe(false);
    }
  });

  it('lievik sa dá na každé rameno každého tvaru; rameno, ktoré tvar nemá, sa ignoruje', () => {
    for (const shape of SHAPES) {
      const mask = AUTOTILE_SHAPE_BASE_MASK[shape];
      expect(narrowRoadPaths(shape, 15).fills.length).toBe(1 + 2 * bitCount(mask));
      expect(narrowRoadPaths(shape, 15).strokes.length).toBe(narrowRoadPaths(shape, 0).strokes.length + 2 * bitCount(mask));
      expect(narrowRoadPaths(shape, ~mask & 15).fills.length).toBe(1); // ramená, ktoré tvar nemá
    }
  });

  it('otočené lieviky: rameno E, S a W lícuje so širokou cestou na svojej hrane', () => {
    expect(covered('straight', 63.7, 7, 2)).toBe(false); // rameno E nie je v `straight` (N–S), maska sa ignoruje
    expect(covered('cross', 63.7, 7, 2)).toBe(true);
    expect(covered('cross', 63.7, 57, 2)).toBe(true);
    expect(covered('cross', 63.7, 5.5, 2)).toBe(false);
    expect(covered('cross', 7, 63.7, 4)).toBe(true); // S
    expect(covered('cross', 57, 63.7, 4)).toBe(true);
    expect(covered('cross', 0.3, 7, 8)).toBe(true); // W
    expect(covered('cross', 0.3, 57, 8)).toBe(true);
    expect(covered('cross', 0.3, 5.5, 8)).toBe(false);
  });

  it('zákruta: lieviky na oboch ramenách (N a E) lícujú so šírkou 6–58 na hrane a nepresahujú ju', () => {
    expect(covered('corner', 7, 0.3, 3)).toBe(true);
    expect(covered('corner', 57, 0.3, 3)).toBe(true);
    expect(covered('corner', 5.5, 0.3, 3)).toBe(false);
    expect(covered('corner', 63.7, 57, 3)).toBe(true);
    expect(covered('corner', 63.7, 7, 3)).toBe(true);
    expect(covered('corner', 63.7, 5.5, 3)).toBe(false);
    expect(covered('corner', 63.7, 58.5, 3)).toBe(false);
    expect(covered('corner', 7, 0.3, 2)).toBe(false); // bez lievika na severe
  });

  it('okrajové čiary ležia v asfalte (každý tvar, každá kombinácia lievikov, obe šírky širokej cesty)', () => {
    for (const shape of SHAPES) {
      for (let mask = 0; mask < 16; mask++) {
        for (const half of [WIDE_HALF, 24]) {
          const { fills, strokes } = narrowRoadPaths(shape, mask, half);
          const polygons = fills.map((fill) => flatten(fill));
          for (const stroke of strokes) {
            for (const [x, y] of flatten(stroke)) {
              if (x < 1e-6 || y < 1e-6 || x > CELL - 1e-6 || y > CELL - 1e-6) continue; // koniec čiary na hrane bunky
              const inside = polygons.some((polygon) => inPolygon(polygon, x, y));
              // body čiary na hranici výplní (napr. začiatok šikmej čiary) padajú do najbližšej výplne s toleranciou 0,01 px
              const nearby = [
                [0.01, 0],
                [-0.01, 0],
                [0, 0.01],
                [0, -0.01],
              ].some(([dx, dy]) => polygons.some((polygon) => inPolygon(polygon, x + dx, y + dy)));
              expect(inside || nearby, `${shape} maska ${String(mask)} pol. ${String(half)}: (${x.toFixed(2)}; ${y.toFixed(2)})`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('lievik skráti okrajové čiary ramena, takže vo výplni lievika nie je tmavá čiara', () => {
    // straight, lievik na severe: zvislé čiary začínajú až v hĺbke lievika (y 13), nie na hrane bunky
    const strokes = narrowRoadPaths('straight', 1).strokes.map((stroke) => flatten(stroke));
    const vertical = strokes.filter((line) => Math.abs(line[0][0] - line[line.length - 1][0]) < 1e-9);
    expect(vertical.map((line) => Math.min(...line.map(([, y]) => y)))).toEqual([FLARE_DEPTH_PX, FLARE_DEPTH_PX]);
    // ... a šikmé čiary vychádzajú z hrany bunky a končia na osi zvislej čiary
    const slanted = strokes.filter((line) => Math.abs(line[0][0] - line[line.length - 1][0]) > 1);
    expect(slanted).toHaveLength(2);
    for (const line of slanted) expect(line[0][1]).toBe(0);
  });
});

function bitCount(mask: number): number {
  let count = 0;
  for (let m = mask; m > 0; m >>= 1) count += m & 1;
  return count;
}
