/**
 * TerrainLayer (ARCHITECTURE §15.1): statický terén sveta, kreslí sa raz pri načítaní mapy.
 *
 * Sprity (`textures` z `SpriteAtlas`): každá bunka dostane sprite `terrain.<id>` z manifestu podľa `coastTile`
 * (prechody pobrežia, šachovnica pevniny 2×2, hrana nábrežia — DESIGN_BRIEF §5.1; hrana nábrežia s vodou na východe, juhu
 * alebo západe je sprite `quay_edge_n` otočený o štvrťotáčky, `coastQuarterTurns`). 6 144 buniek je jedna
 * statická render group: batche sa zostavia raz a posun/zoom kamery ich neprepočítava (mení sa len transformácia
 * skupiny), takže výkon pri zoome 0,25 aj 2,0 je rovnaký a nezávisí od počtu buniek vo výreze.
 *
 * Bez textúr (`textures === null`, napr. testy bez DOM alebo chýbajúci sprite) padá na dočasné kreslenie z tokenov
 * (`--terrain-*`): plné bunky (pevnina ako šachovnica 2×2), pena pri hrane vody a hrana nábrežia k vode.
 * Rozdelenie: `planTerrain` (čistá funkcia, testovateľná v Node) rozhodne CO sa kreslí — zlúčené obdĺžniky
 * podľa farby výplne a pásiky hrán v jednotkách buniek; `TerrainLayer` iba prevedie plán na jeden `Graphics`
 * (staticky, ~desiatky obdĺžnikov na farbu).
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { DIRECTIONS_4, isWater, type Direction4, type Grid, type Rect, type TerrainType } from '@sim/grid';
import { coastQuarterTurns, coastTile, type CoastTileId } from './coast';
import type { SpriteTextures } from './sprite-atlas';
import type { ColorValue, RenderPalette } from './tokens';

/** Farby výplne plných buniek (kľúče `TerrainPalette`). */
export type TerrainFillKey = 'waterDeep' | 'waterShallow' | 'quay' | 'land' | 'landAlt' | 'blocked';

/** Poradie kreslenia výplní (plochy sa neprekrývajú, poradie len fixuje deterministický výstup). */
export const TERRAIN_FILL_KEYS: readonly TerrainFillKey[] = Object.freeze([
  'waterDeep',
  'waterShallow',
  'quay',
  'land',
  'landAlt',
  'blocked',
]);

/** Šachovnica pevniny: strana políčka v bunkách (DESIGN_BRIEF §3 `--terrain-land-alt`: „šachovnica 2×2 buniek“). */
export const LAND_CHECKER_CELLS = 2;

/** Hrúbka peny pri hrane vody ako zlomok bunky (`--cell`); „jemná linka pri pobreží“ (2 px pri 64 px). */
export const FOAM_THICKNESS_CELLS = 1 / 32;

/** Hrúbka hrany nábrežia k vode ako zlomok bunky (`--cell`); tokens.css: „hrana k vode, 4 px“ (pri 64 px). */
export const QUAY_EDGE_THICKNESS_CELLS = 1 / 16;

/** Stred bunky ako zlomok jej strany (kotva otáčaného sprite). */
const HALF_CELL = 0.5;

/** Štvrťotáčka v radiánoch. */
const QUARTER_TURN_RAD = Math.PI / 2;

/** Výplň pre typ terénu; pevnina je výnimka (šachovnica), rieši ju `terrainFillKey`. */
const FILL_BY_TERRAIN: Readonly<Record<Exclude<TerrainType, 'land'>, TerrainFillKey>> = Object.freeze({
  deep_water: 'waterDeep',
  shallow_water: 'waterShallow',
  quay: 'quay',
  blocked: 'blocked',
});

/** Kľúč farby výplne pre bunku (x, y) daného terénu. */
export function terrainFillKey(terrain: TerrainType, x: number, y: number): TerrainFillKey {
  if (terrain !== 'land') return FILL_BY_TERRAIN[terrain];
  const parity = (Math.floor(x / LAND_CHECKER_CELLS) + Math.floor(y / LAND_CHECKER_CELLS)) % 2;
  return parity === 0 ? 'land' : 'landAlt';
}

/** Plán kreslenia terénu; všetky obdĺžniky sú v jednotkách buniek (násobí sa `cellPx`). */
export interface TerrainPlan {
  /** Zlúčené (po riadkoch) plochy podľa farby výplne; navzájom sa neprekrývajú a pokrývajú celú mapu. */
  readonly fills: Readonly<Record<TerrainFillKey, Rect[]>>;
  /** Pásiky peny vo vodných bunkách na hrane s nevodou. */
  readonly foam: readonly Rect[];
  /** Pásiky hrany nábrežia na hrane s vodou. */
  readonly quayEdge: readonly Rect[];
}

/** Pásik hrúbky `thickness` pri hrane bunky (x, y) otočenej smerom `direction`. */
function edgeStrip(x: number, y: number, direction: Direction4, thickness: number): Rect {
  if (direction.dx === 0) {
    return { x, y: direction.dy < 0 ? y : y + 1 - thickness, w: 1, h: thickness };
  }
  return { x: direction.dx < 0 ? x : x + 1 - thickness, y, w: thickness, h: 1 };
}

