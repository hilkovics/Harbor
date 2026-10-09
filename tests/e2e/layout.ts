import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Spoločné rozloženie pozemnej časti pre e2e (R4, TR4-05): príkazy stavby sa berú priamo zo scenára v `data/scenarios/<name>.json` (jednosmerný okruh, vstupný a výstupný
// pruh brány, depo, dvory), takže e2e a `simrun` stoja na tom istom rozložení. Rampa, čakacia plocha ani `truck_gate` už neexistujú (ADR-041).

export interface LayoutCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface ScenarioEntry {
  readonly atTick: number;
  readonly command: LayoutCommand;
}

export interface Layout {
  /** `PlaceRoad` a `RemoveRoad` v poradí scenára (tick 0). */
  readonly roads: readonly LayoutCommand[];
  /** `PlaceModule` v poradí scenára (id modulov podľa poradia: žeriav 2, depo 3, …). */
  readonly modules: readonly LayoutCommand[];
  /** `BuyVehicle` (tick 0). */
  readonly vehicles: readonly LayoutCommand[];
  /** Id depa v príkazoch `BuyVehicle`. */
  readonly depotId: number;
}

/** Príkazy scenára `name` s `atTick = 0` rozdelené na cesty, moduly a nákup vozidiel. */
export function scenarioLayout(name: string): Layout {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'scenarios', `${name}.json`), 'utf8')) as { commands: readonly ScenarioEntry[] };
  const initial = raw.commands.filter((entry) => entry.atTick === 0).map((entry) => entry.command);
  const vehicles = initial.filter((command) => command.type === 'BuyVehicle');
  return {
    roads: initial.filter((command) => command.type === 'PlaceRoad' || command.type === 'RemoveRoad'),
    modules: initial.filter((command) => command.type === 'PlaceModule'),
    vehicles,
    depotId: Number(vehicles[0]?.['depotId'] ?? 3),
  };
}
