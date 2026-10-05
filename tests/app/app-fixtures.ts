// Spoločné pomôcky pre testy src/app (T01-07). Skutočné príkazy (PlaceRoad, SetGameSpeed) sú v T01-04 — tu sú
// minimálne testovacie príkazy, ktoré implementujú rozhranie `Command` a menia svet priamo.
import { commandFromJSON, type Command, type SerializedCommand, type ValidationResult } from '@sim/commands';
import type { EntityId } from '@sim/core';
import cargoTypesJson from '@data/defs/cargo_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import containerTypesJson from '@data/defs/container_types.json';
import logisticsJson from '@data/defs/logistics.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import { DefRegistry } from '@sim/defs';
import { World, type WorldOptions } from '@sim/world';
import { GameLoop } from '@app/game-loop';
import { SimBridge } from '@app/sim-bridge';
import { DEFS as APRON_DEFS, LEGACY_CAPACITY_DEFS, MAP } from '../sim/world/world-fixtures';

export const SEED = 20260929;

/**
 * Svet nad bundled defmi s pripnutým režimom odovzdávania kotviska `apron` (F6a, ADR-033: bundled default je `under_hook`).
 * Testy UI/app fáz 1–6 stoja na vykladaní lode bez vozidiel na apron (`CraneCycleDone` = `in_crane → on_apron`, sloty apronu);
 * namiesto prepisu očakávaní si pripínajú starý režim cez def — rovnako ako testy v `tests/sim` (`APRON_MODULES`).
 */
export function createWorld(options: WorldOptions = {}): World {
  return World.create(APRON_DEFS, MAP, SEED, options);
}

/**
 * Svet s pôvodnými kapacitami spred Fázy 5b (apron 4, staging 2) — pre testy, ktoré stoja na plnom aprone
 * (T5B-01 zväčšila apron na 8 a staging na 4; zmysel testu ostáva, pripína sa balans).
 */
export function createLegacyCapacityWorld(options: WorldOptions = {}): World {
  return World.create(LEGACY_CAPACITY_DEFS, MAP, SEED, options);
}

/**
 * Defy s upraveným počtom stojísk čakacej plochy (`truck_waiting_area.params.bays`). Pri menej stojiskách než dockoch rampy
 * sa druhý kamión nespawnuje, kým prvý neodíde zo stojiska → sim hlási `NoWaitingBay`.
 */
export function defsWithBays(bays: number): DefRegistry {
  return DefRegistry.fromRaw({
    time: timeJson,
    economy: economyJson,
    infrastructure: infrastructureJson,
    cargo_types: cargoTypesJson,
    modules: {
      ...modulesJson,
      items: modulesJson.items.map((item) => (item.id === 'truck_waiting_area' ? { ...item, params: { ...item.params, bays } } : item)),
    },
    ships: shipsJson,
    vehicles: vehiclesJson,
    trucks: trucksJson,
    logistics: logisticsJson,
    contract_templates: contractTemplatesJson,
    lines: linesJson,
    container_types: containerTypesJson,
  });
}

/** Ako `createApp`, ale s čakacou plochou o `bays` stojiskách (viď `defsWithBays`). */
export function createAppWithBays(bays: number): App {
  const world = World.create(defsWithBays(bays), MAP, SEED);
  const bridge = new SimBridge(world);
  const loop = new GameLoop(world, bridge);
  return { world, bridge, loop };
}

/** World + SimBridge + GameLoop prepojené tak, ako ich zapojí bootstrap (loop publikuje do bridge). */
export function createApp(options: WorldOptions = {}): { world: World; bridge: SimBridge; loop: GameLoop } {
  const world = createWorld(options);
  const bridge = new SimBridge(world);
  const loop = new GameLoop(world, bridge);
  return { world, bridge, loop };
}

// ---- logistika F3: cesty, dvory a depo (rozloženie scenára apron_to_yard) ----

type Point = readonly [number, number];

