import { describe, expect, it } from 'vitest';
import { EntityIdAllocator, type EntityId } from '@sim/core/entity-id';

describe('EntityIdAllocator', () => {
  it('prideľuje ID od 1 rastúco', () => {
    const alloc = new EntityIdAllocator();
    expect([alloc.next(), alloc.next(), alloc.next()]).toEqual([1, 2, 3]);
  });

  it('ID sú unikátne', () => {
    const alloc = new EntityIdAllocator();
    const ids = new Set<EntityId>();
    for (let i = 0; i < 10_000; i++) ids.add(alloc.next());
    expect(ids.size).toBe(10_000);
  });

  it('je deterministický — dva alokátory dávajú rovnakú sekvenciu', () => {
    const a = new EntityIdAllocator();
    const b = new EntityIdAllocator();
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('getState → fromState (aj cez JSON) pokračuje tam, kde skončil', () => {
    const original = new EntityIdAllocator();
    for (let i = 0; i < 41; i++) original.next();
    const saved = JSON.parse(JSON.stringify(original.getState())) as { nextId: number };
    expect(saved).toEqual({ nextId: 42 });

    const restored = EntityIdAllocator.fromState(saved);
    expect(restored.next()).toBe(42);
    expect(original.next()).toBe(42);
    expect(restored.next()).toBe(43);
  });

  it('čerstvý alokátor má stav { nextId: 1 }', () => {
    expect(new EntityIdAllocator().getState()).toEqual({ nextId: 1 });
  });

  it('fromState odmietne neplatný stav (0, záporné, necelé, NaN)', () => {
    for (const nextId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => EntityIdAllocator.fromState({ nextId })).toThrow(RangeError);
    }
  });

  it('po vyčerpaní bezpečného rozsahu vyhodí chybu', () => {
    const alloc = EntityIdAllocator.fromState({ nextId: Number.MAX_SAFE_INTEGER });
    expect(alloc.next()).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => alloc.next()).toThrow(RangeError);
  });

  it('EntityId je branded typ — obyčajné číslo sa naň nepriradí (kontroluje tsc)', () => {
    const id: EntityId = new EntityIdAllocator().next();
    const asNumber: number = id; // EntityId je podtyp number
    expect(asNumber).toBe(1);
    const typeChecksOnly = (): EntityId => {
      // @ts-expect-error obyčajné číslo nie je EntityId
      const bad: EntityId = 5;
      return bad;
    };
    expect(typeChecksOnly).toBeTypeOf('function');
  });
});
