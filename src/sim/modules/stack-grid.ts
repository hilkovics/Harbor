/**
 * Geometria bloku so stohmi a `StackGrid` (ADR-039 bod 3–5): dekódovanie slotu `((row × bays) + bay) × maxTier + tier`
 * a odvodená cache obsadenia buniek bloku. Cache **nie je v save** — zostaví sa z ledgera pri vzniku modulu / obnove
 * a udržiava sa hákmi ledgera (`StorageGuard`); invariant kroku 12 ju porovnáva s ledgerom (`YardBlock.findStackProblem`).
 *
 * Bunka = `(bay, row, tier)`; stoh (stĺpec) = `(bay, row)`. Kontajner 20′ zaberá jednu bunku (jeho slot), 40′ pár buniek
 * rovnakého `(row, tier)` v bays `(2k, 2k+1)` — jeho slot je bunka v párnom bay, bunka vedľa (`+ maxTier`) je „tieň“.
 * Cache drží v oboch bunkách 40′ id tej istej jednotky.
 */
import type { EntityId } from '../core/entity-id';

/** Geometria bloku (z `params` skladu); kapacita v TEU = `bays × rows × maxTier`. */
export interface YardGeometry {
  readonly bays: number;
  readonly rows: number;
  readonly maxTier: number;
}

/** Poloha bunky v bloku. */
export interface YardPosition {
  readonly bay: number;
  readonly row: number;
  readonly tier: number;
}

/** Kapacita bloku v TEU (počet buniek). */
export function geometryCapacity(geometry: YardGeometry): number {
  return geometry.bays * geometry.rows * geometry.maxTier;
}

/** Slot bunky `(bay, row, tier)`: `((row × bays) + bay) × maxTier + tier`. */
export function slotOfCell(geometry: YardGeometry, bay: number, row: number, tier: number): number {
  return (row * geometry.bays + bay) * geometry.maxTier + tier;
}

/** Poloha bunky slotu (slot mimo `0 … kapacita − 1` nie je overovaný — volajúci ho kontroluje). */
export function positionOfCell(geometry: YardGeometry, slot: number): YardPosition {
  const tier = slot % geometry.maxTier;
  const column = (slot - tier) / geometry.maxTier;
  const bay = column % geometry.bays;
  return { bay, row: (column - bay) / geometry.bays, tier };
}

/** Odvodená cache obsadenia buniek (viď hlavička súboru). Operácie `place` / `remove` predpokladajú už overený presun (`YardBlock.assertCanPlace`). */
export class StackGrid {
  readonly geometry: YardGeometry;
  /** Bunka (slot) → id jednotky, ktorá ju zaberá (0 = voľná); 40′ zapisuje id do oboch buniek. */
  private readonly cells: Int32Array;
  /** Stĺpec (`row × bays + bay`) → výška stohu (počet obsadených vrstiev zdola). */
  private readonly heights: Uint8Array;

  constructor(geometry: YardGeometry) {
    this.geometry = geometry;
    this.cells = new Int32Array(geometryCapacity(geometry));
    this.heights = new Uint8Array(geometry.bays * geometry.rows);
  }

  /** Vyprázdni cache (pred `place` všetkých jednotiek ledgera pri obnove). */
  clear(): void {
    this.cells.fill(0);
    this.heights.fill(0);
  }

  /** Výška stohu `(bay, row)` — počet obsadených vrstiev. */
  height(bay: number, row: number): number {
    return this.heights[row * this.geometry.bays + bay];
  }

  /** Jednotka na vrchu stohu `(bay, row)`, alebo `null` pre prázdny stoh. */
  top(bay: number, row: number): EntityId | null {
    const height = this.heights[row * this.geometry.bays + bay];
    return height === 0 ? null : (this.cells[slotOfCell(this.geometry, bay, row, height - 1)] as EntityId);
  }

  /** Jednotka, ktorá zaberá bunku `(bay, row, tier)`, alebo `null` (40′ aj z bunky tieňa). */
  at(bay: number, row: number, tier: number): EntityId | null {
    const id = this.cells[slotOfCell(this.geometry, bay, row, tier)];
    return id === 0 ? null : (id as EntityId);
  }

  /** Počet obsadených buniek (TEU v cache). */
  get occupiedCells(): number {
    let sum = 0;
    for (const height of this.heights) sum += height;
    return sum;
  }

  /** Zapíše jednotku na `slot` (40′ aj bunku vedľa). */
  place(unitId: EntityId, sizeFt: number, slot: number): void {
    this.write(slot, sizeFt, unitId);
  }

  /** Odstráni jednotku zo `slotu` (40′ aj bunku vedľa); výška stĺpca klesne na vrstvu jednotky. */
  remove(slot: number, sizeFt: number): void {
    this.write(slot, sizeFt, 0);
  }

  private write(slot: number, sizeFt: number, id: number): void {
    const { geometry } = this;
    const { bay, row, tier } = positionOfCell(geometry, slot);
    const covered = sizeFt === 40 ? 2 : 1;
    for (let i = 0; i < covered; i++) {
      this.cells[slotOfCell(geometry, bay + i, row, tier)] = id;
      this.heights[row * geometry.bays + bay + i] = id === 0 ? tier : tier + 1;
    }
  }
}
