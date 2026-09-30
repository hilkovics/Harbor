// ApronBuffer (T02-03, ARCHITECTURE §5.4, ADR-014): rezervácia najnižšieho voľného slotu, commit na rezervovaný
// slot, FIFO poradie, take, počty used/reserved/capacity pre UI a atomickosť pri chybe.
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { ApronBuffer, ModuleError, type ModuleErrorCode } from '@sim/modules';
import { id } from './module-fixtures';

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

describe('ApronBuffer — kapacita a počty', () => {
  it('nový buffer: capacity, used 0, reserved 0, všetko voľné', () => {
    const apron = new ApronBuffer(4);
    expect(apron.capacity).toBe(4);
    expect(apron.usedCount).toBe(0);
    expect(apron.reservedCount).toBe(0);
    expect(apron.freeUnreservedCount).toBe(4);
    expect(apron.units()).toEqual([]);
    expect(apron.oldest()).toBeUndefined();
    expect(apron.reservedSlots()).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])('kapacita %s → ModuleError invalid_input', (capacity) => {
    expectModuleError(() => new ApronBuffer(capacity), 'invalid_input');
  });

  it('počty used/reserved/free sa menia s rezerváciou, commitom a take', () => {
    const apron = new ApronBuffer(4);
    const a = apron.reserve();
    const b = apron.reserve();
    expect([apron.usedCount, apron.reservedCount, apron.freeUnreservedCount]).toEqual([0, 2, 2]);
    apron.commit(a, id(10));
    expect([apron.usedCount, apron.reservedCount, apron.freeUnreservedCount]).toEqual([1, 1, 2]);
    apron.commit(b, id(11));
    expect([apron.usedCount, apron.reservedCount, apron.freeUnreservedCount]).toEqual([2, 0, 2]);
    apron.take(id(10));
    expect([apron.usedCount, apron.reservedCount, apron.freeUnreservedCount]).toEqual([1, 0, 3]);
  });
});

describe('ApronBuffer — rezervácia', () => {
  it('reserve() vracia najnižší voľný nerezervovaný slot', () => {
    const apron = new ApronBuffer(4);
    expect(apron.reserve()).toBe(0);
    expect(apron.reserve()).toBe(1);
    apron.commit(0, id(5));
    expect(apron.reserve()).toBe(2);
    apron.take(id(5));
    expect(apron.reserve()).toBe(0); // uvoľnený slot 0 je opäť najnižší
    expect(apron.reservedSlots()).toEqual([0, 1, 2]);
  });

  it('dve rezervácie nedostanú ten istý slot (žeriav nemôže prebookovať slot iného)', () => {
    const apron = new ApronBuffer(2);
    const first = apron.reserve();
    const second = apron.reserve();
    expect(first).not.toBe(second);
    expect(apron.freeUnreservedCount).toBe(0);
  });

  it('plný apron (obsadené + rezervované) → reserve() hodí apron_full a nič nezmení', () => {
    const apron = new ApronBuffer(2);
    apron.commit(apron.reserve(), id(1));
    apron.reserve();
    const before = snapshot(apron);
    expectModuleError(() => apron.reserve(), 'apron_full');
    expect(snapshot(apron)).toEqual(before);
  });

  it('reserveSlot rezervuje konkrétny slot; obsadený, rezervovaný alebo mimo rozsahu → chyba', () => {
    const apron = new ApronBuffer(3);
    apron.reserveSlot(2);
    expect(apron.isReserved(2)).toBe(true);
    expect(apron.reserve()).toBe(0);
    apron.commit(0, id(7));
    expectModuleError(() => apron.reserveSlot(2), 'slot_reserved');
    expectModuleError(() => apron.reserveSlot(0), 'slot_occupied');
    expectModuleError(() => apron.reserveSlot(3), 'invalid_slot');
    expectModuleError(() => apron.reserveSlot(-1), 'invalid_slot');
    expectModuleError(() => apron.reserveSlot(0.5), 'invalid_slot');
  });

  it('release zruší rezerváciu; slot bez rezervácie → slot_not_reserved', () => {
    const apron = new ApronBuffer(2);
    const slot = apron.reserve();
    apron.release(slot);
    expect(apron.isReserved(slot)).toBe(false);
    expect(apron.freeUnreservedCount).toBe(2);
    expectModuleError(() => apron.release(slot), 'slot_not_reserved');
  });
});

