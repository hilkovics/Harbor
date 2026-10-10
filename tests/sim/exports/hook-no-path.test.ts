/**
 * Vykládka pod hákom (predvolený buffer 0), keď vozidlo jobu nedôjde pod hák (F6d, T6D-05b, ADR-033 dodatok T6D-05): vozidlo v `no_path`
 * už nie je „na ceste k háku“ (`planUnload`) a žeriav jeho jednotku odloží na apron (`deliver`), odkiaľ ju vozidlo vezme na prístupovej
 * bunke kotviska — žeriav nedrží jednotku pre vozidlo, ktoré nikdy nepríde.
 *
 * - **Prerezaná cesta**: `vertical_slice`, `RemoveRoad` na trase vozidiel v ticku 8 332 (obe vozidlá preplánujú do `no_path`), oprava o 3 000 ticků
 *   neskôr. Pred opravou žeriav ostal v `placing` s prvou jednotkou a loď (49 jednotiek) sa nevykladala.
 * - R4 (TR4-02): jednosmerné avenue nemá obchádzku, po ktorej by prístupová bunka kotviska bola dosiahnuteľná a hák nie (návrat z kotviska vedie jedine cez nábrežie), preto zátkové scenáre
 *   („jednosmerky popri nábreží“, záložná nakládka cez apron) zanikli; presmerovanie jobu nakládky na apron (`TransportJob.rebindTarget`) pokrýva jednotkový test `transport-job.test.ts`.
 * - Save v `no_path`: obnova dá zhodný `stateHash`.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { CraneModule } from '@sim/modules';
import { World, stateHash, type WorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { PORT_MAP, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario, type Scenario } from '../helpers/scenario';
import type { DefRegistry } from '@sim/defs';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const BASE = loadScenarioFile('vertical_slice');
const TICKS = 30_000;
/** Import kontraktu #1 `vertical_slice`: 78 TEU = 50 kontajnerov pri `sizeMix` 0,6 (ADR-039). */
const IMPORT_UNITS = 50;
const TIMEOUT_MS = 120_000;

type Entries = { tick: number; event: SimEvent }[];

interface Observed {
  readonly world: World;
  readonly events: Entries;
  /** Najdlhší súvislý úsek ticků, v ktorých žeriav drží tú istú jednotku. */
  readonly longestHold: number;
  /** Prvý tick, v ktorom platí `saveWhen` — stav sa tu uloží. */
  readonly saved: { readonly tick: number; readonly state: WorldState } | undefined;
}

/** Žeriav drží jednotku v `placing` a nejaké vozidlo je v `no_path` (od ticku `from`). */
const craneHoldsWhileStuck =
  (from: number) =>
  (w: World, crane: CraneModule): boolean =>
    w.clock.tick >= from && crane.state === 'placing' && crane.heldUnitId !== null && [...w.vehicles.values()].some((vehicle) => vehicle.state === 'no_path');

/** Beh scenára (`ticks`) s kontrolou konzervácie po každom ticku, udalosťami a uložením stavu v prvom ticku, kde platí `saveWhen`. */
function observe(scenario: Scenario, saveWhen: (world: World, crane: CraneModule) => boolean, ticks = TICKS, defs: DefRegistry = BUNDLED_DEFS): Observed {
  const world = World.create(defs, PORT_MAP, scenario.seed);
  const events: Entries = [];
  let heldUnit: number | null = null;
  let hold = 0;
  let longestHold = 0;
  let saved: Observed['saved'];
  runScenario(world, scenario, ticks, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      for (const event of tickEvents) events.push({ tick: w.clock.tick, event });
      const crane = [...w.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
      hold = crane.heldUnitId !== null && crane.heldUnitId === heldUnit ? hold + 1 : 0;
      heldUnit = crane.heldUnitId;
      longestHold = Math.max(longestHold, hold);
      if (saved === undefined && saveWhen(w, crane)) saved = { tick: w.clock.tick, state: JSON.parse(JSON.stringify(w.serialize())) as WorldState };
    },
  });
  return { world, events, longestHold, saved };
}

