// Stav reeferu v ledgeri (TR5-01, ADR-042): vznik (na palube napájaný, inak bez napájania), `setReefer`, uloženie v save (v14) a odmietnutie neplatného stavu.
import { describe, expect, it } from 'vitest';
import { CargoError, CargoLedger, CargoStateError, needsPlug, reeferStateProblem, type ReeferState } from '@sim/cargo';
import { createHarness, EXPORT_CONTRACT, EXPORT_LABELS, TEU, at, id, viaJson } from './cargo-fixtures';

const REEFER_LABELS = { direction: 'import' as const, voyageId: null, lineId: null, destinationPort: null, weightClass: 'medium' as const, containerType: 'reefer' };

function reeferOnShip() {
  const harness = createHarness({ tick: 40 });
  const unit = harness.ledger.create(TEU, at.ship(1), null, REEFER_LABELS);
  return { harness, unit };
}

describe('CargoLedger a reefer', () => {
  it('na palube vzniká napájaný z lode; dry jednotka stav reeferu nemá', () => {
    const { harness, unit } = reeferOnShip();
    expect(unit.reefer).toEqual({ plugged: true, unpluggedSinceTick: null, switchAtTick: null, waitSinceTick: null, alarmUntilTick: null, fixUntilTick: null });
    expect(harness.ledger.create(TEU, at.ship(1)).reefer).toBeNull();
  });

  it('exportný reefer vznikne v kamióne bez napájania od svojho vzniku; prázdny reefer zásuvku nepotrebuje', () => {
    const harness = createHarness({ tick: 77 });
    const exported = harness.ledger.create(TEU, at.truck(5), EXPORT_CONTRACT, { ...EXPORT_LABELS, containerType: 'reefer' });
    expect(exported.reefer).toMatchObject({ plugged: false, unpluggedSinceTick: 77 });
    const empty = harness.ledger.create(TEU, at.truck(5), null, { direction: 'empty', voyageId: null, lineId: 'blue_anchor', destinationPort: null, weightClass: 'light', containerType: 'reefer' });
    expect(empty.reefer).toBeNull();
    expect(needsPlug(empty, harness.deps.containerTypes)).toBe(false);
  });

  it('setReefer zmení len stav (poloha a poradie ostávajú), bez udalosti; chyby nič nezmenia', () => {
    const { harness, unit } = reeferOnShip();
    const next: ReeferState = { plugged: false, unpluggedSinceTick: 50, switchAtTick: null, waitSinceTick: null, alarmUntilTick: null, fixUntilTick: null };
    const updated = harness.ledger.setReefer(unit.id, next);
    expect(updated.reefer).toEqual(next);
    expect(updated.location).toEqual(unit.location);
    expect(harness.ledger.get(unit.id)?.reefer).toEqual(next);
    const dry = harness.ledger.create(TEU, at.ship(1));
    expect(() => harness.ledger.setReefer(dry.id, next)).toThrowError(CargoError);
    expect(() => harness.ledger.setReefer(id(999), next)).toThrowError(CargoError);
    expect(() => harness.ledger.setReefer(unit.id, { ...next, plugged: true })).toThrowError(/zapojený reefer/);
    expect(harness.ledger.get(unit.id)?.reefer).toEqual(next);
  });

  it('save: getState → fromState zachová stav reeferu (v14), jednotka bez zásuvky má `reefer: null`', () => {
    const { harness, unit } = reeferOnShip();
    harness.ledger.create(TEU, at.ship(1));
    harness.ledger.setReefer(unit.id, { plugged: false, unpluggedSinceTick: 41, switchAtTick: 90, waitSinceTick: null, alarmUntilTick: null, fixUntilTick: null });
    const state = viaJson(harness.ledger.getState());
    const restored = CargoLedger.fromState(state, harness.deps);
    expect(restored.get(unit.id)?.reefer).toEqual(harness.ledger.get(unit.id)?.reefer);
    expect(restored.getState()).toEqual(state);
    expect(state.units.map((entry) => entry.reefer === null)).toEqual([false, true]);
  });

  it('neplatný save: reefer bez stavu, dry so stavom, zlé ticky', () => {
    const { harness } = reeferOnShip();
    const state = viaJson(harness.ledger.getState());
    const mutate = (patch: (unit: Record<string, unknown>) => void) => {
      const copy = viaJson(state) as unknown as { units: Record<string, unknown>[] };
      patch(copy.units[0]);
      return () => CargoLedger.fromState(copy as never, harness.deps);
    };
    expect(mutate((unit) => (unit['reefer'] = null))).toThrowError(CargoStateError);
    expect(mutate((unit) => (unit['containerType'] = 'dry'))).toThrowError(CargoStateError);
    expect(mutate((unit) => (unit['reefer'] = { ...(unit['reefer'] as object), alarmUntilTick: -1 }))).toThrowError(CargoStateError);
  });

  it('reeferStateProblem: tvar a typy', () => {
    expect(reeferStateProblem(null)).toMatch(/objekt/);
    expect(reeferStateProblem({ plugged: true })).toMatch(/kľúče/);
    expect(reeferStateProblem({ plugged: true, unpluggedSinceTick: null, switchAtTick: null, waitSinceTick: null, alarmUntilTick: null, fixUntilTick: null })).toBeUndefined();
  });
});
