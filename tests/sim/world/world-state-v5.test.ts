/**
 * WorldState v5 (T05-05, TDD; „Rozhodnutia orchestrátora" 11, 12; ARCHITECTURE §14): v5 = v4 + `contracts`, pool,
 * `economy` (DaySummary/MonthSummary, posledných `ledgerEntriesKept` záznamov ledgera), `xp`, `completedContracts`,
 * bankrotové počítadlo a `gameOver`. Migrácia v4 → v5 dá prázdne kontrakty a pool a prázdny ledger so zachovaným
 * `cashCents`. Priority dispatchera sa neukladajú (odvodzujú sa).
 *
 * Predpoklady o API:
 *  W1 `WORLD_STATE_VERSION === 5`; `serialize()` vracia `version: 5` a čistý JSON;
 *  W2 `World.deserialize` prijme stav v4 (kľúče `WORLD_STATE_V4_KEYS`, `version: 4`, `cashCents` na vrchu) a prevedie ho
 *     migráciou; nový svet má prázdne kontrakty, ledger, súhrny a nulové XP/tier, ale pôvodnú hotovosť a náklad;
 *  W3 pool po migrácii je hneď po načítaní prázdny (obnova nespotrebuje `Rng`) a doplní sa v kroku 2 prvého ticku po
 *     načítaní ako pri štarte hry — kniha, ktorá ešte nepridelila žiadne id kontraktu (T06-07, BACKLOG P2 „Pool po
 *     načítaní v4"); predtým až pri najbližšom `DayClosed`;
 *  W4 náklad bez kontraktu (`contractId === null`, staré uloženia a `SpawnShipDebug`) sa exportuje aj po migrácii.
 */
import { describe, expect, it } from 'vitest';
import { World, WORLD_STATE_V4_KEYS, WORLD_STATE_VERSION, type WorldState } from '@sim/world';
import { STRADDLES } from '../helpers/f4';
import { f4Scenario } from '../helpers/f4-layout';
import { runScenario } from '../helpers/scenario';
import {
  DEFS,
  MAP,
  Run5,
  TICKS_PER_DAY,
  cashOf,
  completedOf,
  contractList,
  economyOf,
  events5,
  gameOverOf,
  lostUnits,
  offeredContracts,
  tierOf,
  xpOf,
} from '../helpers/f5';

const UNITS = 12;
/** V ticku 600 je z 12 TEU sedem v sklade a zvyšok na ceste (scenár `f4Scenario` s vlastnou loďou). */
const MID_TICK = 600;
const scenario = f4Scenario('f5_migration', 4004, { vehicles: STRADDLES, units: UNITS });
const RUN_TIMEOUT_MS = 300_000;

