// EconomySystem — krok 9 (T05-02, ARCHITECTURE §6, §9.2, ADR-025): pri DayClosed údržba všetkých modulov, mzdy vozidiel
// a žeriavov, DaySummary a bankrotové počítadlo; pri MonthClosed MonthlyReport; po GameOver svet netickuje systémy.
// Mení tok peňazí → aj scenárové časti (apron_to_yard s modulmi a vozidlami, bankrot, save/load cez uzavretie dňa).
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { DefRegistry, craneParams } from '@sim/defs';
import type { SimEvent, SimEventOf } from '@sim/events';
import { World, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile } from '../helpers/scenario';
import { setCash } from '../helpers/economy';
import { BARE_MAP, DEFS, MAP, RAW_DEFS, SEED, hashState, runTicks } from '../world/world-fixtures';

const TICKS_PER_DAY = World.create(DEFS, MAP, SEED).clock.ticksPerDay;
const CRANE_WAGE = craneParams(DEFS.modules.get('crane_container_gantry')).wagePerDayCents;
const STRADDLE_WAGE = DEFS.vehicles.get('straddle_carrier').wagePerDayCents;
const STARTER_MAINTENANCE = MAP.starter.modules.reduce((sum, spec) => sum + DEFS.modules.get(spec.defId).maintenancePerDayCents, 0);

/** Udalosti ticku daného typu. */
function ofType<T extends SimEvent['type']>(events: readonly SimEvent[], type: T): SimEventOf<T>[] {
  return events.filter((event): event is SimEventOf<T> => event.type === type);
}

/** Dotickuje svet tesne pred hranicu dňa a vráti udalosti ticku, ktorý deň uzavrie. */
function closeNextDay(world: World): readonly SimEvent[] {
  const boundary = (Math.floor(world.clock.tick / TICKS_PER_DAY) + 1) * TICKS_PER_DAY;
  runTicks(world, boundary - world.clock.tick - 1);
  return world.tick();
}

/** Defy s upraveným `economy.json`. */
function defsWithEconomy(overrides: Record<string, unknown>): DefRegistry {
  return DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, ...overrides } });
}

describe('EconomySystem — mimo uzavretia dňa', () => {
  it('tick bez DayClosed ekonomiku nemení (žiadny pohyb, žiadna udalosť kroku 9)', () => {
    const world = World.create(DEFS, MAP, SEED);
    const events: SimEvent[] = [];
    for (let i = 0; i < TICKS_PER_DAY - 1; i++) events.push(...world.tick());
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents);
    expect(world.economy.entries).toEqual([]);
    expect(events.filter((event) => ['MoneyChanged', 'DayClosedSummary', 'MonthlyReport', 'GameOver'].includes(event.type))).toEqual([]);
  });
});

