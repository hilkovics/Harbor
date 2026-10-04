// ApronBuffer (T02-03, T03-02; ARCHITECTURE §5.4, ADR-014, ADR-017): od T03-02 drží len rezervácie slotov, obsadenie,
// FIFO a slot jednotky číta z CargoLedger (review T02-13 — žiadny druhý zápis polohy). Rezervácia najnižšieho slotu,
// ktorý nie je obsadený ani rezervovaný, commit po presune v ledgeri, uvoľnenie slotu presunom z ledgera, atomickosť.
import { describe, expect, it } from 'vitest';
import type { CargoLedger } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import { ApronBuffer, ModuleError, type ModuleErrorCode } from '@sim/modules';
import { emptyCargo, id } from './module-fixtures';

const BERTH = id(1);
const OTHER_BERTH = id(2);
const SHIP = id(900);
const CRANE = id(901);
const VEHICLE = id(902);

/** Jednotka presunutá loď → žeriav → apron `berthId` na `slot` (len ledger, apron sa nevolá). */
function toApron(cargo: CargoLedger, slot: number, berthId: EntityId = BERTH): EntityId {
  const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: SHIP }).id;
  cargo.move(unit, { kind: 'in_crane', craneId: CRANE });
  cargo.move(unit, { kind: 'on_apron', berthId, slot });
  return unit;
}

/** Vyzdvihnutie vozidlom: len presun v ledgeri — slot sa uvoľní sám. */
function pickUp(cargo: CargoLedger, unit: EntityId): void {
  cargo.move(unit, { kind: 'in_vehicle', vehicleId: VEHICLE });
}

function apronOf(capacity: number): { apron: ApronBuffer; cargo: CargoLedger } {
  const cargo = emptyCargo();
  return { apron: new ApronBuffer(capacity, BERTH, cargo), cargo };
}

/** Snímka verejného stavu (na overenie, že chybná operácia nič nezmenila). */
function snapshot(apron: ApronBuffer) {
  return {
    used: apron.usedCount,
    reserved: apron.reservedCount,
    free: apron.freeUnreservedCount,
    units: apron.units(),
    reservedSlots: apron.reservedSlots(),
    slots: Array.from({ length: apron.capacity }, (_, slot) => apron.unitAt(slot)),
  };
}

function expectModuleError(action: () => unknown, code: ModuleErrorCode): void {
  let error: unknown;
  try {
    action();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ModuleError);
  expect((error as ModuleError).code).toBe(code);
}

describe('ApronBuffer — kapacita a počty z ledgera', () => {
  it('nový buffer: capacity, used 0, reserved 0, všetko voľné; druh on_apron a držiteľ = berth', () => {
    const { apron } = apronOf(4);
    expect([apron.capacity, apron.usedCount, apron.reservedCount, apron.freeUnreservedCount, apron.freeCount]).toEqual([4, 0, 0, 4, 4]);
    expect([apron.kind, apron.holderId]).toEqual(['on_apron', BERTH]);
    expect(apron.units()).toEqual([]);
    expect(apron.oldest()).toBeUndefined();
    expect(apron.reservedSlots()).toEqual([]);
    expect(apron.findProblem()).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN])('kapacita %s → invalid_input', (capacity) => {
    expectModuleError(() => new ApronBuffer(capacity, BERTH, emptyCargo()), 'invalid_input');
  });

  it('used = jednotky on_apron tohto berthu v ledgeri; free = capacity − used − reserved', () => {
    const { apron, cargo } = apronOf(4);
    const a = apron.reserve();
    apron.reserve();
    expect([apron.usedCount, apron.reservedCount, apron.freeUnreservedCount]).toEqual([0, 2, 2]);
    const unit = toApron(cargo, a);
    apron.commit(a, unit);
    expect([apron.usedCount, apron.reservedCount, apron.freeUnreservedCount]).toEqual([1, 1, 2]);
    toApron(cargo, 0, OTHER_BERTH); // iný berth sa nepočíta
    expect(apron.usedCount).toBe(1);
    pickUp(cargo, unit);
    expect([apron.usedCount, apron.reservedCount, apron.freeUnreservedCount]).toEqual([0, 1, 3]);
  });
});

describe('ApronBuffer — rezervácia', () => {
  it('reserve() vracia najnižší slot, ktorý nie je obsadený (ledger) ani rezervovaný', () => {
    const { apron, cargo } = apronOf(4);
    expect(apron.reserve()).toBe(0);
    expect(apron.reserve()).toBe(1);
    const unit = toApron(cargo, 0);
    apron.commit(0, unit);
    expect(apron.reserve()).toBe(2);
    pickUp(cargo, unit);
    expect(apron.reserve()).toBe(0); // slot uvoľnený presunom v ledgeri je opäť najnižší
    expect(apron.reservedSlots()).toEqual([0, 1, 2]);
  });

  it('obsadený slot v ledgeri bez rezervácie (obnova) reserve() preskočí', () => {
    const { apron, cargo } = apronOf(3);
    toApron(cargo, 0);
    toApron(cargo, 2);
    expect(apron.reserve()).toBe(1);
  });

  it('plný apron (obsadené + rezervované) → reserve() hodí no_free_slot a nič nezmení', () => {
    const { apron, cargo } = apronOf(2);
    const slot = apron.reserve();
    apron.commit(slot, toApron(cargo, slot));
    apron.reserve();
    const before = snapshot(apron);
    expectModuleError(() => apron.reserve(), 'no_free_slot');
    expect(snapshot(apron)).toEqual(before);
  });

  it('reserveSlot rezervuje konkrétny slot; obsadený, rezervovaný alebo mimo rozsahu → chyba bez zmeny', () => {
    const { apron, cargo } = apronOf(3);
    apron.reserveSlot(2);
    expect(apron.isReserved(2)).toBe(true);
    toApron(cargo, 0);
    const before = snapshot(apron);
    expectModuleError(() => apron.reserveSlot(2), 'slot_reserved');
    expectModuleError(() => apron.reserveSlot(0), 'slot_occupied');
    expectModuleError(() => apron.reserveSlot(3), 'invalid_slot');
    expectModuleError(() => apron.reserveSlot(-1), 'invalid_slot');
    expectModuleError(() => apron.reserveSlot(0.5), 'invalid_slot');
    expect(snapshot(apron)).toEqual(before);
  });

  it('release zruší rezerváciu; slot bez rezervácie → slot_not_reserved', () => {
    const { apron } = apronOf(2);
    const slot = apron.reserve();
    apron.release(slot);
    expect([apron.reservedCount, apron.isReserved(slot)]).toEqual([0, false]);
    expectModuleError(() => apron.release(slot), 'slot_not_reserved');
    expectModuleError(() => apron.release(5), 'invalid_slot');
  });
});

