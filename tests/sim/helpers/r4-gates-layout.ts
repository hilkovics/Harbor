/**
 * Veľké rozloženie brány pre scenár R4 (TR4-01, ADR-041): 8 vstupných pruhov v dvoch blokoch po 4, každý blok s vlastnou predbránovou plochou 8×8 (8 radov po 2), 4 výstupné pruhy,
 * stojisko s 80 bays a rampa s 10 dockmi na vlastnej mape (celá pevnina, jeden vlastnený pozemok) — bundled `harbor_01` má na toľko pruhov priveľmi malý starter pozemok.
 * Zdrojom kamiónov je test: jednotky kladie priamo na docky rampy cez ledger (`stageUnit`), kamióny vznikajú na dvoch portáloch vjazdu (podiely 0,5 / 0,5 → `Rng`); portál 1 vedie
 * k vjazdu plochy A, portál 2 k vjazdu plochy B (jeden vjazd zvládne ≈ 70 kamiónov za hodinu: kamión dlhý 3 bunky pri 0,6 bunky za tick), preto špička 100 kamiónov za hodinu
 * (2 × 50) nevytvorí front na ceste. Kamión na vjazde plochy musí mať telo (3 bunky) mimo križovatiek, preto sú cesty k vjazdom rovné.
 *
 * ```
 *   x:     0 .. 4 ..... 8..11 .. 16 .. 20..23 24..27 28 29 30 ............ 41
 *   y=38                                                         R R R R R R R R R R R R R R    rampa (30, 38) 20×2, 10 dockov: vonkajšie bunky (31 + 2 k, 40)
 *   y=39   P_out ==== (1..11, 39)                                                           výstupy výstupných pruhov, cesta na portál výjazdu (0, 39)
 *   y=40..43           O O O O                                                              4 výstupné pruhy (8..11, 40) rot 0 (1×4), kamión ide na sever
 *   y=44               ===== (8..23, 44) =====  W  (28..29, 44) + (29, 40..43) + (29..49, 40) výstupy vstupných pruhov, vstupy výstupných pruhov (spoločný rad), stojisko (24, 42)
 *   y=45..48           I I I I           I I I I                                            8 vstupných pruhov (8..11, 45) a (20..23, 45) rot 0, kamión ide na sever
 *   y=49               o o o o           o o o o                                            vstupy vstupných pruhov = rad pred pruhmi bloku (výjazd plochy je jeho posledná bunka)
 *   y=50..57       B B B B B B B B   B B B B B B B B                                        predbránové plochy A (4, 50) a B (16, 50): vjazd (4, 58) / (16, 58), výjazd (11, 49) / (23, 49)
 *   y=58   P_in1 = (1..4, 58)       (16, 58..59)                                            cesty od portálov vjazdu: (0, 58) → A, (0, 60) → (1..16, 60) → B
 * ```
 * Reťaz: portál → vjazd plochy → rad plochy (najkratší) → čelo radu → vstupný pruh svojho bloku (rad `r` → pruh `r mod 4`) → (8..23, 44) → stojisko (24, 42) rot 0 → (28, 44) →
 * (29, 40..44) → rad y = 40 → dock rampy → späť rovnako → stojisko (prechod telom) → (23, 44) → vstup výstupného pruhu (8..11, 44) → (8..11, 39) → portál výjazdu (0, 39).
 */
import modulesJson from '@data/defs/modules.json';
import trucksJson from '@data/defs/trucks.json';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { loadMap, parseMapDef, type CellCoord, type LoadedMap } from '@sim/grid';
import type { LoadingRamp, PreGateBuffer, TruckGate, WaitingArea } from '@sim/modules';
import { World } from '@sim/world';
import { LEGACY_HARBOR_JSON, RAW_DEFS } from '../world/world-fixtures';

export const IN_LANES = 8;
export const BLOCKS = 2;
export const LANES_PER_BLOCK = 4;
export const OUT_LANES = 4;
export const DOCKS = 10;
export const BAYS = 80;
export const STAGING_PER_DOCK = 12;
/** Ľavý okraj predbránovej plochy a prvého pruhu každého bloku (plocha 8 širokých, pruhy 4 široké pri jej východnom okraji). */
export const BLOCK_BUFFER_X: readonly number[] = [4, 16];
export const BLOCK_LANE_X: readonly number[] = [8, 20];
export const BUFFER_Y = 50;
export const IN_LANE_ORIGIN_Y = 45;
export const OUT_LANE_ORIGIN_Y = 40;
export const OUT_LANE_X0 = 8;
export const AREA_ORIGIN: CellCoord = { x: 24, y: 42 };
export const RAMP_ORIGIN: CellCoord = { x: 30, y: 38 };
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

const rampItem = modulesJson.items.find((item) => item.id === 'loading_ramp_container');
const areaItem = modulesJson.items.find((item) => item.id === 'truck_waiting_area');
if (rampItem === undefined || areaItem === undefined) throw new Error('bundled defy bez rampy alebo stojiska');

