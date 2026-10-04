// Fixtúra outbound testov (T04-03, ADR-023): rozloženie F3 (`helpers/f3-layout.ts`: cesty, depo 3, blízky dvor 4
// (42, 18) s vonkajšou bunkou (43, 22), ďaleký dvor 5 (49, 26) s (50, 30)) + pozemná časť ako v TDD rozložení T04-05:
//   brána (45, 32) rot 270 — vstup (44, 33), výstup (47, 33);
//   stojisko (49, 31) rot 0 — (48, 33) a (53, 33);
//   rampa (53, 28) rot 0 — dock 0/1 na vonkajších bunkách (54, 30) a (55, 30).
// Cesty pozemnej časti: (44, 33); (47..48, 33); (53, 31..33); predĺženie vetvy y = 30 z (51, 30) po (55, 30). Z ďalekého
// dvora k rampe sú 4 kroky, z blízkeho 19 (vozidlá rampu dosiahnu aj bez brány — prevádzkovosť je vec kamiónov).
// Jednotky v sklade vznikajú priamo cez ledger (fiktívna loď 900, žeriav 901, vozidlo 902 — len prechody §7.1).
// Outbound testy T04-03 izolujú joby sklad → rampa bez odvozu kamiónmi: predvolené defy (`NO_CONTAINER_TRUCK_DEFS`)
// nemajú kamión pre kontajnery, takže spawner (T04-04) nič nespawne a staging ostane plný. Kamióny testujú
// f4-full-import-chain, f4-landside a systems/landside-system.
import trucksJson from '@data/defs/trucks.json';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord } from '@sim/grid';
import type { LoadingRamp, StorageModule, TruckGate, VehicleDepot, WaitingArea } from '@sim/modules';
import { World } from '@sim/world';
import { DEPOT_ORIGIN, FAR_YARD_ORIGIN, NEAR_YARD_ORIGIN, ROAD_SEGMENTS, segment } from '../helpers/f3-layout';
import { LEGACY_CAPACITY_MODULES, MAP, RAW_DEFS } from '../world/world-fixtures';

/** Kamióny, z ktorých žiadny nevozí kontajnery (`truck_container` len `bulk`) — rampa ostane bez odvozu. */
const NO_CONTAINER_TRUCKS = { ...trucksJson, items: trucksJson.items.map((item) => ({ ...item, cargoCategories: ['bulk'] })) };

/** Defy, v ktorých žiadny kamión nevozí kontajnery (`truck_container` len `bulk`) — rampa ostane bez odvozu. */
export const NO_CONTAINER_TRUCK_DEFS: DefRegistry = DefRegistry.fromRaw({ ...RAW_DEFS, trucks: NO_CONTAINER_TRUCKS });

/**
 * `NO_CONTAINER_TRUCK_DEFS` s pôvodnými kapacitami spred Fázy 5b (staging 2 na dock, apron 4; T5B-01 ich zväčšila).
 * Outbound testy T04-03 stoja na 2 dockoch × 2 miestach (plný staging, poradie dockov 0, 0, 1, 1), preto ich majú pripnuté.
 */
export const LEGACY_NO_CONTAINER_TRUCK_DEFS: DefRegistry = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: LEGACY_CAPACITY_MODULES,
  trucks: NO_CONTAINER_TRUCKS,
});

export const GATE_ORIGIN: CellCoord = { x: 45, y: 32 };
export const AREA_ORIGIN: CellCoord = { x: 49, y: 31 };
export const RAMP_ORIGIN: CellCoord = { x: 53, y: 28 };
/** Vonkajšie bunky konektorov rampy v poradí defu. */
export const RAMP_OUTSIDE: readonly CellCoord[] = [
  { x: 54, y: 30 },
  { x: 55, y: 30 },
];
export const GATE_ENTRY_OUTSIDE: CellCoord = { x: 44, y: 33 };

/** Cesty pozemnej časti (11 buniek), po úsekoch. */
export const LANDSIDE_ROADS = {
  gateApproach: segment(44, 33, 44, 33),
  gateExit: segment(47, 33, 48, 33),
  truckLink: segment(53, 31, 53, 33),
  branchExtension: segment(51, 30, 55, 30),
} as const;

export type LandsidePart = 'gate' | 'waiting_area' | 'ramp';

const LANDSIDE_COMMANDS: Readonly<Record<LandsidePart, SerializedCommand>> = {
  gate: { type: 'PlaceModule', defId: 'truck_gate', x: GATE_ORIGIN.x, y: GATE_ORIGIN.y, rotation: 270 },
  waiting_area: { type: 'PlaceModule', defId: 'truck_waiting_area', x: AREA_ORIGIN.x, y: AREA_ORIGIN.y, rotation: 0 },
  ramp: { type: 'PlaceModule', defId: 'loading_ramp_container', x: RAMP_ORIGIN.x, y: RAMP_ORIGIN.y, rotation: 0 },
};

/** Príkaz stavby pozemného modulu na jeho mieste v rozložení. */
export const landsideCommand = (part: LandsidePart): SerializedCommand => LANDSIDE_COMMANDS[part];

/** Enqueue + `applyPending`; odmietnutý príkaz = chyba testu. */
export function execute(world: World, command: SerializedCommand): readonly SimEvent[] {
  world.enqueue(commandFromJSON(command));
  const events = world.applyPending();
  const rejected = events.filter((event) => event.type === 'CommandRejected');
  if (rejected.length > 0) throw new Error(`príkaz ${command.type} odmietnutý: ${JSON.stringify(rejected)}`);
  return events;
}