/** Rozloží terén na plochy a pásiky hrán (čistá funkcia mriežky). */
export function planTerrain(grid: Grid): TerrainPlan {
  const fills = Object.fromEntries(TERRAIN_FILL_KEYS.map((key) => [key, [] as Rect[]])) as Record<TerrainFillKey, Rect[]>;
  const foam: Rect[] = [];
  const quayEdge: Rect[] = [];

  for (let y = 0; y < grid.height; y++) {
    let runKey: TerrainFillKey | null = null;
    let runStart = 0;
    for (let x = 0; x < grid.width; x++) {
      const terrain = grid.at(x, y).terrain;
      const key = terrainFillKey(terrain, x, y);
      if (key !== runKey) {
        if (runKey !== null) fills[runKey].push({ x: runStart, y, w: x - runStart, h: 1 });
        runKey = key;
        runStart = x;
      }

      const water = isWater(terrain);
      if (water || terrain === 'quay') {
        for (const direction of DIRECTIONS_4) {
          const nx = x + direction.dx;
          const ny = y + direction.dy;
          if (!grid.inBounds(nx, ny)) continue;
          const neighborWater = isWater(grid.at(nx, ny).terrain);
          if (water && !neighborWater) foam.push(edgeStrip(x, y, direction, FOAM_THICKNESS_CELLS));
          else if (!water && neighborWater) quayEdge.push(edgeStrip(x, y, direction, QUAY_EDGE_THICKNESS_CELLS));
        }
      }
    }
    if (runKey !== null) fills[runKey].push({ x: runStart, y, w: grid.width - runStart, h: 1 });
  }
  return { fills, foam, quayEdge };
}

function drawRects(graphics: Graphics, rects: readonly Rect[], cellPx: number, color: ColorValue): void {
  if (rects.length === 0) return;
  for (const r of rects) graphics.rect(r.x * cellPx, r.y * cellPx, r.w * cellPx, r.h * cellPx);
  graphics.fill(color);
}

export class TerrainLayer {
  /** Kontajner vrstvy; pridaj ho do sveta (súradnice v px pri zoome 1). Statická render group. */
  readonly view = new Container({ label: 'terrain', isRenderGroup: true });
  /** Id sprity každej bunky (row-major); prázdne v režime `Graphics` fallback. */
  private tileIds: CoastTileId[] = [];

  /**
   * @param textures sprity terénu z `SpriteAtlas`; `null` = dočasné `Graphics` z tokenov
   */
  constructor(
    private readonly grid: Grid,
    private readonly palette: RenderPalette,
    private readonly textures: SpriteTextures | null = null,
  ) {
    this.rebuild();
  }

  /** Počet spritov buniek (0 v režime `Graphics` fallback). */
  get spriteCount(): number {
    return this.tileIds.length;
  }

  /** Id sprity bunky (x, y), alebo `undefined` mimo mapy / v režime `Graphics` fallback. */
  tileIdAt(x: number, y: number): CoastTileId | undefined {
    return this.grid.inBounds(x, y) ? this.tileIds[this.grid.index(x, y)] : undefined;
  }

  /** Prekreslí celý terén (pri načítaní mapy; počas hry sa terén nemení). */
  rebuild(): void {
    for (const child of this.view.removeChildren()) child.destroy();
    this.tileIds = [];
    if (this.textures !== null) this.buildSprites(this.textures);
    else this.buildGraphics();
  }

  private buildSprites(textures: SpriteTextures): void {
    const { cellPx } = this.palette;
    const { width, height } = this.grid;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = coastTile(this.grid, x, y);
        const turns = coastQuarterTurns(this.grid, x, y);
        const sprite = new Sprite(textures.terrain(id));
        if (turns === 0) {
          sprite.setSize(cellPx, cellPx);
          sprite.position.set(x * cellPx, y * cellPx);
        } else {
          // hrana nábrežia s vodou na východe / juhu / západe: sprite hrany (voda na severe) otočený okolo stredu bunky
          sprite.anchor.set(HALF_CELL);
          sprite.setSize(cellPx, cellPx);
          sprite.rotation = turns * QUARTER_TURN_RAD;
          sprite.position.set((x + HALF_CELL) * cellPx, (y + HALF_CELL) * cellPx);
        }
        this.view.addChild(sprite);
        this.tileIds.push(id);
      }
    }
  }

  private buildGraphics(): void {
    const { cellPx, terrain } = this.palette;
    const plan = planTerrain(this.grid);
    const graphics = new Graphics();
    for (const key of TERRAIN_FILL_KEYS) drawRects(graphics, plan.fills[key], cellPx, terrain[key]);
    drawRects(graphics, plan.foam, cellPx, terrain.waterFoam);
    drawRects(graphics, plan.quayEdge, cellPx, terrain.quayEdge);
    this.view.addChild(graphics);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
