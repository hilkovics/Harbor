// CargoLedgerState (T02-02): getState() je čistý JSON v kanonickom poradí, fromState() ho obnoví vrátane FIFO
// poradia a počítadiel (roundtrip), neplatný stav → CargoStateError s JSON pointerom. WorldState v2 ho ukladá ako `cargo` (T02-03).
import { describe, expect, it } from 'vitest';
import {
  CARGO_LOCATION_KINDS,
  CargoError,
  CargoLedger,
  CargoStateError,
  holderIdOf,
  type CargoLedgerState,
} from '@sim/cargo';
import { EntityIdAllocator, EventBus } from '@sim/core';
import type { SimEvent } from '@sim/events';
import {
  CARGO_DEFS,
  GRAIN,
  LIQUID_CHAIN,
  TEU,
  at,
  createHarness,
  flushMoves,
  id,
  moveThrough,
  snapshot,
  viaJson,
  type LedgerHarness,
} from './cargo-fixtures';

const SHIP_A = 100;
const SHIP_B = 101;
const BERTH = 10;

/**
 * Ledger so všetkým, čo stav musí zachovať: dve lode (jednotky v premiešanom poradí id), apron v poradí príchodu
 * odlišnom od id aj slotov, sklad, dock rampy s dvomi jednotkami, žeriav, kontrakt a exportované jednotky.
 */
function busyHarness(): LedgerHarness {
  const harness = createHarness();
  const { ledger } = harness;
  const units = [SHIP_B, SHIP_A, SHIP_B, SHIP_A, SHIP_A, SHIP_B, SHIP_A, SHIP_A, SHIP_B, SHIP_A].map(
    (ship, i) => ledger.create(i % 3 === 0 ? GRAIN : TEU, at.ship(ship), i % 4 === 0 ? id(500 + i) : null).id,
  );
  const [u1, u2, u3, u4, u5, u6, u7] = units;
  harness.ids.next(); // iná entita medzi jednotkami — id nie sú súvislé
  moveThrough(ledger, u4, [at.crane(20), at.apron(BERTH, 3)]);
  moveThrough(ledger, u2, [at.crane(20), at.apron(BERTH, 0)]);
  moveThrough(ledger, u7, [at.crane(21), at.apron(BERTH, 1)]);
  moveThrough(ledger, u5, [at.crane(21)]);
  moveThrough(ledger, u1, [at.crane(22), at.apron(BERTH + 1, 0), at.vehicle(30), at.storage(40, 3)]);
  moveThrough(ledger, u6, [at.vehicle(33), at.ramp(50, 1)]);
  moveThrough(ledger, u3, [at.vehicle(34), at.ramp(50, 1)]);
  const exportedUnit = ledger.create(TEU, at.ship(SHIP_A)).id;
  moveThrough(ledger, exportedUnit, LIQUID_CHAIN);
  harness.events.flush();
  return harness;
}

/** Nový ledger zo stavu nad alokátorom s rovnakým `nextId` (ako po načítaní save). */
function restore(harness: LedgerHarness, raw: unknown): LedgerHarness {
  const ids = new EntityIdAllocator(harness.ids.getState());
  const events = new EventBus<SimEvent>();
  const clock = { tick: harness.clock.tick };
  const deps = { cargoTypes: CARGO_DEFS.cargoTypes, ids, events, clock };
  return { ledger: CargoLedger.fromState(raw, deps), ids, events, clock, deps };
}

describe('CargoLedger.getState', () => {
  it('prázdny ledger', () => {
    expect(createHarness().ledger.getState()).toEqual({ createdCount: 0, exportedCount: 0, units: [] });
  });

  it('čistý JSON: JSON.parse(JSON.stringify(s)) je hlboko rovný s; exportované jednotky sa neukladajú', () => {
    const state = busyHarness().ledger.getState();
    expect(viaJson(state)).toEqual(state);
    expect(state.createdCount).toBe(11);
    expect(state.exportedCount).toBe(1);
    expect(state.units).toHaveLength(10);
    expect(state.units.every((unit) => unit.location.kind !== 'exported')).toBe(true);
  });

  it('kanonické poradie: druhy podľa CARGO_HOLDER_KINDS, držitelia vzostupne, v rámci držiteľa poradie indexu', () => {
    const { units } = busyHarness().ledger.getState();
    expect(units.map((unit) => [unit.location.kind, holderIdOf(unit.location), unit.id])).toEqual([
      ['on_ship', SHIP_A, 8], // loď: vzostupne podľa id
      ['on_ship', SHIP_A, 10],
      ['on_ship', SHIP_B, 9], // držitelia vzostupne podľa id
      ['in_crane', 21, 5],
      ['on_apron', BERTH, 4], // apron: poradie príchodu, nie id ani slot
      ['on_apron', BERTH, 2],
      ['on_apron', BERTH, 7],
      ['in_storage', 40, 1],
      ['at_ramp', 50, 6],
      ['at_ramp', 50, 3],
    ]);
    expect(Object.keys(units[4])).toEqual(['id', 'typeId', 'contractId', 'quantity', 'location']);
    expect(JSON.stringify(units[4].location)).toBe('{"kind":"on_apron","berthId":10,"slot":3}');
    expect(units.find((unit) => unit.id === 1)).toMatchObject({ typeId: GRAIN, contractId: 500, quantity: 25 });
  });

  it('výsledok nezdieľa objekty s ledgerom (úprava stavu ledger nezmení)', () => {
    const harness = busyHarness();
    const before = snapshot(harness);
    // Úmyselný zápis do readonly výsledku — overuje, že getState() vracia kópie.
    const state = harness.ledger.getState() as unknown as { units: { location: Record<string, unknown>; quantity: number }[] };
    state.units[0].location['shipId'] = 999;
    state.units[0].quantity = 0;
    state.units.pop();
    expect(snapshot(harness)).toEqual(before);
  });
});