function line(from: Point, to: Point): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  const dx = Math.sign(to[0] - from[0]);
  const dy = Math.sign(to[1] - from[1]);
  for (let x = from[0], y = from[1]; ; x += dx, y += dy) {
    cells.push({ x, y });
    if (x === to[0] && y === to[1]) return cells;
  }
}

/** Cesty scenára `apron_to_yard`: od výjazdov Root kotviska (41,17) a (46,17) k obom dvorom a k depu. */
export const LOGISTICS_ROADS: readonly (readonly { x: number; y: number }[])[] = [
  line([41, 17], [41, 22]),
  line([46, 17], [46, 22]),
  line([42, 22], [45, 22]),
  line([42, 17], [45, 17]),
  line([44, 23], [44, 30]),
  line([45, 30], [50, 30]),
];

/** Moduly scenára `apron_to_yard` v poradí umiestnenia: depo (id 3), dvor 1 (id 4) a dvor 2 (id 5). */
export const LOGISTICS_MODULES: readonly SerializedCommand[] = [
  { type: 'PlaceModule', defId: 'vehicle_depot', x: 46, y: 27, rotation: 0 },
  { type: 'PlaceModule', defId: 'container_yard_small', x: 42, y: 18, rotation: 0 },
  { type: 'PlaceModule', defId: 'container_yard_small', x: 49, y: 26, rotation: 0 },
];

export const DEPOT_ID = 3 as EntityId;
export const YARD_ID = 4 as EntityId;
export const YARD_2_ID = 5 as EntityId;

export type App = ReturnType<typeof createApp>;

/** Odošle príkazy cez bridge a aplikuje ich (`frame(0)` = bez ticku). */
export function runCommands(app: App, commands: readonly SerializedCommand[]): void {
  for (const json of commands) app.bridge.dispatch(commandFromJSON(json));
  app.loop.frame(0);
}

/** Postaví cesty (`roads`), potom moduly (depo, dvor, dvor); `roads = false` nechá moduly nepripojené. */
export function buildLogistics(app: App, options: { readonly roads?: boolean } = {}): void {
  if (options.roads !== false) {
    runCommands(app, LOGISTICS_ROADS.map((cells) => ({ type: 'PlaceRoad', cells })));
  }
  runCommands(app, LOGISTICS_MODULES);
}

/** Kúpi `count` vozidiel do depa `DEPOT_ID` a aplikuje príkazy. */
export function buyVehicles(app: App, count: number): void {
  runCommands(app, Array.from({ length: count }, () => ({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID })));
}

// ---- pozemná časť F4: brána, stojisko, rampa (rozloženie TDD scenára full_import_chain, bez dvorov) ----

/**
 * Cesty pozemnej časti na `harbor_01`: (44, 33) vstup brány (nadväzuje na verejnú cestu x = 44, y 34..63 od portálu),
 * (47..48, 33) výstup brány → západ stojiska, (53, 31..33) východ stojiska → rampa, (51..55, 30) k dokom rampy.
 */
export const LANDSIDE_ROAD_CELLS: readonly (readonly { x: number; y: number }[])[] = [
  line([44, 33], [44, 33]),
  line([47, 33], [48, 33]),
  line([53, 33], [53, 31]),
  line([51, 30], [55, 30]),
];

export type LandsidePart = 'gate' | 'waiting_area' | 'ramp';

/** Príkazy stavby pozemných modulov: brána (45, 32) rot 270, stojisko (49, 31), rampa (53, 28). */
export const LANDSIDE_MODULE_COMMANDS: Readonly<Record<LandsidePart, SerializedCommand>> = {
  gate: { type: 'PlaceModule', defId: 'truck_gate', x: 45, y: 32, rotation: 270 },
  waiting_area: { type: 'PlaceModule', defId: 'truck_waiting_area', x: 49, y: 31, rotation: 0 },
  ramp: { type: 'PlaceModule', defId: 'loading_ramp_container', x: 53, y: 28, rotation: 0 },
};

/** Id pozemných modulov, keď sa stavajú ako prvé po štartovnom kotvisku (1) a žeriave (2) v poradí brána, stojisko, rampa. */
export const GATE_ID = 3 as EntityId;
export const AREA_ID = 4 as EntityId;
export const RAMP_ID = 5 as EntityId;

