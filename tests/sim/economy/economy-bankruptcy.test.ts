/**
 * Bankrot (T05-05, TDD; „Rozhodnutia orchestrátora" 3; ARCHITECTURE §9.2): `cash < 0` pri `DayClosed` počas
 * `bankruptcyDays` (30) dní za sebou → udalosť `GameOver { reason: 'bankruptcy', day }`, flag `world.gameOver` a sim sa
 * ďalej netickuje (hodiny stoja), príkazy vracajú `game_over`. Hotovosť presne 0 nie je záporná; návrat do plusu
 * počítadlo vynuluje.
 *
 * Svet: starter prístav (berth + žeriav), údržba 210 000 + mzda žeriava 25 000 = 235 000 za deň; `startingCashCents`
 * sa v defoch prepíše, aby hotovosť klesla pod nulu.
 *
 * Predpoklady o API:
 *  B1 `economy.daysNegative` sa aktualizuje pri `DayClosed` (po zápise údržby a miezd): `cash < 0` → +1, inak 0;
 *  B2 pri dosiahnutí `bankruptcyDays` v tom istom ticku `GameOver`, `world.gameOver = true`; ďalší `world.tick()` nič
 *     nezmení (vráti prázdne pole, `clock.tick` sa nehýbe);
 *  B3 `validate` každého príkazu vráti dôvod `game_over`; `applyPending()` ho odmietne s `CommandRejected`;
 *  B4 `daysNegative` aj `gameOver` sú súčasťou uloženého stavu (save/load nezmení dobu do bankrotu).
 */
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { World, type WorldState } from '@sim/world';
import { emptyScenario, must } from '../helpers/harbor';
import { stateHash } from '../helpers/scenario';
import {
  DEFS as BUNDLED,
  MAP,
  Run5,
  TICKS_PER_DAY,
  acceptContract,
  cashOf,
  commandReasons,
  declineContract,
  defsWith,
  economyOf,
  events5,
  gameOverOf,
  tickWorld,
} from '../helpers/f5';

const DAILY_COST = 235_000;
const BANKRUPTCY_DAYS = BUNDLED.economy.bankruptcyDays;
const LONG_TIMEOUT_MS = 300_000;
const BROKE = defsWith({ economy: { startingCashCents: 0 } });

interface Snapshot {
  readonly tick: number;
  readonly cash: number;
  readonly daysNegative: number;
  readonly gameOver: boolean;
}

