/**
 * Veľké rozloženie brány pre scenár R4 (TR4-01, ADR-041; TR4-02 prerobené bez rampy): 8 vstupných pruhov v dvoch blokoch po 4, každý blok s vlastnou predbránovou plochou 8×8, 4 výstupné pruhy,
 * 12 dvorov (každý má jedno TP na hrane — vonkajšiu bunku konektora), 10 odstavných plôch (6 státí) a depo s 10 straddle carriermi na vlastnej mape (celá pevnina, jeden vlastnený pozemok) —
 * bundled `harbor_01` má na toľko pruhov priveľmi malý starter pozemok. Cesty sú dvojpruhové (obojsmerné), takže vjazd aj návrat idú jedným radom.
 * Zdrojom kamiónov je test: jednotky kladie priamo do dvorov cez ledger (`stageUnits`, import bez kontraktu), na ktoré `spawnPickupTrucks` vytvorí kamióny; token dostane TP dvora, alebo státie odstavnej plochy.
 * Kamióny vznikajú na dvoch portáloch vjazdu (podiely 0,5 / 0,5 → `Rng`); portál 1 vedie k vjazdu plochy A, portál 2 k vjazdu plochy B.
 *
 * ```
 *   x:     0 .. 4 ..... 8..11 .. 16 .. 20..23 24..28 29 30 .............................. 89
 *   y=36                                                         Y Y Y Y … Y Y D        dvory (30 + 4k, 36) rot 0 (k = 0…11): TP = vonkajšia bunka (31 + 4k, 40); depo (78, 37)
 *   y=39   P_out ==== (1..11, 39)                                                       výstupy výstupných pruhov, cesta na portál výjazdu (0, 39)
 *   y=40..43           O O O O                      |  ====== (29..89, 40) ======       4 výstupné pruhy (8..11, 40) rot 0 (1×4), cesta k dvorom a odstavným plochám
 *   y=41..45                                           H H H H H H H H H H              odstavné plochy (30 + 6j, 41) rot 180 (j = 0…9), vstup / výstup na ceste y = 40
 *   y=44               ===== (8..23, 44) =====  (24..29, 44) + (29, 40..43)             výstupy vstupných pruhov, vstupy výstupných pruhov (spoločný rad)
 *   y=45..48           I I I I           I I I I                                            8 vstupných pruhov (8..11, 45) a (20..23, 45) rot 0, kamión ide na sever
 *   y=49               o o o o           o o o o                                            vstupy vstupných pruhov = rad pred pruhmi bloku (výjazd plochy je jeho posledná bunka)
 *   y=50..57       B B B B B B B B   B B B B B B B B                                        predbránové plochy A (4, 50) a B (16, 50): vjazd (4, 58) / (16, 58), výjazd (11, 49) / (23, 49)
 *   y=58   P_in1 = (1..4, 58)       (16, 58..59)                                            cesty od portálov vjazdu: (0, 58) → A, (0, 60) → (1..16, 60) → B
 * ```
 */
import modulesJson from '@data/defs/modules.json';
import trucksJson from '@data/defs/trucks.json';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { loadMap, parseMapDef, type CellCoord, type LoadedMap } from '@sim/grid';
import { RtgBlock, type PreGateBuffer, type StorageModule, type TruckGate, type TruckHolding, type VehicleDepot } from '@sim/modules';
import { World } from '@sim/world';
import { execute, stockYard } from '../logistics/outbound-fixtures';
import { LEGACY_HARBOR_JSON, RAW_DEFS } from '../world/world-fixtures';

