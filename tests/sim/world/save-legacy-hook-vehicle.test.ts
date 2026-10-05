/**
 * Save spred T6D-02 s vozidlom mieriacim na **prístupovú bunku** kotviska (`world-restore.ts`, `adaptHookVehicle`, ADR-033 dodatok T6D-02 bod 5), pod bundled
 * defmi (režim `under_hook`, buffer 0): obnova rozbehnuté vozidlo deterministicky prevedie na trasu k bunke pod hákom (zachová rozbehnutý úsek), a keď k háku
 * po zmene siete cesta nevedie, vozidlo skončí v `no_path` a skúsi znova. Prvý test je v kombinácii s uloženým stavom v8 (`toV8State`, migrácia v8 → v9)
 * a kamiónmi čakajúcimi vo vnútrozemí (scenár `landside_pressure`); stojace vozidlá (`loading` / `unloading`) pokrýva `tests/sim/exports/hook-position.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PlaceRoadCommand, RemoveRoadCommand } from '@sim/commands';
import type { EntityId } from '@sim/core';
import { BerthModule, CraneModule } from '@sim/modules';
import { Vehicle, hookCellOfCrane, planRoute, type SerializedVehicle } from '@sim/vehicles';
import { World, hinterlandQueue, stateHash, type AnyWorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { toV8State } from '../helpers/legacy-save';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from './world-fixtures';

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Vozidlo v save: nová `Vehicle` zo záznamu (na plánovanie trasy tak, ako ho plánovala hra pred T6D-02). */
function probeOf(world: World, record: SerializedVehicle): Vehicle {
  return new Vehicle({
    id: record.id as EntityId,
    def: world.defs.vehicles.get(record.defId),
    depotId: record.depotId as EntityId,
    state: record.state,
    x: record.x,
    y: record.y,
    heading: record.heading,
    jobId: record.jobId as EntityId | null,
    purchaseCostCents: record.purchaseCostCents,
    route: record.route,
    progress: record.progress,
    waitTicks: record.waitTicks,
    replanPending: record.replan,
  });
}

/** Žeriav a kotvisko, ku ktorému vozidlo s jobom pod hákom mieri (zdroj pri `to_pickup`, cieľ pri `to_dropoff`); inak `undefined`. */
function hookTarget(world: World, vehicle: Vehicle): { crane: CraneModule; berth: BerthModule; hook: number } | undefined {
  if ((vehicle.state !== 'to_pickup' && vehicle.state !== 'to_dropoff') || vehicle.jobId === null) return undefined;
  const job = world.jobs.get(vehicle.jobId);
  const end = vehicle.state === 'to_pickup' ? job?.from : job?.to;
  if (end?.kind !== 'in_crane') return undefined;
  const crane = world.modules.get(end.craneId);
  const berth = crane instanceof CraneModule ? world.modules.get(crane.berthId) : undefined;
  const hook = hookCellOfCrane(world, end.craneId);
  return crane instanceof CraneModule && berth instanceof BerthModule && hook !== undefined ? { crane, berth, hook } : undefined;
}

/**
 * Záznam vozidla tak, ako by ho uložila hra pred T6D-02: tá istá jazda, no trasa mieri na **prístupovú bunku** kotviska (`planRoute`, A* k modulu) — nie na bunku
 * pod hákom. Plánuje sa z kotvy vozidla v živom svete, takže rozbehnutý úsek (`progress`, poloha) ostane platný.
 */
function legacyRecord(world: World, vehicle: Vehicle): SerializedVehicle {
  const target = hookTarget(world, vehicle) as NonNullable<ReturnType<typeof hookTarget>>;
  const probe = probeOf(world, vehicle.toState());
  expect(planRoute(world, probe, target.berth), `${vehicle.label}: trasa k prístupovej bunke kotviska`).toBe(true);
  expect(probe.remainingRoute().at(-1)).not.toBe(target.hook);
  return probe.toState();
}

