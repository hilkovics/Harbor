/**
 * WorldState v9 (T6D-01, ADR-035; ARCHITECTURE §14): migrácia v8 → v9 nad natívnym savom v8 (`save-v8.json` — `landside_pressure` v ticku 24 000,
 * vznikol **kódom v8** pred zmenou tvaru: v prístave kamión `collect` a kamión `delivery` čakajú v stojisku, plán návratov prázdnych má 22 položiek),
 * roundtrip v9 s počítadlami vnútrozemia a fail-fast cesty nového poľa.
 *
 * 1. Migrácia je deterministická a bez `Rng`: svet dostane `hinterland` s nulovými počítadlami, ostatné polia ostanú bajtovo rovnaké.
 * 2. Zhodenie späť (`toV8State`) dá z načítaného sveta **pôvodný text** natívneho v8 savu (migrácia nič nezahodila ani nepridala).
 * 3. Migrovaný svet beží ďalej pod pravidlami v9 (kamióny v prístave ostávajú, splatné položky plánov sú od teraz čakajúce kamióny vo vnútrozemí) bez straty
 *    jednotiek (konzervácia po každom ticku) a počítadlá vnútrozemia sa po načítaní správne plnia.
 * 4. Poškodené `hinterland` → `WorldStateError` s JSON pointerom.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { World, WorldStateError, hinterlandQueue, migrateWorldState, type AnyWorldState, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { toV8State } from '../helpers/legacy-save';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS, MAP } from './world-fixtures';

type Json = Record<string, unknown>;

const FIXTURE_DIR = fileURLToPath(new URL('../__fixtures__/saves/', import.meta.url));
const V8_TEXT = readFileSync(`${FIXTURE_DIR}save-v8.json`, 'utf8');
const V8 = JSON.parse(V8_TEXT) as Json;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const asState = (raw: unknown): AnyWorldState => raw as AnyWorldState;
const CONTINUE_TICKS = 6_000;
const HEAVY_TIMEOUT_MS = 180_000;
const ZERO_WAIT = { admitted: 0, waitTicksTotal: 0, waitTicksMax: 0, turnedAway: 0 };

function loadError(raw: unknown): WorldStateError {
  try {
    World.deserialize(DEFS, MAP, asState(raw));
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw new Error(`očakávaná WorldStateError, dostal ${String(error)}`, { cause: error });
  }
  throw new Error('načítanie poškodeného savu nevyhodilo chybu');
}

describe('migrácia save v8 → v9 (ADR-035)', () => {
  it('fixture je natívny v8: verzia 8, bez hinterland, kamióny v prístave a splatný plán prázdnych', () => {
    expect(V8['version']).toBe(8);
    expect(V8).not.toHaveProperty('hinterland');
    const trucks = (V8['trucks'] as Json[]).map((truck) => `${String(truck['mission'])}:${String(truck['state'])}`).sort();
    expect(trucks).toEqual(['collect:waiting', 'delivery:waiting']);
    const flow = V8['emptyFlow'] as { returnPlan: { dueTick: number }[]; errands: unknown[] };
    expect(flow.returnPlan.length).toBeGreaterThan(10);
    expect(flow.returnPlan.some((entry) => entry.dueTick <= (V8['clock'] as { tick: number }).tick + 1_000)).toBe(true);
    expect(flow.errands).toHaveLength(1);
  });

  it('migrateWorldState: nulové počítadlá vnútrozemia (len pole hinterland sa pridá), Rng a vstup bez zmeny', () => {
    const before = clone(V8);
    const migrated = migrateWorldState(V8, DEFS) as Json;
    expect(V8).toEqual(before);
    expect(migrated['version']).toBe(9);
    expect(migrated['hinterland']).toEqual({ delivery: ZERO_WAIT, collect: ZERO_WAIT, pickupBayStarvationTicks: 0 });
    // pole vnútrozemia je jediná zmena tejto migrácie: obsah kamiónov, plánov a nákladu zo savu ostáva (iné zmeny tvaru v9 sa overujú vlastnými testami)
    for (const key of ['rng', 'trucks', 'emptyFlow', 'cargo', 'contracts']) expect(migrated[key], key).toEqual(V8[key]);
  });

  it('načítaný svet: serialize() je v9, zhodenie späť dá pôvodný text natívneho v8, roundtrip je idempotentný a invarianty držia', () => {
    const world = World.deserialize(DEFS, MAP, asState(clone(V8)));
    world.assertInvariants();
    const state = world.serialize();
    expect(state.version).toBe(9);
    expect(JSON.stringify(toV8State(state))).toBe(V8_TEXT);
    expect(JSON.stringify(World.deserialize(DEFS, MAP, clone(state)).serialize())).toBe(JSON.stringify(state));
    // pohľad pre UI (splatné položky plánov = čakajúce kamióny vo vnútrozemí) funguje hneď po načítaní; v ticku save nie je nič splatné
    const queue = hinterlandQueue(world);
    expect(queue.total).toBe(queue.pickup + queue.delivery + queue.collect);
    expect([queue.delivery, queue.collect, queue.oldestWaitTicks]).toEqual([0, 0, 0]);
  });

  it(
    `migrovaný v8 beží ďalej pod pravidlami v9 (${String(CONTINUE_TICKS)} tickov): konzervácia po každom ticku, bez straty jednotiek, počítadlá vnútrozemia rastú`,
    () => {
      const scenario = loadScenarioFile('landside_pressure');
      const world = World.deserialize(DEFS, MAP, asState(clone(V8)));
      const start = world.clock.tick;
      runScenario(world, scenario, start + CONTINUE_TICKS, { afterTick: (w) => assertCargoConservation(w) });
      expect(world.clock.tick).toBe(start + CONTINUE_TICKS);
      expect(world.cargo.createdCount - (world.cargo.liveCount + world.cargo.exportedCount + world.cargo.shippedCount)).toBe(0);
      const { hinterland } = world;
      // splatné návraty prázdnych z plánu (22 položiek v save) sa vpustili cez vnútrozemie
      expect(hinterland.admitted('delivery')).toBeGreaterThan(0);
      // uložený a znovu načítaný stav po behu je rovnaký (počítadlá sú v save)
      const saved = world.serialize();
      expect(saved.hinterland).toEqual(hinterland.getState());
      expect(JSON.stringify(World.deserialize(DEFS, MAP, clone(saved)).serialize())).toBe(JSON.stringify(saved));
    },
    HEAVY_TIMEOUT_MS,
  );
});

describe('WorldState v9: počítadlá vnútrozemia v save', () => {
  const base = (): WorldState => clone(World.deserialize(DEFS, MAP, asState(clone(V8))).serialize());
  const WITH_COUNTS = {
    delivery: { admitted: 3, waitTicksTotal: 90, waitTicksMax: 50, turnedAway: 1 },
    collect: { admitted: 2, waitTicksTotal: 10, waitTicksMax: 10, turnedAway: 4 },
    pickupBayStarvationTicks: 123,
  };

  it('nenulové počítadlá sa načítajú a roundtrip dá rovnaký stav', () => {
    const state: WorldState = { ...base(), hinterland: WITH_COUNTS };
    const world = World.deserialize(DEFS, MAP, clone(state));
    expect(world.hinterland.admitted('delivery')).toBe(3);
    expect(world.hinterland.waitTicksTotal('delivery')).toBe(90);
    expect(world.hinterland.waitTicksMax('collect')).toBe(10);
    expect(world.hinterland.turnedAway('collect')).toBe(4);
    expect(world.hinterland.pickupBayStarvationTicks).toBe(123);
    expect(JSON.stringify(world.serialize())).toBe(JSON.stringify(state));
  });

  const CORRUPTIONS: readonly [string, (state: WorldState) => unknown, string][] = [
    ['chýba hinterland', (s) => ({ ...s, hinterland: undefined }), '/hinterland'],
    ['hinterland nie je objekt', (s) => ({ ...s, hinterland: 3 }), '/hinterland'],
    ['neznámy kľúč', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, extra: 1 } }), '/hinterland/extra'],
    ['chýba misia collect', (s) => ({ ...s, hinterland: { delivery: WITH_COUNTS.delivery, pickupBayStarvationTicks: 0 } }), '/hinterland/collect'],
    ['záporné vpustené', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, delivery: { ...WITH_COUNTS.delivery, admitted: -1 } } }), '/hinterland/delivery/admitted'],
    ['neceločíselné čakanie', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, collect: { ...WITH_COUNTS.collect, waitTicksTotal: 1.5 } } }), '/hinterland/collect/waitTicksTotal'],
    ['maximum nad súčtom', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, delivery: { ...WITH_COUNTS.delivery, waitTicksMax: 91 } } }), '/hinterland/delivery/waitTicksMax'],
    ['čakanie bez vpustených', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, collect: { admitted: 0, waitTicksTotal: 5, waitTicksMax: 5, turnedAway: 0 } } }), '/hinterland/collect/waitTicksTotal'],
    ['záporné ticky nedostatku', (s) => ({ ...s, hinterland: { ...WITH_COUNTS, pickupBayStarvationTicks: -2 } }), '/hinterland/pickupBayStarvationTicks'],
  ];

  it.each(CORRUPTIONS)('%s → WorldStateError s cestou', (_name, corrupt, path) => {
    expect(loadError(clone(corrupt(base()))).path).toBe(path);
  });

  it('v8 s kľúčom v9 (hinterland) → WorldStateError na /hinterland (tvar v8)', () => {
    expect(loadError({ ...clone(V8), hinterland: WITH_COUNTS }).path).toBe('/hinterland');
  });

  it('toV8State zahodí počítadlá (v8 ich nepozná) a odmietne inú verziu než 9', () => {
    const v8 = toV8State({ ...base(), hinterland: WITH_COUNTS });
    expect(v8['version']).toBe(8);
    expect(v8).not.toHaveProperty('hinterland');
    expect(() => toV8State({ ...base(), version: 8 })).toThrow(/čaká sa 9/);
  });
});