export const IN_LANES = 8;
export const BLOCKS = 2;
export const LANES_PER_BLOCK = 4;
export const OUT_LANES = 4;
export const YARDS = 12;
export const HOLDINGS = 10;
export const VEHICLES = 10;
/** Ľavý okraj predbránovej plochy a prvého pruhu každého bloku (plocha 8 širokých, pruhy 4 široké pri jej východnom okraji). */
export const BLOCK_BUFFER_X: readonly number[] = [4, 16];
export const BLOCK_LANE_X: readonly number[] = [8, 20];
export const BUFFER_Y = 50;
export const IN_LANE_ORIGIN_Y = 45;
export const OUT_LANE_ORIGIN_Y = 40;
export const OUT_LANE_X0 = 8;
/** Dvor `k` (0…11) stojí na (30 + 4k, 36) rot 0; jeho TP je vonkajšia bunka konektora (31 + 4k, 40) na ceste y = 40. */
export const YARD_ORIGIN_Y = 36;
export const yardOrigin = (k: number): CellCoord => ({ x: 30 + 4 * k, y: YARD_ORIGIN_Y });
export const yardTp = (k: number): CellCoord => ({ x: 31 + 4 * k, y: 40 });
/** Odstavná plocha `j` (0…9) stojí na (30 + 6j, 41) rot 180 (konektory na severnej strane, na ceste y = 40). */
export const holdingOrigin = (j: number): CellCoord => ({ x: 30 + 6 * j, y: 41 });
export const DEPOT_ORIGIN_GATES: CellCoord = { x: 80, y: 37 };
/** Smer jednosmerných ciest okruhu k dvorom: východne po y = 40 (29…89), dole po x = 90, západne po y = 47 a hore po x = 29 späť k brane. */
export const SINK_EAST_X = 90;
export const SINK_RETURN_Y = 47;
export const PORTAL_IN_1: CellCoord = { x: 0, y: 58 };
export const PORTAL_IN_2: CellCoord = { x: 0, y: 60 };
export const PORTAL_OUT: CellCoord = { x: 0, y: 39 };
/** Vjazdy plôch: vonkajšia bunka ich prvého konektora. */
export const BUFFER_INLETS: readonly CellCoord[] = [
  { x: 4, y: 58 },
  { x: 16, y: 58 },
];

const WIDTH = 96;
const HEIGHT = 64;
const WATER_ROWS = 8;

/** Mapa celá pevnina (okrem vody pri severnom okraji pre morskú trasu), jeden vlastnený pozemok, dva portály vjazdu (podiely 0,5 / 0,5) a jeden výjazdu. */
function buildMapJson() {
  const terrain = Array.from({ length: HEIGHT }, (_unused, y) => (y < WATER_ROWS ? '~' : '.').repeat(WIDTH));
  const roads = [PORTAL_IN_1, PORTAL_IN_2, PORTAL_OUT].map((cell) => ({ x: cell.x, y: cell.y }));
  return {
    ...LEGACY_HARBOR_JSON,
    terrain,
    depth: {},
    parcels: [{ id: 'starter', rect: { x: 1, y: 20, w: 91, h: 43 }, priceCents: 0, leasable: false, startOwned: true }],
    roadPortals: [
      { id: 'road_in_1', cell: PORTAL_IN_1, direction: 'in', trafficShare: 0.5 },
      { id: 'road_in_2', cell: PORTAL_IN_2, direction: 'in', trafficShare: 0.5 },
      { id: 'road_out', cell: PORTAL_OUT, direction: 'out' },
    ],
    railPortals: [],
    starter: { modules: [], roads },
  };
}

export const GATES_MAP: LoadedMap = loadMap(parseMapDef(buildMapJson()));

/** Defy so zväčšeným štartovým kapitálom (stavba 12 dvorov, 10 odstavných plôch a 10 vozidiel); ostatné bundled vrátane šancí na problém pruhov (nepripnuté na 0 ako v `APRON_MODULES`; losovanie z `Rng` robí beh závislý od seedu; predbránová plocha 8×8, 8 radov po 2). */
export const GATES_DEFS: DefRegistry = DefRegistry.fromRaw({
  ...RAW_DEFS,
  economy: { ...RAW_DEFS.economy, startingCashCents: 100_000_000_000 },
  modules: modulesJson,
  trucks: trucksJson,
});

const row = (y: number, x0: number, x1: number): CellCoord[] => Array.from({ length: x1 - x0 + 1 }, (_unused, i) => ({ x: x0 + i, y }));
const column = (x: number, y0: number, y1: number): CellCoord[] => Array.from({ length: y1 - y0 + 1 }, (_unused, i) => ({ x, y: y0 + i }));

