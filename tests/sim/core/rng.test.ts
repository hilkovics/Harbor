import { describe, expect, it, vi } from 'vitest';
import { Rng } from '@sim/core/rng';

// Referenčný vektor xoshiro128** pre stav [1, 2, 3, 4] bol vypočítaný nezávisle od implementácie
// skriptom s BigInt aritmetikou (mod 2^32, bez Math.imul a >>> 0) podľa referenčného C kódu
// (Blackman & Vigna): výstupy a stav po piatich krokoch. Prvý výstup sa dá overiť ručne:
// rotl(2 * 5, 7) * 9 = 1280 * 9 = 11520.
const REF_STATE: [number, number, number, number] = [1, 2, 3, 4];
const REF_OUTPUTS = [11520, 0, 5927040, 70819200, 2031721883];
const REF_STATE_AFTER_5: [number, number, number, number] = [15224335, 29364750, 272377353, 1125134346];

// splitmix32(seed) → štyri slová stavu; taktiež vypočítané nezávisle BigInt skriptom.
const SEED_VECTORS: { seed: number; state: number[]; firstOutputs: number[] }[] = [
  { seed: 0, state: [1684164658, 3653269916, 2939563536, 2141751570], firstOutputs: [1789933344, 44971166, 2521387044] },
  { seed: 42, state: [551831576, 144025891, 322543647, 3034809370], firstOutputs: [660444221, 3652823732, 77672526] },
  { seed: 12345, state: [3283241497, 613117429, 2940958500, 516375437], firstOutputs: [1093274547, 203003357, 3741353573] },
];

function takeU32(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => rng.nextU32());
}

