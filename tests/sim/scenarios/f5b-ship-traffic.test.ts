/**
 * Scenár F5b — lode sa neprekrývajú (T5B-02, ADR-029; spätná väzba 4 „lode sa plavia cez seba").
 *
 * harbor_01 so súvislou skupinou troch kotvísk (x 32–55: západné, Root, východné) s vlastnými žeriavmi a dvanástimi
 * loďami (feeder a handy striedavo, spawn každých 40 tickov). Apron je v teste zväčšený, aby lode bez vozidiel
 * odplávali a doprava sa točila (nie balans). Po **každom** ticku: konzervácia nákladu a audit ledgera (`recordRun`),
 * krok 12 sveta a nezávislá kontrola, že žiadne dve lode na mape nezdieľajú bunku (`shipCells`).
 *
 * Overuje: nikdy prekryv; loď vpláva na mapu až s cieľom (kotviská alebo anchorage pridelené pred vstupom); na sea lane
 * je naraz najviac jedna loď; pri kotviskách stoja naraz aspoň dve lode; všetky lode sa vyložia a odplávajú (bez
 * uviaznutia); všetok náklad skončí na aprónoch.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import modulesJson from '@data/defs/modules.json';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { SHIP_STATE_TRAITS, shipCells } from '@sim/ships';
import { World } from '@sim/world';
import {
  EAST_BERTH_CELL,
  WEST_ADJACENT_BERTH_CELL,
  at,
  emptyScenario,
  recordRun,
  spawnShipCommand,
  spawnedShipIds,
  timedOfType,
  withCommands,
  type RunLog,
} from '../helpers/harbor';
import { MAP, RAW_DEFS } from '../world/world-fixtures';

const SHIPS = 12;
const SPAWN_EVERY_TICKS = 40;
const RUN_TICKS = 20_000;
/** Apron s rezervou pre všetky jednotky behu (lode bez vozidiel sa vyložia celé a odplávajú). */
const APRON_SLOTS = 100;
const [berthJson] = modulesJson.items;
const DEFS_BIG_APRON = DefRegistry.fromRaw({
  ...RAW_DEFS,
  modules: { ...modulesJson, items: modulesJson.items.map((item) => (item.id === berthJson.id ? { ...berthJson, params: { ...berthJson.params, apronSlots: APRON_SLOTS } } : item)) },
});

const unitsOf = (index: number): number => 1 + (index % 4);
const classOf = (index: number): string => (index % 2 === 0 ? 'feeder' : 'handy');

const scenario = withCommands(
  emptyScenario('f5b_ship_traffic', 5202),
  ...Array.from({ length: SHIPS }, (_, index) => at(1 + index * SPAWN_EVERY_TICKS, spawnShipCommand(classOf(index), unitsOf(index)))),
);

/** Západné a východné kotvisko pri Roote so žeriavmi (priamo, cena 0 — hotovosť nie je predmetom scenára). */
function buildBerths(world: World): void {
  for (const cell of [WEST_ADJACENT_BERTH_CELL, EAST_BERTH_CELL]) {
    world.placeModule({ defId: 'berth_standard', x: cell.x, y: cell.y, rotation: 0 }, 0);
    world.placeModule({ defId: 'crane_container_gantry', x: cell.x + 3, y: cell.y, rotation: 0 }, 0);
  }
}

/** Prvá bunka zdieľaná dvoma loďami na mape (nezávisle od implementácie invariantu). */
function sharedCell(world: World): string | undefined {
  const owner = new Map<string, EntityId>();
  for (const ship of world.ships.values()) {
    if (!SHIP_STATE_TRAITS[ship.state].onMap) continue;
    for (const cell of shipCells(ship)) {
      const key = `${String(cell.x)},${String(cell.y)}`;
      const other = owner.get(key);
      if (other !== undefined) return `${key}: #${String(other)} a #${String(ship.id)}`;
      owner.set(key, ship.id);
    }
  }
  return undefined;
}

describe('scenár f5b_ship_traffic: 12 lodí, 3 kotviská, harbor_01', () => {
  let world: World;
  let log: RunLog;
  const overlaps: string[] = [];
  /** Loď → či mala pri prvom ticku na mape cieľ (kotviská alebo anchorage). */
  const enteredWithTarget = new Map<EntityId, boolean>();
  let maxOnLane = 0;
  let maxDocked = 0;
  let lastTick = 0;

  beforeAll(() => {
    world = World.create(DEFS_BIG_APRON, MAP, scenario.seed);
    buildBerths(world);
    expect(world.berthGroups.map((group) => group.totalLength)).toEqual([24]);
    let spawned = 0;
    const until = RUN_TICKS;
    log = recordRun(world, scenario, until, {
      onTick: (w, events) => {
        spawned += events.filter((event) => event.type === 'ShipSpawned').length;
        const shared = sharedCell(w);
        if (shared !== undefined) overlaps.push(`tick ${String(w.clock.tick)}: ${shared}`);
        let onLane = 0;
        let docked = 0;
        for (const ship of w.ships.values()) {
          if (SHIP_STATE_TRAITS[ship.state].onMap && !enteredWithTarget.has(ship.id)) {
            enteredWithTarget.set(ship.id, ship.berthIds.length > 0 || ship.anchorageIndex !== null);
          }
          if (ship.state === 'inbound' || ship.state === 'outbound') onLane += 1;
          if (ship.state === 'docked') docked += 1;
        }
        maxOnLane = Math.max(maxOnLane, onLane);
        maxDocked = Math.max(maxDocked, docked);
        if (spawned === SHIPS && w.ships.size === 0 && lastTick === 0) lastTick = w.clock.tick;
      },
    });
  }, 120_000);

  it('príkazy prešli a spawnlo sa 12 lodí', () => {
    expect(timedOfType(log, 'CommandRejected')).toEqual([]);
    expect(spawnedShipIds(log)).toHaveLength(SHIPS);
  });

  it('žiadne dve lode na mape nikdy nezdieľajú bunku', () => {
    expect(overlaps).toEqual([]);
  });

  it('každá loď vplávala na mapu až s cieľom (kotviská alebo anchorage pridelené pred vstupom)', () => {
    expect(enteredWithTarget.size).toBe(SHIPS);
    expect([...enteredWithTarget.values()].every(Boolean)).toBe(true);
  });

  it('na sea lane je naraz najviac jedna loď; pri kotviskách stoja naraz aspoň dve', () => {
    expect(maxOnLane).toBe(1);
    expect(maxDocked).toBeGreaterThanOrEqual(2);
  });

  it('všetky lode sa vyložili a odplávali (bez uviaznutia), všetok náklad je na aprónoch', () => {
    expect(lastTick).toBeGreaterThan(0);
    expect(timedOfType(log, 'ShipDeparted')).toHaveLength(SHIPS);
    const total = Array.from({ length: SHIPS }, (_, index) => unitsOf(index)).reduce((sum, units) => sum + units, 0);
    expect(world.cargo.createdCount).toBe(total);
    expect(world.cargo.countByKind('on_apron')).toBe(total);
    expect(world.cargo.countByKind('on_ship')).toBe(0);
  });
});