export interface OutboundWorld {
  readonly world: World;
  readonly depot: VehicleDepot;
  readonly near: StorageModule;
  readonly far: StorageModule;
}

export interface OutboundOptions {
  /** Pozemné moduly v poradí stavby (predvolene brána, stojisko, rampa → id 6, 7, 8); chýbajúci sa nepostaví. */
  readonly landside?: readonly LandsidePart[];
  /** Príkazy pred pozemnými modulmi (napr. ďalšia rampa s menším id). */
  readonly before?: readonly SerializedCommand[];
  /** Príkazy po pozemných moduloch. */
  readonly after?: readonly SerializedCommand[];
  /** Bunky ciest rozloženia, ktoré sa nepostavia. */
  readonly omitRoads?: readonly CellCoord[];
  readonly defs?: DefRegistry;
  readonly seed?: number;
}

const sameCell = (a: CellCoord, b: CellCoord): boolean => a.x === b.x && a.y === b.y;

/** Svet s rozložením (cesty, depo 3, dvory 4 a 5, pozemné moduly) bez vozidiel a nákladu. */
export function outboundWorld(options: OutboundOptions = {}): OutboundWorld {
  const { landside = ['gate', 'waiting_area', 'ramp'], before = [], after = [], omitRoads = [], defs = NO_CONTAINER_TRUCK_DEFS, seed = 4030 } = options;
  const world = World.create(defs, MAP, seed);
  for (const segmentCells of [...Object.values(ROAD_SEGMENTS), ...Object.values(LANDSIDE_ROADS)]) {
    const cells = segmentCells.filter((cell) => !omitRoads.some((omitted) => sameCell(cell, omitted)));
    if (cells.length > 0) execute(world, { type: 'PlaceRoad', cells });
  }
  execute(world, { type: 'PlaceModule', defId: 'vehicle_depot', x: DEPOT_ORIGIN.x, y: DEPOT_ORIGIN.y, rotation: 0 });
  execute(world, { type: 'PlaceModule', defId: 'container_yard_small', x: NEAR_YARD_ORIGIN.x, y: NEAR_YARD_ORIGIN.y, rotation: 0 });
  execute(world, { type: 'PlaceModule', defId: 'container_yard_small', x: FAR_YARD_ORIGIN.x, y: FAR_YARD_ORIGIN.y, rotation: 0 });
  for (const command of before) execute(world, command);
  for (const part of landside) execute(world, landsideCommand(part));
  for (const command of after) execute(world, command);
  return {
    world,
    depot: world.moduleAt(DEPOT_ORIGIN.x, DEPOT_ORIGIN.y) as VehicleDepot,
    near: world.moduleAt(NEAR_YARD_ORIGIN.x, NEAR_YARD_ORIGIN.y) as StorageModule,
    far: world.moduleAt(FAR_YARD_ORIGIN.x, FAR_YARD_ORIGIN.y) as StorageModule,
  };
}

export const rampOf = (world: World): LoadingRamp => world.moduleAt(RAMP_ORIGIN.x, RAMP_ORIGIN.y) as LoadingRamp;
export const gateOf = (world: World): TruckGate => world.moduleAt(GATE_ORIGIN.x, GATE_ORIGIN.y) as TruckGate;
export const areaOf = (world: World): WaitingArea => world.moduleAt(AREA_ORIGIN.x, AREA_ORIGIN.y) as WaitingArea;

/** Kúpi `count` vozidiel `straddle_carrier` do depa; vráti ich id. */
export function buyVehicles(world: World, depot: VehicleDepot, count: number): EntityId[] {
  const ids: EntityId[] = [];
  for (let i = 0; i < count; i++) {
    const bought = execute(world, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: depot.id }).find((event) => event.type === 'VehicleBought');
    if (bought?.type !== 'VehicleBought') throw new Error('BuyVehicle nevyprodukoval VehicleBought');
    ids.push(bought.vehicleId);
  }
  return ids;
}

/**
 * `count` jednotiek priamo do najnižších voľných slotov skladu v poradí príchodu (FIFO) — cez ledger a fiktívnych
 * držiteľov (loď 900 → žeriav 901 → apron Root berthu slot 0 → vozidlo 902 → sklad), bez rezervácií a bez `unitsIn`.
 */
export function stockYard(world: World, yard: StorageModule, count: number, typeId = 'container_teu'): EntityId[] {
  const units: EntityId[] = [];
  let slot = 0;
  for (let i = 0; i < count; i++) {
    while (yard.unitAt(slot) !== null || yard.isReserved(slot)) slot += 1;
    const unit = world.cargo.create(typeId, { kind: 'on_ship', shipId: 900 as EntityId }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
    world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    world.cargo.move(unit, { kind: 'in_storage', moduleId: yard.id, slot });
    units.push(unit);
  }
  return units;
}

/** Staging rampy po dockoch: `[[staged, reserved], …]`. */
export function stagingOf(ramp: LoadingRamp): [number, number][] {
  const docks: [number, number][] = [];
  for (let dock = 0; dock < ramp.docks; dock++) docks.push([ramp.stagedAt(dock), ramp.reservedAt(dock)]);
  return docks;
}

/** Udalosti jedného typu z poľa udalostí. */
export function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}