describe('save v8 spred T6D-02 (bundled defy, čakajúce kamióny): rozbehnuté vozidlo mieriace na prístupovú bunku sa prevedie na trasu k háku', () => {
  const scenario = loadScenarioFile('landside_pressure');
  const TICKS_AFTER = 4_000;

  /** Stav v ticku, keď vozidlo jazdí k háku ďaleko od neho (≥ 3 bunky, medzi bunkami) a kamióny čakajú vo vnútrozemí. */
  function capture(): { saved: Json; vehicleId: number; hook: number; waiting: number; original: SerializedVehicle[] } {
    const world = World.create(BUNDLED_DEFS, MAP, scenario.seed);
    let found: { saved: Json; vehicleId: number; hook: number; waiting: number; original: SerializedVehicle[] } | undefined;
    runScenario(world, scenario, 34_000, {
      afterTick: (w) => {
        if (found !== undefined) return;
        const waiting = hinterlandQueue(w).total;
        if (waiting === 0) return;
        for (const vehicle of w.vehicles.values()) {
          const target = hookTarget(w, vehicle);
          if (target === undefined || vehicle.cellsAhead < 3 || vehicle.progress === 0 || vehicle.routeCellAt(vehicle.cellsAhead) !== target.hook) continue;
          const state = clone(w.serialize()) as unknown as Json;
          const record = legacyRecord(w, vehicle);
          const legacy = state as { vehicles: Json[] };
          legacy.vehicles = legacy.vehicles.map((entry) => (entry['id'] === vehicle.id ? (record as unknown as Json) : entry));
          found = { saved: toV8State(state), vehicleId: vehicle.id, hook: target.hook, waiting, original: [...w.vehicles.values()].map((entry) => entry.toState()) };
          return;
        }
      },
    });
    if (found === undefined) throw new Error('nenašlo sa vozidlo jazdiace k háku pri čakajúcich kamiónoch');
    return found;
  }

  const { saved, vehicleId, hook, waiting, original } = capture();

  it('uložený stav je v8 a vozidlo mieri mimo bunky pod hákom (tvar spred T6D-02)', () => {
    expect(saved['version']).toBe(8);
    const record = (saved['vehicles'] as SerializedVehicle[]).find((entry) => entry.id === vehicleId) as SerializedVehicle;
    expect(record.route.at(-1)).not.toBe(hook);
  });

  const restored = World.deserialize(BUNDLED_DEFS, MAP, clone(saved) as unknown as AnyWorldState);

  it('vozidlo si zachová stav jazdy, polohu a rozbehnutý úsek; trasa teraz končí v bunke pod hákom', () => {
    const before = (saved['vehicles'] as SerializedVehicle[]).find((entry) => entry.id === vehicleId) as SerializedVehicle;
    const vehicle = restored.vehicles.get(vehicleId as never) as Vehicle;
    expect(vehicle.state).toBe(before.state);
    expect([vehicle.x, vehicle.y, vehicle.progress]).toEqual([before.x, before.y, before.progress]);
    expect(vehicle.replanPending).toBe(false);
    expect(vehicle.routeCellAt(vehicle.cellsAhead)).toBe(hook);
    expect(vehicle.cellsAhead).toBeGreaterThan(0);
  });

  it('ostatné vozidlá sa neprevádzajú (záznam je po obnove rovnaký) a kamióny čakajúce vo vnútrozemí ostávajú čakať (migrácia v8 → v9)', () => {
    for (const record of original) {
      if (record.id === vehicleId) continue;
      expect(restored.vehicles.get(record.id as never)?.toState(), `vozidlo #${String(record.id)}`).toEqual(record);
    }
    expect(hinterlandQueue(restored).total).toBe(waiting);
    expect(findWorldViolation(restored)).toBeUndefined();
  });

  it(`svet dobehne ${String(TICKS_AFTER)} ticků: vozidlo dôjde pod hák, invarianty a konzervácia platia, nič sa nestratí`, () => {
    let underHook = false;
    for (let i = 0; i < TICKS_AFTER; i++) {
      restored.tick();
      const vehicle = restored.vehicles.get(vehicleId as never) as Vehicle;
      if ((vehicle.state === 'loading' || vehicle.state === 'unloading') && vehicle.cell === hook) underHook = true;
      if (i % 50 === 0) assertCargoConservation(restored);
    }
    expect(underHook, 'vozidlo prišlo pod hák').toBe(true);
    expect(lostUnits(restored)).toBe(0);
    expect(findWorldViolation(restored)).toBeUndefined();
    expect(stateHash(restored)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('save spred T6D-02: vozidlo mieriace na prístupovú bunku, keď k háku nevedie cesta → no_path a nový pokus', () => {
  const scenario = loadScenarioFile('vertical_slice');
  const CUT = [{ x: 44, y: 25 }];
  const CUT_TICK = 7_900;

  /** Svet po prerušení cesty (vozidlá majú `replanPending`, ešte neprepočítali) s jedným vozidlom v tvare spred T6D-02 (trasa na prístupovú bunku). */
  function legacyAfterCut(): { saved: AnyWorldState; vehicleId: number } {
    const world = World.create(BUNDLED_DEFS, MAP, scenario.seed);
    runScenario(world, scenario, CUT_TICK);
    const vehicle = [...world.vehicles.values()].find((entry) => hookTarget(world, entry) !== undefined) as Vehicle;
    const record = { ...legacyRecord(world, vehicle), replan: true };
    world.enqueue(new RemoveRoadCommand(CUT));
    world.applyPending();
    const state = clone(world.serialize()) as unknown as { vehicles: Json[] };
    state.vehicles = state.vehicles.map((entry) => (entry['id'] === vehicle.id ? (record as unknown as Json) : entry));
    return { saved: state as unknown as AnyWorldState, vehicleId: vehicle.id };
  }

  const { saved, vehicleId } = legacyAfterCut();
  const restored = World.deserialize(BUNDLED_DEFS, MAP, clone(saved));

  it('vozidlo je po obnove v no_path (stojí, zvyšok trasy zahodený) s odpočtom nového pokusu `repathIntervalTicks`; invarianty platia', () => {
    const vehicle = restored.vehicles.get(vehicleId as never) as Vehicle;
    expect(vehicle.state).toBe('no_path');
    expect(vehicle.waitTicks).toBe(restored.defs.logistics.repathIntervalTicks);
    expect(vehicle.replanPending).toBe(false);
    expect(vehicle.cellsAhead).toBeLessThanOrEqual(1);
    expect(findWorldViolation(restored)).toBeUndefined();
  });

  it('po oprave cesty vozidlo z no_path pokračuje k háku a celý import dobehne bez straty (kontrakt dokončený, 78 exportovaných)', () => {
    for (let i = 0; i < 1_000; i++) {
      restored.tick();
      if (i % 100 === 0) assertCargoConservation(restored);
    }
    expect((restored.vehicles.get(vehicleId as never) as Vehicle).state).toBe('no_path'); // cesta je stále prerušená — nič nezamrzlo, len čaká
    restored.enqueue(new PlaceRoadCommand(CUT));
    restored.applyPending();
    runScenario(restored, scenario, 30_000, { afterTick: (w) => assertCargoConservation(w) });
    expect(restored.contracts.get(1 as never)?.state).toBe('completed');
    expect(restored.cargo.exportedCount).toBe(78);
    expect(lostUnits(restored)).toBe(0);
    expect(findWorldViolation(restored)).toBeUndefined();
  }, 120_000);
});