describe('Rng — xoshiro128**', () => {
  it('referenčný vektor pre pevný stav [1, 2, 3, 4]', () => {
    const rng = new Rng(1);
    rng.setState(REF_STATE);
    expect(takeU32(rng, REF_OUTPUTS.length)).toEqual(REF_OUTPUTS);
    expect(rng.getState()).toEqual(REF_STATE_AFTER_5);
  });

  it.each(SEED_VECTORS)('seed $seed → stav cez splitmix32 a prvé výstupy', ({ seed, state, firstOutputs }) => {
    const rng = new Rng(seed);
    expect(rng.getState()).toEqual(state);
    expect(takeU32(rng, firstOutputs.length)).toEqual(firstOutputs);
  });

  it('rovnaký seed → rovnakých 1 000 čísel', () => {
    const a = new Rng(2024);
    const b = new Rng(2024);
    const seqA = Array.from({ length: 1000 }, () => a.next());
    const seqB = Array.from({ length: 1000 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('rôzne seedy → rôzne sekvencie', () => {
    const seqOf = (seed: number): number[] => takeU32(new Rng(seed), 1000);
    const s1 = seqOf(1);
    const s2 = seqOf(2);
    expect(s1).not.toEqual(s2);
    // Nielen odlišný začiatok — sekvencie sa v podstate nesmú zhodovať na žiadnej pozícii.
    const equalPositions = s1.filter((v, i) => v === s2[i]).length;
    expect(equalPositions).toBeLessThan(3);
  });

  it('seed 0 je platný a nedáva nulový stav', () => {
    const rng = new Rng(0);
    expect(rng.getState().some((w) => w !== 0)).toBe(true);
    expect(rng.nextU32()).not.toBe(rng.nextU32());
  });

  it('neplatný seed (necelé číslo, NaN, Infinity) vyhodí chybu', () => {
    expect(() => new Rng(1.5)).toThrow(RangeError);
    expect(() => new Rng(Number.NaN)).toThrow(RangeError);
    expect(() => new Rng(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  describe('seed je uint32', () => {
    it.each([-1, 2 ** 32, 2 ** 32 + 1, 2 ** 53, -(2 ** 31), Number.NEGATIVE_INFINITY])('seed %s mimo 0 … 2^32 − 1 → RangeError', (seed) => {
      expect(() => new Rng(seed)).toThrow(RangeError);
    });

    it('hranice 0 a 2^32 − 1 aj seedy nad 2^31 sú platné a dávajú rôzne sekvencie', () => {
      const seeds = [0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1];
      const firstOutputs = seeds.map((seed) => takeU32(new Rng(seed), 4).join(','));
      expect(new Set(firstOutputs).size).toBe(seeds.length);
    });

    it('seed sa už nezlieva s hodnotou o 2^32 vyššie (1 vs 2^32 + 1 → druhý je chyba)', () => {
      expect(() => new Rng(1)).not.toThrow();
      expect(() => new Rng(2 ** 32 + 1)).toThrow(/uint32/);
    });
  });

  it('nextU32 vracia uint32', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextU32();
      expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
    }
  });

  describe('getState / setState', () => {
    it('po obnove stavu pokračuje sekvencia identicky', () => {
      const original = new Rng(99);
      takeU32(original, 137); // ľubovoľný posun
      const saved = original.getState();
      const expected = takeU32(original, 1000);

      const restored = new Rng(1); // úplne iný seed
      restored.setState(saved);
      expect(takeU32(restored, 1000)).toEqual(expected);
    });

    it('funguje aj cez JSON roundtrip a Rng.fromState', () => {
      const original = new Rng(5);
      takeU32(original, 10);
      const saved = JSON.parse(JSON.stringify(original.getState())) as [number, number, number, number];
      const restored = Rng.fromState(saved);
      expect(takeU32(restored, 100)).toEqual(takeU32(original, 100));
    });

    it('getState vracia kópiu — jej zmena generátor neovplyvní', () => {
      const rng = new Rng(3);
      const snapshot = rng.getState();
      snapshot[0] = 0;
      snapshot[1] = 0;
      expect(rng.getState()).not.toEqual(snapshot);
      const clone = Rng.fromState(rng.getState());
      expect(rng.nextU32()).toBe(clone.nextU32());
    });

    it('odmietne nulový stav', () => {
      const rng = new Rng(1);
      expect(() => rng.setState([0, 0, 0, 0])).toThrow(RangeError);
    });

    it('odmietne neplatné slová (necelé, záporné, > uint32, NaN) aj zlú dĺžku', () => {
      const rng = new Rng(1);
      expect(() => rng.setState([1, 2, 3, 1.5])).toThrow(RangeError);
      expect(() => rng.setState([1, 2, 3, -1])).toThrow(RangeError);
      expect(() => rng.setState([1, 2, 3, 0x100000000])).toThrow(RangeError);
      expect(() => rng.setState([1, 2, 3, Number.NaN])).toThrow(RangeError);
      expect(() => rng.setState([1, 2, 3] as unknown as [number, number, number, number])).toThrow(RangeError);
    });

    it('neplatný setState nezmení pôvodný stav', () => {
      const rng = new Rng(1);
      const before = rng.getState();
      expect(() => rng.setState([0, 0, 0, 0])).toThrow();
      expect(rng.getState()).toEqual(before);
    });

    it('pripustí aj hraničné hodnoty uint32', () => {
      const rng = new Rng(1);
      expect(() => rng.setState([0, 0, 0, 0xffffffff])).not.toThrow();
    });
  });

  describe('next()', () => {
    it('je nextU32() / 2^32', () => {
      const rng = new Rng(1);
      rng.setState(REF_STATE);
      expect(rng.next()).toBe(REF_OUTPUTS[0] / 2 ** 32);
    });

    it('vždy leží v [0, 1) a je približne rovnomerné', () => {
      const rng = new Rng(11);
      const n = 20_000;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = rng.next();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        sum += v;
      }
      expect(sum / n).toBeGreaterThan(0.48);
      expect(sum / n).toBeLessThan(0.52);
    });
  });

  describe('range(min, max)', () => {
    it('výsledky ležia v [min, max), aj so zápornými hranicami', () => {
      const rng = new Rng(21);
      for (let i = 0; i < 10_000; i++) {
        const a = rng.range(-5, 5);
        expect(a).toBeGreaterThanOrEqual(-5);
        expect(a).toBeLessThan(5);
        const b = rng.range(2.5, 2.75);
        expect(b).toBeGreaterThanOrEqual(2.5);
        expect(b).toBeLessThan(2.75);
      }
    });

    it('rozpätie pretekajúce do Infinity vyhodí chybu a nespotrebuje číslo', () => {
      const rng = new Rng(22);
      const before = rng.getState();
      expect(() => rng.range(-Number.MAX_VALUE, Number.MAX_VALUE)).toThrow(RangeError);
      expect(() => rng.range(-1e308, 1e308)).toThrow(RangeError);
      expect(rng.getState()).toEqual(before);
    });

    it('horná hranica je výlučná aj pri najväčšom next() (1 − 2^−32), ak max(|min|, |max|) < 2^20 × rozpätie', () => {
      const rng = new Rng(23);
      const spy = vi.spyOn(rng, 'next').mockReturnValue(1 - 2 ** -32);
      expect(rng.range(0, 1)).toBeLessThan(1);
      expect(rng.range(-5, 5)).toBeLessThan(5);
      expect(rng.range(1e6, 1e6 + 1)).toBeLessThan(1e6 + 1);
      expect(rng.range(-1e6 - 1, -1e6)).toBeLessThan(-1e6);
      spy.mockReturnValue(0);
      expect(rng.range(1e6, 1e6 + 1)).toBe(1e6);
      expect(rng.range(-5, 5)).toBe(-5);
    });

    it('min === max vráti min; min > max alebo nefinitné hranice vyhodia chybu', () => {
      const rng = new Rng(21);
      expect(rng.range(3, 3)).toBe(3);
      expect(() => rng.range(2, 1)).toThrow(RangeError);
      expect(() => rng.range(Number.NaN, 1)).toThrow(RangeError);
      expect(() => rng.range(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });
  });

  describe('int(min, maxInclusive)', () => {
    it('trafí obe hranice a nikdy nevyjde von', () => {
      const rng = new Rng(31);
      const seen = new Set<number>();
      for (let i = 0; i < 2000; i++) {
        const v = rng.int(0, 3);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(3);
        seen.add(v);
      }
      expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    });

    it('funguje so zápornými hranicami', () => {
      const rng = new Rng(32);
      const seen = new Set<number>();
      for (let i = 0; i < 1000; i++) seen.add(rng.int(-2, 2));
      expect([...seen].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
    });

    it('int(n, n) vždy vráti n', () => {
      const rng = new Rng(33);
      for (let i = 0; i < 50; i++) expect(rng.int(5, 5)).toBe(5);
    });

    it('rozdelenie je približne rovnomerné', () => {
      const rng = new Rng(34);
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 12_000; i++) counts[rng.int(0, 5)] += 1;
      for (const c of counts) {
        expect(c).toBeGreaterThan(1800);
        expect(c).toBeLessThan(2200);
      }
    });

    it('krajné hodnoty next() (0 a 1 − 2^−32) dajú presne min a maxInclusive, aj pri span = 2^32', () => {
      const rng = new Rng(36);
      const spy = vi.spyOn(rng, 'next').mockReturnValue(1 - 2 ** -32);
      expect(rng.int(0, 9)).toBe(9);
      expect(rng.int(-3, 3)).toBe(3);
      expect(rng.int(0, 2 ** 32 - 1)).toBe(2 ** 32 - 1);
      expect(rng.int(-(2 ** 31), 2 ** 31 - 1)).toBe(2 ** 31 - 1);
      spy.mockReturnValue(0);
      expect(rng.int(0, 9)).toBe(0);
      expect(rng.int(-3, 3)).toBe(-3);
      expect(rng.int(0, 2 ** 32 - 1)).toBe(0);
    });

    it('vyhodí chybu pri necelých hraniciach, min > max a intervale širšom než 2^32', () => {
      const rng = new Rng(35);
      expect(() => rng.int(0.5, 3)).toThrow(RangeError);
      expect(() => rng.int(0, 2.5)).toThrow(RangeError);
      expect(() => rng.int(3, 2)).toThrow(RangeError);
      expect(() => rng.int(0, 2 ** 32)).toThrow(RangeError);
      expect(() => rng.int(0, 2 ** 32 - 1)).not.toThrow();
    });
  });

  describe('pick(arr)', () => {
    it('na prázdnom poli vyhodí chybu', () => {
      expect(() => new Rng(41).pick([])).toThrow(RangeError);
    });

    it('jednoprvkové pole vráti ten prvok', () => {
      expect(new Rng(41).pick(['x'])).toBe('x');
    });

    it('vyberie každý prvok a pole nezmení', () => {
      const rng = new Rng(42);
      const items = ['a', 'b', 'c', 'd'] as const;
      const seen = new Set<string>();
      for (let i = 0; i < 500; i++) seen.add(rng.pick(items));
      expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(items).toEqual(['a', 'b', 'c', 'd']);
    });

    it('spotrebuje presne jedno číslo z generátora', () => {
      const a = new Rng(43);
      const b = new Rng(43);
      a.pick([1, 2, 3]);
      b.nextU32();
      expect(a.getState()).toEqual(b.getState());
    });
  });

  describe('weighted(items, weightOf)', () => {
    it('chyby: prázdne pole, súčet ≤ 0, záporná/NaN/nekonečná váha', () => {
      const rng = new Rng(51);
      const id = (w: number): number => w;
      expect(() => rng.weighted([], id)).toThrow(RangeError);
      expect(() => rng.weighted([0, 0], id)).toThrow(RangeError);
      expect(() => rng.weighted([1, -1], id)).toThrow(RangeError); // záporná váha, súčet 0
      expect(() => rng.weighted([5, -1], id)).toThrow(RangeError); // záporná váha, súčet > 0
      expect(() => rng.weighted([1, Number.NaN], id)).toThrow(RangeError);
      expect(() => rng.weighted([1, Number.POSITIVE_INFINITY], id)).toThrow(RangeError);
    });

    it('chyba nespotrebuje žiadne číslo', () => {
      const rng = new Rng(52);
      const before = rng.getState();
      expect(() => rng.weighted([0, 0], (w) => w)).toThrow();
      expect(rng.getState()).toEqual(before);
    });

    it('prvok s nulovou váhou sa nikdy nevyberie', () => {
      const rng = new Rng(53);
      const items = [{ n: 'zero-first', w: 0 }, { n: 'a', w: 1 }, { n: 'zero-mid', w: 0 }, { n: 'b', w: 2 }, { n: 'zero-last', w: 0 }];
      for (let i = 0; i < 5000; i++) {
        expect(['a', 'b']).toContain(rng.weighted(items, (it) => it.w).n);
      }
    });

    it('jediný prvok s kladnou váhou sa vyberie vždy', () => {
      const rng = new Rng(54);
      for (let i = 0; i < 200; i++) expect(rng.weighted(['x', 'y', 'z'], (s) => (s === 'y' ? 0.001 : 0))).toBe('y');
    });

    it('rozdelenie zodpovedá váham (3 : 1)', () => {
      const rng = new Rng(55);
      let heavy = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) {
        if (rng.weighted(['heavy', 'light'], (s) => (s === 'heavy' ? 3 : 1)) === 'heavy') heavy += 1;
      }
      expect(heavy / n).toBeGreaterThan(0.73);
      expect(heavy / n).toBeLessThan(0.77);
    });

    it('zodpovedá kumulatívnemu výberu z jedného čísla na volanie', () => {
      const items = ['a', 'b', 'c', 'd'];
      const weights: Record<string, number> = { a: 1, b: 0, c: 2.5, d: 0.5 };
      const total = 4;
      const rng = new Rng(56);
      const twin = new Rng(56);
      for (let i = 0; i < 500; i++) {
        const target = twin.next() * total;
        const expected = target < 1 ? 'a' : target < 3.5 ? 'c' : 'd';
        expect(rng.weighted(items, (s) => weights[s])).toBe(expected);
      }
    });

    it('weightOf sa volá práve raz pre každý prvok', () => {
      const rng = new Rng(57);
      let calls = 0;
      rng.weighted([1, 2, 3], (w) => {
        calls += 1;
        return w;
      });
      expect(calls).toBe(3);
    });
  });
});
