import { describe, expect, it } from 'vitest';
import { PlaceRoadCommand, RemoveRoadCommand, type ValidationReason } from '@sim/commands';
import type { CellCoord } from '@sim/grid';
import type { World } from '@sim/world';
import {
  CELLS,
  FOR_SALE_PARCEL_ID,
  MAP,
  OTHER_FOR_SALE_PARCEL_ID,
  REFUND_RATE,
  ROAD_COST,
  START_CASH,
  defsWith,
  hashState,
  newWorld,
  roadCount,
  starterRow,
} from './command-fixtures';

const remove = (...cells: CellCoord[]): RemoveRoadCommand => new RemoveRoadCommand(cells);

/** Svet s cestou na `cells` postavenou skutočným PlaceRoad (hotovosť tým klesne). */
function worldWithRoads(cells: readonly CellCoord[], world: World = newWorld()): World {
  const command = new PlaceRoadCommand(cells);
  expect(command.validate(world).ok).toBe(true);
  command.apply(world);
  world.events.flush();
  return world;
}

/**
 * ADR-012 v znení ADR-015: floor(bunky × costPerCellCents × round(rate × 10 000) / 10 000), celočíselne
 * (BigInt ako nezávislý referenčný výpočet).
 */
const refundFor = (cells: number, cost = ROAD_COST, rate = REFUND_RATE): number =>
  Number((BigInt(cells * cost) * BigInt(Math.round(rate * 10_000))) / 10_000n);

describe('RemoveRoad — refundácia (ADR-012, ADR-015)', () => {
  it('removalRefundRate z defu je 50 %', () => {
    expect(REFUND_RATE).toBe(0.5);
  });

  it('miera 0.29 pri cene bunky 200 000 ¢ vráti presne 58 000 ¢ (v double by bolo 57 999)', () => {
    const defs = defsWith({ roadCostPerCellCents: 200_000, removalRefundRate: 0.29 });
    const world = worldWithRoads([CELLS.publicLand], newWorld(defs));
    expect(Math.floor(200_000 * 0.29)).toBe(57_999); // pôvodný vzorec ADR-012 v double
    const command = remove(CELLS.publicLand);
    expect(command.validate(world).costCents).toBe(-58_000);
    const cash = world.cashCents;
    command.apply(world);
    expect(world.cashCents).toBe(cash + 58_000);
  });

  it('odstránenie 3 buniek vráti 50 % ceny, kategória road_sale, práve RoadChanged + MoneyChanged', () => {
    const row = starterRow(3);
    const world = worldWithRoads(row);
    const cashBefore = world.cashCents;
    const refund = refundFor(3);
    expect(refund).toBe(3 * ROAD_COST * 0.5);

    const command = remove(...row);
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: row, costCents: -refund });
    command.apply(world);

    for (const { x, y } of row) expect(world.grid.at(x, y).road).toBe('none');
    expect(world.cashCents).toBe(cashBefore + refund);
    expect(world.events.flush()).toEqual([
      { type: 'RoadChanged', cells: row },
      { type: 'MoneyChanged', cashCents: cashBefore + refund, deltaCents: refund, reason: 'road_sale' },
    ]);
  });

  it('postav + odstráň = štart − cena + 50 % ceny', () => {
    const row = starterRow(4);
    const world = worldWithRoads(row);
    remove(...row).apply(world);
    expect(world.cashCents).toBe(START_CASH - 4 * ROAD_COST + refundFor(4));
    expect(roadCount(world)).toBe(MAP.starter.roads.length);
  });

  it('zaokrúhlenie nadol raz za celý príkaz, nie po bunkách', () => {
    // cena 3 ¢, 50 %: 3 bunky → floor(4.5) = 4 (po bunkách by bolo 3 × floor(1.5) = 3)
    const defs = defsWith({ roadCostPerCellCents: 3 });
    const row = starterRow(3);
    const world = worldWithRoads(row, newWorld(defs));
    expect(remove(...row).validate(world).costCents).toBe(-4);
    const one = worldWithRoads([row[0]], newWorld(defs));
    expect(remove(row[0]).validate(one).costCents).toBe(-1);
  });

  it('miera refundácie sa číta z economy.removalRefundRate', () => {
    const defs = defsWith({ removalRefundRate: 0.25 });
    const row = starterRow(2);
    const world = worldWithRoads(row, newWorld(defs));
    expect(remove(...row).validate(world).costCents).toBe(-refundFor(2, ROAD_COST, 0.25));
  });

  it('refundácia 0 → stále práve jeden MoneyChanged s deltaCents +0', () => {
    const world = worldWithRoads([CELLS.publicLand], newWorld(defsWith({ removalRefundRate: 0 })));
    const cash = world.cashCents;
    const command = remove(CELLS.publicLand);
    expect(Object.is(command.validate(world).costCents, 0)).toBe(true);
    command.apply(world);
    const money = world.events.flush().filter((e) => e.type === 'MoneyChanged');
    expect(money).toEqual([{ type: 'MoneyChanged', cashCents: cash, deltaCents: 0, reason: 'road_sale' }]);
    expect(Object.is(money[0]?.type === 'MoneyChanged' ? money[0].deltaCents : NaN, 0)).toBe(true);
  });

  it('starter cesta z mapy (verejné bunky) sa dá odstrániť s refundáciou', () => {
    const world = newWorld();
    const [first, second] = MAP.starter.roads;
    remove(first, second).apply(world);
    expect(world.grid.at(first.x, first.y).road).toBe('none');
    expect(world.cashCents).toBe(START_CASH + refundFor(2));
  });

  it('odstránenie funguje aj pri zápornej hotovosti (refundácia nie je výdavok)', () => {
    const world = worldWithRoads([CELLS.publicLand]);
    world.cashCents = -1_000;
    expect(remove(CELLS.publicLand).validate(world).ok).toBe(true);
  });

  it('duplicitné bunky sa počítajú raz', () => {
    const [a, b] = starterRow(2);
    const world = worldWithRoads([a, b]);
    expect(remove(b, a, b, a).validate(world)).toEqual({ ok: true, reasons: [], cells: [b, a], costCents: -refundFor(2) });
  });

  it('prenajatá parcela: odstránenie povolené', () => {
    const world = newWorld();
    const parcel = world.parcels.get(OTHER_FOR_SALE_PARCEL_ID);
    if (parcel === undefined) throw new Error('chýba parcela');
    parcel.ownership = 'leased';
    worldWithRoads([CELLS.otherForSaleLand], world);
    expect(remove(CELLS.otherForSaleLand).validate(world).ok).toBe(true);
  });
});

