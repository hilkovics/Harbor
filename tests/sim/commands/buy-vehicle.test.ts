// BuyVehicle (T03-04; docs/tasks/phase-03.md rozhodnutie 4, „Spoločné rozhrania"; ARCHITECTURE §4.4, §9.2, §12.2):
// JSON tvar, dôvody validácie (každý sám aj naraz v kanonickom poradí), validate nemení svet, apply (vozidlo idle
// na vonkajšej bunke depa, cena, VehicleBought + MoneyChanged(vehicle_capex)), odmietnutie z fronty.
import vehiclesJson from '@data/defs/vehicles.json';
import { describe, expect, it } from 'vitest';
import { BuyVehicleCommand, CommandError, commandFromJSON, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { DefRegistry } from '@sim/defs';
import { World } from '@sim/world';
import { eventsOfType } from '../helpers/scenario';
import { DEPOT_OUTSIDE, LAYOUT_ROADS, STRADDLE, STRADDLE_DEF, addVehicleTo, buy, depotWorld, execute } from '../vehicles/vehicle-fixtures';
import { DEFS, MAP, RAW_DEFS, SEED, hashState } from '../world/world-fixtures';

const reasonsOf = (world: World, command: SerializedCommand): readonly string[] => commandFromJSON(command).validate(world).reasons;

describe('BuyVehicle — JSON tvar', () => {
  it('commandFromJSON ↔ toJSON (tvar zo „Spoločných rozhraní"), inštancia BuyVehicleCommand', () => {
    const json = { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: 3 };
    const command = commandFromJSON(json);
    expect(command).toBeInstanceOf(BuyVehicleCommand);
    expect(command.toJSON()).toEqual(json);
    expect(new BuyVehicleCommand({ vehicleDefId: 'x', depotId: 0 }).toJSON()).toEqual({ type: 'BuyVehicle', vehicleDefId: 'x', depotId: 0 });
  });

  const BAD: readonly [string, Record<string, unknown>, RegExp][] = [
    ['chýba depotId', { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier' }, /BuyVehicle\/depotId: chýba povinný kľúč/],
    ['neznámy kľúč', { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: 3, count: 2 }, /BuyVehicle\/count: neznámy kľúč/],
    ['vehicleDefId nie je reťazec', { type: 'BuyVehicle', vehicleDefId: 7, depotId: 3 }, /BuyVehicle\/vehicleDefId: musí byť reťazec/],
    ['depotId necelé', { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: 1.5 }, /BuyVehicle\/depotId: musí byť celé číslo/],
    ['depotId reťazec', { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: '3' }, /BuyVehicle\/depotId: musí byť celé číslo/],
  ];
  it.each(BAD)('%s → CommandError', (_name, json, message) => {
    expect(() => commandFromJSON(json as SerializedCommand)).toThrow(CommandError);
    expect(() => commandFromJSON(json as SerializedCommand)).toThrow(message);
  });

  it('konštruktor s neplatným vstupom → CommandError', () => {
    expect(() => new BuyVehicleCommand(null as unknown as { vehicleDefId: string; depotId: number })).toThrow(CommandError);
    expect(() => new BuyVehicleCommand({ vehicleDefId: 'x', depotId: Number.NaN })).toThrow(CommandError);
  });
});

describe('BuyVehicle.validate', () => {
  it('platný nákup: ok, cena = purchaseCents, žiadne bunky', () => {
    const { world, depot } = depotWorld();
    expect(commandFromJSON(buy(depot.id)).validate(world)).toEqual({ ok: true, reasons: [], cells: [], costCents: STRADDLE_DEF.purchaseCents });
  });

  it('neznámy def → presne unknown_vehicle_def a cena 0', () => {
    const { world, depot } = depotWorld();
    const result = commandFromJSON(buy(depot.id, 'hovercraft')).validate(world);
    expect(result.reasons).toEqual(['unknown_vehicle_def']);
    expect(result.costCents).toBe(0);
  });

  it('neznáme depo, kotvisko aj dvor → presne unknown_depot (státia ani pripojenie sa nehodnotia)', () => {
    const { world } = depotWorld({ yard: true });
    const yard = [...world.modules.values()].find((module) => module.kind === 'storage');
    for (const depotId of [999, 1, 2, yard?.id ?? -1]) expect(reasonsOf(world, buy(depotId)), `modul ${String(depotId)}`).toEqual(['unknown_depot']);
  });

  it('plné depo → presne depot_full', () => {
    const { world, depot } = depotWorld();
    for (let i = 0; i < depot.capacity; i++) execute(world, buy(depot.id));
    expect(depot.vehicleIds).toHaveLength(depot.capacity);
    expect(reasonsOf(world, buy(depot.id))).toEqual(['depot_full']);
  });

  it('depo bez cesty pred konektorom → presne not_connected; po PlaceRoad vonkajšej bunky prejde', () => {
    const { world, depot } = depotWorld({ roads: false });
    expect(world.isConnected(depot)).toBe(false);
    expect(reasonsOf(world, buy(depot.id))).toEqual(['not_connected']);
    execute(world, { type: 'PlaceRoad', cells: [DEPOT_OUTSIDE] });
    expect(reasonsOf(world, buy(depot.id))).toEqual([]);
  });

  it('nedostatok hotovosti → presne insufficient_funds; presne rovnaká hotovosť stačí', () => {
    const { world, depot } = depotWorld();
    world.cashCents = STRADDLE_DEF.purchaseCents - 1;
    expect(reasonsOf(world, buy(depot.id))).toEqual(['insufficient_funds']);
    world.cashCents = STRADDLE_DEF.purchaseCents;
    expect(reasonsOf(world, buy(depot.id))).toEqual([]);
  });

  it('viac porušení naraz v kanonickom poradí VALIDATION_REASONS', () => {
    const { world, depot } = depotWorld({ roads: false });
    for (let i = 0; i < depot.capacity; i++) addVehicleTo(world, depot.id);
    world.cashCents = 0;
    expect(reasonsOf(world, buy(depot.id))).toEqual(['insufficient_funds', 'depot_full', 'not_connected']);
    expect(reasonsOf(world, buy(999, 'hovercraft'))).toEqual(['unknown_vehicle_def', 'unknown_depot']);
  });

  it('validate nemení svet ani nespotrebuje id/Rng', () => {
    const { world, depot } = depotWorld();
    const before = hashState(world.serialize());
    for (let i = 0; i < 5; i++) commandFromJSON(buy(depot.id)).validate(world);
    expect(hashState(world.serialize())).toBe(before);
  });
});

describe('BuyVehicle.apply', () => {
  it('vozidlo idle v strede vonkajšej bunky depa s kurzom von z depa; cena; VehicleBought, potom MoneyChanged(vehicle_capex)', () => {
    const { world, depot } = depotWorld();
    const cashBefore = world.cashCents;
    const nextId = world.ids.getState().nextId;
    const events = execute(world, buy(depot.id));
    expect(events.map((event) => event.type)).toEqual(['VehicleBought', 'MoneyChanged']);
    expect(events[0]).toEqual({ type: 'VehicleBought', vehicleId: nextId, defId: STRADDLE, depotId: depot.id });
    expect(events[1]).toEqual({ type: 'MoneyChanged', cashCents: cashBefore - STRADDLE_DEF.purchaseCents, deltaCents: -STRADDLE_DEF.purchaseCents, reason: 'vehicle_capex' });
    expect(world.cashCents).toBe(cashBefore - STRADDLE_DEF.purchaseCents);

    const vehicle = world.vehicles.get(nextId as EntityId);
    expect(vehicle?.toState()).toEqual({
      id: nextId,
      defId: STRADDLE,
      depotId: depot.id,
      state: 'idle',
      x: DEPOT_OUTSIDE.x + 0.5,
      y: DEPOT_OUTSIDE.y + 0.5,
      heading: 180,
      jobId: null,
      purchaseCostCents: STRADDLE_DEF.purchaseCents,
    });
    expect(depot.vehicleIds).toEqual([nextId]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('viac nákupov: id vzostupne, vehicleIds v poradí nákupu, všetky na tej istej vonkajšej bunke (soft kongescia)', () => {
    const { world, depot } = depotWorld();
    const ids = [0, 1, 2].map(() => eventsOfType(execute(world, buy(depot.id)), 'VehicleBought')[0].vehicleId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(depot.vehicleIds).toEqual(ids);
    expect(new Set([...world.vehicles.values()].map((vehicle) => `${String(vehicle.x)},${String(vehicle.y)}`)).size).toBe(1);
  });

  it('bezplatné vozidlo (syntetický def, purchaseCents 0): VehicleBought bez MoneyChanged', () => {
    const free = DefRegistry.fromRaw({ ...RAW_DEFS, vehicles: { ...vehiclesJson, items: [{ ...vehiclesJson.items[0], purchaseCents: 0 }] } });
    const { world, depot } = depotWorld({ world: World.create(free, MAP, SEED) });
    const cash = world.cashCents;
    const events = execute(world, buy(depot.id));
    expect(events.map((event) => event.type)).toEqual(['VehicleBought']);
    expect(world.cashCents).toBe(cash);
    expect([...world.vehicles.values()][0].purchaseCostCents).toBe(0);
  });

  it('odmietnutý z fronty → CommandRejected s dôvodmi, svet sa nemení', () => {
    const { world } = depotWorld();
    const before = hashState(world.serialize());
    const events = execute(world, buy(999));
    expect(events).toEqual([{ type: 'CommandRejected', commandType: 'BuyVehicle', reasons: ['unknown_depot'] }]);
    expect(hashState(world.serialize())).toBe(before);
  });

  it('apply bez platnej validácie → Error a svet sa nezmení', () => {
    const { world, depot } = depotWorld({ roads: false });
    const before = hashState(world.serialize());
    expect(() => commandFromJSON(buy(depot.id)).apply(world)).toThrow(/nie je platný \(not_connected\)/);
    expect(hashState(world.serialize())).toBe(before);
  });

  it('LAYOUT_ROADS spája depo s dvorom (fixtúra): depo aj dvor sú pripojené', () => {
    const { world, depot } = depotWorld({ yard: true });
    const yard = [...world.modules.values()].find((module) => module.kind === 'storage');
    expect(LAYOUT_ROADS.length).toBeGreaterThan(0);
    expect(world.isConnected(depot)).toBe(true);
    expect(yard !== undefined && world.isConnected(yard)).toBe(true);
  });
});

describe('BuyVehicle — nová hra bez depa', () => {
  it('Root modul (berth, žeriav) nie je depo → unknown_depot', () => {
    const world = World.create(DEFS, MAP, SEED);
    expect(reasonsOf(world, buy(1))).toEqual(['unknown_depot']);
    expect(reasonsOf(world, buy(2))).toEqual(['unknown_depot']);
  });
});
