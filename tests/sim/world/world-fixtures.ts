// Spoločné pomôcky pre testy World (T01-03). Skutočné príkazy (PlaceRoad, …) sú v @sim/commands (T01-04, testy
// v tests/sim/commands) — tu sú testovacie príkazy, ktoré implementujú rozhranie `Command` a menia svet priamo.
import cargoTypesJson from '@data/defs/cargo_types.json';
import contractTemplatesJson from '@data/defs/contract_templates.json';
import economyJson from '@data/defs/economy.json';
import infrastructureJson from '@data/defs/infrastructure.json';
import linesJson from '@data/defs/lines.json';
import containerTypesJson from '@data/defs/container_types.json';
import equipmentJson from '@data/defs/equipment.json';
import logisticsJson from '@data/defs/logistics.json';
import harbor01Json from '@data/maps/harbor_01.json';
import shipsJson from '@data/defs/ships.json';
import timeJson from '@data/defs/time.json';
import trucksJson from '@data/defs/trucks.json';
import vehiclesJson from '@data/defs/vehicles.json';
import type { Command, SerializedCommand, ValidationReason, ValidationResult } from '@sim/commands';
import { DefRegistry, loadBundledDefs } from '@sim/defs';
import { APRON_MODULES } from '../helpers/apron-modules';
import { loadBundledMap, loadMap, parseMapDef, type CellCoord, type Grid, type LoadedMap } from '@sim/grid';
import type { World, WorldState } from '@sim/world';

/** Bundled defy tak, ako ich hra načíta (`data/defs`) — predvolený režim odovzdávania kotviska je `under_hook` (ADR-033). */
export const BUNDLED_DEFS: DefRegistry = loadBundledDefs();

/**
 * Zoznam modulov bundled defov s pripnutým režimom odovzdávania `apron` (F2–F5, ADR-033): testy fáz 2–6, ktorých zmysel stojí na
 * odkladaní jednotiek na apron (apron, rezervácie slotov, `CraneCycleDone` = `on_apron`), si ho pripínajú tu — namiesto prepisu
 * očakávaní. Režim `under_hook` testuje `tests/sim/exports/export-hook.test.ts` a scenár `export_roundtrip`.
 */
export { APRON_MODULES };

/** Surové bundled defy (režim `apron`) — testy z nich skladajú `DefRegistry` s jedným upraveným defom. */
export const RAW_DEFS = {
  time: timeJson,
  economy: economyJson,
  infrastructure: infrastructureJson,
  cargo_types: cargoTypesJson,
  modules: APRON_MODULES,
  ships: shipsJson,
  vehicles: vehiclesJson,
  trucks: trucksJson,
  logistics: logisticsJson,
  contract_templates: contractTemplatesJson,
  lines: linesJson,
  container_types: containerTypesJson,
  equipment: equipmentJson,
};
/**
 * Pôvodný balans kapacít spred Fázy 5b (T5B-01 zväčšila `berth_standard.apronSlots` 4 → 8 a `loading_ramp_container.
 * stagingPerDock` 2 → 4). Scenárové testy, ktorých zmysel stojí na malých kapacitách (plný apron blokuje žeriav,
 * staging sa zaplní), si ich pripínajú tu — namiesto prepisu očakávaní — cez `LEGACY_CAPACITY_DEFS`.
 */
export const LEGACY_APRON_SLOTS = 4;
export const LEGACY_STAGING_PER_DOCK = 2;

/** Zoznam modulov bundled defov s pripnutými pôvodnými kapacitami apronu a stagingu (ostatné parametre nedotknuté). */
export const LEGACY_CAPACITY_MODULES = {
  ...APRON_MODULES,
  items: APRON_MODULES.items.map((item) => {
    if ('apronSlots' in item.params) return { ...item, params: { ...item.params, apronSlots: LEGACY_APRON_SLOTS } };
    if ('stagingPerDock' in item.params) return { ...item, params: { ...item.params, stagingPerDock: LEGACY_STAGING_PER_DOCK } };
    return item;
  }),
};
/** Bundled defy s pôvodnými kapacitami apronu (4) a stagingu (2). */
export const LEGACY_CAPACITY_DEFS: DefRegistry = DefRegistry.fromRaw({ ...RAW_DEFS, modules: LEGACY_CAPACITY_MODULES });
/** Bundled defy s pripnutým režimom `apron` — predvolené defy väčšiny testov (`DEFS`). */
export const DEFS: DefRegistry = DefRegistry.fromRaw(RAW_DEFS);
/**
 * Bundled defy bez náhodných problémov pruhov brány (R4, ADR-041): `APRON_MODULES` pripína `gateIssueChance` a `sealIssueChance` na 0, takže prechod pruhom má presné
 * trvanie a brána `Rng` nespotrebuje. Pomenované pre čitateľnosť testov presných časov a stavu `Rng` (rovnaké defy ako `DEFS`).
 */
export const NO_ISSUE_DEFS: DefRegistry = DEFS;
/** Zdieľaná mapa — testy overujú, že ju žiadny svet nezmení. */
/**
 * harbor_01 v podobe pred jednosmerným prístavom (R1, ADR-037 dodatok): jeden obojsmerný portál `road_south` (44, 63) a dvojpruhová
 * cesta x = 44, y 34–63. Testy mechaniky (príkazy, FSM, sklady, kamióny) stoja na tomto tvare; skutočná jednosmerná mapa a jej
 * slučka sú v testoch mapy a scenárov (`loadBundledMap`, bundled scenáre).
 */
export const LEGACY_HARBOR_JSON = {
  ...harbor01Json,
  roadPortals: [{ id: 'road_south', cell: { x: 44, y: 63 } }],
  starter: { ...harbor01Json.starter, roads: Array.from({ length: 30 }, (_unused, i) => ({ x: 44, y: 63 - i })) },
};
export const MAP: LoadedMap = loadMap(parseMapDef(LEGACY_HARBOR_JSON));
/** Skutočná `harbor_01` s jednosmernou slučkou (R1): testy bundled scenárov (`data/scenarios`) bežia na nej, nie na `MAP`. */
export const PORT_MAP: LoadedMap = loadBundledMap();
/** Mriežka počiatočného stavu mapy len na čítanie (hľadanie buniek, indexy); svety majú vlastné kópie, nezapisovať. */
export const MAP_GRID: Grid = MAP.createGrid();
/**
 * harbor_01 bez `starter.modules` (T02-04): nový svet nemá Root modul, takže testy modulov (T02-03) a pravidiel
 * umiestnenia stavajú na (40, 14) samy. Terén, parcely, cesty a id mapy sú rovnaké ako `MAP`.
 */
export const BARE_MAP: LoadedMap = loadMap(parseMapDef({ ...LEGACY_HARBOR_JSON, starter: { ...LEGACY_HARBOR_JSON.starter, modules: [] } }));
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
    apply: (world) => world.economy.post(deltaCents, 'road_capex'),
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
      world.economy.post(world.rng.int(0, 1000), 'road_sale');
    },
  });
}
