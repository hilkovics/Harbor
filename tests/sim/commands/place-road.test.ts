import { describe, expect, it } from 'vitest';
import { PlaceRoadCommand, type ValidationReason } from '@sim/commands';
import type { CellCoord } from '@sim/grid';
import {
  CELLS,
  MAP,
  OTHER_FOR_SALE_PARCEL_ID,
  ROAD_COST,
  START_CASH,
  defsWith,
  hashState,
  newWorld,
  roadCount,
  starterRow,
} from './command-fixtures';
import { setCash } from '../helpers/economy';

const place = (...cells: CellCoord[]): PlaceRoadCommand => new PlaceRoadCommand(cells);

describe('PlaceRoad.validate — povolené bunky (ADR-008)', () => {
  it.each([
    ['verejná pevnina (0, 54)', CELLS.publicLandNamed],
    ['verejná pevnina', CELLS.publicLand],
    ['verejné nábrežie (Q)', CELLS.publicQuay],
    ['pevnina starter parcely', CELLS.starterLand],
    ['nábrežie starter parcely', CELLS.starterQuay],
  ])('%s → ok, cells = [bunka], costCents = cena 1 bunky', (_name, cell) => {
    const world = newWorld();
    expect(world.grid.at(cell.x, cell.y).road).toBe('none');
    expect(place(cell).validate(world)).toEqual({ ok: true, reasons: [], cells: [cell], costCents: ROAD_COST });
  });

  it('bunka (0, 54) je verejná pevnina harbor_01', () => {
    const cell = newWorld().grid.at(0, 54);
    expect(cell.terrain).toBe('land');
    expect(cell.parcelId).toBeNull();
  });

  it('prenajatá parcela (leased) je povolená', () => {
    const world = newWorld();
    const parcel = world.parcels.get(OTHER_FOR_SALE_PARCEL_ID);
    if (parcel === undefined) throw new Error('chýba parcela');
    parcel.ownership = 'leased';
    expect(place(CELLS.otherForSaleLand).validate(world).ok).toBe(true);
  });

  it('nevyžaduje napojenie na existujúcu cestu (izolovaná bunka)', () => {
    const world = newWorld();
    const { x, y } = CELLS.publicLandNamed;
    expect(world.grid.neighbors4(x, y).every((n) => world.grid.at(n.x, n.y).road === 'none')).toBe(true);
    expect(place(CELLS.publicLandNamed).validate(world).ok).toBe(true);
  });
});

