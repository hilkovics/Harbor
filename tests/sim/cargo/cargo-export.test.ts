// Export náklad v ledgeri (T6A-01, ADR-032 body 2, 3, 5, 8): štítky jednotky, vznik exportu v kamióne, reverzný
// reťazec až po `shipped` (konečný stav s počítadlom `shippedCount`), VGM hold cez `setHold` a stowage poradie.
import { describe, expect, it } from 'vitest';
import {
  CARGO_SPAWN_KIND_BY_DIRECTION,
  CargoError,
  CargoLedger,
  CargoTransitionError,
  DEFAULT_WEIGHT_CLASS,
  IMPORT_LABELS,
  STOWAGE_WEIGHT_RANK,
  compareStowageOrder,
  type CargoUnit,
  type WeightClass,
} from '@sim/cargo';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import {
  EXPORT_CHAIN,
  EXPORT_CONTRACT,
  EXPORT_LABELS,
  LAST_MINUTE_CHAIN,
  TEU,
  at,
  createHarness,
  flushMoves,
  id,
  moveThrough,
  snapshot,
  viaJson,
} from './cargo-fixtures';

const TRUCK = 60;
const SHIP = 90;

describe('CargoLedger.create — štítky a miesto vzniku podľa smeru (ADR-032)', () => {
  it('import bez štítkov dostane IMPORT_LABELS (medium bez Rng) a hold null', () => {
    const { ledger } = createHarness();
    const unit = ledger.create(TEU, at.ship(SHIP));
    expect(unit).toMatchObject({ ...IMPORT_LABELS, hold: null });
    expect(unit.weightClass).toBe(DEFAULT_WEIGHT_CLASS);
    expect(DEFAULT_WEIGHT_CLASS).toBe('medium');
  });

  it('export vzniká v kamióne so štítkami bookingu; udalosť nevzniká', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    expect(unit).toEqual({
      id: 1,
      typeId: TEU,
      contractId: EXPORT_CONTRACT,
      voyageId: 7,
      lineId: 'blue_anchor',
      direction: 'export',
      destinationPort: 'Rotterdam',
      weightClass: 'heavy',
      hold: null,
      status: 'available',
      repairUntilTick: null,
      quantity: 1,
      location: at.truck(TRUCK),
    });
    expect(Object.isFrozen(unit)).toBe(true);
    expect(harness.ledger.unitsAt('in_truck', id(TRUCK))).toEqual([unit.id]);
    expect(harness.events.pending).toBe(0);
    expect(CARGO_SPAWN_KIND_BY_DIRECTION).toEqual({ import: 'on_ship', export: 'in_truck', tranship: 'on_ship', empty: 'in_truck' });
  });

  it.each([
    ['export na lodi', at.ship(SHIP), EXPORT_LABELS],
    ['import v kamióne', at.truck(TRUCK), IMPORT_LABELS],
    ['export na rampe', at.ramp(50, 0), EXPORT_LABELS],
  ])('%s → CargoTransitionError, stav bez zmeny', (_name, location, labels) => {
    const harness = createHarness();
    const before = snapshot(harness);
    const contractId = labels.direction === 'export' ? EXPORT_CONTRACT : null;
    expect(() => harness.ledger.create(TEU, location, contractId, labels)).toThrow(CargoTransitionError);
    expect(snapshot(harness)).toEqual(before);
  });

  it.each([
    ['export bez kontraktu', null, EXPORT_LABELS, /export jednotka musí mať kontrakt/],
    ['export bez voyage', EXPORT_CONTRACT, { ...EXPORT_LABELS, voyageId: null }, /export jednotka musí mať voyage/],
    ['export bez linky', EXPORT_CONTRACT, { ...EXPORT_LABELS, lineId: null }, /export jednotka musí mať linku/],
    ['export bez cieľového prístavu', EXPORT_CONTRACT, { ...EXPORT_LABELS, destinationPort: null }, /export jednotka musí mať cieľový prístav/],
    ['import s cieľovým prístavom', null, { ...IMPORT_LABELS, destinationPort: 'Hamburg' }, /import jednotka nemá cieľový prístav/],
    ['neznáma hmotnostná trieda', EXPORT_CONTRACT, { ...EXPORT_LABELS, weightClass: 'huge' as WeightClass }, /hmotnostná trieda/],
  ])('%s → CargoError(invalid_input), id sa nespotrebuje', (_name, contractId, labels, problem) => {
    const harness = createHarness();
    const before = snapshot(harness);
    let caught: unknown;
    try {
      harness.ledger.create(TEU, at.truck(TRUCK), contractId as ContractId | null, labels);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CargoError);
    expect((caught as CargoError).code).toBe('invalid_input');
    expect((caught as CargoError).message).toMatch(problem);
    expect(snapshot(harness)).toEqual(before);
  });
});

