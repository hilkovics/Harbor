/**
 * Loader mapy (ARCHITECTURE §4.7, §5.1, §5.2): `MapDef` → `LoadedMap` s hotovou mriežkou.
 *
 * Čistá funkcia (bez `fs`, bez náhody): rovnaký `MapDef` → rovnaký výsledok. Fail-fast `MapError` s JSON pointerom
 * pri porušení invariantu; kontroly idú v poradí polí mapy a hlási sa prvý problém:
 * 1. `width`/`height` celé ≥ 1; terén má `height` riadkov po `width` znakoch, len znaky `~ = Q . #`.
 * 2. Zóny `depth`: kľúč `"x,y,w,h"`, celé v mape, bez prekryvu, každá obsahuje aspoň jednu bunku nábrežia.
 * 3. Parcely: unikátne id, celé v mape, bez prekryvu.
 * 4. Portály (cestné, železničné): unikátne id, na okraji mapy, na pevnine (`land`), na verejnej bunke; žiadne dva
 *    portály (ani cestný s železničným, ADR-006) nezdieľajú bunku.
 * 5. `seaLane`: začína na okraji mapy, vrcholy aj bunky úsekov medzi nimi sú voda.
 * 6. `anchorage`: bunky hlbokej vody; `anchorageHeading` (voliteľný) kurz lodí na kotve.
 * 7. `starter.roads`: v mape, terén unesie cestu (nie voda, nie `blocked`), verejná bunka alebo `startOwned` parcela.
 * 8. `starter.modules`: ľavý horný roh je v mape. Existenciu defu, footprint a pravidlá umiestnenia (§8) overuje až
 *    `World.create` (T02-04) — loader nepozná `DefRegistry`.
 */
import harbor01Json from '@data/maps/harbor_01.json';
import { Grid, type CellCoord, type DepthClass, type Rect } from './grid';
import { DEFAULT_ANCHORAGE_HEADING, parseMapDef, type MapDef, type MapPortalDef, type MapStarterRoadDef, type PlacedModuleSpec, type PortalDirection } from './map-def';
import { MapError, pointerSegment } from './map-error';
import type { Parcel } from './parcel';
import type { Rotation } from './rotation';
import { isRoadBuildable, isWater, terrainFromChar, type TerrainType } from './terrain';

export interface MapPortal {
  readonly id: string;
  readonly cell: CellCoord;
  /** Smer cestného portálu; bez poľa `both` (ADR-037 dodatok R1). */
  readonly direction?: PortalDirection;
  /** Podiel premávky portálu vjazdu (R4, ADR-041 bod 3); chýba = predvolený podiel. */
  readonly trafficShare?: number;
}

export interface LoadedStarter {
  /** Predpostavené moduly; umiestni ich `World` (od F2, keď existuje `ModuleRegistry`). */
  readonly modules: readonly PlacedModuleSpec[];
  /** Bunky predpostavených ciest — už zapísané v `grid` ako `road: 'road'`. */
  readonly roads: readonly MapStarterRoadDef[];
}

/**
 * Načítaná mapa; hlboko zmrazená. Mriežka počiatočného stavu (terén, `depthClass`, `parcelId`, starter cesty) sa
 * z nej získava iba ako **nová kópia** cez `createGrid()` — šablóna zostáva vo vnútri, takže zápis do mriežky jedného
 * sveta sa nikdy neprenesie do ďalšieho `create`/`deserialize`. Parcely si `World` kopíruje sám (meniteľné `ownership`).
 */
export interface LoadedMap {
  readonly id: string;
  /** Šírka mapy v bunkách (= `createGrid().width`). */
  readonly width: number;
  /** Výška mapy v bunkách (= `createGrid().height`). */
  readonly height: number;
  /** Nová, nezávislá mriežka počiatočného stavu; každé volanie vráti inú inštanciu. */
  readonly createGrid: () => Grid;
  /** Parcely v poradí mapy; `ownership` = `'owned'` pre `startOwned`, inak `'none'`. */
  readonly parcels: readonly Readonly<Parcel>[];
  readonly roadPortals: readonly MapPortal[];
  readonly railPortals: readonly MapPortal[];
  readonly seaLane: readonly CellCoord[];
  readonly anchorage: readonly CellCoord[];
  /** Kurz lodí na kotve (jednotný, `MapDef.anchorageHeading`; predvolene `DEFAULT_ANCHORAGE_HEADING`). */
  readonly anchorageHeading: Rotation;
  readonly starter: LoadedStarter;
}

/** Hĺbková trieda nábrežia mimo zón `depth` (§4.7, `map.schema.json`: „Bunky Q mimo zón majú triedu 1“). */
const DEFAULT_QUAY_DEPTH_CLASS: DepthClass = 1;