describe('ApronBuffer — commit po presune v ledgeri', () => {
  it('assertCommittable pred presunom: chyby bez zmeny stavu; na platnom vstupe presun + commit prejdú (T02-14)', () => {
    const { apron, cargo } = apronOf(3);
    const slot = apron.reserve();
    const before = snapshot(apron);
    expectModuleError(() => apron.assertCommittable(7, id(2)), 'invalid_slot');
    expectModuleError(() => apron.assertCommittable(2, id(2)), 'slot_not_reserved');
    expect(snapshot(apron)).toEqual(before);
    const unit = cargo.create('container_teu', { kind: 'on_ship', shipId: SHIP }).id;
    cargo.move(unit, { kind: 'in_crane', craneId: CRANE });
    apron.assertCommittable(slot, unit);
    cargo.move(unit, { kind: 'on_apron', berthId: BERTH, slot });
    apron.commit(slot, unit);
    expect([apron.unitAt(slot), apron.isReserved(slot), apron.reservedCount]).toEqual([unit, false, 0]);
  });

  it('assertCommittable: rezervovaný slot, na ktorom už niekto leží (poškodený stav) → slot_occupied', () => {
    const { apron, cargo } = apronOf(2);
    const slot = apron.reserve();
    toApron(cargo, slot); // presun bez commit → rezervovaný a obsadený
    expectModuleError(() => apron.assertCommittable(slot, id(4242)), 'slot_occupied');
    expect(apron.findProblem()).toMatch(/rezervovaný slot 0 obsadila jednotka/);
  });

  it('commit bez presunu v ledgeri → unit_not_at_slot; bez rezervácie → slot_not_reserved; rezervácia ostane', () => {
    const { apron, cargo } = apronOf(2);
    const unit = toApron(cargo, 1);
    expectModuleError(() => apron.commit(1, unit), 'slot_not_reserved');
    const slot = apron.reserve();
    expect(slot).toBe(0);
    expectModuleError(() => apron.commit(slot, unit), 'unit_not_at_slot'); // jednotka leží na slote 1, nie 0
    expectModuleError(() => apron.commit(slot, id(4242)), 'unit_not_at_slot');
    expect([apron.reservedCount, apron.isReserved(slot)]).toEqual([1, true]);
  });
});

describe('ApronBuffer — FIFO a sloty z ledgera', () => {
  it('units() = poradie príchodu v ledgeri, nie poradie slotov; vyzdvihnutie zachová poradie ostatných', () => {
    const { apron, cargo } = apronOf(4);
    const [s0, s1, s2] = [apron.reserve(), apron.reserve(), apron.reserve()];
    const u30 = toApron(cargo, s2);
    apron.commit(s2, u30);
    const u10 = toApron(cargo, s0);
    apron.commit(s0, u10);
    const u20 = toApron(cargo, s1);
    apron.commit(s1, u20);
    expect(apron.units()).toEqual([u30, u10, u20]);
    expect(apron.oldest()).toBe(u30);
    expect([apron.slotOf(u30), apron.slotOf(u10), apron.slotOf(u20)]).toEqual([s2, s0, s1]);
    pickUp(cargo, u10);
    expect(apron.units()).toEqual([u30, u20]);
    expect(apron.slotOf(u10)).toBeUndefined();
    expect(apron.unitAt(s0)).toBeNull();
  });

  it('slotOf jednotky na inom berthe alebo mimo apronu → undefined; unitAt/isReserved mimo rozsahu → invalid_slot', () => {
    const { apron, cargo } = apronOf(2);
    const foreign = toApron(cargo, 0, OTHER_BERTH);
    expect(apron.slotOf(foreign)).toBeUndefined();
    expect(apron.slotOf(id(4242))).toBeUndefined();
    expect(apron.unitAt(0)).toBeNull();
    expectModuleError(() => apron.unitAt(2), 'invalid_slot');
    expectModuleError(() => apron.isReserved(-1), 'invalid_slot');
  });

  it('units() a reservedSlots() sú kópie', () => {
    const { apron, cargo } = apronOf(2);
    const slot = apron.reserve();
    apron.commit(slot, toApron(cargo, slot));
    apron.reserve();
    (apron.units() as EntityId[]).push(id(99));
    (apron.reservedSlots() as number[]).push(7);
    expect(apron.units()).toHaveLength(1);
    expect(apron.reservedSlots()).toEqual([1]);
  });

  it('findProblem: jednotka na slote mimo kapacity (ledger rozsah nepozná)', () => {
    const { apron, cargo } = apronOf(2);
    toApron(cargo, 5);
    expect(apron.findProblem()).toMatch(/leží na slote 5 mimo 0…1/);
  });
});
