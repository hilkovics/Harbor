/**
 * F7 (ADR-044): príkazy nad parcelami (kúpa, prenájom, uvoľnenie), stavba len na vlastnej parcele, denné nájomné
 * `price × leaseMonthlyRateOfPrice / 30`, mzdy strojov a pruhov brány, MonthSummary = Σ ledger, pohľady pre VM.
 * harbor_01: `west_quay` (x 6–21, y 12–49, 32 000 000 ¢, `leasable`), `east_yard` na predaj, `rail_yard` a `starter` vlastnené.
 */
import { describe, expect, it } from 'vitest';
import { BuyParcelCommand, type Command, LeaseParcelCommand, PlaceModuleCommand, PlaceRailCommand, PlaceRoadCommand, ReleaseParcelCommand, commandFromJSON } from '@sim/commands';
import { LEDGER_CATEGORIES, financeSeries, leasePerDayCents, listParcels, sumTotals, type CategoryTotals } from '@sim/economy';
import { RtgCrane } from '@sim/machines';
import { World } from '@sim/world';
import { TICKS_PER_DAY, TICKS_PER_MONTH } from '../helpers/f5';
import { setCash } from '../helpers/economy';
import { DEFS, MAP, SEED, START_CASH, newBareWorld } from '../commands/command-fixtures';

const LONG_TIMEOUT_MS = 300_000;
const WEST = 'west_quay';
const EAST = 'east_yard';
const WEST_PRICE = 32_000_000;
const RATE = DEFS.economy.leaseMonthlyRateOfPrice;
const YARD = 'container_yard_small';
/** Bunka vo vnútri `west_quay` (pevnina) pre sklad 4×4. */
const WEST_CELL = { x: 8, y: 30 };

const ownership = (world: World, id: string) => world.parcels.get(id)?.ownership;

function run(world: World, command: Command): void {
  expect(command.validate(world).reasons).toEqual([]);
  command.apply(world);
  world.events.flush();
}

function tickDays(world: World, days: number): void {
  for (let i = 0; i < days * TICKS_PER_DAY; i++) world.tick();
}

describe('BuyParcel / LeaseParcel / ReleaseParcel', () => {
  it('BuyParcel: strhne cenu (parcel_purchase), parcela owned, udalosť; opakovaná kúpa a neznáma parcela sa odmietnu', () => {
    const world = newBareWorld();
    const command = new BuyParcelCommand(WEST);
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: [], costCents: WEST_PRICE });
    command.apply(world);
    expect(ownership(world, WEST)).toBe('owned');
    expect(world.cashCents).toBe(START_CASH - WEST_PRICE);
    expect(world.events.flush()).toContainEqual({ type: 'ParcelOwnershipChanged', parcelId: WEST, ownership: 'owned' });
    expect(world.economy.entries.at(-1)).toMatchObject({ amountCents: -WEST_PRICE, category: 'parcel_purchase', refId: `parcel:${WEST}` });
    expect(command.validate(world).reasons).toEqual(['parcel_not_for_sale']);
    expect(new BuyParcelCommand('nowhere').validate(world).reasons).toEqual(['unknown_parcel']);
    expect(() => new BuyParcelCommand('starter').apply(world)).toThrow();
  });

  it('BuyParcel bez peňazí: insufficient_funds, svet sa nezmení', () => {
    const world = newBareWorld();
    setCash(world, WEST_PRICE - 1);
    expect(new BuyParcelCommand(WEST).validate(world).reasons).toEqual(['insufficient_funds']);
    expect(ownership(world, WEST)).toBe('none');
  });

  it('LeaseParcel: zadarmo, parcela leased; nie je leasable → parcel_not_leasable; vlastnenú parcelu prenajať nemožno', () => {
    const world = newBareWorld();
    const cash = world.cashCents;
    run(world, new LeaseParcelCommand(WEST));
    expect(ownership(world, WEST)).toBe('leased');
    expect(world.cashCents).toBe(cash);
    expect(new LeaseParcelCommand(WEST).validate(world).reasons).toEqual(['parcel_not_for_sale']);
    expect(new LeaseParcelCommand('starter').validate(world).reasons).toEqual(['parcel_not_for_sale']);
    const notLeasable = [...world.parcels.values()].find((parcel) => parcel.ownership === 'none' && !parcel.leasable);
    if (notLeasable !== undefined) expect(new LeaseParcelCommand(notLeasable.id).validate(world).reasons).toEqual(['parcel_not_leasable']);
  });

  it('ReleaseParcel: prázdny prenájom sa uvoľní; kúpená a nepripojená parcela nie', () => {
    const world = newBareWorld();
    run(world, new LeaseParcelCommand(WEST));
    run(world, new ReleaseParcelCommand(WEST));
    expect(ownership(world, WEST)).toBe('none');
    expect(new ReleaseParcelCommand(WEST).validate(world).reasons).toEqual(['parcel_not_leased']);
    run(world, new BuyParcelCommand(EAST));
    expect(new ReleaseParcelCommand(EAST).validate(world).reasons).toEqual(['parcel_not_leased']);
  });

  it('ReleaseParcel s modulom (aj s cestou) zlyhá: parcel_in_use; po odstránení prejde', () => {
    const world = newBareWorld();
    run(world, new LeaseParcelCommand(WEST));
    run(world, new PlaceModuleCommand({ defId: YARD, x: WEST_CELL.x, y: WEST_CELL.y, rotation: 0 }));
    expect(new ReleaseParcelCommand(WEST).validate(world).reasons).toEqual(['parcel_in_use']);
    const moduleId = [...world.modules.keys()].at(-1) as never;
    commandFromJSON({ type: 'RemoveModule', moduleId }).apply(world);
    expect(new ReleaseParcelCommand(WEST).validate(world).ok).toBe(true);
    run(world, new PlaceRoadCommand([{ x: 7, y: 20 }]));
    expect(new ReleaseParcelCommand(WEST).validate(world).reasons).toEqual(['parcel_in_use']);
  });

  it('serializácia: toJSON ↔ commandFromJSON pre všetky tri príkazy', () => {
    for (const type of ['BuyParcel', 'LeaseParcel', 'ReleaseParcel']) {
      const json = { type, parcelId: WEST };
      expect(commandFromJSON(json).toJSON()).toEqual(json);
    }
  });
});