/** Formát kľúča zóny `depth` — zrkadlí `propertyNames.pattern` v `map.schema.json`. */
const DEPTH_ZONE_KEY = /^(\d+),(\d+),([1-9]\d*),([1-9]\d*)$/;

type Fail = (path: string, problem: string) => MapError;

interface DepthZone {
  readonly key: string;
  readonly rect: Rect;
  readonly depthClass: DepthClass;
}

function formatCell(cell: CellCoord): string {
  return `(${String(cell.x)}, ${String(cell.y)})`;
}

function formatRect(rect: Rect): string {
  return `${String(rect.x)},${String(rect.y)} ${String(rect.w)}×${String(rect.h)}`;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function rectInMap(rect: Rect, width: number, height: number): boolean {
  const { x, y, w, h } = rect;
  return (
    [x, y, w, h].every((n) => Number.isSafeInteger(n)) && x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= width && y + h <= height
  );
}

function freezeCell(cell: CellCoord): CellCoord {
  return Object.freeze({ x: cell.x, y: cell.y });
}

function freezeRect(rect: Rect): Rect {
  return Object.freeze({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
}

/** Rozmery mapy (typ nestačí — `MapDef` môže prísť aj mimo `parseMapDef`). */
function checkDimensions(def: MapDef, fail: Fail): void {
  for (const key of ['width', 'height'] as const) {
    const value = def[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw fail(pointerSegment(key), `musí byť celé číslo ≥ 1, dostal ${String(value)}`);
    }
  }
}

/** Terén row-major (`index = y * width + x`). */
function parseTerrain(def: MapDef, fail: Fail): TerrainType[] {
  const { width, height, terrain } = def;
  if (terrain.length !== height) {
    throw fail('/terrain', `očakávaných ${String(height)} riadkov (height), má ${String(terrain.length)}`);
  }
  const cells: TerrainType[] = [];
  terrain.forEach((row, y) => {
    const path = `/terrain${pointerSegment(y)}`;
    if (row.length !== width) {
      throw fail(path, `riadok má ${String(row.length)} znakov, očakávaných ${String(width)} (width)`);
    }
    for (let x = 0; x < width; x++) {
      const type = terrainFromChar(row[x]);
      if (type === undefined) throw fail(path, `neznámy znak ${JSON.stringify(row[x])} na stĺpci ${String(x)}`);
      cells.push(type);
    }
  });
  return cells;
}

function parseDepthZones(def: MapDef, terrain: readonly TerrainType[], fail: Fail): DepthZone[] {
  const zones: DepthZone[] = [];
  for (const [key, depthClass] of Object.entries(def.depth)) {
    const path = `/depth${pointerSegment(key)}`;
    const match = DEPTH_ZONE_KEY.exec(key);
    if (match === null) throw fail(path, 'kľúč zóny musí byť obdĺžnik "x,y,w,h" (w, h ≥ 1)');
    const rect: Rect = { x: Number(match[1]), y: Number(match[2]), w: Number(match[3]), h: Number(match[4]) };
    if (!rectInMap(rect, def.width, def.height)) {
      throw fail(path, `zóna ${formatRect(rect)} presahuje mapu ${String(def.width)}×${String(def.height)}`);
    }
    const overlapped = zones.find((zone) => rectsOverlap(zone.rect, rect));
    if (overlapped !== undefined) {
      throw fail(path, `zóna sa prekrýva so zónou "${overlapped.key}" (hĺbka by nebola jednoznačná)`);
    }
    let hasQuay = false;
    for (let y = rect.y; y < rect.y + rect.h && !hasQuay; y++) {
      for (let x = rect.x; x < rect.x + rect.w && !hasQuay; x++) hasQuay = terrain[y * def.width + x] === 'quay';
    }
    if (!hasQuay) throw fail(path, `zóna ${formatRect(rect)} neobsahuje žiadnu bunku nábrežia (Q)`);
    zones.push({ key, rect, depthClass });
  }
  return zones;
}

function checkParcels(def: MapDef, fail: Fail): void {
  def.parcels.forEach((parcel, i) => {
    const path = `/parcels${pointerSegment(i)}`;
    const duplicate = def.parcels.findIndex((other) => other.id === parcel.id);
    if (duplicate < i) throw fail(`${path}/id`, `duplicitné id '${parcel.id}' (/parcels/${String(duplicate)})`);
    if (!rectInMap(parcel.rect, def.width, def.height)) {
      throw fail(`${path}/rect`, `obdĺžnik ${formatRect(parcel.rect)} presahuje mapu ${String(def.width)}×${String(def.height)}`);
    }
    const overlapped = def.parcels.findIndex((other, j) => j < i && rectsOverlap(other.rect, parcel.rect));
    if (overlapped >= 0) {
      throw fail(`${path}/rect`, `prekrýva parcelu '${def.parcels[overlapped].id}' (/parcels/${String(overlapped)})`);
    }
  });
}

function buildGrid(def: MapDef, terrain: readonly TerrainType[], zones: readonly DepthZone[]): Grid {
  const { width } = def;
  const parcelIds = new Array<string | null>(terrain.length).fill(null);
  for (const { id, rect } of def.parcels) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) parcelIds[y * width + x] = id;
    }
  }
  const quayDepth = new Array<DepthClass>(terrain.length).fill(DEFAULT_QUAY_DEPTH_CLASS);
  for (const { rect, depthClass } of zones) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) quayDepth[y * width + x] = depthClass;
    }
  }
  return new Grid(def.width, def.height, (x, y) => {
    const index = y * width + x;
    const type = terrain[index];
    // Hĺbku má len nábrežie (§4.7); voda a pevnina majú triedu 0 (§5.1).
    return { terrain: type, depthClass: type === 'quay' ? quayDepth[index] : 0, parcelId: parcelIds[index] };
  });
}

