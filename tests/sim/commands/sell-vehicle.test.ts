// SellVehicle (T03-04; docs/tasks/phase-03.md rozhodnutie 4; ARCHITECTURE §9.2; ADR-015 bod 5): JSON tvar,
// unknown_vehicle / vehicle_busy (mimo idle, job, náklad), refundácia zo zaplatenej ceny v bázických bodoch,
// VehicleSold + MoneyChanged(vehicle_sale) len pri refundácii > 0, depo po predaji všetkých vozidiel ide odstrániť.
import { describe, expect, it } from 'vitest';
import { CommandError, SellVehicleCommand, commandFromJSON, refundCents, type SerializedCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { World } from '@sim/world';
import { STRADDLE_DEF, addVehicleTo, buy, depotWorld, execute, loadInto, sell } from '../vehicles/vehicle-fixtures';
import { DEFS, MAP, SEED, hashState } from '../world/world-fixtures';
import { defsWith } from './command-fixtures';

const id = (value: number): EntityId => value as EntityId;
const RATE = DEFS.economy.removalRefundRate;
const reasonsOf = (world: World, command: SerializedCommand): readonly string[] => commandFromJSON(command).validate(world).reasons;

describe('SellVehicle — JSON tvar', () => {
  it('commandFromJSON ↔ toJSON, inštancia SellVehicleCommand', () => {
    const json = { type: 'SellVehicle', vehicleId: 7 };
    const command = commandFromJSON(json);
    expect(command).toBeInstanceOf(SellVehicleCommand);
    expect(command.toJSON()).toEqual(json);
    expect(new SellVehicleCommand(0).toJSON()).toEqual({ type: 'SellVehicle', vehicleId: 0 });
  });

  it.each([
    ['chýba vehicleId', { type: 'SellVehicle' }, /SellVehicle\/vehicleId: chýba povinný kľúč/],
    ['neznámy kľúč', { type: 'SellVehicle', vehicleId: 7, refund: 1 }, /SellVehicle\/refund: neznámy kľúč/],
    ['vehicleId necelé', { type: 'SellVehicle', vehicleId: 7.5 }, /SellVehicle\/vehicleId: musí byť celé číslo/],
  ] as const)('%s → CommandError', (_name, json, message) => {
    expect(() => commandFromJSON(json as unknown as SerializedCommand)).toThrow(CommandError);
    expect(() => commandFromJSON(json as unknown as SerializedCommand)).toThrow(message);
  });
});

describe('SellVehicle.validate', () => {
  it('neznáme vozidlo → presne unknown_vehicle, bez ceny a buniek', () => {
    const { world } = depotWorld();
    expect(commandFromJSON(sell(999)).validate(world)).toEqual({ ok: false, reasons: ['unknown_vehicle'], cells: [], costCents: 0 });
  });

  it('nečinné vozidlo: ok, costCents = −refundCents(purchaseCostCents, removalRefundRate)', () => {
    const { world, depot } = depotWorld();
    execute(world, buy(depot.id));
    const [vehicle] = world.vehicles.values();
    const refund = refundCents(STRADDLE_DEF.purchaseCents, RATE);
    expect(refund).toBeGreaterThan(0);
    expect(commandFromJSON(sell(vehicle.id)).validate(world)).toEqual({ ok: true, reasons: [], cells: [], costCents: -refund });
  });

  it('vozidlo mimo idle (s jobom), idle s jobom alebo s nákladom → presne vehicle_busy', () => {
    const { world, depot } = depotWorld();
    const moving = addVehicleTo(world, depot.id, { state: 'to_dropoff', jobId: id(40) });
    const idleWithJob = addVehicleTo(world, depot.id);
    idleWithJob.jobId = id(41);
    const loaded = addVehicleTo(world, depot.id);
    loadInto(world, loaded.id);
    for (const vehicle of [moving, idleWithJob, loaded]) expect(reasonsOf(world, sell(vehicle.id)), vehicle.label).toEqual(['vehicle_busy']);
  });

  it('validate nemení svet', () => {
    const { world, depot } = depotWorld();
    execute(world, buy(depot.id));
    const before = hashState(world.serialize());
    commandFromJSON(sell([...world.vehicles.keys()][0])).validate(world);
    expect(hashState(world.serialize())).toBe(before);
  });
});

describe('SellVehicle.apply', () => {
  it('odstráni vozidlo zo sveta aj depa, hotovosť += refundácia, VehicleSold a potom MoneyChanged(vehicle_sale)', () => {
    const { world, depot } = depotWorld();
    execute(world, buy(depot.id));
    execute(world, buy(depot.id));
    const [first, second] = world.vehicles.keys();
    const cash = world.cashCents;
    const refund = refundCents(STRADDLE_DEF.purchaseCents, RATE);
    const events = execute(world, sell(first));
    expect(events).toEqual([
      { type: 'VehicleSold', vehicleId: first },
      { type: 'MoneyChanged', cashCents: cash + refund, deltaCents: refund, reason: 'vehicle_sale' },
    ]);
    expect(world.cashCents).toBe(cash + refund);
    expect([...world.vehicles.keys()]).toEqual([second]);
    expect(depot.vehicleIds).toEqual([second]);
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('refundácia 0 (miera 0 alebo zaplatená cena 0) → VehicleSold bez MoneyChanged', () => {
    const noRefund = depotWorld({ world: World.create(defsWith({ removalRefundRate: 0 }), MAP, SEED) });
    execute(noRefund.world, buy(noRefund.depot.id));
    const cash = noRefund.world.cashCents;
    expect(execute(noRefund.world, sell([...noRefund.world.vehicles.keys()][0])).map((event) => event.type)).toEqual(['VehicleSold']);
    expect(noRefund.world.cashCents).toBe(cash);

    const { world, depot } = depotWorld();
    const gift = addVehicleTo(world, depot.id, { purchaseCostCents: 0 });
    expect(execute(world, sell(gift.id)).map((event) => event.type)).toEqual(['VehicleSold']);
  });

  it('odmietnutý z fronty (vehicle_busy) → CommandRejected, vozidlo ostane', () => {
    const { world, depot } = depotWorld();
    const busy = addVehicleTo(world, depot.id, { state: 'loading', jobId: id(50) });
    expect(execute(world, sell(busy.id))).toEqual([{ type: 'CommandRejected', commandType: 'SellVehicle', reasons: ['vehicle_busy'] }]);
    expect(world.vehicles.has(busy.id)).toBe(true);
  });

  it('RemoveModule depa s vozidlami → has_vehicles; po predaji všetkých vozidiel depo ide odstrániť', () => {
    const { world, depot } = depotWorld();
    execute(world, buy(depot.id));
    execute(world, buy(depot.id));
    const remove: SerializedCommand = { type: 'RemoveModule', moduleId: depot.id };
    expect(reasonsOf(world, remove)).toEqual(['has_vehicles']);
    for (const vehicleId of [...world.vehicles.keys()]) execute(world, sell(vehicleId));
    expect(reasonsOf(world, remove)).toEqual([]);
    expect(eventsOfTypeNames(execute(world, remove))).toContain('ModuleRemoved');
    expect(world.modules.has(depot.id)).toBe(false);
  });
});

function eventsOfTypeNames(events: readonly { type: string }[]): string[] {
  return events.map((event) => event.type);
}
