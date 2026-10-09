// Spoločné pomôcky pre testy src/app (T01-07). Skutočné príkazy (PlaceRoad, SetGameSpeed) sú v T01-04 — tu sú
// minimálne testovacie príkazy, ktoré implementujú rozhranie `Command` a menia svet priamo.
import { commandFromJSON, type Command, type SerializedCommand, type ValidationResult } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { World, type WorldOptions } from '@sim/world';
import { GameLoop } from '@app/game-loop';
import { SimBridge } from '@app/sim-bridge';
import { DEFS as APRON_DEFS, LEGACY_CAPACITY_DEFS, MAP, PORT_MAP } from '../sim/world/world-fixtures';
import { f4Scenario } from '../sim/helpers/f4-layout';

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

/** Cesty scenára `apron_to_yard`: od výjazdov Root kotviska 8 × 4 (41,18) a (46,18) k obom dvorom a k depu (+ obchádzka dolnej bunky západnej nohy). */
export const LOGISTICS_ROADS: readonly (readonly { x: number; y: number }[])[] = [
  line([41, 18], [41, 22]),
  line([46, 18], [46, 22]),
  [{ x: 40, y: 21 }, { x: 40, y: 22 }, { x: 40, y: 23 }, { x: 41, y: 23 }, { x: 42, y: 23 }],
  line([42, 22], [45, 22]),
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

// ---- celý reťazec R4: loď → dvory → kamióny na TP dvora → brána → export (priečna ulica z `f4-layout`) ----

/** Id modulov rozloženia `f4Scenario`: depo 3, dvory 4 a 5, vstupný pruh brány 6, výstupný pruh brány 7. */
export const CHAIN_GATE_ID = 6 as EntityId;
export const CHAIN_GATE_OUT_ID = 7 as EntityId;

/** Aplikácia nad skutočnou `harbor_01` (jednosmerná slučka `PORT_MAP`): scenáre pozemnej časti stavajú priečnu ulicu na nej, nie na legacy `MAP`. */
export function createPortApp(options: WorldOptions = {}): App {
  const world = World.create(APRON_DEFS, PORT_MAP, SEED, options);
  const bridge = new SimBridge(world);
  const loop = new GameLoop(world, bridge);
  return { world, bridge, loop };
}

/**
 * Postaví celé rozloženie pozemnej časti (cesty, depo, dvory, brány; `f4Scenario`), kúpi `vehicles` vozidiel a spawnne feeder s `units` TEU. Aplikácia musí byť
 * z `createPortApp`. Kamióny potom vznikajú skutočným tickom sveta (`frameUntil`) na TP dvora, nie fiktívnymi id.
 */
export function buildFullChain(app: App, options: { readonly units?: number; readonly vehicles?: number } = {}): void {
  const { units = 6, vehicles = 3 } = options;
  const scenario = f4Scenario('app_chain', SEED, { units, vehicles: Array.from({ length: vehicles }, () => 'straddle_carrier') });
  runCommands(app, scenario.commands.map((entry) => entry.command));
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
