// Spoločné pomôcky pre testy World (T01-03). Skutočné príkazy (PlaceRoad, …) sú v @sim/commands (T01-04, testy
// v tests/sim/commands) — tu sú testovacie príkazy, ktoré implementujú rozhranie `Command` a menia svet priamo.
import cargoTypesJson from '@data/defs/cargo_types.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import type { Command, SerializedCommand, ValidationReason, ValidationResult } from '@sim/commands';
import { DefRegistry, loadBundledDefs } from '@sim/defs';
import { loadBundledMap, type CellCoord, type Grid, type LoadedMap } from '@sim/grid';
import type { World, WorldState } from '@sim/world';

export const DEFS: DefRegistry = loadBundledDefs();
/** Surové bundled defy — testy z nich skladajú `DefRegistry` s jedným upraveným defom. */
export const RAW_DEFS = {
  time: timeJson,
  economy: economyJson,
  infrastructure: infrastructureJson,
  cargo_types: cargoTypesJson,
  modules: modulesJson,
  ships: shipsJson,
};
/** Zdieľaná mapa — testy overujú, že ju žiadny svet nezmení. */
export const MAP: LoadedMap = loadBundledMap();
/** Mriežka počiatočného stavu mapy len na čítanie (hľadanie buniek, indexy); svety majú vlastné kópie, nezapisovať. */
export const MAP_GRID: Grid = MAP.createGrid();
export const SEED = 20260929;

/** Defy s upraveným `time.json` (napr. `speeds` bez 1). */
export function defsWithTime(overrides: Record<string, unknown>): DefRegistry {
  return DefRegistry.fromRaw({ ...RAW_DEFS, time: { ...timeJson, ...overrides } });
}

/** FNV-1a 32-bit nad `JSON.stringify(state)` — „hash stavu“ pre testy determinizmu. */
export function hashState(state: WorldState): string {
  const text = JSON.stringify(state);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function runTicks(world: World, n: number): void {
  for (let i = 0; i < n; i++) world.tick();
}

/** Prvá bunka (row-major), ktorá spĺňa podmienku; inak test zlyhá. */
export function findCell(grid: Grid, predicate: (cell: ReturnType<Grid['at']>, x: number, y: number) => boolean): CellCoord {
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (predicate(grid.at(x, y), x, y)) return { x, y };
    }
  }
  throw new Error('findCell: žiadna bunka nespĺňa podmienku');
}

const OK: ValidationResult = Object.freeze({ ok: true, reasons: [], cells: [], costCents: 0 });

export function rejected(...reasons: ValidationReason[]): ValidationResult {
  return { ok: false, reasons, cells: [], costCents: 0 };
}

interface TestCommandOptions {
  readonly type?: string;
  readonly validate?: (world: World) => ValidationResult;
  readonly apply?: (world: World) => void;
}

/** Testovací príkaz s počítadlami volaní; bez `validate` je vždy platný. */
export class TestCommand implements Command {
  readonly type: string;
  validateCalls = 0;
  applyCalls = 0;
  private readonly options: TestCommandOptions;

  constructor(options: TestCommandOptions = {}) {
    this.type = options.type ?? 'Test';
    this.options = options;
  }

  validate(world: World): ValidationResult {
    this.validateCalls += 1;
    return this.options.validate?.(world) ?? OK;
  }

  apply(world: World): void {
    this.applyCalls += 1;
    this.options.apply?.(world);
  }

  toJSON(): SerializedCommand {
    return { type: this.type };
  }
}

/** Zmena hotovosti o `deltaCents` + `MoneyChanged`; odmietne, ak by hotovosť klesla pod 0. */
export function adjustCash(deltaCents: number): TestCommand {
  return new TestCommand({
    type: 'TestAdjustCash',
    validate: (world) => (world.cashCents + deltaCents >= 0 ? OK : rejected('insufficient_funds')),
    apply: (world) => {
      world.cashCents += deltaCents;
      world.events.emit({ type: 'MoneyChanged', cashCents: world.cashCents, deltaCents, reason: 'road_capex' });
    },
  });
}

/** Priamo nastaví vrstvu dopravy na bunkách + `RoadChanged` (zástupca PlaceRoad/RemoveRoad z T01-04). */
export function setRoad(cells: readonly CellCoord[], layer: 'none' | 'road' | 'rail'): TestCommand {
  return new TestCommand({
    type: 'TestSetRoad',
    apply: (world) => {
      for (const { x, y } of cells) world.grid.at(x, y).road = layer;
      world.events.emit({ type: 'RoadChanged', cells });
    },
  });
}

/** Spotrebuje `Rng` a `EntityIdAllocator` a výsledok premietne do hotovosti (divergencia rng je viditeľná v stave). */
export function consumeRng(): TestCommand {
  return new TestCommand({
    type: 'TestConsumeRng',
    apply: (world) => {
      world.ids.next();
      world.cashCents += world.rng.int(0, 1000);
    },
  });
}
