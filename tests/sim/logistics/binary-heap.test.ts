// IndexedBinaryHeap (T03-03, ARCHITECTURE §7.4): min-halda indexov nad Int32Array s pozíciami — poradie podľa
// porovnania, decreaseKey, clear bez alokácie, chyby vstupu.
import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/core';
import { IndexedBinaryHeap } from '@sim/logistics';

/** Halda nad kľúčmi v poli (pri zhode rozhodne menší index — ostré úplné usporiadanie). */
function heapOver(keys: Float64Array): IndexedBinaryHeap {
  return new IndexedBinaryHeap(keys.length, (a, b) => keys[a] < keys[b] || (keys[a] === keys[b] && a < b));
}

function drain(heap: IndexedBinaryHeap): number[] {
  const out: number[] = [];
  while (!heap.isEmpty()) out.push(heap.pop());
  return out;
}

describe('IndexedBinaryHeap', () => {
  it('pop vracia prvky podľa kľúča, pri zhode podľa indexu', () => {
    const keys = Float64Array.from([5, 1, 3, 1, 4, 0, 3]);
    const heap = heapOver(keys);
    for (const item of [0, 1, 2, 3, 4, 5, 6]) heap.push(item);
    expect(heap.size).toBe(7);
    expect(heap.peek()).toBe(5);
    expect(drain(heap)).toEqual([5, 1, 3, 2, 6, 4, 0]);
    expect(heap.size).toBe(0);
  });

  it('náhodné vkladanie a výbery = zoradenie (500 prvkov, deterministický Rng)', () => {
    const rng = new Rng(7);
    const keys = new Float64Array(500);
    for (let i = 0; i < keys.length; i++) keys[i] = rng.int(0, 50);
    const heap = heapOver(keys);
    const order = Array.from({ length: keys.length }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const item of order) heap.push(item);
    const expected = [...order].sort((a, b) => keys[a] - keys[b] || a - b);
    expect(drain(heap)).toEqual(expected);
  });

  it('decreaseKey posunie prvok, ktorého kľúč sa zmenšil', () => {
    const keys = Float64Array.from([10, 20, 30, 40]);
    const heap = heapOver(keys);
    for (const item of [0, 1, 2, 3]) heap.push(item);
    keys[3] = 5;
    heap.decreaseKey(3);
    expect(heap.peek()).toBe(3);
    keys[2] = 5; // rovnaký kľúč ako 3 → rozhodne index
    heap.decreaseKey(2);
    expect(drain(heap)).toEqual([2, 3, 0, 1]);
  });

  it('has, clear: po clear sú pozície voľné a prvky sa dajú vložiť znova', () => {
    const keys = Float64Array.from([3, 2, 1]);
    const heap = heapOver(keys);
    heap.push(0);
    heap.push(2);
    expect(heap.has(0)).toBe(true);
    expect(heap.has(1)).toBe(false);
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.has(0)).toBe(false);
    expect(heap.has(2)).toBe(false);
    heap.push(2);
    heap.push(0);
    heap.push(1);
    expect(drain(heap)).toEqual([2, 1, 0]);
  });

  it('chyby: kapacita < 1, prvok mimo rozsahu, duplicitný push, pop/peek z prázdnej, decreaseKey prvku mimo haldy', () => {
    expect(() => new IndexedBinaryHeap(0, () => false)).toThrow(RangeError);
    expect(() => new IndexedBinaryHeap(1.5, () => false)).toThrow(RangeError);
    const heap = heapOver(new Float64Array(3));
    expect(heap.capacity).toBe(3);
    expect(() => heap.push(3)).toThrow(RangeError);
    expect(() => heap.push(-1)).toThrow(RangeError);
    expect(() => heap.push(0.5)).toThrow(RangeError);
    heap.push(1);
    expect(() => heap.push(1)).toThrow(/už v halde/);
    expect(heap.size).toBe(1);
    expect(() => heap.decreaseKey(2)).toThrow(/nie je/);
    heap.pop();
    expect(() => heap.pop()).toThrow(/prázdna/);
    expect(() => heap.peek()).toThrow(/prázdna/);
  });
});
