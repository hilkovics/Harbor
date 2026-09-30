/**
 * Scenár flotily (T03-04): replay JSON príkazov `PlaceRoad` / `PlaceModule` / `BuyVehicle` / `SellVehicle` na harbor_01 —
 * tok peňazí pri nákupe a predaji vozidiel (`vehicle_capex`, `vehicle_sale`), odmietnuté príkazy bez zmeny stavu,
 * konzervácia nákladu a krok 12 po každom ticku, determinizmus a save/load uprostred behu.
 *
 * Očakávaná hotovosť sa počíta nezávisle z defov (cena cesty, modulov a vozidla, `refundCents`), nie natvrdo.
 * Rozloženie: depo (id 3) na (34, 20) s výjazdom (35, 23), cesta (35, 23) → y = 24 → (51, 24), dvor (id 4) na (50, 20).
 * Vozidlá: tick 0 → id 5, tick 50 → id 6, tick 100 → id 7; tick 200 predaj 6; tick 300 odmietnutý nákup do dvora
 * (unknown_depot) a predaj neexistujúceho vozidla (unknown_vehicle); tick 400 znovu nákup → id 8.
 */
import { describe, expect, it } from 'vitest';
import { refundCents } from '@sim/commands';
import type { EntityId } from '@sim/core';
import type { VehicleDepot } from '@sim/modules';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { eventsOfType, runScenario, stateHash, type Scenario, type ScenarioEntry } from '../helpers/scenario';
import { LAYOUT_ROADS } from '../vehicles/vehicle-fixtures';
import { DEFS, MAP } from '../world/world-fixtures';

const RUN_TICKS = 1000;
const STRADDLE = DEFS.vehicles.get('straddle_carrier');
const DEPOT_ID = 3;
const YARD_ID = 4;

const at = (atTick: number, command: ScenarioEntry['command']): ScenarioEntry => ({ atTick, command });

const SCENARIO: Scenario = {
  id: 'f3_vehicle_fleet',
  seed: 3404,
  map: 'data/maps/harbor_01.json',
  commands: [
    at(0, { type: 'PlaceRoad', cells: LAYOUT_ROADS }),
    at(0, { type: 'PlaceModule', defId: 'vehicle_depot', x: 34, y: 20, rotation: 0 }),
    at(0, { type: 'PlaceModule', defId: 'container_yard_small', x: 50, y: 20, rotation: 0 }),
    at(0, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID }),
    at(50, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID }),
    at(100, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID }),
    at(200, { type: 'SellVehicle', vehicleId: 6 }),
    at(300, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: YARD_ID }),
    at(300, { type: 'SellVehicle', vehicleId: 6 }),
    at(400, { type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: DEPOT_ID }),
  ],
};

/** Referenčná hotovosť: štart − cesty − depo − dvor − 4 nákupy + refundácia jedného predaja. */
const EXPECTED_CASH =
  DEFS.economy.startingCashCents -
  LAYOUT_ROADS.length * DEFS.infrastructure.road.costPerCellCents -
  DEFS.modules.get('vehicle_depot').costCents -
  DEFS.modules.get('container_yard_small').costCents -
  4 * STRADDLE.purchaseCents +
  refundCents(STRADDLE.purchaseCents, DEFS.economy.removalRefundRate);

function run(untilTick = RUN_TICKS, world = World.create(DEFS, MAP, SCENARIO.seed)): { world: World; events: ReturnType<typeof runScenario> } {
  const events = runScenario(world, SCENARIO, untilTick, {
    afterTick: (w) => {
      assertCargoConservation(w);
      w.assertInvariants();
    },
  });
  return { world, events };
}

describe('scenár f3_vehicle_fleet — nákup a predaj vozidiel', () => {
  const { world, events } = run();

  it('moduly a vozidlá: depo 3, dvor 4, vozidlá 5, 7, 8 (6 predané) v depe v poradí nákupu', () => {
    expect(world.modules.get(DEPOT_ID as EntityId)?.kind).toBe('depot');
    expect(world.modules.get(YARD_ID as EntityId)?.kind).toBe('storage');
    expect([...world.vehicles.keys()]).toEqual([5, 7, 8]);
    expect((world.modules.get(DEPOT_ID as EntityId) as VehicleDepot).vehicleIds).toEqual([5, 7, 8]);
    for (const vehicle of world.vehicles.values()) expect([vehicle.state, vehicle.jobId, vehicle.depotId]).toEqual(['idle', null, DEPOT_ID]);
  });

  it('hotovosť = referenčný model; súčet MoneyChanged = zmena hotovosti; vehicle_capex 4×, vehicle_sale 1×', () => {
    expect(world.cashCents).toBe(EXPECTED_CASH);
    const money = eventsOfType(events, 'MoneyChanged');
    expect(money.reduce((sum, event) => sum + event.deltaCents, 0)).toBe(EXPECTED_CASH - DEFS.economy.startingCashCents);
    expect(money.filter((event) => event.reason === 'vehicle_capex').map((event) => event.deltaCents)).toEqual(Array(4).fill(-STRADDLE.purchaseCents));
    expect(money.filter((event) => event.reason === 'vehicle_sale').map((event) => event.deltaCents)).toEqual([
      refundCents(STRADDLE.purchaseCents, DEFS.economy.removalRefundRate),
    ]);
    expect(money.at(-1)?.cashCents).toBe(world.cashCents);
  });

  it('udalosti: VehicleBought 4× (5, 6, 7, 8), VehicleSold 1× (6), dva odmietnuté príkazy s dôvodmi', () => {
    expect(eventsOfType(events, 'VehicleBought').map((event) => [event.vehicleId, event.defId, event.depotId])).toEqual([
      [5, 'straddle_carrier', DEPOT_ID],
      [6, 'straddle_carrier', DEPOT_ID],
      [7, 'straddle_carrier', DEPOT_ID],
      [8, 'straddle_carrier', DEPOT_ID],
    ]);
    expect(eventsOfType(events, 'VehicleSold').map((event) => event.vehicleId)).toEqual([6]);
    expect(eventsOfType(events, 'CommandRejected')).toEqual([
      { type: 'CommandRejected', commandType: 'BuyVehicle', reasons: ['unknown_depot'] },
      { type: 'CommandRejected', commandType: 'SellVehicle', reasons: ['unknown_vehicle'] },
    ]);
  });

  it('vo F3 bez lodí žiadny náklad nevznikol (konzervácia po každom ticku v run)', () => {
    expect(world.cargo.getState()).toEqual({ createdCount: 0, exportedCount: 0, units: [] });
  });

  it('determinizmus: druhý beh s rovnakým seedom a príkazmi → rovnaký stav', () => {
    expect(stateHash(run().world)).toBe(stateHash(world));
  });

  it.each([150, 250, 350])('save/load na ticku %i a pokračovanie → rovnaký stav ako neprerušený beh', (tick) => {
    const first = run(tick).world;
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(first.serialize())) as ReturnType<World['serialize']>);
    expect(stateHash(run(RUN_TICKS, restored).world)).toBe(stateHash(world));
  });
});
