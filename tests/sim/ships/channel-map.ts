// Syntetická mapa „channel_test" 40×40 pre riadenie lodnej dopravy (T5B-02, ADR-029), ktorú harbor_01 nevie ukázať
// v malom: slepý kanál šírky 6 medzi dvoma mólami, v ktorom dokovaná loď zúži priechod a dve lode na opačných stranách
// s posunom ho zatarasia.
//
//  - otvorená voda y 0–9 (celá šírka);
//  - mólo W: nábrežie x 10–12, y 10–37; mólo E: nábrežie x 19–21, y 10–37; kanál x 13–18, y 10–37; dno kanála =
//    nábrežie x 10–21, y 38–39; inde pevnina;
//  - sea lane (30, 0) → (30, 5), koniec dráhy (30,5 ; 5,5);
//  - anchorage: 0 = (30, 3) na dráhe (nepoužiteľná), 1 = (15, 7) pred ústím kanála (zatarasí výstup lodi v kanáli),
//    2 = (6, 3) a 3 = (6, 7) na otvorenej vode mimo trás do kanála (použiteľné pre feeder aj handy);
//  - kotviská (`CHANNEL_BERTHS`): W1 rot 90 na (10, 12) — feeder pri ňom (14, 15), bunky x 13–14, y 12–17;
//    E2 rot 270 na (19, 18) — feeder (18, 21), bunky x 17–18, y 18–23; W3 rot 90 na (10, 28) — feeder (14, 31),
//    bunky x 13–14, y 28–33. Feedery pri W1 a E2 spolu zatarasia kanál (priechod 3 stĺpce nie je v žiadnom riadku),
//    každý sám nie. Kotviská sú samostatné skupiny po 8 → handy (10) nezakotví nikde a čaká na anchorage;
//  - mapa okrem posledného riadku je vlastnená parcela, cestný portál (39, 39) na verejnej bunke;
//  - `CHANNEL_MAP` nemá štartové moduly, `CHANNEL_MAP_W1` má kotvisko W1 (id 1) s kontajnerovým žeriavom (id 2) ako Root.
import { loadMap, parseMapDef, type CellCoord, type LoadedMap, type PlacedModuleSpec } from '@sim/grid';

export const CHANNEL_SIZE = 40;

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;

function terrainChar(x: number, y: number): string {
  if (y <= 9) return '~';
  if (inRange(y, 38, 39) && inRange(x, 10, 21)) return 'Q';
  if (inRange(x, 10, 12) || inRange(x, 19, 21)) return 'Q';
  if (inRange(x, 13, 18)) return '=';
  return '.';
}

/** Kotviská kanála: ľavý horný roh a rotácia (voda W1, W3 na východ, E2 na západ). */
export const CHANNEL_BERTHS = {
  W1: { x: 10, y: 12, rotation: 90 },
  E2: { x: 19, y: 18, rotation: 270 },
  W3: { x: 10, y: 28, rotation: 90 },
} as const satisfies Record<string, CellCoord & { rotation: 90 | 270 }>;

/** Indexy anchorage mapy. */
export const ANCHORAGE_ON_LANE = 0;
export const ANCHORAGE_AT_MOUTH = 1;
export const ANCHORAGE_OPEN = 2;
export const ANCHORAGE_OPEN_SOUTH = 3;

function channelMap(modules: readonly PlacedModuleSpec[]): LoadedMap {
  return loadMap(
    parseMapDef({
      schemaVersion: 1,
      id: 'channel_test',
      width: CHANNEL_SIZE,
      height: CHANNEL_SIZE,
      terrain: Array.from({ length: CHANNEL_SIZE }, (_, y) => Array.from({ length: CHANNEL_SIZE }, (_, x) => terrainChar(x, y)).join('')),
      depth: {},
      parcels: [{ id: 'dock', rect: { x: 0, y: 0, w: CHANNEL_SIZE, h: CHANNEL_SIZE - 1 }, priceCents: 0, leasable: false, startOwned: true }],
      roadPortals: [{ id: 'south', cell: { x: 39, y: 39 } }],
      railPortals: [],
      seaLane: [
        { x: 30, y: 0 },
        { x: 30, y: 5 },
      ],
      anchorage: [
        { x: 30, y: 3 },
        { x: 15, y: 7 },
        { x: 6, y: 3 },
        { x: 6, y: 7 },
      ],
      starter: { modules, roads: [] },
    }),
  );
}

export const CHANNEL_MAP: LoadedMap = channelMap([]);
export const CHANNEL_MAP_W1: LoadedMap = channelMap([
  { defId: 'berth_standard', ...CHANNEL_BERTHS.W1 },
  { defId: 'crane_container_gantry', x: CHANNEL_BERTHS.W1.x, y: CHANNEL_BERTHS.W1.y + 2, rotation: CHANNEL_BERTHS.W1.rotation },
]);
