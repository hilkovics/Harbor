/**
 * `Economy` a `Ledger` (T05-05, TDD; „Rozhodnutia orchestrátora" 1, 2, 11): každá zmena hotovosti ide cez
 * `Economy.post(amountCents, category, refId?)`, zapíše `LedgerEntry` a emituje `MoneyChanged`; existujúce výdavky a
 * predaje (cesty, moduly, vozidlá) majú rovnaké sumy ako vo F1–F4, len ich vedie Economy. Peniaze sú celé centy.
 *
 * Predpoklady o API:
 *  E1 `world.economy.cashCents` je jediný zdroj hotovosti (štart `economy.startingCashCents`), `entries` drží najviac
 *     `ledgerEntriesKept` posledných záznamov (najstaršie vypadávajú), `daily`/`monthly` sú prázdne do prvého `DayClosed`;
 *  E2 výdavok je záznam so záporným `amountCents`, predaj/výplata s kladným; `category` je `LedgerCategory` a súhlasí s
 *     `MoneyChanged.reason` (kontroluje `Run5` po každom ticku: hotovosť = štart + Σ `MoneyChanged`, chvost ledgera
 *     = posledné nenulové zmeny);
 *  E3 sumy: cesta `costPerCellCents` za bunku (`road_capex`), modul `costCents` (`module_capex`), vozidlo `purchaseCents`
 *     (`vehicle_capex`); odstránenie modulu/predaj vozidla = `refundCents(zaplatená cena, removalRefundRate)`.
 */
import { describe, expect, it } from 'vitest';
import { refundCents } from '@sim/commands';
import { World } from '@sim/world';
import { ALL_F4_ROAD_CELLS } from '../helpers/f4-layout';
import { at, emptyScenario, must, withCommands } from '../helpers/harbor';
import {
  DEFS,
  MAP,
  PORT_MAP,
  Run5,
  cashOf,
  completedOf,
  defsWith,
  economyOf,
  gameOverOf,
  portScenario,
  sumByCategory,
  tierOf,
  xpOf,
} from '../helpers/f5';

/** Cesty rozloženia: 32 jednosmerných buniek a križovatka `two_lane` (47, 28). */
const ROAD_CAPEX = (ALL_F4_ROAD_CELLS.length - 1) * DEFS.infrastructure.roadKinds.one_way.costPerCellCents + DEFS.infrastructure.roadKinds.two_lane.costPerCellCents;
const START_CASH = DEFS.economy.startingCashCents;
const MODULE_IDS = ['vehicle_depot', 'container_yard_small', 'container_yard_small', 'gate_in_lane', 'gate_out_lane'];
const MODULES_COST = MODULE_IDS.reduce((sum, defId) => sum + DEFS.modules.get(defId).costCents, 0);
const VEHICLES_COST = 2 * DEFS.vehicles.get('straddle_carrier').purchaseCents;

describe('Economy: počiatočný stav', () => {
  it('hotovosť = startingCashCents, prázdny ledger a súhrny, žiadne dni v mínuse, XP 0, tier 0, hra beží', () => {
    const world = World.create(DEFS, MAP, 5501);
    const economy = economyOf(world);
    expect(economy.cashCents).toBe(START_CASH);
    expect(economy.entries).toEqual([]);
    expect(economy.daily).toEqual([]);
    expect(economy.monthly).toEqual([]);
    expect(economy.daysNegative).toBe(0);
    expect(economy.todayDeltaCents()).toBe(0);
    expect(xpOf(world)).toBe(0);
    expect(completedOf(world)).toBe(0);
    expect(tierOf(world)).toBe(0);
    expect(gameOverOf(world)).toBe(false);
  });

  it('starter moduly (Root berth a žeriav) sú zadarmo: bez záznamu v ledgeri aj po prvom ticku', () => {
    const world = World.create(DEFS, MAP, 5502);
    world.tick();
    expect(economyOf(world).entries).toEqual([]);
    expect(cashOf(world)).toBe(START_CASH);
  });
});

