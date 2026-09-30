/**
 * Kotvisko (ARCHITECTURE §5.3, §5.4; ADR-014). Dlhá hrana leží na strane `waterSide`, pred ňou kotví loď; na jeho
 * bunkách stoja žeriavy (`craneIds`, rozhodnutie 3 — `cell.moduleId` ostáva id berthu) a na nábreží je `apron`.
 *
 * - `waterSide` = `placement.waterSide` defu otočená o rotáciu (rot 0 = `n`).
 * - `lengthCells` = dĺžka hrany pri vode (= `def.footprint.w`, dlhá hrana pri rotácii 0) — príspevok do `BerthGroup`.
 * - `depthClass` = efektívna hĺbka `min(params.depthClass, min(cell.depthClass) footprintu)` (rozhodnutie 4):
 *   ponor lode obmedzuje typ kotviska aj mapa.
 * - `frontWaterBand` = pás `params.frontWaterCells` riadkov vody pred hranou pri vode (`frontBandCells`), kde kotví
 *   loď; `PlaceModule` ho overuje (ADR-015) a ShipSystem (T02-05) z neho odvodí polohu lode.
 */
import type { EntityId } from '../core/entity-id';
import { berthParams } from '../defs/module-def';
import type { BerthParams, Side } from '../defs/types';
import type { CellCoord, DepthClass, Grid } from '../grid/grid';
import { ApronBuffer } from './apron-buffer';
import { Module, type ModuleInit } from './module';
import { ModuleError } from './module-error';
import { frontBandCells, waterSideOf } from './module-geometry';

/** Efektívna hĺbka kotviska: menšia z hĺbky typu kotviska a najplytšej bunky footprintu (rozhodnutie 4). */
export function effectiveBerthDepth(params: BerthParams, cells: readonly { readonly x: number; readonly y: number }[], grid: Grid): DepthClass {
  let depth: DepthClass = params.depthClass;
  for (const { x, y } of cells) {
    const cellDepth = grid.at(x, y).depthClass;
    if (cellDepth < depth) depth = cellDepth;
  }
  return depth;
}

export class BerthModule extends Module {
  /** Typované `params` defu (`berthParams`). */
  readonly params: BerthParams;
  readonly waterSide: Side;
  readonly lengthCells: number;
  /** Efektívna hĺbka (rozhodnutie 4); 0 len pri berthe mimo nábrežia (neplatné umiestnenie). */
  readonly depthClass: DepthClass;
  /** Pás vody pred hranou pri vode (`frontBandCells`, hĺbka `params.frontWaterCells`); bunky môžu byť mimo mapy len pri neplatnom umiestnení. */
  readonly frontWaterBand: readonly CellCoord[];
  readonly apron: ApronBuffer;
  /** Loď, ktorá na kotvisku kotví alebo je naň pridelená (`berthing`); spravuje ShipSystem (T02-05). */
  dockedShipId: EntityId | null = null;
  /** Id `BerthGroup` (od 1); prepisuje ho `World` pri každom prepočte skupín. 0 = modul ešte nie je vo svete. */
  groupId = 0;
  private readonly cranes: EntityId[] = [];

  /** Def iného druhu než `berth` → `DefError`; def bez `placement.waterSide` → `ModuleError('invalid_input')`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = berthParams(init.def);
    const waterSide = waterSideOf(init.def, init.rotation);
    if (waterSide === undefined) {
      throw new ModuleError('invalid_input', `berth '${init.def.id}' nemá placement.waterSide`);
    }
    this.waterSide = waterSide;
    this.lengthCells = init.def.footprint.w;
    this.depthClass = effectiveBerthDepth(this.params, this.cells, init.grid);
    this.frontWaterBand = frontBandCells(this.origin, this.size, waterSide, this.params.frontWaterCells);
    this.apron = new ApronBuffer(this.params.apronSlots);
  }

  /** Žeriavy na kotvisku v poradí pripojenia (= poradie umiestnenia). Nemeň — spravuje ho `World`. */
  get craneIds(): readonly EntityId[] {
    return this.cranes;
  }

  /** Pripojí žeriav; volá výlučne `World.addModule` po overení pravidiel. Duplicitné id → `ModuleError('duplicate_id')`. */
  attachCrane(craneId: EntityId): void {
    if (this.cranes.includes(craneId)) {
      throw new ModuleError('duplicate_id', `${this.label}: žeriav #${String(craneId)} je už pripojený`);
    }
    this.cranes.push(craneId);
  }

  /** Odpojí žeriav; volá výlučne `World.removeModule`. Nepripojený žeriav → `ModuleError('unknown_module')`. */
  detachCrane(craneId: EntityId): void {
    const index = this.cranes.indexOf(craneId);
    if (index < 0) throw new ModuleError('unknown_module', `${this.label}: žeriav #${String(craneId)} nie je pripojený`);
    this.cranes.splice(index, 1);
  }
}
