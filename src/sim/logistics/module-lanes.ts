/**
 * Pruhy modulov pre prezentáciu (TR3-05, VM `ModuleVM.lanes`): bunky jednosmerných pruhov kotviska a RTG bloku so smerom jazdy. Čistý dotaz nad modulom (odvodené z
 * geometrie a rotácie, nie z mriežky sveta), takže ho možno volať aj pre ghost.
 *
 * - kotvisko: `lane` = riadky pod žeriavom (dva jednosmerné pruhy, TP je bunka pod hákom), `bypass` = pevninský riadok (obchádzka bez zastavovania); riadok pri vode
 *   (nohy žeriavov) nie je jazdný a v zozname nie je; smer zľava doprava pri rotácii 0, otočený s modulom;
 * - RTG blok: `lane` = bunky pruhu s TP v stĺpci `laneCol`, smer od vjazdu (bay 0) k výjazdu (rot 0 = `S`).
 */
import { rotateLocalCell } from '../grid/rotation';
import { BerthModule } from '../modules/berth-module';
import type { Module } from '../modules/module';
import { edgeCells, rotateSide } from '../modules/module-geometry';
import { RtgBlock } from '../modules/rtg-block';
import type { Side } from '../defs/types';

export type LaneDirection = 'N' | 'E' | 'S' | 'W';
export type LaneRole = 'lane' | 'bypass';

export interface LaneCell {
  readonly x: number;
  readonly y: number;
  readonly dir: LaneDirection;
  readonly role: LaneRole;
}

const DIRECTION_OF_SIDE: { readonly [S in Side]: LaneDirection } = { n: 'N', e: 'E', s: 'S', w: 'W' };
const HALF_TURN = 180;
const QUARTER_TURN = 90;
const RTG_LANE_SIDE: Side = 's';

/** Bunky pruhov modulu so smerom a úlohou; modul bez pruhov (iný druh) → prázdne pole. Poradie: row-major pri kotvisku, od bayu 0 pri RTG bloku. */
export function moduleLanes(module: Module): readonly LaneCell[] {
  if (module instanceof BerthModule) {
    const dir = DIRECTION_OF_SIDE[rotateSide(module.waterSide, QUARTER_TURN)];
    const water = new Set(edgeCells(module.origin, module.size, module.waterSide).map(({ x, y }) => `${String(x)},${String(y)}`));
    const land = new Set(edgeCells(module.origin, module.size, rotateSide(module.waterSide, HALF_TURN)).map(({ x, y }) => `${String(x)},${String(y)}`));
    const cells: LaneCell[] = [];
    for (const { x, y } of module.cells) {
      const key = `${String(x)},${String(y)}`;
      if (water.has(key)) continue;
      cells.push({ x, y, dir, role: land.has(key) ? 'bypass' : 'lane' });
    }
    return cells;
  }
  if (module instanceof RtgBlock) {
    const dir = DIRECTION_OF_SIDE[rotateSide(RTG_LANE_SIDE, module.rotation)];
    const { w, h } = module.def.footprint;
    return Array.from({ length: module.geometry.bays }, (_, bay): LaneCell => {
      const local = rotateLocalCell(module.laneCol, bay, w, h, module.rotation);
      return { x: module.origin.x + local.x, y: module.origin.y + local.y, dir, role: 'lane' };
    });
  }
  return [];
}

