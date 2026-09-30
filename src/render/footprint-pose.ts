/**
 * Poloha a rotácia spritu modulu (manifest `conventions.rotation`): engine rotuje po 90° okolo STREDU footprintu,
 * sprite je nakreslený v jednej orientácii (rot 0).
 *
 * `ModuleVM` / `CraneVM` nesú ľavý horný roh a rozmery footprintu PO rotácii. Sprite sa preto kladie do kontajnera
 * so stredom v strede footprintu, ktorý sa otočí o `rotation` — vnútri kontajnera sú súradnice rot 0
 * (`baseW × baseH`, počiatok = stred). Čisté funkcie bez Pixi, aby šli testovať v Node.
 */
import { rotateFootprint, type Rotation } from '@sim/grid';
import type { ManifestPoint } from './entity-assets';

/** Footprint v svete: ľavý horný roh a rozmery PO rotácii (bunky) + rotácia. */
export interface FootprintBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation: Rotation;
}

export interface FootprintPose {
  /** Stred footprintu vo svete (px). */
  readonly cx: number;
  readonly cy: number;
  /** Uhol kontajnera (stupne v smere hodinových ručičiek) = rotácia modulu. */
  readonly angle: Rotation;
  /** Rozmery footprintu PRED rotáciou (bunky) — v nich je nakreslený sprite. */
  readonly baseW: number;
  readonly baseH: number;
}

/** Stred a rozmery pred rotáciou pre footprint `box`; `cellPx` = `--cell`. */
export function footprintPose(box: FootprintBox, cellPx: number): FootprintPose {
  const base = rotateFootprint(box.w, box.h, box.rotation); // rotácia 90/270 prehodí osi, preto je to aj inverzia
  return {
    cx: (box.x + box.w / 2) * cellPx,
    cy: (box.y + box.h / 2) * cellPx,
    angle: box.rotation,
    baseW: base.w,
    baseH: base.h,
  };
}

/**
 * Otočí vektor `(dx, dy)` o `rotation` stupňov v smere hodinových ručičiek (os y ide nadol). Presne pre násobky 90°
 * (bez `sin`/`cos`, teda bez zaokrúhlovacích chýb).
 */
export function rotateOffset(dx: number, dy: number, rotation: Rotation): ManifestPoint {
  switch (rotation) {
    case 0:
      return { x: dx, y: dy };
    case 90:
      return { x: 0 - dy, y: dx }; // `0 - v` namiesto `-v`: bez zápornej nuly
    case 180:
      return { x: 0 - dx, y: 0 - dy };
    case 270:
      return { x: dy, y: 0 - dx };
  }
}

/**
 * Stred lokálnej bunky `cell` (bunky footprintu pri rot 0) vzhľadom na stred footprintu, v px, PRED rotáciou —
 * súradnica v kontajneri modulu.
 */
export function localCellCenter(cell: ManifestPoint, baseW: number, baseH: number, cellPx: number): ManifestPoint {
  return { x: (cell.x + 0.5 - baseW / 2) * cellPx, y: (cell.y + 0.5 - baseH / 2) * cellPx };
}

/**
 * Stred lokálnej bunky `cell` (rot 0) vo svete (px) po rotácii modulu `box`. Zhoduje sa so simom:
 * `rotateLocalCell(cell.x, cell.y, baseW, baseH, rotation)` + `(box.x, box.y)`, stred bunky `+ 0.5`.
 */
export function localCellWorldCenter(box: FootprintBox, cell: ManifestPoint, cellPx: number): ManifestPoint {
  const pose = footprintPose(box, cellPx);
  const local = localCellCenter(cell, pose.baseW, pose.baseH, cellPx);
  const rotated = rotateOffset(local.x, local.y, box.rotation);
  return { x: pose.cx + rotated.x, y: pose.cy + rotated.y };
}