describe('stavba len na vlastnej parcele (§8 bod 2)', () => {
  const road = (x: number, y: number) => new PlaceRoadCommand([{ x, y }]);
  const yard = () => new PlaceModuleCommand({ defId: YARD, x: WEST_CELL.x, y: WEST_CELL.y, rotation: 0 });

  it('na parcele na predaj: modul, cesta aj koľaj odmietnuté; po kúpe aj po prenájme prejdú', () => {
    for (const acquire of [new BuyParcelCommand(WEST), new LeaseParcelCommand(WEST)]) {
      const world = newBareWorld();
      expect(yard().validate(world).reasons).toContain('parcel_not_owned');
      expect(road(7, 20).validate(world).reasons).toContain('parcel_not_owned');
      expect(new PlaceRailCommand([{ x: 7, y: 21 }]).validate(world).reasons).toContain('parcel_not_owned');
      run(world, acquire);
      expect(yard().validate(world).reasons).not.toContain('parcel_not_owned');
      expect(road(7, 20).validate(world).ok).toBe(true);
      expect(new PlaceRailCommand([{ x: 7, y: 21 }]).validate(world).ok).toBe(true);
    }
  });
});

describe('DayClosed: nájomné, mzdy strojov a brán', () => {
  it('nájomné = round(price × rate / 30) za deň v kategórii parcel_lease; po uvoľnení neúčtuje', () => {
    const world = newBareWorld();
    run(world, new LeaseParcelCommand(WEST));
    run(world, new LeaseParcelCommand(EAST));
    const perDay = leasePerDayCents(WEST_PRICE, RATE) + leasePerDayCents(world.parcels.get(EAST)?.priceCents ?? 0, RATE);
    expect(leasePerDayCents(WEST_PRICE, RATE)).toBe(Math.round((WEST_PRICE * 0.015) / 30));
    tickDays(world, 1);
    expect(world.economy.daily.at(-1)?.expenseCents.parcel_lease).toBe(perDay);
    run(world, new ReleaseParcelCommand(EAST));
    tickDays(world, 1);
    expect(world.economy.daily.at(-1)?.expenseCents.parcel_lease).toBe(leasePerDayCents(WEST_PRICE, RATE));
    run(world, new ReleaseParcelCommand(WEST));
    tickDays(world, 1);
    expect(world.economy.daily.at(-1)?.expenseCents.parcel_lease).toBeUndefined();
  });

  it('vlastnená (kúpená) parcela nájomné neplatí', () => {
    const world = newBareWorld();
    run(world, new BuyParcelCommand(WEST));
    tickDays(world, 1);
    expect(world.economy.daily.at(-1)?.expenseCents.parcel_lease).toBeUndefined();
  });

  it('mzda stroja a pruhu brány pochádza z defov', () => {
    const rtg = RtgCrane.create(1 as never, 2 as never, DEFS.equipment.rtg, 0);
    expect(rtg.dailyWageCents()).toBe(DEFS.equipment.rtg.wagePerDayCents);
    expect(rtg.dailyWageCents()).toBeGreaterThan(0);
    for (const id of ['gate_in_lane', 'gate_out_lane']) {
      const params = DEFS.modules.get(id).params as { wagePerDayCents?: number };
      expect(params.wagePerDayCents).toBeGreaterThan(0);
    }
  });
});

