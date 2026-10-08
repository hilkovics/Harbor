/**
 * Vozidlo pod hákom stojí fyzicky pod žeriavom (F6d, T6D-02, ADR-033 dodatok): job vykládky / nakládky pod hák vedie vozidlo na nábrežie
 * kotviska do bunky pod hákom (`hookCellOfCrane`), nie na prístupovú bunku cesty; jednotky idú žeriav ↔ vozidlo priamo (predvolený buffer 0),
 * apron sa použije len ako protideadlock. Režim `apron` nábrežie nemá. Uložená hra spred T6D-02 (vozidlo čaká na prístupovej bunke) sa pri obnove
 * prevedie. Svet = prístav F4 (`exportWorld`), roundtrip booking ako v `export-hook.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { BerthModule, CraneModule } from '@sim/modules';
import { hookCellOfCrane } from '@sim/vehicles/vehicle-trip';
import { World, stateHash, type WorldState } from '@sim/world';
import { findRemovalViolations } from '@sim/world/module-rules';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, apronDefs, hookDefs, lostUnits, ofType, runUntilDeparted, startLoading } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';

const TIMEOUT = 40_000;
const ARRIVALS_12 = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];

function roundtrip(defs: ReturnType<typeof hookDefs>, vehicles = 2) {
  return startLoading({ defs, vehicles: Array<string>(vehicles).fill('straddle_carrier'), kind: 'roundtrip', booked: 12, importUnits: 24, arrivals: ARRIVALS_12 });
}

const craneOf = (world: World): CraneModule => [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;

/** Koniec jobu vozidla v `loading` (zdroj `in_crane`) alebo `unloading` (cieľ `in_crane`): žeriav, pod ktorým vozidlo čaká; inak `undefined`. */
function craneWaitedUnder(world: World, vehicle: { jobId: number | null; state: string }): CraneModule | undefined {
  if (vehicle.jobId === null || (vehicle.state !== 'loading' && vehicle.state !== 'unloading')) return undefined;
  const job = world.jobs.get(vehicle.jobId as never);
  const end = vehicle.state === 'loading' ? job?.from : job?.to;
  return end?.kind === 'in_crane' ? (world.modules.get(end.craneId) as CraneModule) : undefined;
}

describe('predvolený režim under_hook: vozidlo čaká v bunke pod hákom na nábreží', () => {
  const run = roundtrip(hookDefs(0));
  const crane = craneOf(run.world);
  const hook = hookCellOfCrane(run.world, crane.id);
  const seen = { loading: 0, unloading: 0 };
  const offHook: string[] = [];
  /** Odstránenie kotviska, kým na jeho nábreží stojí vozidlo pod hákom: pravidlo `has_vehicles` (a len vtedy). */
  const removalBlocked: boolean[] = [];
  const events = runUntilDeparted(run.world, TIMEOUT, (world) => {
    for (const vehicle of world.vehicles.values()) {
      const under = craneWaitedUnder(world, vehicle);
      if (under === undefined) continue;
      if (vehicle.state === 'loading') seen.loading += 1;
      else seen.unloading += 1;
      if (vehicle.cell !== hook || vehicle.cellsAhead !== 0) offHook.push(`${String(world.clock.tick)}: ${vehicle.label} ${vehicle.state} na ${String(vehicle.cell)}`);
    }
    const berth = world.modules.get(crane.berthId) as BerthModule;
    const waiting = [...world.vehicles.values()].some((vehicle) => craneWaitedUnder(world, vehicle) !== undefined);
    if (waiting) removalBlocked.push(findRemovalViolations(world, berth).some((violation) => violation.rule === 'has_vehicles'));
  });

  it('kotvisko má jazdné nábrežie a žeriav bunku pod hákom (v nábreží, vo footprinte žeriava)', () => {
    expect(hook).toBeDefined();
    expect(run.world.quay.ownerAt(hook as number)).toBe(crane.berthId);
    const { x, y } = run.world.grid.coordOf(hook as number);
    expect(x >= crane.origin.x && x < crane.origin.x + crane.size.w && y >= crane.origin.y && y < crane.origin.y + crane.size.h).toBe(true);
    expect(run.world.grid.atIndex(hook as number).road).toBe('none'); // pod modulom cesta nie je — ide o nábrežie, nie o cestu
  });

  it('každé čakajúce vozidlo (loading pri vykládke aj unloading pri nakládke) stojí v strede bunky pod hákom, nikdy na prístupovej bunke cesty', () => {
    expect(seen.loading).toBeGreaterThan(0);
    expect(seen.unloading).toBeGreaterThan(0);
    expect(offHook).toEqual([]);
  });

  it('kým vozidlo čaká pod hákom, kotvisko sa nedá odstrániť (has_vehicles): vozidlo by stratilo jazdnú bunku', () => {
    expect(removalBlocked.length).toBeGreaterThan(0);
    expect(removalBlocked.every(Boolean)).toBe(true);
  });

  it('vykládka: aspoň 80 % jednotiek ide in_crane → in_vehicle (priamo), apron len ako protideadlock; nakládka vždy z vozidla', () => {
    const moves = ofType(events, 'CargoMoved').map((entry) => `${entry.event.from.kind}>${entry.event.to.kind}`);
    const count = (key: string): number => moves.filter((move) => move === key).length;
    const direct = count('in_crane>in_vehicle');
    const viaApron = count('in_crane>on_apron');
    expect(direct + viaApron).toBe(24);
    // zvyšok je protideadlock (vozidlo s exportom čaká pod hákom, kým žeriav drží import): 21 z 24 pri dvoch vozidlách
    expect(direct / (direct + viaApron)).toBeGreaterThanOrEqual(0.8);
    expect(count('in_vehicle>in_crane')).toBe(12);
    expect(count('on_apron>in_crane')).toBe(0);
  });

  it('nič sa nestratilo, invarianty sveta bez porušenia, apron je po skončení prázdny', () => {
    assertCargoConservation(run.world);
    expect(lostUnits(run.world)).toBe(0);
    expect(findWorldViolation(run.world)).toBeUndefined();
    expect(run.world.cargo.countByKind('on_apron')).toBe(0);
  });
});