describe('reverzný reťazec a shipped (ADR-032 bod 3)', () => {
  it.each([
    ['cez sklad', EXPORT_CHAIN],
    ['last minute bez skladu', LAST_MINUTE_CHAIN],
  ])('export %s: každý krok CargoMoved, na konci jednotka zmizne a shippedCount = 1', (_name, chain) => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    moveThrough(harness.ledger, unit.id, chain);
    const moves = flushMoves(harness.events);
    expect(moves.map((move) => move.to.kind)).toEqual(chain.map((location) => location.kind));
    expect(harness.ledger.get(unit.id)).toBeUndefined();
    expect(harness.ledger.shippedCount).toBe(1);
    expect(harness.ledger.exportedCount).toBe(0);
    expect(harness.ledger.countByKind('shipped')).toBe(1);
    expect(harness.ledger.liveCount).toBe(0);
    expect(() => harness.ledger.move(unit.id, at.ship(SHIP))).toThrow(/neexistuje/);
  });

  it('štítky a hold prežijú každý presun (move vytvorí novú zmrazenú jednotku s novou lokáciou)', () => {
    const { ledger } = createHarness();
    const unit = ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    ledger.setHold(unit.id, { reason: 'vgm', untilTick: 40 });
    ledger.move(unit.id, at.ramp(50, 0));
    const moved = ledger.get(unit.id) as CargoUnit;
    expect(moved).toMatchObject({ ...EXPORT_LABELS, contractId: EXPORT_CONTRACT, hold: { reason: 'vgm', untilTick: 40 }, location: at.ramp(50, 0) });
    expect(Object.isFrozen(moved)).toBe(true);
  });

  it('getState nesie shippedCount a štítky; fromState obnoví ledger s rovnakým stavom aj počtami', () => {
    const harness = createHarness();
    const shipped = harness.ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    moveThrough(harness.ledger, shipped.id, EXPORT_CHAIN);
    const held = harness.ledger.create(TEU, at.truck(TRUCK + 1), EXPORT_CONTRACT, { ...EXPORT_LABELS, weightClass: 'light' });
    harness.ledger.setHold(held.id, { reason: 'vgm', untilTick: 99 });
    harness.ledger.create(TEU, at.ship(SHIP));
    const state = viaJson(harness.ledger.getState());
    expect(state.shippedCount).toBe(1);
    expect(state.createdCount).toBe(3);
    const restored = CargoLedger.fromState(state, harness.deps);
    expect(restored.getState()).toEqual(state);
    expect(restored.shippedCount).toBe(1);
    expect(restored.get(held.id)?.hold).toEqual({ reason: 'vgm', untilTick: 99 });
    restored.assertConservation();
  });
});

describe('CargoLedger.countExportsAt — počet jednotiek smeru export u držiteľa (T6A-09b)', () => {
  it('rozlišuje import a export na lodi O(1) bez ohľadu na kontrakt; presun a odchod z lode počítadlo upravia', () => {
    const { ledger } = createHarness();
    const imp = ledger.create(TEU, at.ship(SHIP));
    const exp = ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    const exp2 = ledger.create(TEU, at.truck(TRUCK + 1), EXPORT_CONTRACT, { ...EXPORT_LABELS, weightClass: 'light' });
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countExportsAt('on_ship', id(SHIP))]).toEqual([1, 0]);
    moveThrough(ledger, exp.id, EXPORT_CHAIN.slice(0, -1));
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countExportsAt('on_ship', id(SHIP))]).toEqual([2, 1]);
    moveThrough(ledger, exp2.id, EXPORT_CHAIN.slice(0, -1));
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countExportsAt('on_ship', id(SHIP))]).toEqual([3, 2]);
    ledger.move(exp.id, { kind: 'shipped' });
    expect([ledger.countAt('on_ship', id(SHIP)), ledger.countExportsAt('on_ship', id(SHIP))]).toEqual([2, 1]);
    expect(ledger.countExportsAt('on_ship', id(999))).toBe(0);
    expect(ledger.get(imp.id)?.direction).toBe('import');
    ledger.assertConservation();
  });

  it('obnova zo save zostaví počítadlo z jednotiek', () => {
    const harness = createHarness();
    harness.ledger.create(TEU, at.ship(SHIP));
    const exp = harness.ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    moveThrough(harness.ledger, exp.id, EXPORT_CHAIN.slice(0, -1));
    const restored = CargoLedger.fromState(viaJson(harness.ledger.getState()), harness.deps);
    expect(restored.countExportsAt('on_ship', id(SHIP))).toBe(1);
    expect(restored.countAt('on_ship', id(SHIP))).toBe(2);
    restored.assertConservation();
  });
});