describe('Economy: výdavky a predaje z F1–F4 idú cez ledger s rovnakými sumami', () => {
  const seed = 5503;

  it('stavba prístavu: road_capex 33 buniek, module_capex 5 modulov, vehicle_capex 2 vozidlá; hotovosť = štart − súčet', () => {
    const world = World.create(DEFS, PORT_MAP, seed);
    const run = new Run5(world, portScenario('f5_ledger_build', seed));
    run.runTo(2);

    const sums = sumByCategory(economyOf(world).entries);
    expect(sums.road_capex).toBe(-ROAD_CAPEX);
    expect(sums.module_capex).toBe(-MODULES_COST);
    expect(sums.vehicle_capex).toBe(-VEHICLES_COST);
    // (44, 34) je už na starter mape: jej predaj vráti polovicu ceny jednosmernej bunky
    expect(sums.road_sale).toBe(75_000);
    expect(Object.keys(sums).sort()).toEqual(['module_capex', 'road_capex', 'road_sale', 'vehicle_capex']);
    expect(cashOf(world)).toBe(START_CASH - ROAD_CAPEX + 75_000 - MODULES_COST - VEHICLES_COST);
    for (const entry of economyOf(world).entries.filter((candidate) => candidate.category !== 'road_sale')) {
      expect(entry.amountCents).toBeLessThan(0);
      expect(Number.isSafeInteger(entry.amountCents)).toBe(true);
    }
    expect(run.ofSim('CommandRejected')).toEqual([]);
    expect(run.violations).toEqual([]);
    expect(run.ticksChecked).toBe(2);
  });

  it('odstránenie modulu a predaj vozidla: module_sale a vehicle_sale = refundCents(zaplatená cena, removalRefundRate), kladné záznamy', () => {
    const world = World.create(DEFS, PORT_MAP, seed);
    const run = new Run5(world, portScenario('f5_ledger_sales', seed));
    run.runTo(2);
    const yard = must([...world.modules.values()].filter((module) => module.kind === 'storage').at(-1), 'dvor');
    const vehicle = must([...world.vehicles.values()][0], 'vozidlo');
    const before = economyOf(world).entries.length;
    run.send({ type: 'RemoveModule', moduleId: yard.id });
    run.send({ type: 'SellVehicle', vehicleId: vehicle.id });
    run.step();

    const rate = DEFS.economy.removalRefundRate;
    const fresh = economyOf(world).entries.slice(before);
    const sums = sumByCategory(fresh);
    expect(sums.module_sale).toBe(refundCents(DEFS.modules.get('container_yard_small').costCents, rate));
    expect(sums.vehicle_sale).toBe(refundCents(DEFS.vehicles.get('straddle_carrier').purchaseCents, rate));
    expect(Object.keys(sums).sort()).toEqual(['module_sale', 'vehicle_sale']);
    expect(sums.module_sale).toBe(7_500_000);
    expect(sums.vehicle_sale).toBe(2_400_000);
    expect(run.ofSim('CommandRejected')).toEqual([]);
    expect(run.violations).toEqual([]);
  });
});

describe('Ledger: okno posledných záznamov', () => {
  it('drží najviac ledgerEntriesKept záznamov (najstaršie vypadnú), hotovosť sa zachová', () => {
    const kept = 4;
    const defs = defsWith({ economy: { ledgerEntriesKept: kept } });
    const roads = [1, 2, 3, 4, 5, 6].map((i) => at(i, { type: 'PlaceRoad', cells: [{ x: 41, y: 17 + i }] }));
    const scenario = withCommands(emptyScenario('f5_ledger_ring', 5504), ...roads);
    const world = World.create(defs, MAP, 5504);
    const run = new Run5(world, scenario);
    run.runTo(8);

    const entries = economyOf(world).entries;
    expect(entries).toHaveLength(kept);
    expect(entries.map((entry) => entry.category)).toEqual(Array<string>(kept).fill('road_capex'));
    expect(entries.map((entry) => entry.amountCents)).toEqual(Array<number>(kept).fill(-(DEFS.infrastructure.road.costPerCellCents)));
    const ticks = entries.map((entry) => entry.tick);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(ticks[0]).toBeGreaterThanOrEqual(3);
    expect(cashOf(world)).toBe(START_CASH - 6 * (DEFS.infrastructure.road.costPerCellCents));
    expect(run.ofSim('CommandRejected')).toEqual([]);
    expect(run.violations).toEqual([]);
  });
});
