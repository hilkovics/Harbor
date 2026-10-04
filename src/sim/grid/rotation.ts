/**
 * Rotácia footprintu modulu (ARCHITECTURE §8 bod 7): 0/90/180/270 v smere hodinových ručičiek.
 *
 * Footprint `w×h` pri rotácii 0 má lokálne bunky `(x, y)`, `0 ≤ x < w`, `0 ≤ y < h`. Po rotácii leží v obdĺžniku
 * `rotateFootprint(w, h, r)` a lokálna bunka sa zobrazí podľa tabuľky (docs/tasks/phase-01.md, „Spoločné rozhrania“):
 *
 * | r   | výsledok             | rozmery |
 * |-----|----------------------|---------|
 * | 0   | (x, y)               | w×h     |
 * | 90  | (h−1−y, x)           | h×w     |
 * | 180 | (w−1−x, h−1−y)       | w×h     |
 * | 270 | (y, w−1−x)           | h×w     |
 */
import type { CellCoord } from './grid';

/** Povolené rotácie v stupňoch, v smere hodinových ručičiek. */
export const ROTATIONS = [0, 90, 180, 270] as const;

export type Rotation = (typeof ROTATIONS)[number];

interface RotationRule {
  /** Rotácia o 90 alebo 270 prehodí šírku a výšku footprintu. */
  readonly swapsAxes: boolean;
  /** Zobrazenie lokálnej bunky footprintu `w×h` (rozmery pred rotáciou). */
  readonly mapCell: (x: number, y: number, w: number, h: number) => CellCoord;
}

const ROTATION_RULES: Readonly<Record<Rotation, RotationRule>> = Object.freeze({
  0: { swapsAxes: false, mapCell: (x, y) => ({ x, y }) },
  90: { swapsAxes: true, mapCell: (x, y, _w, h) => ({ x: h - 1 - y, y: x }) },
  180: { swapsAxes: false, mapCell: (x, y, w, h) => ({ x: w - 1 - x, y: h - 1 - y }) },
  270: { swapsAxes: true, mapCell: (x, y, w) => ({ x: y, y: w - 1 - x }) },
});

/** Hodnota je jedna z povolených rotácií (napr. pri parsovaní JSON). */
export function isRotation(value: unknown): value is Rotation {
  return (ROTATIONS as readonly unknown[]).includes(value);
}

function ruleFor(rotation: Rotation, caller: string): RotationRule {
  if (!isRotation(rotation)) {
    throw new RangeError(`${caller}: rotácia musí byť 0, 90, 180 alebo 270, dostal ${String(rotation)}`);
  }
  return ROTATION_RULES[rotation];
}

function assertFootprint(w: number, h: number, caller: string): void {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1) {
    throw new RangeError(`${caller}: footprint musí mať celé rozmery ≥ 1, dostal ${String(w)}×${String(h)}`);
  }
}

/** Rozmery footprintu `w×h` po rotácii (90/270 prehodí `w` a `h`). */
export function rotateFootprint(w: number, h: number, rotation: Rotation): { w: number; h: number } {
  assertFootprint(w, h, 'rotateFootprint');
  return ruleFor(rotation, 'rotateFootprint').swapsAxes ? { w: h, h: w } : { w, h };
}

/**
 * Lokálna bunka `(x, y)` footprintu `w×h` (rozmery pri rotácii 0) po rotácii `rotation`.
 * Výsledok leží v `rotateFootprint(w, h, rotation)`; zobrazenie je bijekcia. Bunka mimo footprintu → `RangeError`.
 */
export function rotateLocalCell(x: number, y: number, w: number, h: number, rotation: Rotation): CellCoord {
  assertFootprint(w, h, 'rotateLocalCell');
  const rule = ruleFor(rotation, 'rotateLocalCell');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) {
    throw new RangeError(
      `rotateLocalCell: bunka (${String(x)}, ${String(y)}) je mimo footprintu ${String(w)}×${String(h)}`,
    );
  }
  return rule.mapCell(x, y, w, h);
}