describe('CargoLedger.setHold (VGM hold, ADR-032 bod 5)', () => {
  it('zmení len hold — poloha, poradie v indexe aj počty ostanú, udalosť nevzniká; null hold uvoľní', () => {
    const harness = createHarness();
    const { ledger } = harness;
    const a = ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    const b = ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    const held = ledger.setHold(a.id, { reason: 'vgm', untilTick: 12 });
    expect(held).toEqual({ ...a, hold: { reason: 'vgm', untilTick: 12 } });
    expect(Object.isFrozen(held.hold)).toBe(true);
    expect(ledger.unitsAt('in_truck', id(TRUCK))).toEqual([a.id, b.id]);
    expect(harness.events.pending).toBe(0);
    expect(ledger.setHold(a.id, null).hold).toBeNull();
    ledger.assertConservation();
  });

  it.each([
    ['neznáma jednotka', 'unknown_unit', (ledger: CargoLedger) => ledger.setHold(id(999), null)],
    ['import jednotka', 'invalid_input', (ledger: CargoLedger) => ledger.setHold(ledger.create(TEU, at.ship(SHIP)).id, { reason: 'vgm', untilTick: 5 })],
    ['záporný tick', 'invalid_input', (ledger: CargoLedger, unit: EntityId) => ledger.setHold(unit, { reason: 'vgm', untilTick: -1 })],
    ['neznámy dôvod', 'invalid_input', (ledger: CargoLedger, unit: EntityId) => ledger.setHold(unit, { reason: 'damage' as 'vgm', untilTick: 5 })],
  ])('%s → CargoError(%s), jednotka bez zmeny', (_name, code, act) => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(TRUCK), EXPORT_CONTRACT, EXPORT_LABELS);
    const before = harness.ledger.get(unit.id);
    let caught: unknown;
    try {
      act(harness.ledger, unit.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CargoError);
    expect((caught as CargoError).code).toBe(code);
    expect(harness.ledger.get(unit.id)).toBe(before);
  });
});

describe('stowage plán F6a (ADR-032 bod 8)', () => {
  const key = (unitId: number, weightClass: WeightClass) => ({ id: unitId as EntityId, weightClass });

  it('heavy → medium → light, pri zhode vzostupne podľa id', () => {
    expect(STOWAGE_WEIGHT_RANK).toEqual({ heavy: 0, medium: 1, light: 2 });
    const units = [key(5, 'light'), key(2, 'medium'), key(9, 'heavy'), key(1, 'light'), key(4, 'heavy'), key(3, 'medium')];
    expect([...units].sort(compareStowageOrder).map((unit) => unit.id)).toEqual([4, 9, 2, 3, 1, 5]);
  });

  it('úplné usporiadanie: rôzne jednotky nie sú nikdy rovnocenné, antisymetria', () => {
    const units = [key(1, 'heavy'), key(2, 'heavy'), key(3, 'light')];
    for (const a of units) {
      for (const b of units) {
        const ab = compareStowageOrder(a, b);
        expect(Math.sign(ab) + Math.sign(compareStowageOrder(b, a))).toBe(0);
        expect(ab === 0).toBe(a === b);
      }
    }
  });

  it('voyage a štítky exportu sú branded typy (VoyageId) — test len typov', () => {
    const voyage: VoyageId = EXPORT_LABELS.voyageId as VoyageId;
    expect(voyage).toBe(7);
  });
});