describe('ApronBuffer — commit, take a FIFO', () => {
  it('commit vyžaduje rezervovaný slot a rezervácia ním zaniká', () => {
    const apron = new ApronBuffer(3);
    expectModuleError(() => apron.commit(0, id(1)), 'slot_not_reserved');
    const slot = apron.reserve();
    apron.commit(slot, id(1));
    expect(apron.unitAt(slot)).toBe(1);
    expect(apron.isReserved(slot)).toBe(false);
    expect(apron.slotOf(id(1))).toBe(slot);
  });

  it('jednotka nemôže byť na aprone dvakrát', () => {
    const apron = new ApronBuffer(3);
    apron.commit(apron.reserve(), id(1));
    const slot = apron.reserve();
    const before = snapshot(apron);
    expectModuleError(() => apron.commit(slot, id(1)), 'unit_on_apron');
    expect(snapshot(apron)).toEqual(before);
  });

  it('assertCommittable: rovnaké chyby ako commit, stav nemení; na platnom vstupe prejde a commit potom tiež (T02-14)', () => {
    const apron = new ApronBuffer(3);
    apron.commit(apron.reserve(), id(1));
    const slot = apron.reserve();
    const before = snapshot(apron);
    expectModuleError(() => apron.assertCommittable(7, id(2)), 'invalid_slot');
    expectModuleError(() => apron.assertCommittable(2, id(2)), 'slot_not_reserved');
    expectModuleError(() => apron.assertCommittable(slot, id(1)), 'unit_on_apron');
    expect(() => apron.assertCommittable(slot, id(2))).not.toThrow();
    expect(snapshot(apron)).toEqual(before);
    apron.commit(slot, id(2));
    expect(apron.units()).toEqual([1, 2]);
  });

  it('FIFO = poradie commitu, nie poradie slotov; take zachová poradie ostatných', () => {
    const apron = new ApronBuffer(4);
    const [s0, s1, s2] = [apron.reserve(), apron.reserve(), apron.reserve()];
    // Žeriavy dokončia cykly v inom poradí než rezervovali.
    apron.commit(s2, id(30));
    apron.commit(s0, id(10));
    apron.commit(s1, id(20));
    expect(apron.units()).toEqual([30, 10, 20]);
    expect(apron.oldest()).toBe(30);
    expect(apron.take(id(10))).toBe(s0);
    expect(apron.units()).toEqual([30, 20]);
    expect(apron.take(id(30))).toBe(s2);
    expect(apron.oldest()).toBe(20);
  });

  it('take neznámej jednotky → unit_not_on_apron bez zmeny', () => {
    const apron = new ApronBuffer(2);
    apron.commit(apron.reserve(), id(1));
    const before = snapshot(apron);
    expectModuleError(() => apron.take(id(2)), 'unit_not_on_apron');
    expect(snapshot(apron)).toEqual(before);
  });

  it('units() a reservedSlots() sú kópie', () => {
    const apron = new ApronBuffer(2);
    apron.commit(apron.reserve(), id(1));
    (apron.units() as EntityId[]).push(id(99));
    (apron.reservedSlots() as number[]).push(1);
    expect(apron.units()).toEqual([1]);
    expect(apron.reservedSlots()).toEqual([]);
  });

  it('unitAt/isReserved mimo rozsahu → invalid_slot; slotOf neznámej jednotky → undefined', () => {
    const apron = new ApronBuffer(2);
    expectModuleError(() => apron.unitAt(2), 'invalid_slot');
    expectModuleError(() => apron.isReserved(-1), 'invalid_slot');
    expect(apron.slotOf(id(42))).toBeUndefined();
  });
});