/** Cesty rozloženia pri bránach (dvojpruhové); vjazd plochy a výjazd na portál výjazdu sú súčasťou. */
export const GATES_ROADS: readonly (readonly CellCoord[])[] = [row(58, 1, 4), row(60, 1, 16), column(16, 58, 59), row(49, 8, 11), row(49, 20, 23), row(44, 8, 29), row(39, 1, OUT_LANE_X0 + OUT_LANES - 1)];

/** Jednosmerný okruh k dvorom a odstavným plochám (`PlaceRoad` s `one_way`): hore po x = 29 (y 41–43) → východne po y = 40 → dole po x = 78 → západne po y = 47 → hore po x = 29 (y 45–46) k bráne. */
export const SINK_ROADS: readonly { readonly cells: readonly CellCoord[]; readonly dir: 'N' | 'E' | 'S' | 'W' }[] = [
  { cells: column(29, 41, 43), dir: 'N' },
  { cells: row(40, 29, SINK_EAST_X - 1), dir: 'E' },
  { cells: column(SINK_EAST_X, 40, SINK_RETURN_Y - 1), dir: 'S' },
  { cells: row(SINK_RETURN_Y, 30, SINK_EAST_X), dir: 'W' },
  { cells: column(29, 45, SINK_RETURN_Y), dir: 'N' },
];

/** Príkazy stavby: cesty, predbránové plochy, vstupné a výstupné pruhy, depo, dvory, odstavné plochy a vozidlá (v tomto poradí → id modulov od 1; depo má id 15). */
export function gatesCommands(): SerializedCommand[] {
  const commands: SerializedCommand[] = [
    ...GATES_ROADS.map((cells): SerializedCommand => ({ type: 'PlaceRoad', cells: [...cells] })),
    ...SINK_ROADS.map(({ cells, dir }): SerializedCommand => ({ type: 'PlaceRoad', cells: [...cells], kind: 'one_way', dirs: cells.map(() => dir) })),
  ];
  for (const x of BLOCK_BUFFER_X) commands.push({ type: 'PlaceModule', defId: 'pre_gate_buffer', x, y: BUFFER_Y, rotation: 0 });
  for (const x0 of BLOCK_LANE_X) for (let i = 0; i < LANES_PER_BLOCK; i++) commands.push({ type: 'PlaceModule', defId: 'gate_in_lane', x: x0 + i, y: IN_LANE_ORIGIN_Y, rotation: 0 });
  for (let i = 0; i < OUT_LANES; i++) commands.push({ type: 'PlaceModule', defId: 'gate_out_lane', x: OUT_LANE_X0 + i, y: OUT_LANE_ORIGIN_Y, rotation: 0 });
  commands.push({ type: 'PlaceModule', defId: 'vehicle_depot', x: DEPOT_ORIGIN_GATES.x, y: DEPOT_ORIGIN_GATES.y, rotation: 0 });
  for (let k = 0; k < YARDS; k++) commands.push({ type: 'PlaceModule', defId: 'container_yard_small', x: yardOrigin(k).x, y: yardOrigin(k).y, rotation: 0 });
  for (let j = 0; j < HOLDINGS; j++) commands.push({ type: 'PlaceModule', defId: 'truck_holding', x: holdingOrigin(j).x, y: holdingOrigin(j).y, rotation: 180 });
  return commands;
}

export interface GatesWorld {
  readonly world: World;
  readonly buffers: readonly PreGateBuffer[];
  readonly inLanes: readonly TruckGate[];
  readonly outLanes: readonly TruckGate[];
  readonly yards: readonly StorageModule[];
  readonly holdings: readonly TruckHolding[];
  readonly depot: VehicleDepot;
}