/** Defy s veľkou rampou (20×2, 10 dockov) a stojiskom s 80 bays; ostatné bundled vrátane šancí na problém pruhov (nepripnuté na 0 ako v `APRON_MODULES`; losovanie z `Rng` robí beh závislý od seedu; predbránová plocha 8×8, 8 radov po 2). */
export const GATES_DEFS: DefRegistry = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: {
    ...modulesJson,
    items: modulesJson.items.map((item) => {
      if (item.id === 'loading_ramp_container') {
        return {
          ...rampItem,
          footprint: { w: 2 * DOCKS, h: 2 },
          connectors: Array.from({ length: DOCKS }, (_unused, k) => ({ x: 1 + 2 * k, y: 1, side: 's', type: 'road' })),
          params: { ...rampItem.params, docks: DOCKS, stagingPerDock: STAGING_PER_DOCK },
        };
      }
      if (item.id === 'truck_waiting_area') return { ...areaItem, params: { ...areaItem.params, bays: BAYS, pickupReservedBays: 2 } };
      return item;
    }),
  },
  trucks: trucksJson,
});

const row = (y: number, x0: number, x1: number): CellCoord[] => Array.from({ length: x1 - x0 + 1 }, (_unused, i) => ({ x: x0 + i, y }));
const column = (x: number, y0: number, y1: number): CellCoord[] => Array.from({ length: y1 - y0 + 1 }, (_unused, i) => ({ x, y: y0 + i }));

/** Cesty rozloženia (dvojpruhové); vjazd plochy a výjazd na portál výjazdu sú súčasťou. */
export const GATES_ROADS: readonly (readonly CellCoord[])[] = [
  row(58, 1, 4),
  row(60, 1, 16),
  column(16, 58, 59),
  row(49, 8, 11),
  row(49, 20, 23),
  row(44, 8, 23),
  row(39, 1, OUT_LANE_X0 + OUT_LANES - 1),
  row(44, 28, 29),
  column(29, 40, 43),
  row(40, 29, 2 * DOCKS + 29),
];

/** Príkazy stavby: cesty, predbránové plochy, vstupné a výstupné pruhy, stojisko a rampa (v tomto poradí → id modulov od 1). */
export function gatesCommands(): SerializedCommand[] {
  const commands: SerializedCommand[] = GATES_ROADS.map((cells) => ({ type: 'PlaceRoad', cells: [...cells] }));
  for (const x of BLOCK_BUFFER_X) commands.push({ type: 'PlaceModule', defId: 'pre_gate_buffer', x, y: BUFFER_Y, rotation: 0 });
  for (const x0 of BLOCK_LANE_X) for (let i = 0; i < LANES_PER_BLOCK; i++) commands.push({ type: 'PlaceModule', defId: 'gate_in_lane', x: x0 + i, y: IN_LANE_ORIGIN_Y, rotation: 0 });
  for (let i = 0; i < OUT_LANES; i++) commands.push({ type: 'PlaceModule', defId: 'gate_out_lane', x: OUT_LANE_X0 + i, y: OUT_LANE_ORIGIN_Y, rotation: 0 });
  commands.push({ type: 'PlaceModule', defId: 'truck_waiting_area', x: AREA_ORIGIN.x, y: AREA_ORIGIN.y, rotation: 0 });
  commands.push({ type: 'PlaceModule', defId: 'loading_ramp_container', x: RAMP_ORIGIN.x, y: RAMP_ORIGIN.y, rotation: 0 });
  return commands;
}

export interface GatesWorld {
  readonly world: World;
  readonly buffers: readonly PreGateBuffer[];
  readonly inLanes: readonly TruckGate[];
  readonly outLanes: readonly TruckGate[];
  readonly area: WaitingArea;
  readonly ramp: LoadingRamp;
}

/** Svet s rozložením (bez nákladu); odmietnutý príkaz stavby je chyba. */
export function gatesWorld(seed: number, defs: DefRegistry = GATES_DEFS): GatesWorld {
  const world = World.create(defs, GATES_MAP, seed);
  for (const command of gatesCommands()) {
    world.enqueue(commandFromJSON(command));
    const rejected = world.applyPending().filter((event) => event.type === 'CommandRejected');
    if (rejected.length > 0) throw new Error(`príkaz ${JSON.stringify(command)} odmietnutý: ${JSON.stringify(rejected)}`);
  }
  const at = (x: number, y: number) => world.moduleAt(x, y);
  return {
    world,
    buffers: BLOCK_BUFFER_X.map((x) => at(x, BUFFER_Y) as PreGateBuffer),
    inLanes: BLOCK_LANE_X.flatMap((x0) => Array.from({ length: LANES_PER_BLOCK }, (_unused, i) => at(x0 + i, IN_LANE_ORIGIN_Y) as TruckGate)),
    outLanes: Array.from({ length: OUT_LANES }, (_unused, i) => at(OUT_LANE_X0 + i, OUT_LANE_ORIGIN_Y) as TruckGate),
    area: at(AREA_ORIGIN.x, AREA_ORIGIN.y) as WaitingArea,
    ramp: at(RAMP_ORIGIN.x, RAMP_ORIGIN.y) as LoadingRamp,
  };
}

/** Jedna jednotka priamo na dock rampy cez ledger (fiktívna loď 900, žeriav 901, vozidlo 902 — len prechody §7.1). */
export function stageUnit(world: World, ramp: LoadingRamp, dock: number): EntityId {
  const unit = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as EntityId }).id;
  world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
  world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
  world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
  world.cargo.move(unit, { kind: 'at_ramp', rampId: ramp.id, dock });
  return unit;
}
