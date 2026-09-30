/**
 * Kruhový buffer s pevnou kapacitou (ARCHITECTURE §9.2: napr. ledger `RingBuffer<LedgerEntry>(50k)`).
 * Po naplnení `push` prepisuje najstaršie prvky.
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  /** Index najstaršieho prvku v `items`. */
  private head = 0;
  private count = 0;

  /** @param capacity celé číslo ≥ 1 */
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer: capacity musí byť celé číslo ≥ 1, dostal ${String(capacity)}`);
    }
    this.items = new Array<T | undefined>(capacity).fill(undefined);
  }

  /** Aktuálny počet prvkov (≤ capacity). */
  get size(): number {
    return this.count;
  }

  /** Pridá prvok ako najnovší; ak je buffer plný, prepíše najstarší. */
  push(item: T): void {
    if (this.count < this.capacity) {
      this.items[(this.head + this.count) % this.capacity] = item;
      this.count += 1;
    } else {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /**
   * Prvok podľa indexu od najstaršieho (0 = najstarší). Záporný index počíta od najnovšieho
   * (-1 = najnovší), ako `Array.prototype.at`. Mimo rozsahu vráti `undefined`.
   */
  at(index: number): T | undefined {
    if (!Number.isInteger(index)) return undefined;
    const i = index < 0 ? this.count + index : index;
    if (i < 0 || i >= this.count) return undefined;
    return this.items[(this.head + i) % this.capacity];
  }

  /** Kópia obsahu od najstaršieho po najnovší. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.items[(this.head + i) % this.capacity] as T);
    }
    return out;
  }

  /** Vyprázdni buffer (kapacita ostáva). */
  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
