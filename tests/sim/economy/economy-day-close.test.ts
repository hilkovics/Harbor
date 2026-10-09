/**
 * Uzávierky obdobia (T05-05, TDD; „Rozhodnutia orchestrátora" 2; ARCHITECTURE §9.2): pri `DayClosed` sa strhne údržba
 * (Σ `maintenancePerDayCents` všetkých postavených modulov vrátane starter modulov) a mzdy (Σ `wagePerDayCents`
 * vozidiel a žeriavov), vznikne `DaySummary`; pri `MonthClosed` vznikne `MonthSummary` a `MonthlyReport`.
 * Cesty majú údržbu 0 (`infrastructure.json`), prenájmy pozemkov prídu až vo F7.
 *
 * Rozloženie F4 s 2 vozidlami: údržba = berth 120 000 + žeriav 90 000 + depo 15 000 + 2 × dvor 30 000 + brána 15 000 +
 * stojisko 10 000 + rampa 20 000 = 330 000, mzdy = 2 × 18 000 + 25 000 = 61 000; spolu 384 000 za deň.
 * Starter prístav (berth + žeriav): údržba 210 000, mzdy 25 000 = 235 000 za deň.
 *
 * Predpoklady o API:
 *  M1 údržba a mzdy sa zapíšu v ticku `DayClosed` ako záznamy `maintenance` / `wages` (záporné sumy) a ako
 *     `MoneyChanged`; `daily` získa práve jeden `DaySummary` na `DayClosed` s `cashEndCents` = hotovosť po zápisoch;
 *     `expenseCents`/`incomeCents` sú veľkosti (znamienko sa nerozlišuje), `Σ income − Σ expense` = zmena hotovosti
 *     za obdobie od predošlého súhrnu;
 *  M2 `MonthClosed` (30. `DayClosed`) vyrobí `MonthSummary` (rovnaké polia ako `DaySummary`, agregát mesiaca) a jednu
 *     udalosť `MonthlyReport { month, summary }` s tým istým súhrnom ako `economy.monthly.at(-1)`;
 *  M3 `todayDeltaCents()` = hotovosť − `cashEndCents` posledného súhrnu (zmena od poslednej uzávierky).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { World } from '@sim/world';
import { emptyScenario, must } from '../helpers/harbor';
import {
  DAYS_PER_MONTH,
  DEFS,
  MAP,
  Run5,
  TICKS_PER_DAY,
  TICKS_PER_MONTH,
  cashOf,
  economyOf,
  events5,
  expectedMaintenanceCents,
  expectedWagesCents,
  expenseOf,
  incomeOf,
  netOf,
  portScenario,
  sumByCategory,
} from '../helpers/f5';

const START_CASH = DEFS.economy.startingCashCents;
const PORT_MAINTENANCE = 323_000;
const PORT_WAGES = 61_000;
const STARTER_MAINTENANCE = 210_000;
const STARTER_WAGES = 25_000;
const LONG_TIMEOUT_MS = 300_000;

describe('DayClosed: údržba a mzdy v rozložení F4 s 2 vozidlami', () => {
  const seed = 5601;
  let world: World;
  let run: Run5;
  let cashAtClose0 = 0;
  let cashAtClose1 = 0;

  beforeAll(() => {
    world = World.create(DEFS, MAP, seed);
    run = new Run5(world, portScenario('f5_day_close', seed));
  });

  it('stráž: očakávané sumy zodpovedajú defom a postavenému svetu', () => {
    run.runTo(TICKS_PER_DAY - 1);
    expect(expectedMaintenanceCents(world)).toBe(PORT_MAINTENANCE);
    expect(expectedWagesCents(world)).toBe(PORT_WAGES);
    expect(economyOf(world).daily).toEqual([]);
    expect(economyOf(world).monthly).toEqual([]);
    expect(events5(run.events, 'MonthlyReport')).toEqual([]);
    expect(run.ofSim('MoneyChanged').filter((move) => move.event.reason === 'maintenance' || move.event.reason === 'wages')).toEqual([]);
  });

  it('pred uzávierkou dňa sa údržba ani mzdy nestrhávajú a todayDeltaCents = hotovosť − štart', () => {
    expect(economyOf(world).todayDeltaCents()).toBe(cashOf(world) - START_CASH);
  });

  it('prvý DayClosed: údržba −323 000 a mzdy −61 000 v ticku uzávierky, DaySummary s výdavkami dňa 0 (CAPEX + údržba + mzdy)', () => {
    run.runTo(TICKS_PER_DAY);
    const closes = run.ofSim('DayClosed');
    expect(closes.map((entry) => entry.tick)).toEqual([TICKS_PER_DAY]);

    const moves = run.ofSim('MoneyChanged').filter((move) => move.tick === TICKS_PER_DAY);
    const byReason = (reason: string): number => moves.filter((move) => move.event.reason === reason).reduce((sum, move) => sum + move.event.deltaCents, 0);
    expect(byReason('maintenance')).toBe(-PORT_MAINTENANCE);
    expect(byReason('wages')).toBe(-PORT_WAGES);
    expect(moves.every((move) => move.event.reason === 'maintenance' || move.event.reason === 'wages')).toBe(true);

    const entries = economyOf(world).entries.filter((entry) => entry.tick === TICKS_PER_DAY);
    const sums = sumByCategory(entries);
    expect(sums.maintenance).toBe(-PORT_MAINTENANCE);
    expect(sums.wages).toBe(-PORT_WAGES);

    const daily = economyOf(world).daily;
    expect(daily).toHaveLength(1);
    const summary = must(daily[0], 'DaySummary');
    expect(summary.cashEndCents).toBe(cashOf(world));
    expect(expenseOf(summary, 'maintenance')).toBe(PORT_MAINTENANCE);
    expect(expenseOf(summary, 'wages')).toBe(PORT_WAGES);
    expect(expenseOf(summary, 'road_capex')).toBe(50 * DEFS.infrastructure.road.costPerCellCents);
    expect(expenseOf(summary, 'module_capex')).toBe(60_000_000);
    expect(expenseOf(summary, 'vehicle_capex')).toBe(9_600_000);
    expect(incomeOf(summary, 'contract_revenue')).toBe(0);
    expect(summary.cashEndCents - START_CASH).toBe(netOf(summary));
    cashAtClose0 = summary.cashEndCents;
  });

  it('po uzávierke je todayDeltaCents nula a rastie len o nové pohyby', () => {
    run.runTo(TICKS_PER_DAY + 1);
    expect(economyOf(world).todayDeltaCents()).toBe(0);
    expect(cashOf(world)).toBe(cashAtClose0);
  });

  it('druhý DayClosed bez akcií: hotovosť klesne presne o 384 000 (údržba + mzdy), súhrn dňa má len tieto dve kategórie', () => {
    run.runTo(2 * TICKS_PER_DAY);
    const daily = economyOf(world).daily;
    expect(daily).toHaveLength(2);
    const summary = must(daily[1], 'DaySummary 2');
    expect(summary.cashEndCents).toBe(cashOf(world));
    expect(cashOf(world)).toBe(cashAtClose0 - PORT_MAINTENANCE - PORT_WAGES);
    expect(expenseOf(summary, 'maintenance')).toBe(PORT_MAINTENANCE);
    expect(expenseOf(summary, 'wages')).toBe(PORT_WAGES);
    expect(netOf(summary)).toBe(-(PORT_MAINTENANCE + PORT_WAGES));
    expect(summary.cashEndCents - must(daily[0], 'DaySummary 1').cashEndCents).toBe(netOf(summary));
    cashAtClose1 = summary.cashEndCents;
  });

  it('tretie vozidlo mení mzdy od nasledujúcej uzávierky: −79 000 mzdy, údržba rovnaká; nákup je CAPEX dňa nákupu', () => {
    const depot = must([...world.modules.values()].find((module) => module.kind === 'depot'), 'depo');
    run.send({ type: 'BuyVehicle', vehicleDefId: 'straddle_carrier', depotId: depot.id });
    run.step();
    const capex = DEFS.vehicles.get('straddle_carrier').purchaseCents;
    expect(cashOf(world)).toBe(cashAtClose1 - capex);
    run.runTo(3 * TICKS_PER_DAY);
    const daily = economyOf(world).daily;
    expect(daily).toHaveLength(3);
    const summary = must(daily[2], 'DaySummary 3');
    expect(expenseOf(summary, 'wages')).toBe(PORT_WAGES + DEFS.vehicles.get('straddle_carrier').wagePerDayCents);
    expect(expenseOf(summary, 'maintenance')).toBe(PORT_MAINTENANCE);
    expect(expenseOf(summary, 'vehicle_capex')).toBe(capex);
    expect(summary.cashEndCents - cashAtClose1).toBe(netOf(summary));
  });

  it('invarianty: peniaze a konzervácia po každom ticku, žiadny príkaz odmietnutý', () => {
    expect(run.violations).toEqual([]);
    expect(run.ticksChecked).toBe(world.clock.tick);
    expect(run.ofSim('CommandRejected')).toEqual([]);
  });
});

describe('MonthClosed: MonthSummary a MonthlyReport (starter prístav, 30 dní)', () => {
  it('po 30 dňoch jedna udalosť MonthlyReport so súhrnom mesiaca = economy.monthly[0]; údržba 30 × 210 000, mzdy 30 × 25 000', () => {
    const world = World.create(DEFS, MAP, 5602);
    const run = new Run5(world, emptyScenario('f5_month_close', 5602));
    run.runTo(TICKS_PER_MONTH - 1);
    expect(economyOf(world).daily).toHaveLength(DAYS_PER_MONTH - 1);
    expect(economyOf(world).monthly).toEqual([]);
    expect(events5(run.events, 'MonthlyReport')).toEqual([]);
    run.runTo(TICKS_PER_MONTH);

    const economy = economyOf(world);
    expect(economy.daily).toHaveLength(DAYS_PER_MONTH);
    expect(economy.monthly).toHaveLength(1);
    expect(run.ofSim('MonthClosed').map((entry) => entry.tick)).toEqual([TICKS_PER_MONTH]);

    const reports = events5(run.events, 'MonthlyReport');
    expect(reports).toHaveLength(1);
    const report = must(reports[0], 'MonthlyReport');
    expect(report.tick).toBe(TICKS_PER_MONTH);
    expect(Number.isInteger(report.event.month)).toBe(true);
    const month = must(economy.monthly[0], 'MonthSummary');
    expect(report.event.summary).toEqual(month);

    expect(month.cashEndCents).toBe(cashOf(world));
    expect(expenseOf(month, 'maintenance')).toBe(DAYS_PER_MONTH * STARTER_MAINTENANCE);
    expect(expenseOf(month, 'wages')).toBe(DAYS_PER_MONTH * STARTER_WAGES);
    const dailyNet = economy.daily.reduce((sum, day) => sum + netOf(day), 0);
    expect(netOf(month)).toBe(dailyNet);
    expect(month.cashEndCents).toBe(START_CASH + dailyNet);
    expect(run.violations).toEqual([]);
    expect(run.ticksChecked).toBe(TICKS_PER_MONTH);
  }, LONG_TIMEOUT_MS);
});
