// Typy ciest v príkazoch (T03-18, ADR-020; docs/tasks/phase-03.md „Doplnok od používateľa" rozhodnutie 12):
// PlaceRoad { cells, kind?, dirs? } — predvolený typ, ceny z defu, smery jednosmerky, invalid_road_kind/invalid_direction,
// prestavba (cena = nový typ − refundácia starého, udalosti road_sale + road_capex, occupied, parcela) a RemoveRoad
// s refundáciou podľa typu bunky.
import { describe, expect, it } from 'vitest';
import { CommandError, PlaceRoadCommand, RemoveRoadCommand, type ValidationReason } from '@sim/commands';
import type { CellCoord } from '@sim/grid';
import type { World } from '@sim/world';
import { DEPOT_OUTSIDE, addVehicleTo, depotWorld } from '../vehicles/vehicle-fixtures';
import { CELLS, DEFS, REFUND_RATE, START_CASH, defsWith, hashState, newWorld, starterRow } from './command-fixtures';
import { setCash } from '../helpers/economy';

const KINDS = DEFS.infrastructure.roadKinds;
const TWO_LANE = KINDS.two_lane.costPerCellCents;
const ONE_LANE = KINDS.one_lane.costPerCellCents;
const ONE_WAY = KINDS.one_way.costPerCellCents;

const place = (cells: readonly CellCoord[], kind?: string, dirs?: readonly string[]): PlaceRoadCommand => new PlaceRoadCommand(cells, kind, dirs);

function cellOf(world: World, { x, y }: CellCoord) {
  return world.grid.at(x, y);
}

/** Aplikuje platný príkaz a vráti udalosti. */
function applyOk(world: World, command: PlaceRoadCommand | RemoveRoadCommand) {
  expect(command.validate(world).ok).toBe(true);
  command.apply(world);
  return world.events.flush();
}

describe('PlaceRoad — typ cesty a cena z defu', () => {
  it('bez kind → two_lane bez smeru, cena two_lane (spätná kompatibilita F1–F3)', () => {
    const world = newWorld();
    const row = starterRow(2);
    expect(place(row).validate(world)).toEqual({ ok: true, reasons: [], cells: row, costCents: 2 * TWO_LANE });
    applyOk(world, place(row));
    for (const cell of row) expect([cellOf(world, cell).roadKind, cellOf(world, cell).roadDir]).toEqual(['two_lane', null]);
  });

  it.each([
    ['one_lane', ONE_LANE],
    ['two_lane', TWO_LANE],
  ])('kind %s → cena %i za bunku, bunky dostanú typ', (kind, unit) => {
    const world = newWorld();
    const row = starterRow(3);
    expect(place(row, kind).validate(world).costCents).toBe(3 * unit);
    const events = applyOk(world, place(row, kind));
    expect(world.cashCents).toBe(START_CASH - 3 * unit);
    expect(events).toEqual([
      { type: 'RoadChanged', cells: row },
      { type: 'MoneyChanged', cashCents: START_CASH - 3 * unit, deltaCents: -3 * unit, reason: 'road_capex' },
    ]);
    for (const cell of row) expect([cellOf(world, cell).road, cellOf(world, cell).roadKind, cellOf(world, cell).roadDir]).toEqual(['road', kind, null]);
  });

  it('one_way: cena one_way a smer každej bunky z dirs (rovnaký index ako cells)', () => {
    const world = newWorld();
    const [a, b, c] = starterRow(3);
    const command = place([a, b, c], 'one_way', ['E', 'E', 'S']);
    expect(command.validate(world).costCents).toBe(3 * ONE_WAY);
    applyOk(world, command);
    expect([a, b, c].map((cell) => [cellOf(world, cell).roadKind, cellOf(world, cell).roadDir])).toEqual([
      ['one_way', 'E'],
      ['one_way', 'E'],
      ['one_way', 'S'],
    ]);
  });

  it('duplicitná bunka: platí smer jej prvého výskytu', () => {
    const world = newWorld();
    const [a, b] = starterRow(2);
    applyOk(world, place([a, b, a], 'one_way', ['N', 'E', 'W']));
    expect([cellOf(world, a).roadDir, cellOf(world, b).roadDir]).toEqual(['N', 'E']);
  });

  it('ceny sa čítajú z defu (nie natvrdo)', () => {
    const world = newWorld(defsWith({ oneLaneCostPerCellCents: 777, oneWayCostPerCellCents: 999 }));
    const row = starterRow(2);
    expect(place(row, 'one_lane').validate(world).costCents).toBe(2 * 777);
    expect(place(row, 'one_way', ['E', 'E']).validate(world).costCents).toBe(2 * 999);
  });

  it('konštruktor: kind/dirs zlého typu → CommandError; roadKind getter', () => {
    expect(() => new PlaceRoadCommand([], 5 as unknown as string)).toThrow(CommandError);
    expect(() => new PlaceRoadCommand([], 'one_way', 'E' as unknown as string[])).toThrow(/PlaceRoad\/dirs: musí byť pole reťazcov/);
    expect(place([]).roadKind).toBe('two_lane');
    expect(place([], 'one_way').roadKind).toBe('one_way');
    expect(place([], 'nope').roadKind).toBeUndefined();
  });
});