describe('EconomySystem — DayClosed', () => {
  it('nová hra: údržba starter modulov (Root berth + žeriav) a mzda žeriava, potom DaySummary dňa 0', () => {
    const world = World.create(DEFS, MAP, SEED);
    const events = closeNextDay(world);
    const tick = TICKS_PER_DAY;
    const start = DEFS.economy.startingCashCents;
    expect([STARTER_MAINTENANCE, CRANE_WAGE]).toEqual([210_000, 25_000]);
    // Za DayClosed idú najprv booking ponuky poolu (krok 2, F6a), potom krok 9 (údržba, mzdy, súhrn).
    const afterDay = events.slice(events.findIndex((event) => event.type === 'DayClosed') + 1);
    const economyEvents = afterDay.filter((event) => event.type !== 'ContractOffered');
    expect(afterDay.slice(0, afterDay.length - economyEvents.length).every((event) => event.type === 'ContractOffered')).toBe(true);
    expect(economyEvents).toEqual([
      { type: 'MoneyChanged', cashCents: start - 210_000, deltaCents: -210_000, reason: 'maintenance' },
      { type: 'MoneyChanged', cashCents: start - 235_000, deltaCents: -25_000, reason: 'wages' },
      {
        type: 'DayClosedSummary',
        day: 0,
        summary: { day: 0, incomeCents: {}, expenseCents: { maintenance: 210_000, wages: 25_000 }, cashEndCents: start - 235_000 },
      },
    ]);
    expect(world.economy.entries).toEqual([
      { tick, amountCents: -210_000, category: 'maintenance' },
      { tick, amountCents: -25_000, category: 'wages' },
    ]);
    expect(world.economy.daily).toHaveLength(1);
    expect(world.economy.todayDeltaCents()).toBe(0);
    expect(world.economy.daysNegative).toBe(0);
  });

  it('svet bez modulov a vozidiel: žiadny MoneyChanged, DaySummary s prázdnymi súčtami', () => {
    const world = World.create(DEFS, BARE_MAP, SEED);
    const events = closeNextDay(world);
    expect(ofType(events, 'MoneyChanged')).toEqual([]);
    expect(ofType(events, 'DayClosedSummary')).toEqual([
      { type: 'DayClosedSummary', day: 0, summary: { day: 0, incomeCents: {}, expenseCents: {}, cashEndCents: DEFS.economy.startingCashCents } },
    ]);
  });

  it('DaySummary obsahuje aj pohyby príkazov dňa (CAPEX) a cashEnd sedí so zostatkom', () => {
    const world = World.create(DEFS, MAP, SEED);
    world.enqueue(commandFromJSON({ type: 'PlaceRoad', cells: [{ x: 35, y: 23 }, { x: 36, y: 23 }] }));
    const events = closeNextDay(world);
    const road = 2 * DEFS.infrastructure.road.costPerCellCents;
    const [summary] = ofType(events, 'DayClosedSummary');
    expect(summary.summary.expenseCents).toEqual({ road_capex: road, maintenance: STARTER_MAINTENANCE, wages: CRANE_WAGE });
    expect(summary.summary.cashEndCents).toBe(world.cashCents);
    expect(world.cashCents).toBe(DEFS.economy.startingCashCents - road - STARTER_MAINTENANCE - CRANE_WAGE);
  });

  it('príkaz aplikovaný v ticku za hranicou dňa patrí do nasledujúceho dňa', () => {
    const world = World.create(DEFS, MAP, SEED);
    closeNextDay(world);
    world.enqueue(commandFromJSON({ type: 'PlaceRoad', cells: [{ x: 35, y: 23 }] }));
    world.tick();
    expect(world.economy.daily[0].expenseCents).toEqual({ maintenance: STARTER_MAINTENANCE, wages: CRANE_WAGE });
    expect(world.economy.openDay().expenseCents).toEqual({ road_capex: DEFS.infrastructure.road.costPerCellCents });
    expect(world.economy.todayDeltaCents()).toBe(-DEFS.infrastructure.road.costPerCellCents);
  });

  it('scenár apron_to_yard: údržba všetkých postavených modulov (vrátane starter) a mzdy žeriava aj vozidiel', () => {
    const scenario = loadScenarioFile('apron_to_yard');
    const world = World.create(DEFS, MAP, scenario.seed);
    for (const { command } of scenario.commands) world.enqueue(commandFromJSON(command));
    const events = closeNextDay(world);
    assertCargoConservation(world);
    const maintenance = [...world.modules.values()].reduce((sum, module) => sum + module.def.maintenancePerDayCents, 0);
    expect(world.modules.size).toBe(5); // berth, žeriav, depo, 2 dvory
    expect(world.vehicles.size).toBe(2);
    expect(maintenance).toBe(285_000);
    expect(ofType(events, 'MoneyChanged').map((event) => [event.reason, event.deltaCents])).toEqual([
      ['maintenance', -285_000],
      ['wages', -(CRANE_WAGE + 2 * STRADDLE_WAGE)],
    ]);
    expect(CRANE_WAGE + 2 * STRADDLE_WAGE).toBe(61_000);
  });

  it('predané vozidlo a odstránený modul sa v ďalší deň neúčtujú', () => {
    const scenario = loadScenarioFile('apron_to_yard');
    const world = World.create(DEFS, MAP, scenario.seed);
    // Len stavba bez lode: vozidlá ostanú idle pri depe, takže sa dajú predať.
    for (const { command } of scenario.commands) if (command.type !== 'SpawnShipDebug') world.enqueue(commandFromJSON(command));
    world.applyPending();
    const [vehicle] = [...world.vehicles.values()];
    world.enqueue(commandFromJSON({ type: 'SellVehicle', vehicleId: vehicle.id }));
    const yard = [...world.modules.values()].find((module) => module.def.id === 'container_yard_small');
    if (yard === undefined) throw new Error('scenár nemá dvor');
    world.enqueue(commandFromJSON({ type: 'RemoveModule', moduleId: yard.id }));
    const events = closeNextDay(world);
    expect(ofType(events, 'MoneyChanged').map((event) => [event.reason, event.deltaCents])).toEqual([
      ['maintenance', -(285_000 - DEFS.modules.get('container_yard_small').maintenancePerDayCents)],
      ['wages', -(CRANE_WAGE + STRADDLE_WAGE)],
    ]);
  });
});

describe('EconomySystem — MonthClosed', () => {
  it('MonthlyReport po DayClosedSummary: súčet 30 denných súhrnov mesiaca, cashEnd posledného dňa', () => {
    const world = World.create(DEFS, MAP, SEED, { checkInvariants: false });
    const events: SimEvent[] = [];
    for (let day = 0; day < 30; day++) events.push(...closeNextDay(world));
    const reports = ofType(events, 'MonthlyReport');
    expect(reports).toHaveLength(1);
    const daily = STARTER_MAINTENANCE + CRANE_WAGE;
    expect(reports[0]).toEqual({
      type: 'MonthlyReport',
      month: 0,
      summary: { month: 0, incomeCents: {}, expenseCents: { maintenance: 30 * STARTER_MAINTENANCE, wages: 30 * CRANE_WAGE }, cashEndCents: DEFS.economy.startingCashCents - 30 * daily },
    });
    const last = events.slice(events.findIndex((event) => event.type === 'MonthClosed'));
    expect(last.map((event) => event.type)).toEqual(['MonthClosed', 'MoneyChanged', 'MoneyChanged', 'DayClosedSummary', 'MonthlyReport']);
    expect(world.economy.monthly).toEqual([reports[0].summary]);
    expect(world.economy.daily).toHaveLength(30);
  });
});

