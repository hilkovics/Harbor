/**
 * Vykládka pod hákom (predvolený buffer 0), keď vozidlo jobu nedôjde pod hák (F6d, T6D-05b, ADR-033 dodatok T6D-05): vozidlo v `no_path`
 * už nie je „na ceste k háku“ (`planUnload`) a žeriav jeho jednotku odloží na apron (`deliver`), odkiaľ ju vozidlo vezme na prístupovej
 * bunke kotviska — žeriav nedrží jednotku pre vozidlo, ktoré nikdy nepríde.
 *
 * - **Prerezaná cesta**: `vertical_slice`, `RemoveRoad` na trase vozidiel v ticku 7 900 (obe vozidlá preplánujú do `no_path`), oprava o 3 000 ticků
 *   neskôr. Pred opravou žeriav ostal v `placing` s prvou jednotkou a loď (77 jednotiek) sa nevykladala.
 * - **Jednosmerky popri nábreží**: kruh ciest okolo dvora je jednosmerný tak, že z cestných buniek pri nábreží sa na ňho nedá odbočiť
 *   (`isRoadStepAllowed`); prístupová bunka kotviska je dosiahnuteľná, bunka pod hákom nie — každá jednotka ide cez apron.
 * - Save v `no_path` uprostred cyklu: obnova dá zhodný `stateHash`.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { CraneModule } from '@sim/modules';
import { World, stateHash, type AnyWorldState } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { MAP, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario, type Scenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';

const BASE = loadScenarioFile('vertical_slice');
const TICKS = 30_000;
const IMPORT_UNITS = 78;
const TIMEOUT_MS = 120_000;

const cells = (points: readonly (readonly [number, number])[]): { x: number; y: number }[] => points.map(([x, y]) => ({ x, y }));

type Entries = { tick: number; event: SimEvent }[];

interface Observed {
  readonly world: World;
  readonly events: Entries;
  /** Najdlhší súvislý úsek ticků, v ktorých žeriav drží tú istú jednotku. */
  readonly longestHold: number;
  /** Prvý tick (≥ `saveFrom`), v ktorom žeriav drží jednotku v `placing` a nejaké vozidlo je v `no_path` — stav sa tu uloží. */
  readonly saved: { readonly tick: number; readonly state: AnyWorldState } | undefined;
}

/** Beh scenára s kontrolou konzervácie po každom ticku, udalosťami a uložením prvého stavu „žeriav drží jednotku, nejaké vozidlo je v `no_path`“. */
function observe(scenario: Scenario, saveFrom: number): Observed {
  const world = World.create(BUNDLED_DEFS, MAP, scenario.seed);
  const events: Entries = [];
  let heldUnit: number | null = null;
  let hold = 0;
  let longestHold = 0;
  let saved: Observed['saved'];
  runScenario(world, scenario, TICKS, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      for (const event of tickEvents) events.push({ tick: w.clock.tick, event });
      const crane = [...w.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
      hold = crane.heldUnitId !== null && crane.heldUnitId === heldUnit ? hold + 1 : 0;
      heldUnit = crane.heldUnitId;
      longestHold = Math.max(longestHold, hold);
      if (saved === undefined && w.clock.tick >= saveFrom && crane.state === 'placing' && heldUnit !== null) {
        if ([...w.vehicles.values()].some((vehicle) => vehicle.state === 'no_path')) saved = { tick: w.clock.tick, state: JSON.parse(JSON.stringify(w.serialize())) as AnyWorldState };
      }
    },
  });
  return { world, events, longestHold, saved };
}

const moves = (events: Entries, from: string, to: string, window: readonly [number, number] = [0, TICKS]): number =>
  events.filter((entry) => entry.event.type === 'CargoMoved' && entry.event.from.kind === from && entry.event.to.kind === to && entry.tick >= window[0] && entry.tick < window[1]).length;

/** Dokončenie po obnove v ticku uloženia: zhodný `stateHash` ako súvislý beh. */
function expectRoundtrip(observed: Observed, scenario: Scenario): void {
  expect(observed.saved, 'stav „žeriav drží jednotku, nejaké vozidlo je v no_path“ sa nenašiel').toBeDefined();
  const { state } = observed.saved as NonNullable<Observed['saved']>;
  const restored = World.deserialize(BUNDLED_DEFS, MAP, JSON.parse(JSON.stringify(state)) as AnyWorldState);
  runScenario(restored, scenario, TICKS);
  expect(stateHash(restored)).toBe(stateHash(observed.world));
  expect(restored.cargo.exportedCount).toBe(observed.world.cargo.exportedCount);
}