describe('režim apron: bez nábrežia, vozidlá ostávajú na cestách (bitovo ako F2–F6c)', () => {
  const run = roundtrip(apronDefs());
  let onQuay = 0;
  runUntilDeparted(run.world, TIMEOUT, (world) => {
    for (const vehicle of world.vehicles.values()) if (world.quay.isQuay(vehicle.cell)) onQuay += 1;
  });

  it('v režime apron je z kotviska jazdná len obchádzka (pevninský riadok) a žiadne vozidlo na nábreží nestojí ani nejazdí; bunky pod hákom nie sú', () => {
    expect(onQuay).toBe(0);
    const driving = world().quay.owners().reduce((count, owner) => count + (owner === 0 ? 0 : 1), 0);
    expect(driving).toBe(24); // 8 × 4 bez riadku pri vode: 3 riadky po 8 buniek (pruhy a obchádzka), tranzit smie len obchádzka
    for (const crane of world().modules.values()) if (crane.kind === 'crane') expect(world().quay.hookCellOf(crane.id)).toBeUndefined();
  });

  function world(): World {
    return run.world;
  }

  it('žiadne priame odovzdanie: žiadny pohyb in_crane → in_vehicle (každá jednotka ide cez apron)', () => {
    const moves = ofType(runUntilDeparted(roundtrip(apronDefs()).world, TIMEOUT), 'CargoMoved').map((entry) => `${entry.event.from.kind}>${entry.event.to.kind}`);
    expect(moves.includes('in_crane>in_vehicle')).toBe(false);
    expect(moves.filter((move) => move === 'in_crane>on_apron')).toHaveLength(24);
  });
});

describe('save: vozidlo čakajúce pod hákom (T6D-02)', () => {
  /** Svet v ticku, keď vozidlo čaká v `loading` / `unloading` pod hákom; vráti serializovaný stav pred ďalším tickom. */
  function waitingState(state: 'loading' | 'unloading'): { world: World; vehicleId: number; saved: WorldState; hash: string } {
    const run = roundtrip(hookDefs(0));
    let found: { vehicleId: number; saved: WorldState; hash: string } | undefined;
    runUntilDeparted(run.world, TIMEOUT, (world) => {
      if (found !== undefined) return;
      for (const vehicle of world.vehicles.values()) {
        if (vehicle.state === state && craneWaitedUnder(world, vehicle) !== undefined) {
          found = { vehicleId: vehicle.id, saved: JSON.parse(JSON.stringify(world.serialize())) as WorldState, hash: stateHash(world) };
          return;
        }
      }
    });
    if (found === undefined) throw new Error(`žiadne vozidlo v stave ${state} pod hákom`);
    return { world: run.world, ...found };
  }

  it('roundtrip s vozidlom čakajúcim pod hákom dá zhodný stateHash a invarianty držia', () => {
    const { saved, hash } = waitingState('loading');
    const restored = World.deserialize(hookDefs(0), MAP, saved);
    expect(stateHash(restored)).toBe(hash);
    expect(() => restored.assertInvariants()).not.toThrow();
  });
});