describe('PlaceRoad — invalid_road_kind a invalid_direction (bunky sa neposudzujú)', () => {
  const [a, b] = starterRow(2);
  it.each<[string, PlaceRoadCommand, ValidationReason]>([
    ['neznámy typ', place([a], 'four_lane'), 'invalid_road_kind'],
    ['prázdny reťazec', place([a], ''), 'invalid_road_kind'],
    ['neznámy typ aj so smermi', place([a], 'nope', ['X']), 'invalid_road_kind'],
    ['jednosmerka bez dirs', place([a, b], 'one_way'), 'invalid_direction'],
    ['menej smerov než buniek', place([a, b], 'one_way', ['E']), 'invalid_direction'],
    ['viac smerov než buniek', place([a], 'one_way', ['E', 'E']), 'invalid_direction'],
    ['smer mimo N/E/S/W', place([a, b], 'one_way', ['E', 'x']), 'invalid_direction'],
    ['dirs pri dvojpruhovej', place([a], 'two_lane', ['E']), 'invalid_direction'],
    ['dirs pri jednopruhovej', place([a], 'one_lane', ['E']), 'invalid_direction'],
    ['dirs bez kind (= two_lane)', place([a], undefined, ['E']), 'invalid_direction'],
  ])('%s → [%s], cells [], costCents 0', (_name, command, reason) => {
    const world = newWorld();
    expect(command.validate(world)).toEqual({ ok: false, reasons: [reason], cells: [], costCents: 0 });
  });

  it('aj so zlou bunkou vráti len chybu tvaru (bunky sa neposudzujú)', () => {
    expect(place([CELLS.deepWater, { x: -1, y: 0 }], 'nope').validate(newWorld()).reasons).toEqual(['invalid_road_kind']);
  });

  it('prázdny ťah jednosmerky s prázdnymi dirs je platný tvar → empty', () => {
    expect(place([], 'one_way', []).validate(newWorld()).reasons).toEqual(['empty']);
  });
});

