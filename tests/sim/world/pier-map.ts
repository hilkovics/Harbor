// Syntetická mapa „pier_test" 40×30 pre pravidlá kotvísk (T02-04), ktoré harbor_01 (jedno rovné nábrežie) nevie ukázať:
// kotviská rôznych orientácií, ostrovček v páse vody a pás siahajúci za okraj mapy.
//
//  - mólo W: nábrežie x 5–7, y 2–9 (kotvisko rot 90 → waterSide e, pás x 8–10; rot 270 → waterSide w, pás x 2–4);
//  - nábrežie A: x 10–17, y 10–12 (kotvisko rot 0 na (10, 10), pás y 7–9) — pás móla W rot 90 ho pretína v (10, 7–9);
//  - nábrežie M: x 22–29, y 10–12 s ostrovčekom nábrežia (24, 8) v páse vody;
//  - mólo E: nábrežie x 36–38, y 2–9 (rot 90 → pás x 39–41, x 40+ je mimo mapy);
//  - voda y 0–12 inde, pevnina y ≥ 13; celá mapa y 0–27 je vlastnená parcela „dock", portál (20, 29).
import { loadMap, parseMapDef, type LoadedMap } from '@sim/grid';

export const PIER_WIDTH = 40;
export const PIER_HEIGHT = 30;

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;

function terrainChar(x: number, y: number): string {
  if (y >= 13) return '.';
  if (inRange(y, 10, 12) && (inRange(x, 10, 17) || inRange(x, 22, 29))) return 'Q';
  if (inRange(y, 2, 9) && (inRange(x, 5, 7) || inRange(x, 36, 38))) return 'Q';
  if (x === 24 && y === 8) return 'Q';
  return '~';
}

export const PIER_MAP: LoadedMap = loadMap(
  parseMapDef({
    schemaVersion: 1,
    id: 'pier_test',
    width: PIER_WIDTH,
    height: PIER_HEIGHT,
    terrain: Array.from({ length: PIER_HEIGHT }, (_, y) => Array.from({ length: PIER_WIDTH }, (_, x) => terrainChar(x, y)).join('')),
    depth: {},
    parcels: [{ id: 'dock', rect: { x: 0, y: 0, w: PIER_WIDTH, h: 28 }, priceCents: 0, leasable: false, startOwned: true }],
    roadPortals: [{ id: 'south', cell: { x: 20, y: 29 } }],
    railPortals: [],
    seaLane: [
      { x: 33, y: 0 },
      { x: 33, y: 1 },
    ],
    anchorage: [{ x: 20, y: 0 }],
    starter: { modules: [], roads: [] },
  }),
);