describe('MonthSummary a pohľady pre VM', () => {
  it('MonthSummary mesiaca 0 = Σ záznamov ledgera podľa kategórie a znamienka; MonthlyReport emitovaný raz', () => {
    const world = World.create(DEFS, MAP, SEED);
    run(world, new LeaseParcelCommand(WEST));
    let reports = 0;
    const entriesBefore = world.economy.entries.length;
    expect(entriesBefore).toBeGreaterThanOrEqual(0);
    while (world.clock.gameMonth < 1) {
      for (const event of world.tick()) if (event.type === 'MonthlyReport') reports++;
    }
    expect(reports).toBe(1);
    const income: CategoryTotals = {};
    const expense: CategoryTotals = {};
    for (const entry of world.economy.entries) {
      const bucket = entry.amountCents >= 0 ? income : expense;
      bucket[entry.category] = (bucket[entry.category] ?? 0) + Math.abs(entry.amountCents);
    }
    const month = world.economy.monthly[0];
    expect(month?.month).toBe(0);
    expect(world.economy.entries.length).toBeLessThan(DEFS.economy.ledgerEntriesKept);
    for (const category of LEDGER_CATEGORIES) {
      expect(month?.incomeCents[category] ?? 0).toBe(income[category] ?? 0);
      expect(month?.expenseCents[category] ?? 0).toBe(expense[category] ?? 0);
    }
    expect(month?.expenseCents.parcel_lease).toBe(30 * leasePerDayCents(WEST_PRICE, RATE));
    expect(sumTotals(month?.expenseCents ?? {})).toBeGreaterThan(0);
    expect(world.clock.tick).toBeGreaterThanOrEqual(TICKS_PER_MONTH);
  }, LONG_TIMEOUT_MS);

  it('listParcels: stav for_sale / owned / leased, obdĺžnik, cena a nájom; financeSeries: dni, mesiace a kategórie z ledgera', () => {
    const world = newBareWorld();
    run(world, new LeaseParcelCommand(WEST));
    run(world, new BuyParcelCommand(EAST));
    const views = listParcels(world);
    expect(views.map((view) => [view.id, view.state])).toEqual([
      ['starter', 'owned'],
      [WEST, 'leased'],
      [EAST, 'owned'],
      ['rail_yard', 'owned'],
    ]);
    const west = views.find((view) => view.id === WEST);
    expect(west).toMatchObject({ priceCents: WEST_PRICE, leasePerMonthCents: Math.round(WEST_PRICE * RATE), leasable: true, rect: { x: 6, y: 12, w: 16, h: 38 } });
    run(world, new ReleaseParcelCommand(WEST));
    expect(listParcels(world).find((view) => view.id === WEST)?.state).toBe('for_sale');

    tickDays(world, 2);
    const series = financeSeries(world);
    expect(series.categories).toEqual(LEDGER_CATEGORIES);
    expect(series.daily.map((point) => point.label)).toEqual(['Deň 1', 'Deň 2']);
    expect(series.daily[1]?.cashEnd).toBe(world.cashCents);
    expect(series.daily[0]?.expenseByCat.parcel_purchase).toBe(world.parcels.get(EAST)?.priceCents);
    expect(series.monthly).toEqual([]);
  });
});