describe('PlaceRoad.validate — odmietnutia', () => {
  it.each<[string, CellCoord, ValidationReason[]]>([
    ['hlboká voda', CELLS.deepWater, ['terrain']],
    ['plytká voda', CELLS.shallowWater, ['terrain']],
    ['blocked (verejná)', CELLS.publicBlocked, ['terrain']],
    ['parcela na predaj', CELLS.forSaleLand, ['parcel_not_owned']],
    ['blocked na parcele na predaj (dva dôvody jednej bunky)', CELLS.forSaleBlocked, ['terrain', 'parcel_not_owned']],
    ['mimo mapy vľavo', { x: -1, y: 20 }, ['out_of_bounds']],
    ['mimo mapy vpravo', { x: MAP.width, y: 20 }, ['out_of_bounds']],
    ['mimo mapy dole', { x: 20, y: MAP.height }, ['out_of_bounds']],
  ])('%s → %j, cells [], costCents 0', (_name, cell, reasons) => {
    expect(place(cell).validate(newWorld())).toEqual({ ok: false, reasons, cells: [], costCents: 0 });
  });

  it('bunka pod modulom → occupied', () => {
    const world = newWorld();
    world.grid.at(CELLS.starterLand.x, CELLS.starterLand.y).moduleId = world.ids.next();
    expect(place(CELLS.starterLand).validate(world).reasons).toEqual(['occupied']);
  });

  it('bunka s koľajou → priecestie (ADR-043 TR6-02): validácia prejde, bunka sa stane cestou a koľaj ostane v `Rail.crossings`', () => {
    const world = newWorld();
    world.grid.at(CELLS.publicLand.x, CELLS.publicLand.y).road = 'rail';
    expect(place(CELLS.publicLand).validate(world).ok).toBe(true);
    place(CELLS.publicLand).apply(world);
    expect(world.grid.at(CELLS.publicLand.x, CELLS.publicLand.y).road).toBe('road');
    expect(world.rail.isCrossing(world.grid.index(CELLS.publicLand.x, CELLS.publicLand.y))).toBe(true);
  });

  it('atomickosť: jedna zlá bunka odmietne celý príkaz; cells/costCents = platná časť', () => {
    const world = newWorld();
    const result = place(CELLS.starterLand, CELLS.forSaleLand, CELLS.publicLand).validate(world);
    expect(result).toEqual({
      ok: false,
      reasons: ['parcel_not_owned'],
      cells: [CELLS.starterLand, CELLS.publicLand],
      costCents: 2 * ROAD_COST,
    });
  });

  it('dôvody sú bez duplicít v kanonickom poradí VALIDATION_REASONS', () => {
    const result = place(CELLS.forSaleLand, CELLS.deepWater, { x: -5, y: -5 }, CELLS.shallowWater, CELLS.forSaleBlocked).validate(
      newWorld(),
    );
    expect(result.reasons).toEqual(['out_of_bounds', 'terrain', 'parcel_not_owned']);
  });

  it('prázdny zoznam → empty', () => {
    expect(place().validate(newWorld())).toEqual({ ok: false, reasons: ['empty'], cells: [], costCents: 0 });
  });

  it('všetky bunky už majú cestu → empty (nič nové)', () => {
    const world = newWorld();
    const [a, b] = world.map.starter.roads;
    expect(place(a, b, a).validate(world)).toEqual({ ok: false, reasons: ['empty'], cells: [], costCents: 0 });
  });

  it('zlá bunka medzi existujúcimi cestami nie je empty, ale jej dôvod', () => {
    const world = newWorld();
    expect(place(CELLS.starterRoad, CELLS.deepWater).validate(world).reasons).toEqual(['terrain']);
  });
});

describe('PlaceRoad.validate — cena a hotovosť', () => {
  it('existujúca cesta sa preskočí bez chyby a bez ceny', () => {
    const world = newWorld();
    const result = place(CELLS.starterRoad, CELLS.publicLand).validate(world);
    expect(result).toEqual({ ok: true, reasons: [], cells: [CELLS.publicLand], costCents: ROAD_COST });
  });

  it('duplicitné bunky sa počítajú raz, cells v poradí prvého výskytu', () => {
    const [a, b, c] = starterRow(3);
    const result = place(b, a, b, c, a, a).validate(newWorld());
    expect(result).toEqual({ ok: true, reasons: [], cells: [b, a, c], costCents: 3 * ROAD_COST });
  });

  it('cena = nové bunky × infrastructure.road.costPerCellCents (z defu, nie natvrdo)', () => {
    const world = newWorld(defsWith({ roadCostPerCellCents: 12345 }));
    expect(place(...starterRow(4)).validate(world).costCents).toBe(4 * 12345);
  });

  it('hotovosť presne rovná cene stačí', () => {
    const world = newWorld();
    setCash(world, 3 * ROAD_COST);
    expect(place(...starterRow(3)).validate(world).ok).toBe(true);
  });

  it('o cent menej → insufficient_funds (costCents ostáva cena)', () => {
    const world = newWorld();
    setCash(world, 3 * ROAD_COST - 1);
    expect(place(...starterRow(3)).validate(world)).toEqual({
      ok: false,
      reasons: ['insufficient_funds'],
      cells: starterRow(3),
      costCents: 3 * ROAD_COST,
    });
  });

  it('záporná hotovosť → insufficient_funds; spolu s dôvodmi buniek', () => {
    const world = newWorld();
    setCash(world, -1);
    expect(place(CELLS.publicLand, CELLS.deepWater).validate(world).reasons).toEqual(['terrain', 'insufficient_funds']);
  });

  it('cesta zadarmo (cena 0) prejde aj pri zápornej hotovosti', () => {
    const world = newWorld(defsWith({ roadCostPerCellCents: 0 }));
    setCash(world, -100);
    expect(place(CELLS.publicLand).validate(world)).toEqual({ ok: true, reasons: [], cells: [CELLS.publicLand], costCents: 0 });
  });
});