function checkPortals(grid: Grid, def: MapDef, fail: Fail): void {
  const seenIds = new Map<string, string>();
  /** Bunka portálu (`"x,y"`) → cesta portálu, ktorý ju obsadil ako prvý. */
  const seenCells = new Map<string, string>();
  const lists: readonly [string, readonly MapPortalDef[]][] = [
    ['/roadPortals', def.roadPortals],
    ['/railPortals', def.railPortals],
  ];
  for (const [listPath, portals] of lists) {
    portals.forEach(({ id, cell }, i) => {
      const path = `${listPath}${pointerSegment(i)}`;
      const firstPath = seenIds.get(id);
      if (firstPath !== undefined) throw fail(`${path}/id`, `duplicitné id portálu '${id}' (${firstPath})`);
      seenIds.set(id, path);
      const cellPath = `${path}/cell`;
      if (!grid.inBounds(cell.x, cell.y)) throw fail(cellPath, `bunka ${formatCell(cell)} je mimo mapy`);
      if (!grid.isEdge(cell.x, cell.y)) throw fail(cellPath, `portál ${formatCell(cell)} nie je na okraji mapy`);
      const { terrain, parcelId } = grid.at(cell.x, cell.y);
      if (terrain !== 'land') throw fail(cellPath, `portál ${formatCell(cell)} nie je na pevnine (terén ${terrain})`);
      if (parcelId !== null) throw fail(cellPath, `portál ${formatCell(cell)} leží v parcele '${parcelId}', musí byť na verejnej bunke`);
      const cellKey = `${String(cell.x)},${String(cell.y)}`;
      const firstCell = seenCells.get(cellKey);
      if (firstCell !== undefined) {
        throw fail(cellPath, `bunka ${formatCell(cell)} už používa portál (${firstCell}) — portály (ani cestný a železničný) nesmú zdieľať bunku`);
      }
      seenCells.set(cellKey, path);
    });
  }
}

/** Vnútorné bunky úseku a→b (bez koncov) — rovnomerné vzorkovanie so zaokrúhlením, deterministické. */
function segmentInterior(a: CellCoord, b: CellCoord): CellCoord[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const cells: CellCoord[] = [];
  for (let i = 1; i < steps; i++) {
    cells.push({ x: a.x + Math.round((dx * i) / steps), y: a.y + Math.round((dy * i) / steps) });
  }
  return cells;
}

function checkSeaLane(grid: Grid, def: MapDef, fail: Fail): void {
  def.seaLane.forEach((cell, i) => {
    const path = `/seaLane${pointerSegment(i)}`;
    if (!grid.inBounds(cell.x, cell.y)) throw fail(path, `bunka ${formatCell(cell)} je mimo mapy`);
    const { terrain } = grid.at(cell.x, cell.y);
    if (!isWater(terrain)) throw fail(path, `plavebná dráha ${formatCell(cell)} nie je na vode (terén ${terrain})`);
    if (i === 0) {
      if (!grid.isEdge(cell.x, cell.y)) throw fail(path, `plavebná dráha musí začínať na okraji mapy, ${formatCell(cell)} nie je`);
      return;
    }
    const from = def.seaLane[i - 1];
    for (const step of segmentInterior(from, cell)) {
      const stepTerrain = grid.at(step.x, step.y).terrain;
      if (!isWater(stepTerrain)) {
        throw fail(path, `úsek ${formatCell(from)} → ${formatCell(cell)} prechádza bunkou ${formatCell(step)} (terén ${stepTerrain})`);
      }
    }
  });
}

function checkAnchorage(grid: Grid, def: MapDef, fail: Fail): void {
  def.anchorage.forEach((cell, i) => {
    const path = `/anchorage${pointerSegment(i)}`;
    if (!grid.inBounds(cell.x, cell.y)) throw fail(path, `bunka ${formatCell(cell)} je mimo mapy`);
    const { terrain } = grid.at(cell.x, cell.y);
    if (terrain !== 'deep_water') throw fail(path, `kotvisko ${formatCell(cell)} nie je na hlbokej vode (terén ${terrain})`);
  });
}

