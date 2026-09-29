/**
 * Mriežka sveta (ARCHITECTURE §5.1): `width × height` buniek uložených row-major (`index = y * width + x`).
 * Súradnice: `x` doprava, `y` nadol; (0, 0) je ľavý horný roh, sever = menšie `y`.
 *
 * `inBounds`, `index`, `at`, `atIndex` nealokujú (horúca cesta A*, autotile, validácia ghostu).
 * Prístup mimo mapy je chyba (`RangeError`), nie `undefined` — volajúci sa pýta `inBounds` vopred.
 */
import type { EntityId } from '../core/entity-id';
import type { TerrainType } from './terrain';

/** Súradnice bunky (v `MapDef` §4.7 označené ako `Cell`). */
export interface CellCoord {
  readonly x: number;
  readonly y: number;
}

/** Obdĺžnik buniek: ľavý horný roh a rozmery (parcely, zóny hĺbky, footprinty). */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Vrstva dopravy na bunke — cesta alebo koľaj, nikdy obe (ADR-006). */
export type RoadLayer = 'none' | 'road' | 'rail';

/** Hĺbková trieda bunky: 1–3 pre nábrežie (§4.7 `depth`), 0 pre všetko ostatné. */
export type DepthClass = 0 | 1 | 2 | 3;

/**
 * Bunka mriežky (§5.1). Statické polia (`terrain`, `depthClass`, `parcelId`) určí mapa a nemenia sa;
 * dynamické (`moduleId`, `road`, `traffic`) mení simulácia.
 */
export interface Cell {
  readonly terrain: TerrainType;
  readonly depthClass: DepthClass;
  /** Parcela, do ktorej bunka patrí; `null` = verejná bunka (ADR-008). */
  readonly parcelId: string | null;
  /** Modul, ktorého footprint bunku zaberá. */
  moduleId: EntityId | null;
  road: RoadLayer;
  /** Akumulátor heatmapy dopravy (§7.6, decay). */
  traffic: number;
}

/** Statické polia novej bunky; dynamické začínajú prázdne (`moduleId: null`, `road: 'none'`, `traffic: 0`). */
export interface CellInit {
  readonly terrain: TerrainType;
  /** Predvolene 0. */
  readonly depthClass?: DepthClass;
  /** Predvolene `null` (verejná bunka). */
  readonly parcelId?: string | null;
}

export type Direction4Name = 'N' | 'E' | 'S' | 'W';

export interface Direction4 {
  readonly name: Direction4Name;
  readonly dx: number;
  readonly dy: number;
  /** Bit v maske susedov (autotile, T01-08): N=1, E=2, S=4, W=8. */
  readonly bit: number;
}

/** Štyri smery v poradí N, E, S, W — rovnaké poradie ako `Grid.neighbors4`. */
export const DIRECTIONS_4: readonly Direction4[] = Object.freeze([
  Object.freeze({ name: 'N', dx: 0, dy: -1, bit: 1 }),
  Object.freeze({ name: 'E', dx: 1, dy: 0, bit: 2 }),
  Object.freeze({ name: 'S', dx: 0, dy: 1, bit: 4 }),
  Object.freeze({ name: 'W', dx: -1, dy: 0, bit: 8 }),
] as const);

