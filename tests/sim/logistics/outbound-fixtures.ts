// Fixtúra testov nad rozložením `helpers/f4-layout.ts` (R4: cesty, depo 3, dvory 4 (40, 19) a 5 (48, 19), vstupný pruh brány 6 (44, 30) a výstupný pruh 7 (45, 30)).
// Jednotky v sklade vznikajú priamo cez ledger (fiktívna loď 900, žeriav 901, vozidlo 902 — len prechody §7.1).
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { YardBlock, type StorageModule, type TruckGate, type VehicleDepot } from '@sim/modules';
import { World } from '@sim/world';
import { F4_DEPOT_ID, GATE, GATE_OUT, f4Scenario, type F4Options } from '../helpers/f4-layout';
import { PORT_MAP, RAW_DEFS } from '../world/world-fixtures';

export const GATE_ORIGIN = GATE.origin;
export const GATE_OUT_ORIGIN = GATE_OUT.origin;

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

export interface OutboundOptions extends Pick<F4Options, 'landside' | 'omitRoadCells'> {
  readonly defs?: DefRegistry;
  readonly seed?: number;
}

/** Svet s rozložením `f4-layout` (cesty, depo 3, dvory 4 a 5, brány 6 a 7) bez vozidiel a nákladu. */
export function outboundWorld(options: OutboundOptions = {}): OutboundWorld {
  const { defs = DefRegistry.fromRaw(RAW_DEFS), seed = 4030 } = options;
  const world = World.create(defs, PORT_MAP, seed);
  for (const entry of f4Scenario('outbound', seed, { landside: options.landside, omitRoadCells: options.omitRoadCells }).commands) execute(world, entry.command);
  return {
    world,
    depot: world.modules.get(F4_DEPOT_ID as EntityId) as VehicleDepot,
    near: world.moduleAt(40, 19) as StorageModule,
    far: world.moduleAt(48, 19) as StorageModule,
  };
}

/** Vstupný pruh brány (id 6 v predvolenom rozložení). */
export const gateOf = (world: World): TruckGate => world.moduleAt(GATE_ORIGIN.x, GATE_ORIGIN.y) as TruckGate;
/** Výstupný pruh brány (id 7 v predvolenom rozložení). */
export const gateOutOf = (world: World): TruckGate => world.moduleAt(GATE_OUT_ORIGIN.x, GATE_OUT_ORIGIN.y) as TruckGate;

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
 * `count` jednotiek priamo do voľných slotov skladu rozložených po vrstvách stohov (vrstva 0 všetkých stĺpcov, potom vrstva 1, …) v poradí príchodu (FIFO) — cez ledger a fiktívnych
 * držiteľov (loď 900 → žeriav 901 → apron Root berthu slot 0 → vozidlo 902 → sklad), bez rezervácií a bez `unitsIn`.
 */
export function stockYard(world: World, yard: StorageModule, count: number, typeId = 'container_teu'): EntityId[] {
  const units: EntityId[] = [];
  // Rozloženie po vrstvách (ADR-039): najprv vrstva 0 všetkých stĺpcov, potom vrstva 1, …; každá jednotka je navrchu svojho stohu, kým sa neukladá na druhú vrstvu.
  const geometry = yard instanceof YardBlock ? yard.geometry : { bays: yard.capacity, rows: 1, maxTier: 1 };
  const columns = geometry.bays * geometry.rows;
  let index = 0;
  for (let i = 0; i < count; i++) {
    let slot = -1;
    while (slot < 0 || yard.unitAt(slot) !== null || yard.isReserved(slot)) {
      const tier = Math.floor(index / columns);
      const column = index % columns;
      slot = column * geometry.maxTier + tier;
      index += 1;
    }
    const unit = world.cargo.create(typeId, { kind: 'on_ship', shipId: 900 as EntityId }).id;
    world.cargo.move(unit, { kind: 'in_crane', craneId: 901 as EntityId });
    world.cargo.move(unit, { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
    world.cargo.move(unit, { kind: 'in_vehicle', vehicleId: 902 as EntityId });
    world.cargo.move(unit, { kind: 'in_storage', moduleId: yard.id, slot });
    units.push(unit);
  }
  return units;
}

/** Udalosti jedného typu z poľa udalostí. */
export function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);
}