describe('prerezaná cesta počas vykládky (buffer 0): žeriav neuviazne na jednotke vozidla v no_path', () => {
  const CUT_TICK = 7_900;
  const REPAIR_TICK = 10_900;
  const CUT_CELL = [{ x: 44, y: 25 }];
  const scenario: Scenario = {
    ...BASE,
    commands: [
      ...BASE.commands,
      { atTick: CUT_TICK, command: { type: 'RemoveRoad', cells: CUT_CELL } },
      { atTick: REPAIR_TICK, command: { type: 'PlaceRoad', cells: CUT_CELL } },
    ],
  };
  const observed = observe(scenario, CUT_TICK + 600);
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

  it('po oprave siete sa všetko dokončí: kontrakt, 78 exportovaných jednotiek, žiadna stratená, invarianty sveta', () => {
    expect(world.contracts.get(1 as never)?.state).toBe('completed');
    expect(world.cargo.exportedCount).toBe(IMPORT_UNITS);
    expect(lostUnits(world)).toBe(0);
    expect([...world.vehicles.values()].map((vehicle) => vehicle.state)).toEqual(['idle', 'idle']);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('save uprostred prerušenia (žeriav drží jednotku, vozidlá v no_path): obnova dá zhodný stateHash aj výsledok', () => {
    expect(observed.saved?.tick).toBeGreaterThanOrEqual(CUT_TICK);
    expect(observed.saved?.tick).toBeLessThan(REPAIR_TICK);
    expectRoundtrip(observed, scenario);
  }, TIMEOUT_MS);
});

describe('jednosmerky popri nábreží: prístupová bunka kotviska je dosiahnuteľná, bunka pod hákom nie', () => {
  /**
   * Kruh okolo dvora: stĺpec x = 41 smerom na juh, riadok y = 17 smerom na západ, stĺpec x = 46 smerom na sever; riadok y = 22 a jeho rohy
   * ostávajú obojsmerné (vstup z depa (44, 22)). Z bunky jednosmerky sa vychádza len v jej smere, takže zo žiadnej cestnej bunky pri nábreží
   * (y = 17) sa nedá odbočiť na sever do bunky pod hákom (43, 16); prístupové bunky konektorov kotviska (41, 17) a (46, 17) sú cieľom jazdy.
   */
  const ring = [
    { atTick: 0, command: { type: 'PlaceRoad', cells: cells([[41, 17], [41, 18], [41, 19], [41, 20], [41, 21]]), kind: 'one_way', dirs: ['S', 'S', 'S', 'S', 'S'] } },
    { atTick: 0, command: { type: 'PlaceRoad', cells: cells([[41, 22]]) } },
    { atTick: 0, command: { type: 'PlaceRoad', cells: cells([[46, 21], [46, 20], [46, 19], [46, 18]]), kind: 'one_way', dirs: ['N', 'N', 'N', 'N'] } },
    { atTick: 0, command: { type: 'PlaceRoad', cells: cells([[46, 22]]) } },
    { atTick: 0, command: { type: 'PlaceRoad', cells: cells([[46, 17], [45, 17], [44, 17], [43, 17], [42, 17]]), kind: 'one_way', dirs: ['W', 'W', 'W', 'W', 'W'] } },
    { atTick: 0, command: { type: 'PlaceRoad', cells: cells([[42, 22], [43, 22], [44, 22], [45, 22]]) } },
  ] as unknown as Scenario['commands'];
  const scenario: Scenario = { ...BASE, commands: [...ring, ...BASE.commands.slice(4)] };
  const observed = observe(scenario, 0);
  const { world, events } = observed;

  it('každé vozidlo jobu vykládky uviazne v no_path (k háku nevedie cesta) a žeriav všetko odloží na apron; nikdy nie priamo na vozidlo', () => {
    expect(events.some((entry) => entry.event.type === 'VehicleStateChanged' && entry.event.to === 'no_path')).toBe(true);
    expect(moves(events, 'in_crane', 'in_vehicle')).toBe(0);
    expect(moves(events, 'in_crane', 'on_apron')).toBe(IMPORT_UNITS);
    expect(moves(events, 'on_apron', 'in_vehicle')).toBeGreaterThanOrEqual(IMPORT_UNITS); // vozidlo ich berie z apronu na prístupovej bunke
  });

  it('žeriav nezamrzne: žiadnu jednotku nedrží dlhšie než 500 ticků (nameraných 150 — čakanie na voľné vozidlo; bez opravy držal prvú jednotku do konca behu)', () => {
    expect(observed.longestHold).toBeLessThan(500);
  });

  it('všetko sa dokončí: kontrakt, 78 exportovaných jednotiek, žiadna stratená, invarianty sveta', () => {
    expect(world.contracts.get(1 as never)?.state).toBe('completed');
    expect(world.cargo.exportedCount).toBe(IMPORT_UNITS);
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('save v no_path uprostred cyklu: obnova dá zhodný stateHash aj výsledok', () => {
    expectRoundtrip(observed, scenario);
  }, TIMEOUT_MS);
});