/** Postaví cesty pozemnej časti (`roads = false` ich vynechá) a potom moduly `parts` v danom poradí. */
export function buildLandside(app: App, options: { readonly roads?: boolean; readonly parts?: readonly LandsidePart[] } = {}): void {
  const { roads = true, parts = ['gate', 'waiting_area', 'ramp'] } = options;
  if (roads) runCommands(app, LANDSIDE_ROAD_CELLS.map((cells) => ({ type: 'PlaceRoad', cells })));
  runCommands(
    app,
    parts.map((part) => LANDSIDE_MODULE_COMMANDS[part]),
  );
}

// ---- celý reťazec F4: loď → dvory → rampa → kamióny → export (rozloženie scenára full_import_chain) ----

/** Id pozemných modulov v celom reťazci: depo 3, dvory 4 a 5, potom brána, stojisko a rampa. */
export const CHAIN_GATE_ID = 6 as EntityId;
export const CHAIN_AREA_ID = 7 as EntityId;
export const CHAIN_RAMP_ID = 8 as EntityId;

/**
 * Postaví celý reťazec scenára `full_import_chain` (cesty a moduly F3 + pozemná časť), kúpi `vehicles` vozidiel a
 * spawnne feeder s `units` TEU. Kamióny potom vznikajú skutočným tickom sveta (`frameUntil`), nie fiktívnymi id.
 */
export function buildFullChain(app: App, options: { readonly units?: number; readonly vehicles?: number } = {}): void {
  const { units = 6, vehicles = 3 } = options;
  buildLogistics(app);
  buildLandside(app);
  buyVehicles(app, vehicles);
  runCommands(app, [{ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units }]);
}

/** Posúva hru po framoch (jeden tick na frame), kým `done()` neplatí; strop chráni pred nekonečnou slučkou. */
export function frameUntil(app: App, done: () => boolean, limit = 4000): void {
  for (let i = 0; i < limit && !done(); i += 1) app.loop.frame(app.loop.tickMs);
  if (!done()) throw new Error(`podmienka neplatí ani po ${String(limit)} frameoch`);
}

const OK: ValidationResult = Object.freeze({ ok: true, reasons: [], cells: [], costCents: 0 });

abstract class TestCommand implements Command {
  abstract readonly type: string;
  validateCalls = 0;
  applyCalls = 0;

  validate(): ValidationResult {
    this.validateCalls += 1;
    return OK;
  }

  apply(world: World): void {
    this.applyCalls += 1;
    this.doApply(world);
  }

  protected abstract doApply(world: World): void;

  toJSON(): SerializedCommand {
    return { type: this.type };
  }
}

/** Nastaví rýchlosť hry a emituje `GameSpeedChanged` (zástupca `SetGameSpeed` z T01-04). */
export class TestSetSpeed extends TestCommand {
  readonly type = 'TestSetSpeed';

  constructor(private readonly speed: number) {
    super();
  }

  protected doApply(world: World): void {
    world.clock.setSpeed(this.speed);
    world.events.emit({ type: 'GameSpeedChanged', speed: this.speed });
  }
}

/** Zmení hotovosť o `deltaCents` a emituje `MoneyChanged`. */
export class TestAdjustCash extends TestCommand {
  readonly type = 'TestAdjustCash';

  constructor(private readonly deltaCents: number) {
    super();
  }

  protected doApply(world: World): void {
    world.economy.post(this.deltaCents, 'road_capex');
  }
}

/** Príkaz, ktorý neprejde validáciou (`insufficient_funds`); `apply` sa nesmie zavolať. */
export class TestRejected extends TestCommand {
  readonly type = 'TestRejected';

  override validate(): ValidationResult {
    this.validateCalls += 1;
    return { ok: false, reasons: ['insufficient_funds'], cells: [], costCents: 0 };
  }

  protected doApply(): void {
    throw new Error('TestRejected.apply sa nesmie zavolať');
  }
}
