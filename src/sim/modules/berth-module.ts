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
 * - `apron` drží len rezervácie slotov; obsadenie číta z ledgera (ADR-017).
 * - `lastNoStorageHour` = herná hodina posledného `NoStorageAvailable` z tohto kotviska (throttle dispatchera
 *   1× za hodinu, ADR-018); jediný dynamický stav v save (`runtime`), ostatné sa odvodí.
 */
import type { EntityId } from '../core/entity-id';
import { berthParams } from '../defs/module-def';
import type { BerthParams, Side } from '../defs/types';
import type { CellCoord, DepthClass, Grid } from '../grid/grid';
import { ApronBuffer } from './apron-buffer';
import type { CargoDropTarget } from './cargo-drop-target';
import { Module, type ModuleInit } from './module';
import { ModuleError } from './module-error';
import { frontBandCells, waterSideOf } from './module-geometry';
import { checkRuntimeKeys, readOptionalCount } from './runtime-state';
import type { CargoSlotsView } from './slot-reservations';

/** Dynamický stav kotviska v save (`WorldState.modules[i].runtime`, ADR-018). */
export type BerthRuntimeState = {
  /** Herná hodina posledného `NoStorageAvailable` z kotviska; `null` = zatiaľ nikdy. */
  readonly lastNoStorageHour: number | null;
};

const BERTH_RUNTIME_KEYS: readonly (keyof BerthRuntimeState)[] = ['lastNoStorageHour'];

const NO_CRANES: readonly EntityId[] = Object.freeze([]);

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
  /** Cieľ nakládky exportu: slot apronu (`on_apron`, ADR-032) — jeden objekt na kotvisko, vracia ho `cargoDropTarget()`. */
  private readonly drop: CargoDropTarget;
  /** Loď, ktorá na kotvisku kotví alebo je naň pridelená (`berthing`); spravuje ShipSystem (T02-05). */
  dockedShipId: EntityId | null = null;
  /** Id `BerthGroup` (od 1); prepisuje ho `World` pri každom prepočte skupín. 0 = modul ešte nie je vo svete. */
  groupId = 0;
  /** Herná hodina posledného `NoStorageAvailable` (throttle 1×/h, ADR-018); mení ho len dispatcher, `null` = nikdy. */
  lastNoStorageHour: number | null = null;
  /** Žeriavy (meniteľná kópia len pre `attachCrane` / `detachCrane`); von ide zmrazená snímka `craneView`. */
  private readonly cranes: EntityId[] = [];
  private craneView: readonly EntityId[] = NO_CRANES;

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
    this.apron = new ApronBuffer(this.params.apronSlots, this.id, init.cargo, `apron ${this.label}`);
    const { apron } = this;
    this.drop = Object.freeze({
      kind: 'on_apron',
      category: null,
      reserves: true,
      places: apron.capacity,
      reservationsAt: (slot: number): number => (Number.isInteger(slot) && slot >= 0 && slot < apron.capacity && apron.isReserved(slot) ? 1 : 0),
      restoreReservation: (slot: number): void => {
        apron.reserveSlot(slot);
      },
      release: (slot: number): void => {
        apron.release(slot);
      },
      assertCommittable: (slot: number, unitId: EntityId): void => {
        apron.assertCommittable(slot, unitId);
      },
      commit: (slot: number, unitId: EntityId): void => {
        apron.commit(slot, unitId);
      },
    });
  }

  /** Cieľ nakládky exportu: slot apronu (`on_apron`, ADR-032 bod 9) — vozidlo ho pri vykládke premení na obsadenie. */
  override cargoDropTarget(): CargoDropTarget {
    return this.drop;
  }

  /** Sloty apronu (obsadenie z ledgera, rezervácie žeriavov) pre generický kód — ADR-017. */
  override cargoSlots(): CargoSlotsView {
    return this.apron;
  }

  /**
   * Žeriavy na kotvisku v poradí pripojenia (= poradie umiestnenia) — zmrazená snímka (review T03-13): mení sa len pri
   * `attachCrane` / `detachCrane`, čítanie nealokuje a volajúci interný zoznam zmeniť nemôže.
   */
  get craneIds(): readonly EntityId[] {
    return this.craneView;
  }

  /** Pripojí žeriav; volá výlučne `World.addModule` po overení pravidiel. Duplicitné id → `ModuleError('duplicate_id')`. */
  attachCrane(craneId: EntityId): void {
    if (this.cranes.includes(craneId)) {
      throw new ModuleError('duplicate_id', `${this.label}: žeriav #${String(craneId)} je už pripojený`);
    }
    this.cranes.push(craneId);
    this.craneView = Object.freeze([...this.cranes]);
  }

  /** Odpojí žeriav; volá výlučne `World.removeModule`. Nepripojený žeriav → `ModuleError('unknown_module')`. */
  detachCrane(craneId: EntityId): void {
    const index = this.cranes.indexOf(craneId);
    if (index < 0) throw new ModuleError('unknown_module', `${this.label}: žeriav #${String(craneId)} nie je pripojený`);
    this.cranes.splice(index, 1);
    this.craneView = Object.freeze([...this.cranes]);
  }

  override getRuntimeState(): BerthRuntimeState {
    return { lastNoStorageHour: this.lastNoStorageHour };
  }

  /**
   * Presne kľúče `BerthRuntimeState`, `lastNoStorageHour` `null` alebo celé ≥ 0 (že nie je v budúcnosti, overí obnova
   * sveta — modul hodiny nepozná). Neplatný stav → `ModuleStateError`, kotvisko sa nezmení.
   */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, BERTH_RUNTIME_KEYS);
    this.lastNoStorageHour = readOptionalCount(fields['lastNoStorageHour'], '/lastNoStorageHour');
  }
}