describe('CargoLedger.fromState — roundtrip', () => {
  it('getState → JSON → fromState → getState je identický; počítadlá aj indexy sa zhodujú', () => {
    const original = busyHarness();
    const restored = restore(original, viaJson(original.ledger.getState()));
    expect(restored.ledger.getState()).toEqual(original.ledger.getState());
    expect(snapshot(restored)).toEqual(snapshot(original));
    for (const kind of CARGO_LOCATION_KINDS) expect(restored.ledger.countByKind(kind)).toBe(original.ledger.countByKind(kind));
    expect(restored.ledger.unitsOnApron(id(BERTH))).toEqual([4, 2, 7]);
    expect(restored.ledger.unitsAt('at_ramp', id(50))).toEqual([6, 3]);
    expect(restored.ledger.unitAtSlot('on_apron', id(BERTH), 1)).toBe(7);
    expect(restored.ledger.unitAtSlot('in_storage', id(40), 3)).toBe(1);
    expect(restored.ledger.get(id(5))).toEqual(original.ledger.get(id(5)));
    restored.ledger.assertConservation();
  });

  it('obnovený ledger sa ďalej správa rovnako (rovnaké udalosti, id a stav po tých istých operáciách)', () => {
    const original = busyHarness();
    const restored = restore(original, viaJson(original.ledger.getState()));
    const script = (harness: LedgerHarness): unknown => {
      const { ledger } = harness;
      harness.clock.tick = 77;
      const fresh = ledger.create(TEU, at.ship(SHIP_B)).id;
      const [first] = ledger.unitsOnApron(id(BERTH));
      ledger.move(first, at.vehicle(35));
      ledger.move(id(5), at.apron(BERTH, 3)); // slot uvoľnený jednotkou 4
      const [nextOnShip] = ledger.unitsOnShip(id(SHIP_A));
      ledger.move(nextOnShip, at.pipeline(70));
      moveThrough(ledger, id(6), [at.truck(60), at.exported()]);
      return { fresh, moves: flushMoves(harness.events), state: ledger.getState(), nextId: harness.ids.getState().nextId };
    };
    expect(script(restored)).toEqual(script(original));
  });

  it('vstupný stav sa nemení a obnovený ledger ho nezdieľa', () => {
    const original = busyHarness();
    const raw = viaJson(original.ledger.getState());
    const frozenCopy = JSON.stringify(raw);
    const restored = restore(original, raw);
    expect(JSON.stringify(raw)).toBe(frozenCopy);
    (raw.units[0].location as unknown as Record<string, unknown>)['shipId'] = 999;
    expect(restored.ledger.getState()).toEqual(original.ledger.getState());
  });

  it('shipový index sa po načítaní zoradí podľa id aj pri premiešanom poradí v stave', () => {
    const harness = createHarness({ nextId: 10 });
    const state: CargoLedgerState = {
      createdCount: 3,
      exportedCount: 0,
      units: [7, 2, 5].map((unitId) => ({ id: id(unitId), typeId: TEU, contractId: null, quantity: 1, location: at.ship(SHIP_A) })),
    };
    const ledger = CargoLedger.fromState(state, harness.deps);
    expect(ledger.unitsOnShip(id(SHIP_A))).toEqual([2, 5, 7]);
    ledger.assertConservation();
  });

  it('nové jednotky po načítaní dostanú id z alokátora sveta (bez kolízie s uloženými)', () => {
    const original = busyHarness();
    const restored = restore(original, viaJson(original.ledger.getState()));
    const unit = restored.ledger.create(TEU, at.ship(SHIP_A));
    expect(unit.id).toBe(original.ids.getState().nextId);
    expect(restored.ledger.createdCount).toBe(original.ledger.createdCount + 1);
    restored.ledger.assertConservation();
  });
});

