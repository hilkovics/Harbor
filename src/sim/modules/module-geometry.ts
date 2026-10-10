/**
 * Geometria modulov (ARCHITECTURE §8 bod 7): footprint po rotácii, otáčanie strán, konektory vo svete, hrana
 * modulu a pás vody pred ňou. Čisté funkcie bez stavu — rovnako ich používa `Module` (bunky), pravidlá
 * umiestnenia (`PlaceModule.validate`, T02-04), výpočet `BerthGroup` aj ghost v UI.
 *
 * Konvencia (docs/tasks/phase-02.md): `x`, `y` = ľavý horný roh footprintu **po** rotácii; rotácia v smere
 * hodinových ručičiek (`rotateLocalCell`), preto strana `n` sa pri 90° stane `e`, pri 180° `s`, pri 270° `w`.
 */
import type { ConnectorAccess, ConnectorType, ModuleDef, ModulePlacementDef, Side } from '../defs/types';
import { SIDES } from '../defs/types';
import type { CellCoord } from '../grid/grid';
import { ROTATIONS, rotateFootprint, rotateLocalCell, type Rotation } from '../grid/rotation';

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

/** Konektor vo svete: bunka footprintu po rotácii a strana, ktorou sa do nej vchádza (po rotácii). */
export interface PlacedConnector {
  readonly x: number;
  readonly y: number;
  readonly side: Side;
  readonly type: ConnectorType;
  /** Prístup cez konektor (ADR-041 bod 8); chýba = `both`. */
  readonly access?: ConnectorAccess;
}

/** Smie sa cez konektor vojsť (`in`) alebo odísť (`out`)? Chýbajúci `access` = oboje. */
export function connectorAllows(connector: Pick<PlacedConnector, 'access'>, direction: 'in' | 'out'): boolean {
  const access = connector.access ?? 'both';
  return access === 'both' || access === direction;
}

/**
 * Konektory defu pre modul s ľavým horným rohom (po rotácii) na `(x, y)`: lokálna bunka cez `rotateLocalCell`
 * + `(x, y)`, strana cez `rotateSide` (§8 bod 7). Poradie = poradie v defe. Neplatná rotácia → `RangeError`.
 */
export function connectorsOf(def: Readonly<ModuleDef>, x: number, y: number, rotation: Rotation): readonly PlacedConnector[] {
  const { w, h } = def.footprint;
  return Object.freeze(
    def.connectors.map((connector): PlacedConnector => {
      const cell = rotateLocalCell(connector.x, connector.y, w, h, rotation);
      return Object.freeze({ x: x + cell.x, y: y + cell.y, side: rotateSide(connector.side, rotation), type: connector.type, ...(connector.access === undefined ? {} : { access: connector.access }) });
    }),
  );
}

/** Krok o jednu bunku von z modulu cez danú stranu (sever = menšie `y`, rovnako ako `DIRECTIONS_4`). */
export const SIDE_STEPS: { readonly [S in Side]: { readonly dx: number; readonly dy: number } } = Object.freeze({
  n: Object.freeze({ dx: 0, dy: -1 }),
  e: Object.freeze({ dx: 1, dy: 0 }),
  s: Object.freeze({ dx: 0, dy: 1 }),
  w: Object.freeze({ dx: -1, dy: 0 }),
});

/**
 * Vonkajšia bunka konektora (rozhodnutie orchestrátora F3 č. 2, ADR-017): susedná bunka konektora na strane `side`,
 * teda miesto, kde vozidlo stojí pri vstupe do modulu a kde musí byť cesta. Môže ležať mimo mapy.
 */
export function connectorOutside(connector: Pick<PlacedConnector, 'x' | 'y' | 'side'>): CellCoord {
  const { dx, dy } = SIDE_STEPS[connector.side];
  return Object.freeze({ x: connector.x + dx, y: connector.y + dy });
}

type Size = { readonly w: number; readonly h: number };

/** Prvá bunka hrany a krok pozdĺž nej (tabuľka podľa strany, nie switch); dĺžka hrany je `w` pri n/s, `h` pri e/w. */
const EDGE_LINES: {
  readonly [S in Side]: (origin: CellCoord, size: Size) => { readonly start: CellCoord; readonly dx: number; readonly dy: number; readonly length: number };
} = {
  n: (origin, size) => ({ start: { x: origin.x, y: origin.y }, dx: 1, dy: 0, length: size.w }),
  e: (origin, size) => ({ start: { x: origin.x + size.w - 1, y: origin.y }, dx: 0, dy: 1, length: size.h }),
  s: (origin, size) => ({ start: { x: origin.x, y: origin.y + size.h - 1 }, dx: 1, dy: 0, length: size.w }),
  w: (origin, size) => ({ start: { x: origin.x, y: origin.y }, dx: 0, dy: 1, length: size.h }),
};

/**
 * Bunky hrany footprintu (`origin` = ľavý horný roh, `size` po rotácii) na strane `side`, stúpajúco po osi hrany
 * (`x` pri n/s, `y` pri e/w). Pri kotvisku je to dlhá hrana pri vode (`waterSide`).
 */
export function edgeCells(origin: CellCoord, size: Size, side: Side): readonly CellCoord[] {
  const { start, dx, dy, length } = EDGE_LINES[side](origin, size);
  return Object.freeze(Array.from({ length }, (_, i) => Object.freeze({ x: start.x + i * dx, y: start.y + i * dy })));
}

/**
 * Pás `depth` riadkov buniek pred hranou `side` (pri kotvisku: voda, kde kotví loď, `params.frontWaterCells`).
 * Poradie: vzdialenosť `d = 1 … depth` od hrany, v rámci nej ako `edgeCells`. Bunky môžu ležať mimo mapy —
 * hranice overuje volajúci.
 */
export function frontBandCells(origin: CellCoord, size: Size, side: Side, depth: number): readonly CellCoord[] {
  if (!Number.isSafeInteger(depth) || depth < 0) throw new RangeError(`frontBandCells: hĺbka pásu musí byť celé číslo ≥ 0, dostal ${String(depth)}`);
  const { dx, dy } = SIDE_STEPS[side];
  const edge = edgeCells(origin, size, side);
  const band: CellCoord[] = [];
  for (let d = 1; d <= depth; d++) {
    for (const cell of edge) band.push(Object.freeze({ x: cell.x + d * dx, y: cell.y + d * dy }));
  }
  return Object.freeze(band);
}