describe('WorldState v5', () => {
  it('WORLD_STATE_VERSION je 9 (v5 + trasa lode ADR-029 + export ADR-032 + prázdne kontajnery ADR-034 + vnútrozemie ADR-035) a serialize() vracia verziu 9 ako čistý JSON', () => {
    expect(WORLD_STATE_VERSION).toBe(9);
    const world = World.create(DEFS, MAP, 5901);
    world.tick();
    const state = world.serialize();
    expect(state.version).toBe(9);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('roundtrip čerstvého sveta s poolom: rovnaké kontrakty, ekonomika a ďalší beh', () => {
    const world = World.create(DEFS, MAP, 5902);
    world.tick();
    const clone = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
    expect(JSON.stringify(contractList(clone))).toBe(JSON.stringify(contractList(world)));
    expect(cashOf(clone)).toBe(cashOf(world));
    for (let i = 0; i < 2 * TICKS_PER_DAY; i++) {
      world.tick();
      clone.tick();
    }
    expect(JSON.stringify(clone.serialize())).toBe(JSON.stringify(world.serialize()));
    expect(offeredContracts(clone)).toHaveLength(DEFS.economy.offersPerDay);
  }, RUN_TIMEOUT_MS);
});

describe('migrácia WorldState v4 → v5', () => {
  function legacyV4(): { readonly plain: World; readonly v4: Record<string, unknown> } {
    const plain = World.create(DEFS, MAP, scenario.seed);
    runScenario(plain, scenario, MID_TICK);
    expect(plain.cargo.liveCount, 'uprostred reťaze má byť náklad na mape').toBeGreaterThan(0);
    const current = JSON.parse(JSON.stringify(plain.serialize())) as Record<string, unknown>;
    // Polia v5 navyše sa zahodia: to, čo zostane, je tvar v4 (hotovosť ako `cashCents` na vrchu).
    const v4 = Object.fromEntries(WORLD_STATE_V4_KEYS.map((key) => [key, current[key]]));
    v4['version'] = 4;
    v4['cashCents'] = cashOf(plain);
    return { plain, v4 };
  }

  it('uložená hra v4 sa načíta: hotovosť a náklad zostanú, kontrakty, pool, ledger, XP a tier sú prázdne, hra beží', () => {
    const { plain, v4 } = legacyV4();
    const migrated = World.deserialize(DEFS, MAP, v4 as unknown as WorldState);

    expect(cashOf(migrated)).toBe(cashOf(plain));
    expect(economyOf(migrated).entries).toEqual([]);
    expect(economyOf(migrated).daily).toEqual([]);
    expect(economyOf(migrated).monthly).toEqual([]);
    expect(economyOf(migrated).daysNegative).toBe(0);
    expect(economyOf(migrated).todayDeltaCents()).toBe(0);
    expect(contractList(migrated)).toEqual([]);
    expect(xpOf(migrated)).toBe(0);
    expect(completedOf(migrated)).toBe(0);
    expect(tierOf(migrated)).toBe(0);
    expect(gameOverOf(migrated)).toBe(false);

    const saved = migrated.serialize();
    expect(saved.version).toBe(9);
    const savedRecord = saved as unknown as Record<string, unknown>;
    const plainRecord = plain.serialize() as unknown as Record<string, unknown>;
    expect(JSON.stringify(savedRecord['cargo'])).toBe(JSON.stringify(plainRecord['cargo']));
    expect(JSON.stringify(savedRecord['modules'])).toBe(JSON.stringify(plainRecord['modules']));
    expect(JSON.stringify(savedRecord['vehicles'])).toBe(JSON.stringify(plainRecord['vehicles']));
    expect(() => migrated.assertInvariants()).not.toThrow();
  });

  it('pool z v4 sa doplní v prvom ticku po načítaní ako pri štarte hry (T06-07): obnova nespotrebuje Rng, save pred prvým tickom ho nestratí', () => {
    const { v4 } = legacyV4();
    const migrated = World.deserialize(DEFS, MAP, v4 as unknown as WorldState);
    expect(migrated.rng.getState()).toEqual(v4['rng']);
    expect(offeredContracts(migrated)).toEqual([]);
    // Save hneď po načítaní (hra po načítaní stojí, ADR-030) — pool sa doplní aj po jeho obnove.
    const resaved = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(migrated.serialize())) as WorldState);
    const first = migrated.tick();
    resaved.tick();
    const offered = first.filter((event) => event.type === 'ContractOffered');
    expect(offered).toHaveLength(DEFS.economy.offersPerDay);
    expect(offeredContracts(migrated).map((contract) => [contract.id, contract.offeredTick])).toEqual(
      offered.map((_event, i) => [i + 1, MID_TICK + 1]),
    );
    expect(migrated.rng.getState()).not.toEqual(v4['rng']);
    expect(JSON.stringify(resaved.serialize())).toBe(JSON.stringify(migrated.serialize()));
    // Ďalší tick pool nedopĺňa (kniha už id pridelila); ďalšie doplnenie až pri DayClosed.
    expect(migrated.tick().filter((event) => event.type === 'ContractOffered')).toEqual([]);
  });

  it('náklad bez kontraktu z v4 sa po migrácii dostane až na export (12 TEU), lostUnits 0; pool je plný od prvého ticku', () => {
    const { v4 } = legacyV4();
    const migrated = World.deserialize(DEFS, MAP, v4 as unknown as WorldState);
    const startCash = cashOf(migrated);
    const run = new Run5(migrated, scenario, { checkCounters: false });
    run.runTo(migrated.clock.tick + 10);
    expect(offeredContracts(migrated), 'pool sa doplní v prvom ticku po načítaní').toHaveLength(DEFS.economy.offersPerDay);
    expect(events5(run.events, 'ContractOffered')).toHaveLength(DEFS.economy.offersPerDay);
    run.runUntil((w) => w.cargo.exportedCount === UNITS, 30_000);
    expect(lostUnits(migrated)).toBe(0);
    expect(migrated.cargo.exportedCount).toBe(UNITS);
    expect(contractList(migrated).every((contract) => contract.state === 'offered' || contract.state === 'expired')).toBe(true);

    run.runTo(Math.ceil((migrated.clock.tick + 1) / TICKS_PER_DAY) * TICKS_PER_DAY);
    expect(offeredContracts(migrated)).toHaveLength(DEFS.economy.offersPerDay);
    expect(cashOf(migrated)).toBeLessThan(startCash);
    expect(run.violations).toEqual([]);
    expect(run.ticksChecked).toBe(migrated.clock.tick - MID_TICK);
  }, RUN_TIMEOUT_MS);
});