describe('CargoLedger.fromState — neplatný stav', () => {
  const NEXT_ID = 20;
  const unit = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 1,
    typeId: TEU,
    contractId: null,
    quantity: 1,
    location: at.ship(SHIP_A),
    ...overrides,
  });
  const state = (units: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    createdCount: units.length,
    exportedCount: 0,
    units,
    ...overrides,
  });

  it.each<[string, string, unknown, RegExp]>([
    ['stav nie je objekt', '', [], /musí byť objekt, dostal pole/],
    ['neznámy kľúč stavu', '/liveCount', { ...state([]), liveCount: 0 }, /neznámy kľúč/],
    ['chýba exportedCount', '/exportedCount', { createdCount: 0, units: [] }, /chýba povinný kľúč/],
    ['záporné createdCount', '/createdCount', state([], { createdCount: -1 }), /celé číslo ≥ 0, dostal -1/],
    ['necelé exportedCount', '/exportedCount', state([], { exportedCount: 0.5 }), /celé číslo ≥ 0, dostal 0\.5/],
    ['units nie je pole', '/units', state([], { units: {} }), /musí byť pole, dostal objekt/],
    ['jednotka nie je objekt', '/units/0', state([7]), /musí byť objekt, dostal 7/],
    ['neznámy kľúč jednotky', '/units/0/owner', state([unit({ owner: 1 })]), /neznámy kľúč/],
    ['chýba quantity', '/units/0/quantity', state([{ id: 1, typeId: TEU, contractId: null, location: at.ship(1) }]), /chýba povinný kľúč/],
    ['id 0', '/units/0/id', state([unit({ id: 0 })]), /id musí byť celé číslo 1…19.*dostal 0/],
    ['id ≥ nextId', '/units/0/id', state([unit({ id: NEXT_ID })]), /menšie ako ids\.nextId.*dostal 20/],
    ['duplicitné id', '/units/1/id', state([unit(), unit({ location: at.ship(SHIP_B) })]), /duplicitné id 1 \(\/units\/0\)/],
    ['neznámy typ', '/units/0/typeId', state([unit({ typeId: 'crude_oil' })]), /neznámy typ nákladu "crude_oil"/],
    ['contractId 0', '/units/0/contractId', state([unit({ contractId: 0 })]), /null alebo celé číslo ≥ 1/],
    ['quantity 0', '/units/0/quantity', state([unit({ quantity: 0 })]), /celé číslo ≥ 1, dostal 0/],
    ['neznámy druh lokácie', '/units/0/location/kind', state([unit({ location: { kind: 'in_warehouse' } })]), /neznámy druh/],
    ['neplatný držiteľ', '/units/0/location/shipId', state([unit({ location: { kind: 'on_ship', shipId: -2 } })]), /≥ 1/],
    ['uložená exportovaná jednotka', '/units/0/location/kind', state([unit({ location: at.exported() })]), /len v exportedCount/],
    [
      'dvakrát obsadený slot apronu',
      '/units/1/location',
      state([unit({ location: at.apron(BERTH, 2) }), unit({ id: 2, location: at.apron(BERTH, 2) })]),
      /miesto on_apron\(berthId=10, slot=2\) už obsadila jednotka \/units\/0/,
    ],
    ['createdCount ≠ živé + exportované', '/createdCount', state([unit()], { createdCount: 3, exportedCount: 1 }), /3 ≠ živé 1 \+ exportedCount 1/],
  ])('%s → CargoStateError na %s', (_name, path, raw, problem) => {
    const harness = createHarness({ nextId: NEXT_ID });
    let caught: unknown;
    try {
      CargoLedger.fromState(raw, harness.deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CargoStateError);
    const error = caught as CargoStateError;
    expect(error).toBeInstanceOf(CargoError);
    expect(error.code).toBe('state');
    expect(error.path).toBe(path);
    expect(error.problem).toMatch(problem);
    expect(error.message).toBe(`CargoLedgerState${path}: ${error.problem}`);
  });

  it('rovnaký slot na rôznych berthoch a rovnaký dock rampy sú platné', () => {
    const harness = createHarness({ nextId: NEXT_ID });
    const raw = state([
      unit({ location: at.apron(BERTH, 2) }),
      unit({ id: 2, location: at.apron(BERTH + 1, 2) }),
      unit({ id: 3, location: at.ramp(50, 0) }),
      unit({ id: 4, location: at.ramp(50, 0) }),
    ]);
    const ledger = CargoLedger.fromState(raw, harness.deps);
    expect(ledger.unitsAt('at_ramp', id(50))).toEqual([3, 4]);
    ledger.assertConservation();
  });
});
