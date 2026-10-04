/**
 * Odovzdávanie pod hákom (F6a, T6A-05, ADR-033): vozidlo čaká pod žeriavom a jednotka prejde `in_crane ↔ in_vehicle` (vykládka aj
 * nakládka), buffer `craneBufferSlots` na aprone, protideadlock, metriky čakania a obnova uloženej hry uprostred čakania. Svet =
 * prístav F4 (`exportWorld`), booking roundtrip sa prijíma príkazom, príchody kamiónov sú pevné (`arrivals`). Režim `apron`
 * (F2–F5) sa pripína cez def (`apronDefs`) — rozdiely oproti režimu `under_hook` sa porovnávajú nad tým istým scenárom.
 */
import { describe, expect, it } from 'vitest';
import type { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import { BerthModule, CraneModule } from '@sim/modules';
import { HOOK_WAIT_TICKS } from '@sim/vehicles/vehicle-fsm';
import { World, stateHash, type AnyWorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, apronDefs, hookDefs, lostUnits, ofType, runUntilDeparted, startLoading } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';

const TIMEOUT = 40_000;
/** Pevné príchody kamiónov (ticky od prijatia) pred cut-off (4 320): 12 exportov. */
const ARRIVALS_12 = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
const STRADDLES = (count: number): string[] => Array<string>(count).fill('straddle_carrier');

type Entries = readonly { readonly tick: number; readonly event: SimEvent }[];

interface RoundtripOptions {
  readonly defs: DefRegistry;
  readonly vehicles?: number;
  readonly booked?: number;
  readonly importUnits?: number;
  readonly arrivals?: readonly number[];
}

function roundtrip(options: RoundtripOptions) {
  const { defs, vehicles = 2, booked = 12, importUnits = 24, arrivals = ARRIVALS_12.slice(0, booked) } = options;
  return startLoading({ defs, vehicles: STRADDLES(vehicles), kind: 'roundtrip', booked, importUnits, arrivals });
}

/** Počty presunov nákladu podľa dvojice `z>do` (druhy polôh ledgera). */
function moveCounts(events: Entries): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of ofType(events, 'CargoMoved')) {
    const key = `${entry.event.from.kind}>${entry.event.to.kind}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const craneOf = (world: World): CraneModule => [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
const berthOf = (world: World): BerthModule => [...world.modules.values()].find((module): module is BerthModule => module instanceof BerthModule) as BerthModule;

/** Čaká vozidlo pod hákom (job s koncovým alebo východiskovým bodom `in_crane`, vozidlo v `loading`/`unloading`)? */
function vehicleUnderHook(world: World): boolean {
  for (const vehicle of world.vehicles.values()) {
    if (vehicle.jobId === null || (vehicle.state !== 'loading' && vehicle.state !== 'unloading')) continue;
    const job = world.jobs.get(vehicle.jobId);
    if (job !== undefined && (job.from.kind === 'in_crane' || job.to.kind === 'in_crane')) return true;
  }
  return false;
}

describe('odovzdávanie pod hákom: ledger a priebeh (ADR-033)', () => {
  const run = roundtrip({ defs: hookDefs(1) });
  const events = runUntilDeparted(run.world, TIMEOUT);
  const moves = moveCounts(events);

  it('vykládka: každá jednotka importu ide z lode do žeriava a odtiaľ priamo do vozidla, alebo na buffer apronu', () => {
    expect(moves['on_ship>in_crane']).toBe(24);
    expect((moves['in_crane>in_vehicle'] ?? 0) + (moves['in_crane>on_apron'] ?? 0)).toBe(24);
    expect(moves['in_crane>in_vehicle']).toBeGreaterThan(0);
    // Vozidlo pri vykládke vezie jednotku do skladu (alebo zo skladu k žeriavu, ak ju vyložilo na buffer).
    expect(moves['in_vehicle>in_storage']).toBeGreaterThan(0);
  });

  it('nakládka: exporty idú sklad → vozidlo → žeriav → loď; nikdy cez apron (on_apron → in_crane)', () => {
    expect(moves['in_vehicle>in_crane']).toBe(12);
    expect(moves['in_crane>on_ship']).toBe(12);
    expect(moves['on_apron>in_crane']).toBeUndefined();
    expect(moves['in_vehicle>on_apron']).toBeUndefined();
    expect(ofType(events, 'UnitLoaded')).toHaveLength(12);
  });

  it('booking je dokončený, nič sa nestratilo a svet neporušuje invarianty', () => {
    expect(ofType(events, 'ExportShipped')).toHaveLength(1);
    expect(run.offer.exportContract.state).toBe('completed');
    expect(lostUnits(run.world)).toBe(0);
    expect(findWorldViolation(run.world)).toBeUndefined();
    assertCargoConservation(run.world);
  });

  it('dual cycle funguje aj pod hákom: po zdvihnutí exportu sa hneď vykladá import (DualCycle)', () => {
    expect(ofType(events, 'DualCycle').length).toBeGreaterThan(0);
  });
});

describe('režim apron ostáva bez priameho odovzdania (F2–F5 bitovo nezmenené)', () => {
  it('rovnaký roundtrip v režime apron: žiadny presun in_crane ↔ in_vehicle, import aj export idú cez apron', () => {
    const run = roundtrip({ defs: apronDefs() });
    const events = runUntilDeparted(run.world, TIMEOUT);
    const moves = moveCounts(events);
    expect(moves['in_crane>in_vehicle']).toBeUndefined();
    expect(moves['in_vehicle>in_crane']).toBeUndefined();
    expect(moves['in_crane>on_apron']).toBeGreaterThanOrEqual(24);
    expect(moves['on_apron>in_crane']).toBe(12);
    expect(run.offer.exportContract.state).toBe('completed');
    expect(lostUnits(run.world)).toBe(0);
  });
});

describe('vozidlo čaká pod žeriavom (bez nového stavu FSM)', () => {
  it('pod hákom stoja vozidlá v existujúcich stavoch loading/unloading s odpočtom HOOK_WAIT_TICKS; job má koncový bod in_crane', () => {
    const run = roundtrip({ defs: hookDefs(1) });
    let loadingUnderHook = 0;
    let unloadingUnderHook = 0;
    runUntilDeparted(run.world, TIMEOUT, (world) => {
      for (const vehicle of world.vehicles.values()) {
        if (vehicle.jobId === null) continue;
        const job = world.jobs.get(vehicle.jobId);
        if (job === undefined) continue;
        if (vehicle.state === 'loading' && job.from.kind === 'in_crane') {
          loadingUnderHook += 1;
          expect(vehicle.waitTicks).toBe(HOOK_WAIT_TICKS);
        }
        if (vehicle.state === 'unloading' && job.to.kind === 'in_crane') {
          unloadingUnderHook += 1;
          expect(vehicle.waitTicks).toBe(HOOK_WAIT_TICKS);
        }
      }
    });
    expect(loadingUnderHook).toBeGreaterThan(0);
    expect(unloadingUnderHook).toBeGreaterThan(0);
  });

  it('dispatch vopred: job vykládky pod hákom vznikne už pri jednotke, ktorá je ešte na lodi (on_ship, zdroj in_crane)', () => {
    const run = roundtrip({ defs: hookDefs(1) });
    let seen = 0;
    runUntilDeparted(run.world, TIMEOUT, (world) => {
      for (const job of world.jobs.values()) {
        if (job.from.kind !== 'in_crane') continue;
        const unit = world.cargo.get(job.unitIds[0]!);
        if (unit?.location.kind === 'on_ship') seen += 1;
      }
    });
    expect(seen).toBeGreaterThan(0);
  });
});

describe('buffer a protideadlock (ADR-033)', () => {
  /** Najväčší počet jednotiek importu na aprone počas behu (jednotky exportu sa nepočítajú). */
  function maxImportOnApron(): { readonly record: (w: World) => void; readonly max: () => number } {
    let max = 0;
    return {
      record: (w) => {
        const berth = berthOf(w);
        let count = 0;
        for (const unit of w.cargo.liveUnits()) if (unit.direction === 'import' && unit.location.kind === 'on_apron' && unit.location.berthId === berth.id) count += 1;
        max = Math.max(max, count);
      },
      max: () => max,
    };
  }

  it('craneBufferSlots 0: bez exportu pod hákom žeriav s importom čaká na vozidlo, nič sa neodkladá na apron', () => {
    // Bez príchodov kamiónov: export nikdy nie je pod hákom, takže protideadlock slot sa nepoužije.
    const run = roundtrip({ defs: hookDefs(0), arrivals: [], booked: 6, importUnits: 12 });
    const probe = maxImportOnApron();
    const events = runUntilDeparted(run.world, 60_000, probe.record);
    expect(probe.max()).toBe(0);
    expect(moveCounts(events)['in_crane>on_apron']).toBeUndefined();
    expect(moveCounts(events)['in_crane>in_vehicle']).toBe(12);
    expect(lostUnits(run.world)).toBe(0);
  });

  it('craneBufferSlots 1: jednotka sa odloží na apron najviac na buffer (1 × počet žeriavov), keď pod hákom nikto nečaká', () => {
    const run = roundtrip({ defs: hookDefs(1), vehicles: 1, arrivals: [], booked: 6, importUnits: 12 });
    const probe = maxImportOnApron();
    const events = runUntilDeparted(run.world, 60_000, probe.record);
    const cranes = berthOf(run.world).craneIds.length;
    expect(probe.max()).toBeGreaterThan(0);
    expect(probe.max()).toBeLessThanOrEqual(cranes);
    expect((moveCounts(events)['in_crane>in_vehicle'] ?? 0) + (moveCounts(events)['in_crane>on_apron'] ?? 0)).toBe(12);
    expect(lostUnits(run.world)).toBe(0);
  });

  it('protideadlock: jedno vozidlo, buffer 0 a export pod hákom — žeriav s importom v ruke odloží jednotku na voľný slot apronu, loď odíde', () => {
    for (const buffer of [0, 1]) {
      const run = roundtrip({ defs: hookDefs(buffer), vehicles: 1 });
      const events = runUntilDeparted(run.world, 60_000);
      expect(ofType(events, 'UnitLoaded'), `buffer ${String(buffer)}`).toHaveLength(12);
      expect(run.offer.exportContract.state).toBe('completed');
      expect(lostUnits(run.world)).toBe(0);
    }
  });

  it('konfigurácie buffer 0/1 × 1/2/4 vozidlá: žiadne uviaznutie, žiadna strata, 24 importov a 12 exportov', () => {
    for (const buffer of [0, 1]) {
      for (const vehicles of [1, 2, 4]) {
        const run = roundtrip({ defs: hookDefs(buffer), vehicles });
        const events = runUntilDeparted(run.world, 60_000);
        const label = `buffer ${String(buffer)}, vozidiel ${String(vehicles)}`;
        expect(ofType(events, 'UnitLoaded'), label).toHaveLength(12);
        expect(moveCounts(events)['on_ship>in_crane'], label).toBe(24);
        expect(lostUnits(run.world), label).toBe(0);
        expect(findWorldViolation(run.world), label).toBeUndefined();
      }
    }
  });
});

describe('metriky čakania pod hákom (craneWaitForVehicleTicks, vehicleWaitUnderCraneTicks)', () => {
  it('jedno vozidlo: žeriav čaká na vozidlo a vozidlo čaká pod žeriavom; hodnoty sú celé ≥ 0 a prežijú uloženie', () => {
    const defs = hookDefs(0);
    const run = roundtrip({ defs, vehicles: 1 });
    runUntilDeparted(run.world, 60_000);
    const crane = craneOf(run.world);
    expect(crane.waitForVehicleTicks).toBeGreaterThan(0);
    expect(crane.vehicleWaitTicks).toBeGreaterThan(0);
    expect(Number.isInteger(crane.waitForVehicleTicks)).toBe(true);
    expect(Number.isInteger(crane.vehicleWaitTicks)).toBe(true);
    const restored = World.deserialize(defs, MAP, JSON.parse(JSON.stringify(run.world.serialize())) as AnyWorldState);
    expect(craneOf(restored).waitForVehicleTicks).toBe(crane.waitForVehicleTicks);
    expect(craneOf(restored).vehicleWaitTicks).toBe(crane.vehicleWaitTicks);
  });

  it('režim apron: čakanie na vozidlo sa nemeria (obe metriky 0)', () => {
    const run = roundtrip({ defs: apronDefs() });
    runUntilDeparted(run.world, TIMEOUT);
    const crane = craneOf(run.world);
    expect([crane.waitForVehicleTicks, crane.vehicleWaitTicks]).toEqual([0, 0]);
  });

  it('viac vozidiel skráti čakanie žeriava na vozidlo (1 → 4 vozidlá)', () => {
    const waits = [1, 4].map((vehicles) => {
      const run = roundtrip({ defs: hookDefs(0), vehicles });
      runUntilDeparted(run.world, 60_000);
      return craneOf(run.world).waitForVehicleTicks;
    });
    expect(waits[1]).toBeLessThan(waits[0]!);
  });
});

describe('determinizmus a obnova uprostred čakania pod hákom', () => {
  it('rovnaký beh dá rovnaký stateHash a rovnaký prúd udalostí', () => {
    const a = roundtrip({ defs: hookDefs(1) });
    const b = roundtrip({ defs: hookDefs(1) });
    const eventsA = runUntilDeparted(a.world, TIMEOUT);
    const eventsB = runUntilDeparted(b.world, TIMEOUT);
    expect(stateHash(a.world)).toBe(stateHash(b.world));
    expect(eventsA).toEqual(eventsB);
  });

  it('uloženie a obnova v ticku, keď vozidlo čaká pod hákom (vykládka aj nakládka), dá zhodný stateHash a zhodné ďalšie udalosti', () => {
    const defs = hookDefs(1);
    const reference = roundtrip({ defs });
    const referenceEvents = runUntilDeparted(reference.world, TIMEOUT);
    const referenceHash = stateHash(reference.world);

    // Sondujeme beh; v prvých tickoch s vozidlom pod hákom (vykládka, potom nakládka) urobíme snímku a dobehneme z obnoveného sveta.
    for (const phase of ['unload', 'load'] as const) {
      const live = roundtrip({ defs });
      let snapshotTick = -1;
      let snapshot: AnyWorldState | undefined;
      const head: { tick: number; event: SimEvent }[] = [];
      const probe = (world: World): void => {
        if (snapshot !== undefined || !vehicleUnderHook(world)) return;
        const waiting = [...world.vehicles.values()].some((vehicle) => {
          const job = vehicle.jobId === null ? undefined : world.jobs.get(vehicle.jobId);
          return job !== undefined && (phase === 'unload' ? vehicle.state === 'loading' && job.from.kind === 'in_crane' : vehicle.state === 'unloading' && job.to.kind === 'in_crane');
        });
        if (!waiting) return;
        snapshot = JSON.parse(JSON.stringify(world.serialize())) as AnyWorldState;
        snapshotTick = world.clock.tick;
      };
      for (let i = 0; i < TIMEOUT && snapshot === undefined; i++) {
        for (const event of live.world.tick()) head.push({ tick: live.world.clock.tick, event });
        probe(live.world);
      }
      expect(snapshot, `snímka ${phase}`).toBeDefined();
      const restored = World.deserialize(defs, MAP, snapshot as AnyWorldState);
      expect(stateHash(restored)).toBe(stateHash(live.world));
      const tail = runUntilDeparted(restored, TIMEOUT);
      expect(stateHash(restored), `obnova ${phase} v ticku ${String(snapshotTick)}`).toBe(referenceHash);
      expect([...head, ...tail]).toEqual(referenceEvents);
    }
  });
});