/** Svet s rozložením (bez nákladu); odmietnutý príkaz stavby je chyba. */
export function gatesWorld(seed: number, defs: DefRegistry = GATES_DEFS): GatesWorld {
  const world = World.create(defs, GATES_MAP, seed);
  const run = (command: SerializedCommand): void => {
    world.enqueue(commandFromJSON(command));
    const rejected = world.applyPending().filter((event) => event.type === 'CommandRejected');
    if (rejected.length > 0) throw new Error(`príkaz ${JSON.stringify(command)} odmietnutý: ${JSON.stringify(rejected)}`);
  };
  for (const command of gatesCommands()) run(command);
  const at = (x: number, y: number) => world.moduleAt(x, y);
  const depot = at(DEPOT_ORIGIN_GATES.x, DEPOT_ORIGIN_GATES.y) as VehicleDepot;
  for (let i = 0; i < VEHICLES; i++) run({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: depot.id });
  return {
    world,
    buffers: BLOCK_BUFFER_X.map((x) => at(x, BUFFER_Y) as PreGateBuffer),
    inLanes: BLOCK_LANE_X.flatMap((x0) => Array.from({ length: LANES_PER_BLOCK }, (_unused, i) => at(x0 + i, IN_LANE_ORIGIN_Y) as TruckGate)),
    outLanes: Array.from({ length: OUT_LANES }, (_unused, i) => at(OUT_LANE_X0 + i, OUT_LANE_ORIGIN_Y) as TruckGate),
    yards: Array.from({ length: YARDS }, (_unused, k) => at(yardOrigin(k).x, yardOrigin(k).y) as StorageModule),
    holdings: Array.from({ length: HOLDINGS }, (_unused, j) => at(holdingOrigin(j).x, holdingOrigin(j).y) as TruckHolding),
    depot,
  };
}

/**
 * `count` jednotiek importu (bez kontraktu) priamo do dvorov cez ledger, striedavo po dvoroch (fiktívna loď 900, žeriav 901, vozidlo 902 — len prechody §7.1); vráti ich id.
 * Každú jednotku odvezie kamión misie `pickup`, ktorý vznikne v kroku 8 (token TP dvora, alebo státie odstavnej plochy).
 */
export function stageUnits(layout: GatesWorld, count: number): EntityId[] {
  const ids: EntityId[] = [];
  for (let i = 0; i < count; i++) ids.push(...stockYard(layout.world, layout.yards[i % layout.yards.length], 1));
  return ids;
}

/** Roh RTG bloku v rozložení (blok 5 × 12, jeho pruh je stĺpec `RTG_ORIGIN.x + 4`; vjazd pruhu na severe, výjazd na juhu). */
export const RTG_ORIGIN: CellCoord = { x: 80, y: 22 };

/**
 * Dostaví do `layout` RTG blok s pruhom TP: dvojpruhové cesty (vjazd (84, 21) ← stĺpec x = 88 ← križovatka (88, 40) na okruhu, výjazd (84, 34) → stĺpec x = 84 → okruh (84, 40)); kamión pôjde
 * z okruhu hore po x = 88, dole pruhom bloku a späť na okruh. Vráti blok (obslúži ho jeho stroj, ktorý vzniká s blokom).
 */
export function addRtgBlock(layout: GatesWorld): RtgBlock {
  const { world } = layout;
  const lane = RTG_ORIGIN.x + 4;
  execute(world, { type: 'RemoveRoad', cells: [{ x: 88, y: 40 }] });
  execute(world, { type: 'PlaceRoad', cells: [{ x: 88, y: 40 }], kind: 'two_lane' });
  execute(world, { type: 'PlaceRoad', cells: [...row(21, lane, 88), ...column(88, 22, 39)] });
  execute(world, { type: 'PlaceRoad', cells: column(lane, 34, 39) });
  execute(world, { type: 'PlaceModule', defId: 'rtg_block', x: RTG_ORIGIN.x, y: RTG_ORIGIN.y, rotation: 0 });
  const block = world.moduleAt(RTG_ORIGIN.x, RTG_ORIGIN.y);
  if (!(block instanceof RtgBlock)) throw new Error('RTG blok sa nepostavil');
  return block;
}