describe('PlaceRoad — prestavba (RemoveRoad + PlaceRoad v jednom kroku)', () => {
  const starter = CELLS.starterRoad;

  it('rovnaký typ aj smer → preskočí sa zadarmo (empty)', () => {
    const world = newWorld();
    expect(place([starter], 'two_lane').validate(world)).toEqual({ ok: false, reasons: ['empty'], cells: [], costCents: 0 });
    const [a, b] = starterRow(2);
    applyOk(world, place([a, b], 'one_way', ['E', 'E']));
    expect(place([a, b], 'one_way', ['E', 'E']).validate(world).reasons).toEqual(['empty']);
  });

  it('two_lane → one_lane: cena = nový − refundácia starého; udalosti RoadChanged, road_sale, road_capex', () => {
    const world = newWorld();
    const refund = TWO_LANE * REFUND_RATE;
    const net = ONE_LANE - refund;
    const command = place([starter], 'one_lane');
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: [starter], costCents: net });
    expect(command.quote(world)).toMatchObject({ buildCents: ONE_LANE, refundCents: refund, costCents: net });
    const version = world.roadVersion;
    const events = applyOk(world, command);
    expect(events).toEqual([
      { type: 'RoadChanged', cells: [starter] },
      { type: 'MoneyChanged', cashCents: START_CASH + refund, deltaCents: refund, reason: 'road_sale' },
      { type: 'MoneyChanged', cashCents: START_CASH - net, deltaCents: -ONE_LANE, reason: 'road_capex' },
    ]);
    expect(world.cashCents).toBe(START_CASH - net);
    expect(world.roadVersion).toBe(version + 1);
    expect([cellOf(world, starter).roadKind, cellOf(world, starter).roadDir]).toEqual(['one_lane', null]);
  });

  it('zmena smeru jednosmerky je prestavba (refundácia one_way, stavba one_way)', () => {
    const world = newWorld();
    const [a, b] = starterRow(2);
    applyOk(world, place([a, b], 'one_way', ['E', 'E']));
    const command = place([a, b], 'one_way', ['W', 'E']);
    expect(command.quote(world)).toMatchObject({ cells: [a], buildCents: ONE_WAY, refundCents: ONE_WAY * REFUND_RATE, costCents: ONE_WAY * (1 - REFUND_RATE) });
    applyOk(world, command);
    expect([cellOf(world, a).roadDir, cellOf(world, b).roadDir]).toEqual(['W', 'E']);
  });

  it('jednosmerka → dvojpruhová: smer sa zmaže', () => {
    const world = newWorld();
    const [a] = starterRow(1);
    applyOk(world, place([a], 'one_way', ['N']));
    applyOk(world, place([a]));
    expect([cellOf(world, a).roadKind, cellOf(world, a).roadDir]).toEqual(['two_lane', null]);
  });

  it('mix nových a prestavaných buniek: stavba za všetky, refundácia zo súčtu starých cien raz za príkaz', () => {
    const world = newWorld(defsWith({ removalRefundRate: 0.29 }));
    const roads = world.map.starter.roads.slice(0, 3);
    const fresh = starterRow(2);
    const command = place([...roads, ...fresh], 'one_lane');
    const refund = Math.floor((3 * TWO_LANE * 2900) / 10_000);
    expect(refund).toBe(174_000);
    expect(command.quote(world)).toMatchObject({ ok: true, cells: [...roads, ...fresh], buildCents: 5 * ONE_LANE, refundCents: refund, costCents: 5 * ONE_LANE - refund });
  });

  it('refundácia vyššia než stavba → záporná cena (príjem), prejde aj pri zápornej hotovosti', () => {
    const world = newWorld(defsWith({ oneLaneCostPerCellCents: 50_000 }));
    setCash(world, -10);
    const command = place([starter], 'one_lane');
    expect(command.validate(world)).toEqual({ ok: true, reasons: [], cells: [starter], costCents: 50_000 - TWO_LANE / 2 });
    const events = applyOk(world, command);
    expect(events.filter((e) => e.type === 'MoneyChanged').map((e) => (e.type === 'MoneyChanged' ? [e.reason, e.deltaCents] : []))).toEqual([
      ['road_sale', TWO_LANE / 2],
      ['road_capex', -50_000],
    ]);
    expect(world.cashCents).toBe(-10 - 50_000 + TWO_LANE / 2);
  });

  it('insufficient_funds počíta s čistou cenou prestavby', () => {
    const world = newWorld();
    const net = ONE_LANE - TWO_LANE * REFUND_RATE;
    setCash(world, net);
    expect(place([starter], 'one_lane').validate(world).ok).toBe(true);
    setCash(world, net - 1);
    expect(place([starter], 'one_lane').validate(world)).toEqual({ ok: false, reasons: ['insufficient_funds'], cells: [starter], costCents: net });
  });

  it('bunka s vozidlom (stojace aj cieľ rozbehnutého úseku) → occupied; susedná bunka ide', () => {
    const { world, depot } = depotWorld();
    addVehicleTo(world, depot.id);
    expect(place([DEPOT_OUTSIDE], 'one_lane').validate(world).reasons).toEqual(['occupied']);
    const from = world.grid.index(40, 24);
    const to = world.grid.index(41, 24);
    addVehicleTo(world, depot.id, { route: [from, to], progress: 0.5, x: 41, y: 24.5 });
    expect(place([{ x: 40, y: 24 }], 'one_lane').validate(world).reasons).toEqual(['occupied']);
    expect(place([{ x: 41, y: 24 }], 'one_lane').validate(world).reasons).toEqual(['occupied']);
    expect(place([{ x: 42, y: 24 }], 'one_lane').validate(world).ok).toBe(true);
  });

  it('prestavba cesty na parcele na predaj → parcel_not_owned (ADR-008)', () => {
    const world = newWorld();
    cellOf(world, CELLS.forSaleLand).road = 'road';
    expect(place([CELLS.forSaleLand], 'one_lane').validate(world).reasons).toEqual(['parcel_not_owned']);
    expect(place([CELLS.forSaleLand]).validate(world).reasons).toEqual(['empty']);
  });

  it('validate/quote nemení svet; výsledok validate má len 4 kľúče', () => {
    const world = newWorld();
    const before = hashState(world.serialize());
    const command = place([starter, ...starterRow(2)], 'one_lane');
    expect(Object.keys(command.validate(world))).toEqual(['ok', 'reasons', 'cells', 'costCents']);
    command.quote(world);
    expect(hashState(world.serialize())).toBe(before);
    expect(world.events.pending).toBe(0);
  });
});

