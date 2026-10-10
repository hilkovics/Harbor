// Ledger a vlak (TR6-01, ADR-043, TERMINAL_2 §6.10): in_storage → in_handler → in_train → exported a opačne, vznik exportu priamo v `in_train`, jedinečné miesto vo vlaku a save.
import { describe, expect, it } from 'vitest';
import { CargoError, CargoLedger, CargoTransitionError } from '@sim/cargo';
import { EXPORT_CONTRACT, EXPORT_LABELS, TEU, at, createHarness, id, moveThrough, viaJson } from './cargo-fixtures';

describe('CargoLedger a vlak', () => {
  it('nakládka: in_storage → in_handler(RMG) → in_train → exported; konzervácia po každom kroku', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.ship(1));
    moveThrough(harness.ledger, unit.id, [at.crane(2), at.vehicle(3), at.storage(4, 0), at.handler(5), at.train(6, 2)]);
    expect(harness.ledger.get(unit.id)?.location).toEqual({ kind: 'in_train', trainId: 6, slot: 2 });
    expect(harness.ledger.countAt('in_train', id(6))).toBe(1);
    harness.ledger.move(unit.id, at.exported());
    expect(harness.ledger.exportedCount).toBe(1);
    harness.ledger.assertConservation();
  });

  it('vykládka: in_train → in_handler → in_storage; z vlaku sa nejde priamo do skladu ani do kamióna', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.truck(1), EXPORT_CONTRACT, EXPORT_LABELS);
    moveThrough(harness.ledger, unit.id, [at.handler(5), at.train(6, 0), at.handler(5), at.storage(4, 1)]);
    const other = harness.ledger.create(TEU, at.truck(1), EXPORT_CONTRACT, EXPORT_LABELS);
    moveThrough(harness.ledger, other.id, [at.handler(5), at.train(6, 1)]);
    expect(() => harness.ledger.move(other.id, at.storage(4, 2))).toThrowError(CargoTransitionError);
    expect(() => harness.ledger.move(other.id, at.truck(9))).toThrowError(CargoTransitionError);
    expect(harness.ledger.get(other.id)?.location).toEqual(at.train(6, 1));
  });

  it('export po koľaji vzniká priamo v `in_train` (miesto vzniku exportu), import nie', () => {
    const harness = createHarness();
    const unit = harness.ledger.create(TEU, at.train(6, 0), EXPORT_CONTRACT, EXPORT_LABELS);
    expect(unit.location).toEqual(at.train(6, 0));
    expect(() => harness.ledger.create(TEU, at.train(6, 1))).toThrowError(CargoTransitionError);
    expect(() => harness.ledger.create(TEU, at.train(6, 0), EXPORT_CONTRACT, EXPORT_LABELS)).toThrowError(CargoError);
  });

  it('miesto vo vlaku je jedinečné; presun v tom istom vlaku na obsadené miesto sa odmietne bez zmeny', () => {
    const harness = createHarness();
    const a = harness.ledger.create(TEU, at.train(6, 0), EXPORT_CONTRACT, EXPORT_LABELS);
    const b = harness.ledger.create(TEU, at.train(6, 1), EXPORT_CONTRACT, EXPORT_LABELS);
    expect(harness.ledger.unitAtSlot('in_train', id(6), 1)).toBe(b.id);
    expect(() => harness.ledger.move(a.id, at.handler(8))).not.toThrow();
    expect(() => harness.ledger.move(a.id, at.train(6, 1))).toThrowError(/slot|miesto/i);
    expect(harness.ledger.get(a.id)?.location).toEqual(at.handler(8));
  });

  it('save: getState → fromState zachová lokáciu v `in_train` aj poradie', () => {
    const harness = createHarness();
    harness.ledger.create(TEU, at.train(6, 2), EXPORT_CONTRACT, EXPORT_LABELS);
    harness.ledger.create(TEU, at.train(6, 0), EXPORT_CONTRACT, EXPORT_LABELS);
    const state = viaJson(harness.ledger.getState());
    const restored = CargoLedger.fromState(state, harness.deps);
    expect(restored.getState()).toEqual(state);
    expect(restored.unitsAt('in_train', id(6))).toEqual(harness.ledger.unitsAt('in_train', id(6)));
  });
});