describe('bankrot: 30 dní za sebou v mínuse', () => {
  it('stráž: bankruptcyDays = 30 a denný náklad starter prístavu 235 000', () => {
    expect(BANKRUPTCY_DAYS).toBe(30);
    expect(BROKE.economy.startingCashCents).toBe(0);
  });

  it('počítadlo daysNegative rastie pri každom DayClosed (1, 2, 3, …) a GameOver príde presne pri 30. uzávierke', () => {
    const world = World.create(BROKE, MAP, 5701);
    const snapshots: Snapshot[] = [];
    const run = new Run5(world, emptyScenario('f5_bankruptcy', 5701), {
      onTick: (_self, tickEvents) => {
        if (tickEvents.some((event) => event.type === 'DayClosed')) {
          snapshots.push({ tick: world.clock.tick, cash: cashOf(world), daysNegative: economyOf(world).daysNegative, gameOver: gameOverOf(world) });
        }
      },
    });
    run.runTo((BANKRUPTCY_DAYS + 5) * TICKS_PER_DAY);

    expect(snapshots).toHaveLength(BANKRUPTCY_DAYS);
    snapshots.forEach((snapshot, index) => {
      const day = index + 1;
      expect(snapshot.tick, `uzávierka ${String(day)}`).toBe(day * TICKS_PER_DAY);
      expect(snapshot.cash, `uzávierka ${String(day)}`).toBe(-day * DAILY_COST);
      expect(snapshot.daysNegative, `uzávierka ${String(day)}`).toBe(day);
      expect(snapshot.gameOver, `uzávierka ${String(day)}`).toBe(day === BANKRUPTCY_DAYS);
    });

    const over = events5(run.events, 'GameOver');
    expect(over).toHaveLength(1);
    const entry = must(over[0], 'GameOver');
    expect(entry.tick).toBe(BANKRUPTCY_DAYS * TICKS_PER_DAY);
    expect(entry.event.reason).toBe('bankruptcy');
    expect(Number.isInteger(entry.event.day)).toBe(true);
    expect(gameOverOf(world)).toBe(true);
    expect(run.violations).toEqual([]);
  }, LONG_TIMEOUT_MS);

  it('po GameOver sa sim netickuje: hodiny stoja, žiadne udalosti, hotovosť sa nemení; príkazy vracajú game_over', () => {
    const world = World.create(BROKE, MAP, 5702);
    const run = new Run5(world, emptyScenario('f5_bankruptcy_stop', 5702));
    run.runTo((BANKRUPTCY_DAYS + 1) * TICKS_PER_DAY);
    expect(gameOverOf(world)).toBe(true);
    const frozenTick = world.clock.tick;
    expect(frozenTick).toBe(BANKRUPTCY_DAYS * TICKS_PER_DAY);
    const frozenCash = cashOf(world);
    const daily = economyOf(world).daily.length;

    for (let i = 0; i < 50; i++) expect(world.tick(), `tick ${String(i)} po GameOver`).toEqual([]);
    expect(world.clock.tick).toBe(frozenTick);
    expect(cashOf(world)).toBe(frozenCash);
    expect(economyOf(world).daily).toHaveLength(daily);

    for (const command of [{ type: 'PlaceRoad', cells: [{ x: 41, y: 17 }] }, acceptContract(1), declineContract(1)]) {
      expect(commandReasons(world, command), command.type).toContain('game_over');
    }
    world.enqueue(commandFromJSON({ type: 'PlaceRoad', cells: [{ x: 41, y: 17 }] }));
    const rejected = world.applyPending().flatMap((event) => (event.type === 'CommandRejected' ? [event] : []));
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reasons).toContain('game_over');
    expect(cashOf(world)).toBe(frozenCash);
  }, LONG_TIMEOUT_MS);

  it('hotovosť presne 0 nie je záporná: počítadlo sa nezvýši; o deň neskôr (−235 000) začne od 1', () => {
    const defs = defsWith({ economy: { startingCashCents: DAILY_COST } });
    const world = World.create(defs, MAP, 5703);
    tickWorld(world, TICKS_PER_DAY);
    expect(cashOf(world)).toBe(0);
    expect(economyOf(world).daysNegative).toBe(0);
    tickWorld(world, TICKS_PER_DAY);
    expect(cashOf(world)).toBe(-DAILY_COST);
    expect(economyOf(world).daysNegative).toBe(1);
    expect(gameOverOf(world)).toBe(false);
  });

  it('návrat do plusu vynuluje počítadlo a bankrot nenastane ani po ďalších 40 dňoch', () => {
    const world = World.create(BROKE, MAP, 5704);
    tickWorld(world, 3 * TICKS_PER_DAY);
    expect(economyOf(world).daysNegative).toBe(3);
    economyOf(world).post(100_000_000, 'contract_revenue');
    expect(cashOf(world)).toBe(100_000_000 - 3 * DAILY_COST);
    tickWorld(world, TICKS_PER_DAY);
    expect(economyOf(world).daysNegative).toBe(0);
    tickWorld(world, 39 * TICKS_PER_DAY);
    expect(economyOf(world).daysNegative).toBe(0);
    expect(gameOverOf(world)).toBe(false);
    expect(cashOf(world)).toBeGreaterThan(0);
  }, LONG_TIMEOUT_MS);

  it('save/load uprostred: počítadlo aj GameOver prežijú, obnovený svet skončí v rovnakom ticku s rovnakým stavom', () => {
    const original = World.create(BROKE, MAP, 5705);
    tickWorld(original, 5 * TICKS_PER_DAY);
    expect(economyOf(original).daysNegative).toBe(5);
    const saved = JSON.parse(JSON.stringify(original.serialize())) as WorldState;
    const clone = World.deserialize(BROKE, MAP, saved);
    expect(economyOf(clone).daysNegative).toBe(5);
    expect(cashOf(clone)).toBe(cashOf(original));
    expect(stateHash(clone)).toBe(stateHash(original));

    for (const world of [original, clone]) {
      while (!gameOverOf(world)) tickWorld(world, TICKS_PER_DAY);
    }
    expect(clone.clock.tick).toBe(original.clock.tick);
    expect(original.clock.tick).toBe(BANKRUPTCY_DAYS * TICKS_PER_DAY);
    expect(stateHash(clone)).toBe(stateHash(original));

    const afterGameOver = World.deserialize(BROKE, MAP, JSON.parse(JSON.stringify(original.serialize())) as WorldState);
    expect(gameOverOf(afterGameOver)).toBe(true);
    expect(afterGameOver.tick()).toEqual([]);
  }, LONG_TIMEOUT_MS);
});
