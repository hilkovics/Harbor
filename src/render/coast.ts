/**
 * Prechody pobrežia (DESIGN_BRIEF §5.1): ktorý sprite terénu patrí bunke podľa jej susedov.
 *
 * Čistá funkcia mriežky bez Pixi — testovateľná v Node. `TerrainLayer` z nej dostane id sprity
 * (`assets/manifest.json` → `terrain.<id>`), kreslenie sa týka len jeho.
 *
 * Sprity `water_*` na PEVNINE majú vodu vykreslenú zo strany/rohu (pena `--terrain-water-foam`); vodné bunky samotné
 * sú plné (`water_deep` / `water_shallow`), takže pobrežie sa kreslí na strane pevniny.
 */
import type { terrain as terrainManifest } from '../../assets/manifest.json';
import { DIRECTIONS_4, isWater, type Grid } from '@sim/grid';

/** Id sprity terénu podľa manifestu (`terrain.*`), vrátane obrysov parciel a portálov. */
export type TerrainSpriteId = keyof typeof terrainManifest;

/** Id sprity, ktorú vie vybrať `coastTile` (bez `parcel_outline_*` a `portal_*` — tie nie sú súčasťou terénu bunky). */
export type CoastTileId = Exclude<TerrainSpriteId, `parcel_outline_${string}` | `portal_${string}`>;

const [BIT_N, BIT_E, BIT_S, BIT_W] = DIRECTIONS_4.map((direction) => direction.bit);

/** Sprity „voda z jednej strany“ v poradí N, E, S, W (rovnaké ako `DIRECTIONS_4`). */
const EDGE_BY_DIRECTION: readonly CoastTileId[] = Object.freeze([
  'water_edge_n',
  'water_edge_e',
  'water_edge_s',
  'water_edge_w',
]);

/** Sprity „voda z dvoch susedných strán“ podľa masky vody. */
const INNER_BY_MASK: ReadonlyMap<number, CoastTileId> = new Map<number, CoastTileId>([
  [BIT_N | BIT_E, 'water_inner_ne'],
  [BIT_E | BIT_S, 'water_inner_se'],
  [BIT_S | BIT_W, 'water_inner_sw'],
  [BIT_W | BIT_N, 'water_inner_nw'],
]);

interface DiagonalCorner {
  readonly dx: number;
  readonly dy: number;
  readonly tile: CoastTileId;
}

/** Diagonály v poradí, v akom sa hľadá voda v rohu bez vody na stranách: NE, NW, SE, SW. */
const DIAGONAL_CORNERS: readonly DiagonalCorner[] = Object.freeze([
  { dx: 1, dy: -1, tile: 'water_corner_ne' },
  { dx: -1, dy: -1, tile: 'water_corner_nw' },
  { dx: 1, dy: 1, tile: 'water_corner_se' },
  { dx: -1, dy: 1, tile: 'water_corner_sw' },
]);

/** Strana šachovnice pevniny v bunkách (DESIGN_BRIEF §3 `--terrain-land-alt`: „šachovnica 2×2 buniek“). */
const LAND_CHECKER_CELLS = 2;

/** Bunka (x, y) leží v mape a je to voda; bunky mimo mapy sa nepočítajú ako voda. */
function isWaterAt(grid: Grid, x: number, y: number): boolean {
  return grid.inBounds(x, y) && isWater(grid.at(x, y).terrain);
}

/**
 * Maska vody v 4-susedoch bunky (x, y): N=1, E=2, S=4, W=8 (`DIRECTIONS_4[i].bit`, rovnako ako autotile ciest).
 * Samotná bunka sa nekontroluje; susedia mimo mapy nie sú voda.
 */
export function coastWaterMask(grid: Grid, x: number, y: number): number {
  let mask = 0;
  for (const { dx, dy, bit } of DIRECTIONS_4) {
    if (isWaterAt(grid, x + dx, y + dy)) mask |= bit;
  }
  return mask;
}