const moves = (events: Entries, from: string, to: string, window: readonly [number, number] = [0, Infinity]): number =>
  events.filter((entry) => entry.event.type === 'CargoMoved' && entry.event.from.kind === from && entry.event.to.kind === to && entry.tick >= window[0] && entry.tick < window[1]).length;

/** Dokončenie po obnove v ticku uloženia: zhodný `stateHash` ako súvislý beh. */
function expectRoundtrip(observed: Observed, scenario: Scenario, ticks = TICKS, defs: DefRegistry = BUNDLED_DEFS): void {
  expect(observed.saved, 'sledovaný stav sa v behu nenašiel').toBeDefined();
  const { state } = observed.saved as NonNullable<Observed['saved']>;
  const restored = World.deserialize(defs, PORT_MAP, JSON.parse(JSON.stringify(state)) as WorldState);
  runScenario(restored, scenario, ticks);
  expect(stateHash(restored)).toBe(stateHash(observed.world));
  expect(restored.cargo.exportedCount).toBe(observed.world.cargo.exportedCount);
}

describe('prerezaná cesta počas vykládky (buffer 0): žeriav neuviazne na jednotke vozidla v no_path', () => {
  const CUT_TICK = 8_332;
  const REPAIR_TICK = 11_332;
  // K háku vedie jediná cesta cez západný konektor kotviska (41, 18): strata bunky (42, 18) v ticku 8 332 (zaparkované vozidlá
  // vyšli z depa v 8 327 s prvou loďou) nechá obe vozidlá bez cesty k háku v no_path.
  const CUT_CELL = [{ x: 42, y: 18 }];
  const scenario: Scenario = {
    ...BASE,
    commands: [
      ...BASE.commands,
      { atTick: CUT_TICK, command: { type: 'RemoveRoad', cells: CUT_CELL } },
      { atTick: REPAIR_TICK, command: { type: 'PlaceRoad', cells: CUT_CELL, kind: 'one_way', dirs: ['W'] } },
    ],
  };
  const observed = observe(scenario, craneHoldsWhileStuck(CUT_TICK + 600));
  const { world, events } = observed;

  it('obe vozidlá po zásahu uviaznu v no_path', () => {
    const stuck = events.filter((entry) => entry.event.type === 'VehicleStateChanged' && entry.event.to === 'no_path' && entry.tick >= CUT_TICK && entry.tick < REPAIR_TICK);
    expect(new Set(stuck.map((entry) => (entry.event as { vehicleId: number }).vehicleId)).size).toBe(2);
  });

  it('kým je cesta prerušená, žeriav vykladá ďalej: jednotky vozidiel v no_path idú na apron (aspoň 2), nie je to jedna jednotka v ruke', () => {
    const window: [number, number] = [CUT_TICK, REPAIR_TICK];
    expect(moves(events, 'in_crane', 'on_apron', window)).toBeGreaterThanOrEqual(2);
    expect(moves(events, 'on_ship', 'in_crane', window)).toBeGreaterThanOrEqual(3);
  });

  it('po oprave siete sa všetko dokončí: kontrakt, 50 exportovaných jednotiek, žiadna stratená, invarianty sveta', () => {
    expect(world.contracts.get(1 as never)?.state).toBe('completed');
    expect(world.cargo.exportedCount).toBe(IMPORT_UNITS);
    expect(lostUnits(world)).toBe(0);
    expect([...world.vehicles.values()].map((vehicle) => vehicle.state)).toEqual(['parked', 'parked']);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('save uprostred prerušenia (žeriav drží jednotku, vozidlá v no_path): obnova dá zhodný stateHash aj výsledok', () => {
    expect(observed.saved?.tick).toBeGreaterThanOrEqual(CUT_TICK);
    expect(observed.saved?.tick).toBeLessThan(REPAIR_TICK);
    expectRoundtrip(observed, scenario);
  }, TIMEOUT_MS);
});