describe('EconomySystem — bankrot (GameOver)', () => {
  const BANKRUPTCY_DAYS = 3;
  const defs = defsWithEconomy({ bankruptcyDays: BANKRUPTCY_DAYS });

  it(`hotovosť < 0 pri ${String(BANKRUPTCY_DAYS)} uzavretiach dňa za sebou → GameOver ako posledná udalosť kroku 9, raz`, () => {
    const world = World.create(defs, MAP, SEED);
    setCash(world, -1);
    const gameOvers: SimEventOf<'GameOver'>[] = [];
    for (let day = 0; day < BANKRUPTCY_DAYS - 1; day++) {
      gameOvers.push(...ofType(closeNextDay(world), 'GameOver'));
      expect(world.gameOver).toBe(false);
    }
    expect(world.economy.daysNegative).toBe(BANKRUPTCY_DAYS - 1);
    const events = closeNextDay(world);
    expect(gameOvers).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'GameOver', reason: 'bankruptcy', day: BANKRUPTCY_DAYS - 1 });
    expect([world.gameOver, world.economy.gameOver, world.economy.daysNegative]).toEqual([true, true, BANKRUPTCY_DAYS]);
  });

  it('deň s hotovosťou ≥ 0 počítadlo vynuluje', () => {
    const world = World.create(defs, MAP, SEED);
    setCash(world, -1);
    closeNextDay(world);
    closeNextDay(world);
    expect(world.economy.daysNegative).toBe(2);
    setCash(world, 10_000_000);
    closeNextDay(world);
    expect(world.economy.daysNegative).toBe(0);
    setCash(world, -1);
    closeNextDay(world);
    closeNextDay(world);
    expect(world.gameOver).toBe(false);
  });

  it('po GameOver tick neposúva čas ani netickuje systémy (loď stojí, ďalší deň sa neúčtuje); príkazy sa odmietnu s game_over (T05-04, ADR-027)', () => {
    const world = World.create(defs, MAP, SEED);
    world.enqueue(commandFromJSON({ type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 4 }));
    world.tick();
    setCash(world, -1);
    for (let day = 0; day < BANKRUPTCY_DAYS; day++) closeNextDay(world);
    expect(world.gameOver).toBe(true);
    const frozen = hashState(world.serialize());
    const tick = world.clock.tick;
    for (let i = 0; i < TICKS_PER_DAY + 10; i++) expect(world.tick()).toEqual([]);
    expect(world.clock.tick).toBe(tick);
    expect(hashState(world.serialize())).toBe(frozen);
    world.enqueue(commandFromJSON({ type: 'SetGameSpeed', speed: 0 }));
    expect(world.tick()).toEqual([{ type: 'CommandRejected', commandType: 'SetGameSpeed', reasons: ['game_over'] }]);
    expect(world.clock.tick).toBe(tick);
    expect(hashState(world.serialize())).toBe(frozen);
  });

  it('gameOver a počítadlo prežijú save/load; obnovený svet tiež netickuje', () => {
    const world = World.create(defs, MAP, SEED);
    setCash(world, -1);
    for (let day = 0; day < BANKRUPTCY_DAYS; day++) closeNextDay(world);
    const state = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    expect([state.economy.gameOver, state.economy.daysNegative]).toEqual([true, BANKRUPTCY_DAYS]);
    const loaded = World.deserialize(defs, MAP, state);
    expect(loaded.gameOver).toBe(true);
    const tick = loaded.clock.tick;
    runTicks(loaded, 100);
    expect(loaded.clock.tick).toBe(tick);
  });
});

describe('EconomySystem — save/load cez uzavretie dňa', () => {
  it('svet uložený uprostred dňa (s pohybmi otvoreného dňa) dobehne za hranicu dňa zhodne s originálom vrátane knihy a súhrnov', () => {
    const scenario = loadScenarioFile('apron_to_yard');
    const original = World.create(DEFS, MAP, scenario.seed);
    for (const { command } of scenario.commands) original.enqueue(commandFromJSON(command));
    runTicks(original, TICKS_PER_DAY - 500);
    expect(original.economy.todayDeltaCents()).toBeLessThan(0);
    const clone = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(original.serialize())) as WorldState);
    expect(clone.economy.todayDeltaCents()).toBe(original.economy.todayDeltaCents());
    const originalEvents: string[] = [];
    const cloneEvents: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      originalEvents.push(...original.tick().map((event) => JSON.stringify(event)));
      cloneEvents.push(...clone.tick().map((event) => JSON.stringify(event)));
    }
    expect(cloneEvents).toEqual(originalEvents);
    expect(hashState(clone.serialize())).toBe(hashState(original.serialize()));
    expect(clone.economy.daily).toEqual(original.economy.daily);
    expect(clone.economy.daily).toHaveLength(1);
  });
});
