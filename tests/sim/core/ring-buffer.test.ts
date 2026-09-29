import { describe, expect, it } from 'vitest';
import { RingBuffer } from '@sim/core/ring-buffer';
import { Rng } from '@sim/core/rng';

describe('RingBuffer', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('odmietne capacity = %s', (capacity) => {
    expect(() => new RingBuffer<number>(capacity)).toThrow(RangeError);
  });

  it('prázdny buffer: size 0, toArray prázdne, at undefined', () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.capacity).toBe(3);
    expect(rb.size).toBe(0);
    expect(rb.toArray()).toEqual([]);
    expect(rb.at(0)).toBeUndefined();
    expect(rb.at(-1)).toBeUndefined();
  });

  it('pod kapacitou drží prvky v poradí vkladania', () => {
    const rb = new RingBuffer<string>(4);
    rb.push('a');
    rb.push('b');
    expect(rb.size).toBe(2);
    expect(rb.toArray()).toEqual(['a', 'b']);
  });

  it('pri zaplnení prepisuje najstaršie prvky; toArray je od najstaršieho', () => {
    const rb = new RingBuffer<number>(3);
    for (const n of [1, 2, 3]) rb.push(n);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    rb.push(4);
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([2, 3, 4]);
    rb.push(5);
    rb.push(6);
    expect(rb.toArray()).toEqual([4, 5, 6]);
  });

  it('opakované pretečenie (viac než 3× kapacita) drží posledných `capacity` prvkov', () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 1; i <= 10; i++) rb.push(i);
    expect(rb.toArray()).toEqual([8, 9, 10]);
    expect(rb.size).toBe(3);
  });

  it('kapacita 1 drží len posledný prvok', () => {
    const rb = new RingBuffer<string>(1);
    rb.push('a');
    rb.push('b');
    expect(rb.toArray()).toEqual(['b']);
    expect(rb.at(0)).toBe('b');
    expect(rb.at(-1)).toBe('b');
  });

  it('at(i): 0 = najstarší, záporné počítajú od najnovšieho, mimo rozsahu a necelé → undefined', () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) rb.push(i); // obsah [3, 4, 5]
    expect(rb.at(0)).toBe(3);
    expect(rb.at(1)).toBe(4);
    expect(rb.at(2)).toBe(5);
    expect(rb.at(3)).toBeUndefined();
    expect(rb.at(-1)).toBe(5);
    expect(rb.at(-3)).toBe(3);
    expect(rb.at(-4)).toBeUndefined();
    expect(rb.at(0.5)).toBeUndefined();
    expect(rb.at(Number.NaN)).toBeUndefined();
  });

  it('toArray vracia kópiu', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    const copy = rb.toArray();
    copy.push(99);
    expect(rb.toArray()).toEqual([1]);
    expect(rb.size).toBe(1);
  });

  it('clear vyprázdni buffer, kapacita ostáva a buffer sa dá znova použiť', () => {
    const rb = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) rb.push(i);
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.capacity).toBe(3);
    expect(rb.toArray()).toEqual([]);
    expect(rb.at(0)).toBeUndefined();
    rb.push(10);
    rb.push(11);
    expect(rb.toArray()).toEqual([10, 11]);
  });

  it('uloží aj hodnoty undefined/null/0 ako platné prvky', () => {
    const rb = new RingBuffer<number | null | undefined>(3);
    rb.push(0);
    rb.push(null);
    rb.push(undefined);
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([0, null, undefined]);
  });

  it('zhoduje sa s naivným modelom (pole + shift) na náhodnej postupnosti operácií', () => {
    const rng = new Rng(2025);
    for (const capacity of [1, 2, 5, 17]) {
      const rb = new RingBuffer<number>(capacity);
      const model: number[] = [];
      for (let i = 0; i < 500; i++) {
        if (rng.int(0, 49) === 0) {
          rb.clear();
          model.length = 0;
        } else {
          rb.push(i);
          model.push(i);
          if (model.length > capacity) model.shift();
        }
        expect(rb.size).toBe(model.length);
        expect(rb.toArray()).toEqual(model);
        expect(rb.at(0)).toBe(model[0]);
        expect(rb.at(-1)).toBe(model[model.length - 1]);
      }
    }
  });
});
