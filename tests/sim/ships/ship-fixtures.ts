// Spoločné pomôcky pre testy lodí a systémov krokov 3–4 (T02-05): defy s testovacími triedami lodí, sypkým nákladom
// a sypkým žeriavom, spawn cez SpawnShipDebug a behanie tickov po podmienku.
//
// Mapa harbor_01: seaLane (48,0) → (48,7) → (44,7); anchorage (44,7), (52,7), (36,7), (60,7); Root berth x 40–47,
// y 14–16 (rot 0, voda y ≤ 13), Root žeriav (43,14) id 2. Poloha feedera pri Root berthe = (43, 13), handy na dvoch
// berthoch od x 40 = (45, 13).
import cargoTypesJson from '@data/defs/cargo_types.json';
import modulesJson from '@data/defs/modules.json';
import shipsJson from '@data/defs/ships.json';
import { SpawnShipDebugCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { CellCoord, LoadedMap } from '@sim/grid';
import type { BerthModule, CraneModule } from '@sim/modules';
import type { Ship } from '@sim/ships';
import { World, type WorldOptions } from '@sim/world';
import { MAP, RAW_DEFS } from '../world/world-fixtures';

export const TEU = 'container_teu';
/** Sypký testovací náklad (kategória bulk). */
export const GRAIN = 'grain_test';
/** Loď len na sypký náklad. */
export const BULKER = 'bulker_test';
/** Loď s ponorom 2 (Root berth má hĺbku 1). */
export const DEEP_SHIP = 'deep_test';
/** Loď širšia než pás vody kotviska (`frontWaterCells` 3). */
export const WIDE_SHIP = 'wide_test';
/** Žeriav na sypký náklad. */
export const BULK_CRANE = 'crane_bulk_test';
export const BERTH = 'berth_standard';
export const CRANE = 'crane_container_gantry';

const [feederJson] = shipsJson.items;
const [, craneJson] = modulesJson.items;

/** Bundled defy + testovacie triedy lodí, sypký náklad a sypký žeriav. */
export const SHIP_DEFS: DefRegistry = DefRegistry.fromRaw({
  ...RAW_DEFS,
  cargo_types: {
    ...cargoTypesJson,
    items: [
      ...cargoTypesJson.items,
      { id: GRAIN, category: 'bulk', unitName: 't', unitsPerBatch: 25, basePricePerUnitCents: 1200, xpPerUnit: 1, colorToken: 'cargo-bulk' },
    ],
  },
  ships: {
    ...shipsJson,
    items: [
      ...shipsJson.items,
      { ...feederJson, id: BULKER, displayName: 'Bulker', cargoCategories: ['bulk'] },
      { ...feederJson, id: DEEP_SHIP, displayName: 'Deep', draftClass: 2 },
      { ...feederJson, id: WIDE_SHIP, displayName: 'Wide', widthCells: 4 },
    ],
  },
  modules: {
    ...modulesJson,
    items: [...modulesJson.items, { ...craneJson, id: BULK_CRANE, params: { ...craneJson.params, category: 'bulk' } }],
  },
});

export const SEED = 5005;
export const ROOT_BERTH_ID = 1 as EntityId;
export const ROOT_CRANE_ID = 2 as EntityId;
export const EAST_BERTH: CellCoord = { x: 48, y: 14 };
export const WEST_BERTH: CellCoord = { x: 32, y: 14 };
export const GAP_BERTH: CellCoord = { x: 30, y: 14 };

export function newWorld(options: WorldOptions = {}, map: LoadedMap = MAP): World {
  return World.create(SHIP_DEFS, map, SEED, options);
}

/** Aplikuje príkaz hneď (bez posunu času); odmietnutie = chyba testu. Vráti udalosti. */
export function applyNow(world: World, command: Parameters<World['enqueue']>[0]): readonly SimEvent[] {
  world.enqueue(command);
  const events = world.applyPending();
  const rejected = events.find((event) => event.type === 'CommandRejected');
  if (rejected !== undefined) throw new Error(`príkaz ${command.type} odmietnutý: ${JSON.stringify(rejected)}`);
  return events;
}

/** Spawne loď cez `SpawnShipDebug` (bez posunu času) a vráti ju. */
export function spawn(world: World, shipClassId: string, units: number, cargoTypeId = TEU): Ship {
  const events = applyNow(world, new SpawnShipDebugCommand({ shipClassId, cargoTypeId, units }));
  const spawned = events.find((event) => event.type === 'ShipSpawned');
  if (spawned?.type !== 'ShipSpawned') throw new Error('ShipSpawned chýba');
  const ship = world.ships.get(spawned.shipId);
  if (ship === undefined) throw new Error(`loď ${String(spawned.shipId)} nie je vo world.ships`);
  return ship;
}

/** Postaví modul priamo (bez pravidiel príkazu, cena 0). */
export function placeModule(world: World, defId: string, cell: CellCoord): EntityId {
  return world.placeModule({ defId, x: cell.x, y: cell.y, rotation: 0 }, 0).id;
}

export function berth(world: World, berthId: EntityId): BerthModule {
  const module = world.modules.get(berthId);
  if (module?.kind !== 'berth') throw new Error(`#${String(berthId)} nie je berth`);
  return module as BerthModule;
}

export function crane(world: World, craneId: EntityId): CraneModule {
  const module = world.modules.get(craneId);
  if (module?.kind !== 'crane') throw new Error(`#${String(craneId)} nie je žeriav`);
  return module as CraneModule;
}

/** Udalosti všetkých tickov, kým `predicate` neplatí (kontrola po každom ticku); nesplnenie do `max` = chyba. */
export function tickUntil(world: World, predicate: (world: World) => boolean, max = 2000): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < max; i++) {
    events.push(...world.tick());
    if (predicate(world)) return events;
  }
  throw new Error(`podmienka nenastala do ${String(max)} tickov (tick ${String(world.clock.tick)})`);
}

/** Udalosti `n` tickov. */
export function tickN(world: World, n: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...world.tick());
  return events;
}

export function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}
