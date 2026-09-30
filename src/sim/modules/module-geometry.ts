/**
 * Geometria modulov (ARCHITECTURE §8 bod 7): footprint po rotácii a otáčanie strán. Čisté funkcie bez stavu —
 * rovnako ich používa `Module` (bunky), `PlaceModule.validate` (ghost, T02-04) aj výpočet `BerthGroup`.
 *
 * Konvencia (docs/tasks/phase-02.md): `x`, `y` = ľavý horný roh footprintu **po** rotácii; rotácia v smere
 * hodinových ručičiek (`rotateLocalCell`), preto strana `n` sa pri 90° stane `e`, pri 180° `s`, pri 270° `w`.
 */
import type { ModuleDef, ModulePlacementDef, Side } from '../defs/types';
import { SIDES } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import { ROTATIONS, rotateFootprint, type Rotation } from '../grid/rotation';

/** Rozmery a bunky footprintu vo svete. */
export interface ModuleFootprint {
  /** Rozmery po rotácii. */
  readonly size: { readonly w: number; readonly h: number };
  /** Bunky footprintu row-major (y, potom x) — deterministické poradie pre udalosti aj serializáciu. */
  readonly cells: readonly CellCoord[];
}

/** Počet krokov po 90° pre rotáciu (index v `ROTATIONS`). */
function quarterTurns(rotation: Rotation): number {
  const turns = ROTATIONS.indexOf(rotation);
  if (turns < 0) throw new RangeError(`rotácia musí byť 0, 90, 180 alebo 270, dostal ${String(rotation)}`);
  return turns;
}

/** Strana `side` (pri rotácii 0) po otočení modulu o `rotation` v smere hodinových ručičiek. */
export function rotateSide(side: Side, rotation: Rotation): Side {
  const index = SIDES.indexOf(side);
  if (index < 0) throw new RangeError(`strana musí byť n, e, s alebo w, dostal ${String(side)}`);
  return SIDES[(index + quarterTurns(rotation)) % SIDES.length];
}

/** `placement.waterSide` defu (pri rotácii 0) ako strana `Side` — tabuľka, nie switch. */
const WATER_SIDE_AT_ROTATION_0: { readonly [K in NonNullable<ModulePlacementDef['waterSide']>]: Side } = { north: 'n' };

/**
 * Strana dlhej hrany pri vode po rotácii (berth: rot 0 = `n`); `undefined` pre def bez `placement.waterSide`
 * (nie-berth).
 */
export function waterSideOf(def: Readonly<ModuleDef>, rotation: Rotation): Side | undefined {
  const { waterSide } = def.placement;
  return waterSide === undefined ? undefined : rotateSide(WATER_SIDE_AT_ROTATION_0[waterSide], rotation);
}

/**
 * Footprint defu s ľavým horným rohom (po rotácii) na `(x, y)`. Hranice mapy neoveruje (to je vec volajúceho —
 * `Grid.rectInBounds`); neplatná rotácia alebo rozmer → `RangeError`.
 */
export function footprintOf(def: Readonly<ModuleDef>, x: number, y: number, rotation: Rotation): ModuleFootprint {
  const size = rotateFootprint(def.footprint.w, def.footprint.h, rotation);
  const cells: CellCoord[] = [];
  for (let cy = y; cy < y + size.h; cy++) {
    for (let cx = x; cx < x + size.w; cx++) cells.push(Object.freeze({ x: cx, y: cy }));
  }
  return { size: Object.freeze(size), cells: Object.freeze(cells) };
}