describe('RemoveRoad — refundácia podľa typu bunky (ADR-012, ADR-020)', () => {
  it('jednopruhová bunka vráti 50 % ceny one_lane; bunka sa normalizuje (two_lane, bez smeru)', () => {
    const world = newWorld();
    const [a] = starterRow(1);
    applyOk(world, place([a], 'one_lane'));
    const cash = world.cashCents;
    const command = new RemoveRoadCommand([a]);
    expect(command.validate(world).costCents).toBe(-ONE_LANE * REFUND_RATE);
    const events = applyOk(world, command);
    expect(events).toEqual([
      { type: 'RoadChanged', cells: [a] },
      { type: 'MoneyChanged', cashCents: cash + ONE_LANE * REFUND_RATE, deltaCents: ONE_LANE * REFUND_RATE, reason: 'road_sale' },
    ]);
    expect([cellOf(world, a).road, cellOf(world, a).roadKind, cellOf(world, a).roadDir]).toEqual(['none', 'two_lane', null]);
  });

  it('mix typov: refundácia zo súčtu cien typov, zaokrúhlená raz za príkaz', () => {
    const world = newWorld(defsWith({ removalRefundRate: 0.29 }));
    const [a, b] = starterRow(2);
    applyOk(world, place([a], 'one_way', ['E']));
    applyOk(world, place([b], 'one_lane'));
    const starter = CELLS.starterRoad;
    const command = new RemoveRoadCommand([a, b, starter]);
    const expected = Math.floor(((ONE_WAY + ONE_LANE + TWO_LANE) * 2900) / 10_000);
    expect(command.quote(world)).toMatchObject({ buildCents: 0, refundCents: expected, costCents: -expected });
  });
});