describe('PlaceRoad.validate nemení svet', () => {
  it('stav (vrátane Rng, hodín, hotovosti, ciest) a buffer udalostí ostanú nezmenené; výsledok je opakovateľný', () => {
    const world = newWorld();
    const before = hashState(world.serialize());
    const command = place(CELLS.publicLand, CELLS.forSaleLand, CELLS.starterRoad, { x: -1, y: 0 });
    const first = command.validate(world);
    const second = command.validate(world);
    expect(second).toEqual(first);
    expect(hashState(world.serialize())).toBe(before);
    expect(world.events.pending).toBe(0);
  });

  it('výsledok validácie je zmrazený (UI ho nemôže omylom zmeniť)', () => {
    const result = place(CELLS.publicLand).validate(newWorld());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cells)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
  });
});

describe('PlaceRoad.apply', () => {
  it('road = road na nových bunkách, hotovosť −= cena, práve RoadChanged + MoneyChanged(road_capex)', () => {
    const world = newWorld();
    const row = starterRow(3);
    const command = place(row[0], CELLS.starterRoad, row[1], row[0], row[2]);
    expect(command.validate(world).ok).toBe(true);
    command.apply(world);

    for (const { x, y } of row) expect(world.grid.at(x, y).road).toBe('road');
    expect(world.cashCents).toBe(START_CASH - 3 * ROAD_COST);
    expect(roadCount(world)).toBe(world.map.starter.roads.length + 3);
    expect(world.events.flush()).toEqual([
      { type: 'RoadChanged', cells: row },
      { type: 'MoneyChanged', cashCents: START_CASH - 3 * ROAD_COST, deltaCents: -3 * ROAD_COST, reason: 'road_capex' },
    ]);
  });

  it('RoadChanged.cells = presne zmenené bunky (existujúca cesta v ňom nie je)', () => {
    const world = newWorld();
    place(CELLS.starterRoad, CELLS.publicLand).apply(world);
    const [roadChanged] = world.events.flush();
    expect(roadChanged).toEqual({ type: 'RoadChanged', cells: [CELLS.publicLand] });
  });

  it('hotovosť rovná cene → po stavbe 0', () => {
    const world = newWorld();
    setCash(world, 2 * ROAD_COST);
    place(...starterRow(2)).apply(world);
    expect(world.cashCents).toBe(0);
  });

  it('cesta zadarmo: MoneyChanged s deltaCents +0 (nie −0)', () => {
    const world = newWorld(defsWith({ roadCostPerCellCents: 0 }));
    place(CELLS.publicLand).apply(world);
    const money = world.events.flush().find((e) => e.type === 'MoneyChanged');
    expect(money).toEqual({ type: 'MoneyChanged', cashCents: START_CASH, deltaCents: 0, reason: 'road_capex' });
    expect(Object.is(money?.type === 'MoneyChanged' ? money.deltaCents : NaN, 0)).toBe(true);
  });

  it('apply bez platnej validácie vyhodí Error a svet nezmení', () => {
    const world = newWorld();
    const before = hashState(world.serialize());
    expect(() => place(CELLS.publicLand, CELLS.deepWater).apply(world)).toThrow(/PlaceRoad\.apply: príkaz nie je platný \(terrain\)/);
    expect(hashState(world.serialize())).toBe(before);
    expect(world.events.pending).toBe(0);
  });

  it('príkaz nemá vlastný stav: ten istý objekt možno aplikovať do dvoch svetov s rovnakým výsledkom', () => {
    const command = place(...starterRow(5));
    const a = newWorld();
    const b = newWorld();
    command.apply(a);
    command.apply(b);
    expect(hashState(a.serialize())).toBe(hashState(b.serialize()));
  });
});
