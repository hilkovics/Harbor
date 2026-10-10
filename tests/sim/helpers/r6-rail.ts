// Pomôcky pre testy železnice (TR6-01, ADR-043): `harbor_01` s koľajovým portálom na východnom okraji južného pásu súše (95, 51), železničný terminál `rmg_rail_block` otočený o 90°
// (16 × 6, vjazd koľají na východe: bunky (86, 50) a (86, 51)) a koľaj od portálu k nemu. Svet je bez starter modulov a s dostatkom hotovosti.
import economyJson from '@data/defs/economy.json';
import railJson from '@data/defs/rail.json';
import type { CellCoord } from '@sim/grid';
import { loadMap, parseMapDef, type LoadedMap } from '@sim/grid';
import { DefRegistry } from '@sim/defs';
import { RailTerminal } from '@sim/modules';
import { World } from '@sim/world';
import { send } from './f6a';
import { LEGACY_HARBOR_JSON, RAW_DEFS } from '../world/world-fixtures';

export const RAIL_PORTAL: CellCoord = { x: 95, y: 51 };
export const TERMINAL_ORIGIN = { x: 70, y: 50, rotation: 90 } as const;
export const RAIL_CASH_CENTS = 5_000_000_000;

export const RAIL_MAP: LoadedMap = loadMap(
  parseMapDef({ ...LEGACY_HARBOR_JSON, railPortals: [{ id: 'rail_east', cell: RAIL_PORTAL }], starter: { ...LEGACY_HARBOR_JSON.starter, modules: [] } }),
);

export interface RailDefsOptions {
  readonly timetable?: Partial<typeof railJson.timetable>;
  readonly train?: Partial<typeof railJson.train>;
}

/** Bundled defy s upravenou `rail.json` a veľkou hotovosťou. */
export function railDefs(options: RailDefsOptions = {}): DefRegistry {
  return DefRegistry.fromRaw({
    ...RAW_DEFS,
    economy: { ...economyJson, startingCashCents: RAIL_CASH_CENTS },
    rail: { ...railJson, timetable: { ...railJson.timetable, ...options.timetable }, train: { ...railJson.train, ...options.train } },
  });
}

/** Bunky koľaje od portálu (95, 51) na západ po vjazd koľaje 1 (86, 51) a odbočka na vjazd koľaje 0 (86, 50). */
export function approachCells(): CellCoord[] {
  const cells: CellCoord[] = [];
  for (let x = RAIL_PORTAL.x; x >= 86; x--) cells.push({ x, y: 51 });
  cells.push({ x: 86, y: 50 });
  return cells;
}

export interface RailWorld {
  readonly world: World;
  readonly terminal: RailTerminal;
}

/** Svet s terminálom a (voliteľne) koľajou k portálu. */
export function railWorld(options: RailDefsOptions & { readonly seed?: number; readonly rails?: boolean } = {}): RailWorld {
  const world = World.create(railDefs(options), RAIL_MAP, options.seed ?? 6001, { checkInvariants: true });
  const placed = send(world, { type: 'PlaceModule', defId: 'rmg_rail_block', ...TERMINAL_ORIGIN });
  if (!placed.some((event) => event.type === 'ModulePlaced')) throw new Error('railWorld: terminál sa nepostavil');
  if (options.rails !== false) {
    const events = send(world, { type: 'PlaceRail', cells: approachCells() });
    if (!events.some((event) => event.type === 'RoadChanged')) throw new Error('railWorld: koľaj sa nepostavila');
  }
  const terminal = [...world.modules.values()].find((module): module is RailTerminal => module instanceof RailTerminal);
  if (terminal === undefined) throw new Error('railWorld: terminál vo svete nie je');
  return { world, terminal };
}
