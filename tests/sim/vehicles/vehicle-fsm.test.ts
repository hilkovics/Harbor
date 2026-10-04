// FSM vozidla (T03-05, T03-06; docs/tasks/phase-03.md rozhodnutie 7; ADR-019): tabuľka prechodov, vlastnosti stavov
// (job, stavy jobu, pohyb, odpočet, cieľ), návrat z no_path podľa stavu jobu, Vehicle.transition a changeVehicleState.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import {
  RESUME_AFTER_NO_PATH,
  VEHICLE_STATES,
  VEHICLE_STATE_TRAITS,
  VEHICLE_TRANSITIONS,
  Vehicle,
  VehicleError,
  changeVehicleState,
  isVehicleTransitionAllowed,
} from '@sim/vehicles';
import { STRADDLE_DEF } from './vehicle-fixtures';

function idleVehicle(): Vehicle {
  return new Vehicle({ id: 7 as EntityId, def: STRADDLE_DEF, depotId: 3 as EntityId, state: 'idle', x: 0.5, y: 0.5, heading: 0, purchaseCostCents: 0, route: [0] });
}

describe('VEHICLE_TRANSITIONS', () => {
  it('idle → to_pickup → loading → to_dropoff → unloading → idle, to_* ↔ no_path; nič iné', () => {
    expect([...VEHICLE_TRANSITIONS.entries()]).toEqual([
      ['idle', ['to_pickup']],
      ['to_pickup', ['loading', 'no_path']],
      ['loading', ['to_dropoff']],
      ['to_dropoff', ['unloading', 'no_path']],
      ['unloading', ['idle']],
      ['no_path', ['to_pickup', 'to_dropoff']],
    ]);
    let allowed = 0;
    for (const from of VEHICLE_STATES) for (const to of VEHICLE_STATES) if (isVehicleTransitionAllowed(from, to)) allowed += 1;
    expect(allowed).toBe(9);
  });
});

describe('VEHICLE_STATE_TRAITS', () => {
  it('job, stavy jobu, pohyb, odpočet a cieľ pre každý stav', () => {
    expect(VEHICLE_STATES.map((state) => {
      const traits = VEHICLE_STATE_TRAITS[state];
      return [state, traits.hasJob, [...traits.jobStates], traits.motion, traits.waits, traits.destination];
    })).toEqual([
      ['idle', false, [], 'park', false, null],
      ['to_pickup', true, ['assigned'], 'drive', false, 'source'],
      ['loading', true, ['picking'], 'park', true, 'source'],
      ['to_dropoff', true, ['moving'], 'drive', false, 'target'],
      ['unloading', true, ['dropping'], 'park', true, 'target'],
      ['no_path', true, ['assigned', 'moving'], 'halt', true, null],
    ]);
    expect(Object.isFrozen(VEHICLE_STATE_TRAITS)).toBe(true);
  });

  it('RESUME_AFTER_NO_PATH: assigned → to_pickup, moving → to_dropoff; každý stav jobu v no_path má návrat', () => {
    expect(RESUME_AFTER_NO_PATH).toEqual({ assigned: 'to_pickup', moving: 'to_dropoff' });
    for (const state of VEHICLE_STATE_TRAITS.no_path.jobStates) expect(RESUME_AFTER_NO_PATH[state]).toBeDefined();
  });
});

describe('Vehicle.transition a changeVehicleState', () => {
  it('povolený prechod zmení stav; changeVehicleState emituje VehicleStateChanged { vehicleId, from, to }', () => {
    const vehicle = idleVehicle();
    const events: SimEvent[] = [];
    changeVehicleState({ emit: (event) => events.push(event) }, vehicle, 'to_pickup');
    expect(vehicle.state).toBe('to_pickup');
    expect(events).toEqual([{ type: 'VehicleStateChanged', vehicleId: 7, from: 'idle', to: 'to_pickup' }]);
  });

  it('nepovolený prechod → VehicleError(invalid_transition), stav sa nezmení a nič sa neemituje', () => {
    const vehicle = idleVehicle();
    const events: SimEvent[] = [];
    let error: unknown;
    try {
      changeVehicleState({ emit: (event) => events.push(event) }, vehicle, 'loading');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(VehicleError);
    expect((error as VehicleError).code).toBe('invalid_transition');
    expect(vehicle.state).toBe('idle');
    expect(events).toEqual([]);
  });
});