function checkStarterRoads(grid: Grid, def: MapDef, fail: Fail): void {
  const startOwned = new Map(def.parcels.map((parcel) => [parcel.id, parcel.startOwned === true] as const));
  def.starter.roads.forEach((cell, i) => {
    const path = `/starter/roads${pointerSegment(i)}`;
    if (!grid.inBounds(cell.x, cell.y)) throw fail(path, `bunka ${formatCell(cell)} je mimo mapy`);
    const { terrain, parcelId } = grid.at(cell.x, cell.y);
    if (!isRoadBuildable(terrain)) throw fail(path, `cesta ${formatCell(cell)} nemôže byť na teréne ${terrain}`);
    if (parcelId !== null && startOwned.get(parcelId) !== true) {
      throw fail(path, `cesta ${formatCell(cell)} leží na parcele '${parcelId}' na predaj (ADR-008)`);
    }
  });
}

/** Predpostavené moduly: ľavý horný roh v mape (zvyšok — def, footprint, pravidlá umiestnenia — overí `World.create`). */
function checkStarterModules(grid: Grid, def: MapDef, fail: Fail): void {
  def.starter.modules.forEach(({ defId, x, y }, i) => {
    if (!grid.inBounds(x, y)) {
      throw fail(`/starter/modules${pointerSegment(i)}`, `modul '${defId}': bunka ${formatCell({ x, y })} je mimo mapy`);
    }
  });
}

function toParcel(def: MapDef['parcels'][number]): Readonly<Parcel> {
  return Object.freeze({
    id: def.id,
    rect: freezeRect(def.rect),
    priceCents: def.priceCents,
    leasable: def.leasable,
    ownership: def.startOwned === true ? 'owned' : 'none',
  });
}

function toPortals(portals: readonly MapPortalDef[]): readonly MapPortal[] {
  return Object.freeze(
    portals.map(({ id, cell, direction, trafficShare }) =>
      Object.freeze({ id, cell: freezeCell(cell), ...(direction === undefined ? {} : { direction }), ...(trafficShare === undefined ? {} : { trafficShare }) }),
    ),
  );
}

/**
 * Overí invarianty mapy (viď hlavička súboru) a zostaví `LoadedMap`: terén, `depthClass` nábrežia zo zón `depth`
 * (inak 1; voda a pevnina 0), `parcelId` podľa parciel a starter cesty zapísané ako `road: 'road'`.
 * Vstup sa nemení; výsledok s ním nezdieľa objekty. Porušenie → `MapError`.
 */
export function loadMap(def: MapDef): LoadedMap {
  const fail: Fail = (path, problem) => new MapError(def.id, path, problem);
  checkDimensions(def, fail);
  const terrain = parseTerrain(def, fail);
  const zones = parseDepthZones(def, terrain, fail);
  checkParcels(def, fail);
  const grid = buildGrid(def, terrain, zones);
  checkPortals(grid, def, fail);
  checkSeaLane(grid, def, fail);
  checkAnchorage(grid, def, fail);
  checkStarterRoads(grid, def, fail);
  checkStarterModules(grid, def, fail);

  for (const { x, y, dir } of def.starter.roads) {
    const cell = grid.at(x, y);
    cell.road = 'road';
    if (dir !== undefined) {
      cell.roadKind = 'one_way';
      cell.roadDir = dir;
    }
  }

  // `grid` je šablóna: nikdy sa nevydáva, každý volajúci `createGrid()` dostane vlastný `clone()`.
  return Object.freeze({
    id: def.id,
    width: def.width,
    height: def.height,
    createGrid: () => grid.clone(),
    parcels: Object.freeze(def.parcels.map(toParcel)),
    roadPortals: toPortals(def.roadPortals),
    railPortals: toPortals(def.railPortals),
    seaLane: Object.freeze(def.seaLane.map(freezeCell)),
    anchorage: Object.freeze(def.anchorage.map(freezeCell)),
    anchorageHeading: def.anchorageHeading ?? DEFAULT_ANCHORAGE_HEADING,
    starter: Object.freeze({
      modules: Object.freeze(def.starter.modules.map((spec) => Object.freeze({ ...spec }))),
      roads: Object.freeze(def.starter.roads.map((road) => Object.freeze({ ...road }))),
    }),
  });
}

/** Načíta mapu zabalenú v `data/maps/harbor_01.json` (statický JSON import, bez `fs`): `parseMapDef` + `loadMap`. */
export function loadBundledMap(): LoadedMap {
  return loadMap(parseMapDef(harbor01Json));
}
