/**
 * Procedurálne kreslenie hladkej koľaje (R6): podložka, pražce v rovnomernom rozstupe a dve koľajnice pozdĺž `RailPath`.
 * Rozmery a farby zodpovedajú spritu `rail_straight.svg` (`rail-config.ts`, tokeny `--rail-base`, `--rail-tie`).
 */
import type { Graphics } from 'pixi.js';
import {
  RAIL_BED_WIDTH_CELLS,
  RAIL_STEEL_OFFSET_CELLS,
  RAIL_STEEL_WIDTH_CELLS,
  RAIL_TIE_FIRST_CELLS,
  RAIL_TIE_LENGTH_CELLS,
  RAIL_TIE_PITCH_CELLS,
  RAIL_TIE_THICKNESS_CELLS,
} from './rail-config';
import { pointAt, type Pt, type RailPath } from './rail-path';
import type { RailPalette } from './tokens';

/** Alfa podložky ako v spritoch (`opacity .18`). */
const BED_ALPHA = 0.18;

/** Posun lomenej čiary o `offset` kolmo vľavo od smeru (priemerná normála v bodoch). */
export function offsetPolyline(points: readonly Pt[], offset: number): Pt[] {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: p.x + (-(b.y - a.y) / len) * offset, y: p.y + ((b.x - a.x) / len) * offset };
  });
}

/** Nakreslí cestu do `g` (súradnice v px: bunky × `cellPx`). */
export function drawRailPath(g: Graphics, path: RailPath, cellPx: number, palette: RailPalette): void {
  const line = (pts: readonly Pt[]): void => {
    pts.forEach((p, i) => {
      if (i === 0) g.moveTo(p.x * cellPx, p.y * cellPx);
      else g.lineTo(p.x * cellPx, p.y * cellPx);
    });
  };
  line(path.points);
  g.stroke({ width: RAIL_BED_WIDTH_CELLS * cellPx, color: palette.base.color, alpha: BED_ALPHA * palette.base.alpha, cap: 'butt', join: 'round' });
  for (let s = RAIL_TIE_FIRST_CELLS; s < path.length; s += RAIL_TIE_PITCH_CELLS) {
    const { point, dir } = pointAt(path, s);
    const nx = -dir.y * (RAIL_TIE_LENGTH_CELLS / 2);
    const ny = dir.x * (RAIL_TIE_LENGTH_CELLS / 2);
    g.moveTo((point.x - nx) * cellPx, (point.y - ny) * cellPx).lineTo((point.x + nx) * cellPx, (point.y + ny) * cellPx);
  }
  g.stroke({ width: RAIL_TIE_THICKNESS_CELLS * cellPx, color: palette.tie.color, alpha: palette.tie.alpha, cap: 'butt' });
  for (const side of [-1, 1]) line(offsetPolyline(path.points, side * RAIL_STEEL_OFFSET_CELLS));
  g.stroke({ width: RAIL_STEEL_WIDTH_CELLS * cellPx, color: palette.base.color, alpha: palette.base.alpha, cap: 'butt', join: 'round' });
}