function assertDimension(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Grid: ${name} musí byť celé číslo ≥ 1, dostal ${String(value)}`);
  }
}

function createCell(init: CellInit): Cell {
  return {
    terrain: init.terrain,
    depthClass: init.depthClass ?? 0,
    parcelId: init.parcelId ?? null,
    moduleId: null,
    road: 'none',
    traffic: 0,
  };
}

export class Grid {
  readonly width: number;
  readonly height: number;
  /** Row-major: `cells[y * width + x]`. */
  private readonly cells: Cell[];

  /**
   * @param width šírka v bunkách (celé číslo ≥ 1)
   * @param height výška v bunkách (celé číslo ≥ 1)
   * @param init statické polia bunky na (x, y); volá sa row-major (y, potom x)
   */
  constructor(width: number, height: number, init: (x: number, y: number) => CellInit) {
    assertDimension('width', width);
    assertDimension('height', height);
    this.width = width;
    this.height = height;
    this.cells = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        this.cells.push(createCell(init(x, y)));
      }
    }
  }

  /** Počet buniek (`width × height`); platné indexy sú `0 … cellCount − 1`. */
  get cellCount(): number {
    return this.cells.length;
  }

  /** Bunka leží v mape (celočíselné súradnice v rozsahu). */
  inBounds(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Bunka leží na okraji mapy (a v mape). */
  isEdge(x: number, y: number): boolean {
    return this.inBounds(x, y) && (x === 0 || y === 0 || x === this.width - 1 || y === this.height - 1);
  }

  /** Row-major index bunky (`y * width + x`); mimo mapy `RangeError`. */
  index(x: number, y: number): number {
    if (!this.inBounds(x, y)) this.throwOutOfBounds('index', x, y);
    return y * this.width + x;
  }

  /** Bunka na (x, y) — živý objekt (zápis dynamických polí sa prejaví v mriežke); mimo mapy `RangeError`. */
  at(x: number, y: number): Cell {
    if (!this.inBounds(x, y)) this.throwOutOfBounds('at', x, y);
    return this.cells[y * this.width + x];
  }

  /** Bunka podľa row-major indexu (serializácia, iterácia); mimo rozsahu `RangeError`. */
  atIndex(index: number): Cell {
    if (!Number.isInteger(index) || index < 0 || index >= this.cells.length) {
      throw new RangeError(`Grid.atIndex: index ${String(index)} je mimo 0…${String(this.cells.length - 1)}`);
    }
    return this.cells[index];
  }

  /** Súradnice bunky s daným row-major indexom (inverzia `index`); mimo rozsahu `RangeError`. */
  coordOf(index: number): CellCoord {
    if (!Number.isInteger(index) || index < 0 || index >= this.cells.length) {
      throw new RangeError(`Grid.coordOf: index ${String(index)} je mimo 0…${String(this.cells.length - 1)}`);
    }
    return { x: index % this.width, y: Math.floor(index / this.width) };
  }

  /**
   * Susedia bunky v poradí N, E, S, W (`DIRECTIONS_4`); susedia mimo mapy sa vynechajú, relatívne poradie ostáva.
   * Pre bitovú masku podľa smeru iteruj `DIRECTIONS_4` s `inBounds` (index v tomto poli nemusí zodpovedať smeru).
   * Samotná bunka musí byť v mape, inak `RangeError`.
   */
  neighbors4(x: number, y: number): CellCoord[] {
    if (!this.inBounds(x, y)) this.throwOutOfBounds('neighbors4', x, y);
    const result: CellCoord[] = [];
    for (const { dx, dy } of DIRECTIONS_4) {
      const nx = x + dx;
      const ny = y + dy;
      if (this.inBounds(nx, ny)) result.push({ x: nx, y: ny });
    }
    return result;
  }

  /** Celý obdĺžnik leží v mape (celočíselný, `w, h ≥ 1`). */
  rectInBounds(rect: Rect): boolean {
    const { x, y, w, h } = rect;
    return (
      Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && this.inBounds(x, y) && this.inBounds(x + w - 1, y + h - 1)
    );
  }

  /** Bunky obdĺžnika row-major (footprint, parcela); obdĺžnik mimo mapy `RangeError`. */
  rect(rect: Rect): CellCoord[] {
    if (!this.rectInBounds(rect)) {
      const { x, y, w, h } = rect;
      throw new RangeError(
        `Grid.rect: obdĺžnik ${String(x)},${String(y)} ${String(w)}×${String(h)} nie je celý v mape ${String(this.width)}×${String(this.height)}`,
      );
    }
    const result: CellCoord[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) result.push({ x, y });
    }
    return result;
  }

  /** Nezávislá hlboká kópia vrátane dynamických polí (napr. `World` si klonuje šablónu z `LoadedMap`). */
  clone(): Grid {
    const copy = new Grid(this.width, this.height, (x, y) => this.at(x, y));
    for (let i = 0; i < this.cells.length; i++) {
      const source = this.cells[i];
      const target = copy.cells[i];
      target.moduleId = source.moduleId;
      target.road = source.road;
      target.traffic = source.traffic;
    }
    return copy;
  }

  private throwOutOfBounds(method: string, x: number, y: number): never {
    throw new RangeError(
      `Grid.${method}: bunka (${String(x)}, ${String(y)}) je mimo mapy ${String(this.width)}×${String(this.height)}`,
    );
  }
}