/** Sprite pevniny (`land` / `land_alt`) podľa šachovnice 2×2 buniek. */
function landChecker(x: number, y: number): CoastTileId {
  const parity = (Math.floor(x / LAND_CHECKER_CELLS) + Math.floor(y / LAND_CHECKER_CELLS)) % 2;
  return parity === 0 ? 'land' : 'land_alt';
}

/** Sprite pevniny podľa vody okolo: strana, vnútorný roh (dve susedné strany), roh (diagonála), inak šachovnica. */
function landTile(grid: Grid, x: number, y: number): CoastTileId {
  const mask = coastWaterMask(grid, x, y);
  if (mask !== 0) {
    const inner = INNER_BY_MASK.get(mask);
    if (inner !== undefined) return inner;
    // Jedna strana, protiľahlé strany alebo ≥ 3 strany: hrana prvej strany v poradí N, E, S, W.
    const first = DIRECTIONS_4.findIndex((direction) => (mask & direction.bit) !== 0);
    return EDGE_BY_DIRECTION[first];
  }
  const corner = DIAGONAL_CORNERS.find(({ dx, dy }) => isWaterAt(grid, x + dx, y + dy));
  return corner !== undefined ? corner.tile : landChecker(x, y);
}

/**
 * Otočenie sprity bunky v štvrťotáčkach po smere hodinových ručičiek (0 = bez otočenia). Hranu nábrežia (`quay_edge_n`,
 * voda na severe) má manifest len s jednou stranou, ostatné strany sa kreslia jej otočením: voda na východe 1, na juhu 2,
 * na západe 3 štvrťotáčky. Iné sprity sa neotáčajú (pevnina má vlastné sprity pre všetky štyri strany).
 */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** Otočenie sprity `coastTile` pre bunku (x, y) — viď `QuarterTurns`; pri vode na viacerých stranách nábrežia platí prvá v poradí N, E, S, W. */
export function coastQuarterTurns(grid: Grid, x: number, y: number): QuarterTurns {
  if (grid.at(x, y).terrain !== 'quay') return 0;
  const mask = coastWaterMask(grid, x, y);
  const first = DIRECTIONS_4.findIndex((direction) => (mask & direction.bit) !== 0);
  return first < 0 ? 0 : (first as QuarterTurns);
}

/**
 * Sprite terénu bunky (x, y) podľa typu a susedov:
 * - `blocked` → `blocked`; hlboká/plytká voda → `water_deep` / `water_shallow`;
 * - `quay`: voda na ktorejkoľvek strane → `quay_edge_n` (voda na severe; ostatné strany sú jeho otočenie, `coastQuarterTurns`),
 *   inak `quay`;
 * - `land`: maska vody v 4-susedoch (N=1, E=2, S=4, W=8) — jedna strana `water_edge_{n|e|s|w}`, dve susedné strany
 *   `water_inner_{ne|se|sw|nw}`, protiľahlé strany alebo ≥ 3 strany hrana prvej strany v poradí N, E, S, W; bez vody
 *   na stranách, ale s vodou na diagonále → `water_corner_{ne|nw|se|sw}` (prvá v poradí NE, NW, SE, SW);
 *   inak šachovnica 2×2 (`⌊x/2⌋ + ⌊y/2⌋` párne → `land`, nepárne → `land_alt`).
 * Bunky mimo mapy sa nepočítajú ako voda; bunka (x, y) mimo mapy je `RangeError` (`Grid.at`).
 */
export function coastTile(grid: Grid, x: number, y: number): CoastTileId {
  const terrain = grid.at(x, y).terrain;
  if (terrain === 'blocked') return 'blocked';
  if (terrain === 'deep_water') return 'water_deep';
  if (terrain === 'shallow_water') return 'water_shallow';
  if (terrain === 'quay') return coastWaterMask(grid, x, y) !== 0 ? 'quay_edge_n' : 'quay';
  return landTile(grid, x, y);
}
