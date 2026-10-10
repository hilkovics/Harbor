// Economy (T05-02, ARCHITECTURE §9.2, ADR-025): post ako jediná cesta zmeny hotovosti (záznam knihy + MoneyChanged),
// súčty otvoreného dňa podľa znamienka, DaySummary / MonthSummary, bankrotové počítadlo a stav do save.
import { describe, expect, it } from 'vitest';
import { EventBus } from '@sim/core';
import { DAILY_SUMMARIES_KEPT, Economy, MONTHLY_SUMMARIES_KEPT, freezeTotals, sumTotals, type EconomyEnv } from '@sim/economy';
import type { SimEvent } from '@sim/events';

interface Harness {
  readonly env: EconomyEnv & { clock: { tick: number } };
  readonly events: EventBus<SimEvent>;
  readonly economy: Economy;
}

function harness(cashCents = 1_000, entriesKept = 100): Harness {
  const events = new EventBus<SimEvent>();
  const env = { events, clock: { tick: 0 } };
  return { env, events, economy: new Economy(env, cashCents, entriesKept) };
}

describe('Economy.post', () => {
  it('zmení hotovosť, zapíše záznam knihy s tickom hodín a emituje MoneyChanged s kategóriou ako reason', () => {
    const { env, events, economy } = harness(1_000);
    env.clock.tick = 42;
    economy.post(-300, 'module_capex', 'module:7');
    env.clock.tick = 43;
    economy.post(50, 'module_sale');
    expect(economy.cashCents).toBe(750);
    expect(economy.entries).toEqual([
      { tick: 42, amountCents: -300, category: 'module_capex', refId: 'module:7' },
      { tick: 43, amountCents: 50, category: 'module_sale' },
    ]);
    expect(Object.hasOwn(economy.entries[1], 'refId')).toBe(false);
    expect(events.flush()).toEqual([
      { type: 'MoneyChanged', cashCents: 700, deltaCents: -300, reason: 'module_capex' },
      { type: 'MoneyChanged', cashCents: 750, deltaCents: 50, reason: 'module_sale' },
    ]);
  });

  it('súčty otvoreného dňa podľa znamienka: príjem do incomeCents, výdavok ako kladná veľkosť do expenseCents; nula len v knihe', () => {
    const { economy, events } = harness(0);
    economy.post(-200, 'road_capex');
    economy.post(-100, 'road_capex');
    economy.post(80, 'road_sale');
    economy.post(0, 'road_capex');
    expect(economy.openDay()).toEqual({ incomeCents: { road_sale: 80 }, expenseCents: { road_capex: 300 } });
    expect(economy.todayDeltaCents()).toBe(-220);
    expect(economy.entries).toHaveLength(4);
    expect(events.flush().at(-1)).toEqual({ type: 'MoneyChanged', cashCents: -220, deltaCents: 0, reason: 'road_capex' });
  });

  it.each([
    ['zlomková suma', 0.5],
    ['NaN', Number.NaN],
    ['nekonečno', Number.POSITIVE_INFINITY],
    ['mimo bezpečného rozsahu', Number.MAX_SAFE_INTEGER + 2],
  ])('%s → RangeError, nič sa nezmení', (_name, amount) => {
    const { economy, events } = harness(1_000);
    expect(() => economy.post(amount, 'maintenance')).toThrow(RangeError);
    expect([economy.cashCents, economy.entries.length, events.pending, economy.todayDeltaCents()]).toEqual([1_000, 0, 0, 0]);
  });

  it('hotovosť, ktorá by vyšla z bezpečného rozsahu → RangeError', () => {
    const { economy } = harness(Number.MAX_SAFE_INTEGER);
    expect(() => economy.post(1, 'contract_revenue')).toThrow(RangeError);
    expect(economy.cashCents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('počiatočná hotovosť musí byť bezpečné celé číslo', () => {
    expect(() => new Economy({ events: new EventBus<SimEvent>(), clock: { tick: 0 } }, 1.5, 10)).toThrow(RangeError);
  });

  it('kniha drží len posledných ledgerEntriesKept záznamov (kruhový buffer); entries je zmrazená kópia obnovená po post', () => {
    const { economy } = harness(0, 3);
    for (let i = 1; i <= 5; i++) economy.post(i, 'contract_revenue');
    const first = economy.entries;
    expect(first.map((entry) => entry.amountCents)).toEqual([3, 4, 5]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(economy.entries).toBe(first); // bez zápisu tá istá kópia
    economy.post(6, 'contract_revenue');
    expect(economy.entries).not.toBe(first);
    expect(economy.entries.map((entry) => entry.amountCents)).toEqual([4, 5, 6]);
    expect(economy.cashCents).toBe(21); // hotovosť nezávisí od orezania knihy
  });
});

describe('Economy — uzavretie dňa a mesiaca', () => {
  it('closeDay: zmrazený DaySummary so súčtami dňa a cashEnd, nový deň začína od nuly', () => {
    const { economy } = harness(1_000);
    economy.post(-210, 'maintenance');
    economy.post(-25, 'wages');
    economy.post(100, 'contract_revenue');
    const summary = economy.closeDay(0);
    expect(summary).toEqual({ day: 0, incomeCents: { contract_revenue: 100 }, expenseCents: { maintenance: 210, wages: 25 }, cashEndCents: 865 });
    expect(Object.isFrozen(summary) && Object.isFrozen(summary.incomeCents) && Object.isFrozen(summary.expenseCents)).toBe(true);
    expect(economy.daily).toEqual([summary]);
    expect(economy.openDay()).toEqual({ incomeCents: {}, expenseCents: {} });
    expect(economy.todayDeltaCents()).toBe(0);
    // cashEnd(d) = cashEnd(d − 1) + Σ income − Σ expense
    economy.post(-65, 'maintenance');
    const next = economy.closeDay(1);
    expect(next.cashEndCents).toBe(summary.cashEndCents + sumTotals(next.incomeCents) - sumTotals(next.expenseCents));
  });

  it('kľúče súčtov sú v kanonickom poradí LEDGER_CATEGORIES bez ohľadu na poradie pohybov', () => {
    const { economy } = harness(0);
    economy.post(-1, 'wages');
    economy.post(-1, 'module_capex');
    economy.post(-1, 'maintenance');
    expect(Object.keys(economy.closeDay(0).expenseCents)).toEqual(['module_capex', 'maintenance', 'wages']);
    expect(Object.keys(freezeTotals({ wages: 1, penalty: 2 }))).toEqual(['penalty', 'wages']);
  });

  it(`história dní drží ${String(DAILY_SUMMARIES_KEPT)} súhrnov (najstarší vypadne)`, () => {
    const { economy } = harness(0);
    for (let day = 0; day <= DAILY_SUMMARIES_KEPT; day++) economy.closeDay(day);
    expect(economy.daily).toHaveLength(DAILY_SUMMARIES_KEPT);
    expect(economy.daily[0].day).toBe(1);
    expect(economy.daily.at(-1)?.day).toBe(DAILY_SUMMARIES_KEPT);
  });

  it('closeMonth sčíta len denné súhrny dní mesiaca; cashEnd = aktuálna hotovosť', () => {
    const { economy } = harness(0);
    for (let day = 0; day < 60; day++) {
      economy.post(-10, 'maintenance');
      if (day % 2 === 0) economy.post(7, 'contract_revenue');
      economy.closeDay(day);
    }
    const month = economy.closeMonth(1, 30, 59);
    expect(month).toEqual({ month: 1, incomeCents: { contract_revenue: 15 * 7 }, expenseCents: { maintenance: 30 * 10 }, cashEndCents: economy.cashCents });
    expect(economy.monthly).toEqual([month]);
    expect(Object.isFrozen(month)).toBe(true);
  });

  it('closeMonth mesiaca bez denných súhrnov (napr. po migrácii starého save) dá prázdne súčty', () => {
    const { economy } = harness(500);
    expect(economy.closeMonth(3, 90, 119)).toEqual({ month: 3, incomeCents: {}, expenseCents: {}, cashEndCents: 500 });
  });

  it(`história mesiacov drží ${String(MONTHLY_SUMMARIES_KEPT)} súhrnov`, () => {
    const { economy } = harness(0);
    for (let month = 0; month <= MONTHLY_SUMMARIES_KEPT; month++) economy.closeMonth(month, month * 30, month * 30 + 29);
    expect(economy.monthly).toHaveLength(MONTHLY_SUMMARIES_KEPT);
    expect(economy.monthly[0].month).toBe(1);
  });
});

describe('Economy.recordSolvency — bankrotové počítadlo', () => {
  it('záporná hotovosť zvyšuje počítadlo, hotovosť ≥ 0 ho nuluje; pri dosiahnutí limitu gameOver práve raz', () => {
    const { economy } = harness(-1);
    expect([economy.recordSolvency(3), economy.daysNegative]).toEqual([false, 1]);
    expect([economy.recordSolvency(3), economy.daysNegative]).toEqual([false, 2]);
    economy.post(1, 'module_sale'); // hotovosť 0 → nie je záporná
    expect([economy.recordSolvency(3), economy.daysNegative]).toEqual([false, 0]);
    economy.post(-1, 'maintenance');
    expect(economy.recordSolvency(3)).toBe(false);
    expect(economy.recordSolvency(3)).toBe(false);
    expect(economy.gameOver).toBe(false);
    expect([economy.recordSolvency(3), economy.daysNegative, economy.gameOver]).toEqual([true, 3, true]);
    expect([economy.recordSolvency(3), economy.daysNegative, economy.gameOver]).toEqual([false, 4, true]);
  });
});

describe('Economy — stav do save', () => {
  function busy(): Harness {
    const h = harness(10_000, 5);
    h.env.clock.tick = 8_640;
    h.economy.post(-200, 'maintenance');
    h.economy.post(-30, 'wages', 'crane:2');
    h.economy.closeDay(0);
    h.economy.post(500, 'module_sale', 'module:9');
    h.economy.post(-1, 'road_capex');
    h.economy.closeMonth(0, 0, 29);
    h.economy.recordSolvency(30);
    return h;
  }

  it('getState je čistý JSON; fromState obnoví hotovosť, knihu, súhrny, súčty dňa aj počítadlá', () => {
    const { economy } = busy();
    const state = economy.getState();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state.today).toEqual({ incomeCents: { module_sale: 500 }, expenseCents: { road_capex: 1 } });
    const restored = Economy.fromState({ events: new EventBus<SimEvent>(), clock: { tick: 8_640 } }, economy.cashCents, 5, JSON.parse(JSON.stringify(state)));
    expect(restored.getState()).toEqual(state);
    expect(JSON.stringify(restored.getState())).toBe(JSON.stringify(state));
    expect([restored.cashCents, restored.todayDeltaCents(), restored.daysNegative, restored.gameOver]).toEqual([
      economy.cashCents,
      economy.todayDeltaCents(),
      economy.daysNegative,
      economy.gameOver,
    ]);
    expect(Object.isFrozen(restored.daily[0])).toBe(true);
  });

  it('getState vracia nové objekty (zmena výsledku ekonomiku nezmení)', () => {
    const { economy } = busy();
    const state = economy.getState() as unknown as { entries: { amountCents: number }[]; daily: { cashEndCents: number }[] };
    state.entries[0].amountCents = 1;
    state.daily[0].cashEndCents = 1;
    expect(economy.entries[0].amountCents).toBe(-200);
    expect(economy.daily[0].cashEndCents).toBe(9_770);
  });

  it('fromState s menšou kapacitou knihy ponechá najnovšie záznamy', () => {
    const { economy } = busy();
    const restored = Economy.fromState({ events: new EventBus<SimEvent>(), clock: { tick: 0 } }, economy.cashCents, 2, economy.getState());
    expect(restored.entries.map((entry) => entry.amountCents)).toEqual([500, -1]);
  });
});