describe('RemoveRoad — odmietnutia', () => {
  it.each<[string, CellCoord, ValidationReason[]]>([
    ['bunka bez cesty', CELLS.publicLand, ['no_road']],
    ['voda (cesta tam nikdy nie je)', CELLS.deepWater, ['no_road']],
    ['parcela na predaj bez cesty (dva dôvody)', CELLS.forSaleLand, ['parcel_not_owned', 'no_road']],
    ['mimo mapy', { x: -1, y: -1 }, ['out_of_bounds']],
  ])('%s → %j', (_name, cell, reasons) => {
    expect(remove(cell).validate(newWorld())).toEqual({ ok: false, reasons, cells: [], costCents: 0 });
  });

  it('bunka s koľajou → no_road (koľaj odstraňuje RemoveRail)', () => {
    const world = newWorld();
    world.grid.at(CELLS.publicLand.x, CELLS.publicLand.y).road = 'rail';
    expect(remove(CELLS.publicLand).validate(world).reasons).toEqual(['no_road']);
  });

  it('cesta na parcele na predaj → parcel_not_owned (pravidlo ako pri stavbe, ADR-008)', () => {
    const world = newWorld();
    // Stav, ktorý bežná hra nevyrobí (napr. budúci ReleaseParcel) — nastavený priamo v mriežke.
    world.grid.at(CELLS.forSaleLand.x, CELLS.forSaleLand.y).road = 'road';
    expect(world.grid.at(CELLS.forSaleLand.x, CELLS.forSaleLand.y).parcelId).toBe(FOR_SALE_PARCEL_ID);
    expect(remove(CELLS.forSaleLand).validate(world)).toEqual({ ok: false, reasons: ['parcel_not_owned'], cells: [], costCents: 0 });
  });

  it('prázdny zoznam → empty', () => {
    expect(remove().validate(newWorld())).toEqual({ ok: false, reasons: ['empty'], cells: [], costCents: 0 });
  });

  it('atomickosť: jedna bunka bez cesty odmietne celý príkaz; cells/costCents = platná časť', () => {
    const world = worldWithRoads([CELLS.publicLand]);
    expect(remove(CELLS.publicLand, CELLS.starterLand).validate(world)).toEqual({
      ok: false,
      reasons: ['no_road'],
      cells: [CELLS.publicLand],
      costCents: -refundFor(1),
    });
  });

  it('validate nemení svet', () => {
    const world = worldWithRoads(starterRow(2));
    const before = hashState(world.serialize());
    remove(...starterRow(2), CELLS.deepWater).validate(world);
    remove(...starterRow(2)).validate(world);
    expect(hashState(world.serialize())).toBe(before);
    expect(world.events.pending).toBe(0);
  });

  it('apply bez platnej validácie vyhodí Error a svet nezmení', () => {
    const world = worldWithRoads([CELLS.publicLand]);
    const before = hashState(world.serialize());
    expect(() => remove(CELLS.publicLand, CELLS.starterLand).apply(world)).toThrow(/RemoveRoad\.apply: príkaz nie je platný \(no_road\)/);
    expect(hashState(world.serialize())).toBe(before);
  });
});
