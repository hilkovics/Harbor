/**
 * Binárna min-halda indexov uzlov s pozíciami (ARCHITECTURE §7.4; rozhodnutie orchestrátora F3 č. 5) — open set A*.
 *
 * - Prvky sú celé čísla `0 … capacity − 1` (index bunky), každý najviac raz; halda je `Int32Array` a pozícia prvku
 *   v halde je v druhom `Int32Array` (`-1` = nie je v halde). Vďaka pozíciám vie `decreaseKey` posunúť prvok, ktorého
 *   kľúč sa zmenšil, bez duplicitných záznamov (A* s konzistentnou heuristikou).
 * - Poradie určuje porovnanie `less(a, b)` dodané pri vytvorení (kľúče si drží volajúci, napr. `f`/`h` v `Float64Array`).
 *   Porovnanie musí byť ostré úplné usporiadanie (pri zhode kľúčov rozhodne index), inak poradie výberu nie je
 *   jednoznačné — pri deterministickom porovnaní je deterministická aj halda.
 * - Po vytvorení **nealokuje**: `push`, `pop`, `decreaseKey` aj `clear` pracujú len nad predalokovanými poľami.
 */

/** Ostré porovnanie prvkov haldy: `true` = `a` ide pred `b`. */
export type HeapLess = (a: number, b: number) => boolean;

/** Pozícia prvku, ktorý v halde nie je. */
const NOT_IN_HEAP = -1;

/** Index koreňa haldy. */
const ROOT = 0;

export class IndexedBinaryHeap {
  private readonly items: Int32Array;
  private readonly positions: Int32Array;
  private readonly less: HeapLess;
  private count = 0;

  /**
   * @param capacity počet možných prvkov (`0 … capacity − 1`), celé číslo ≥ 1; inak `RangeError`
   * @param less ostré porovnanie prvkov (menší ide skôr)
   */
  constructor(capacity: number, less: HeapLess) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`IndexedBinaryHeap: kapacita musí byť celé číslo ≥ 1, dostal ${String(capacity)}`);
    }
    this.items = new Int32Array(capacity);
    this.positions = new Int32Array(capacity).fill(NOT_IN_HEAP);
    this.less = less;
  }

  /** Počet možných prvkov (`0 … capacity − 1`). */
  get capacity(): number {
    return this.positions.length;
  }

  /** Počet prvkov v halde. */
  get size(): number {
    return this.count;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  /** Je prvok v halde? Prvok mimo rozsahu → `RangeError`. */
  has(item: number): boolean {
    this.checkItem(item, 'has');
    return this.positions[item] !== NOT_IN_HEAP;
  }

  /** Vloží prvok. Prvok mimo rozsahu alebo už v halde → `RangeError` (halda sa nezmení). */
  push(item: number): void {
    this.checkItem(item, 'push');
    if (this.positions[item] !== NOT_IN_HEAP) throw new RangeError(`IndexedBinaryHeap.push: prvok ${String(item)} už v halde je`);
    const at = this.count;
    this.count += 1;
    this.place(item, at);
    this.siftUp(at);
  }

  /** Najmenší prvok bez odobratia; prázdna halda → `RangeError`. */
  peek(): number {
    if (this.count === 0) throw new RangeError('IndexedBinaryHeap.peek: halda je prázdna');
    return this.items[ROOT];
  }

  /** Odoberie a vráti najmenší prvok; prázdna halda → `RangeError`. */
  pop(): number {
    if (this.count === 0) throw new RangeError('IndexedBinaryHeap.pop: halda je prázdna');
    const top = this.items[ROOT];
    this.positions[top] = NOT_IN_HEAP;
    this.count -= 1;
    if (this.count > 0) {
      this.place(this.items[this.count], ROOT);
      this.siftDown(ROOT);
    }
    return top;
  }

  /**
   * Kľúč prvku v halde sa zmenšil (volajúci ho už zapísal) — posunie ho k koreňu. Prvok, ktorý v halde nie je,
   * → `RangeError`. Zväčšenie kľúča halda nepodporuje (A* s konzistentnou heuristikou ho nepotrebuje).
   */
  decreaseKey(item: number): void {
    this.checkItem(item, 'decreaseKey');
    const at = this.positions[item];
    if (at === NOT_IN_HEAP) throw new RangeError(`IndexedBinaryHeap.decreaseKey: prvok ${String(item)} v halde nie je`);
    this.siftUp(at);
  }

  /** Vyprázdni haldu v čase O(size) bez alokácie (pozície zvyšných prvkov sa vynulujú). */
  clear(): void {
    for (let i = 0; i < this.count; i++) this.positions[this.items[i]] = NOT_IN_HEAP;
    this.count = 0;
  }

  private checkItem(item: number, method: string): void {
    if (!Number.isInteger(item) || item < 0 || item >= this.positions.length) {
      throw new RangeError(`IndexedBinaryHeap.${method}: prvok musí byť celé číslo 0…${String(this.positions.length - 1)}, dostal ${String(item)}`);
    }
  }

  private place(item: number, at: number): void {
    this.items[at] = item;
    this.positions[item] = at;
  }

  private siftUp(start: number): void {
    const item = this.items[start];
    let at = start;
    while (at > ROOT) {
      const parentAt = (at - 1) >> 1;
      const parent = this.items[parentAt];
      if (!this.less(item, parent)) break;
      this.place(parent, at);
      at = parentAt;
    }
    this.place(item, at);
  }

  private siftDown(start: number): void {
    const item = this.items[start];
    let at = start;
    for (;;) {
      const left = 2 * at + 1;
      if (left >= this.count) break;
      const right = left + 1;
      const childAt = right < this.count && this.less(this.items[right], this.items[left]) ? right : left;
      const child = this.items[childAt];
      if (!this.less(child, item)) break;
      this.place(child, at);
      at = childAt;
    }
    this.place(item, at);
  }
}
