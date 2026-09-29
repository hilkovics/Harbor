/**
 * Deterministický generátor pseudonáhodných čísel — xoshiro128** (32-bit; Blackman & Vigna).
 *
 * Jediný zdroj náhody v `src/sim/` (CLAUDE.md, tvrdé pravidlo 3). Stav sú 4× uint32,
 * ktoré sa ukladajú do save (ARCHITECTURE §14: seed/stav v save), takže obnova pokračuje identicky.
 * Všetka aritmetika ide cez `Math.imul` a `>>> 0`, aby výsledok nezávisel od platformy.
 */

/** Stav generátora: štyri uint32 slová (s0..s3). Nikdy nesmie byť celý nulový. */
export type RngState = [number, number, number, number];

/** 2^32 — rozsah uint32, deliteľ pre `next()` (skutočná konštanta). */
const U32_RANGE = 4294967296;

/** Rotácia uint32 doľava o `k` bitov (0 < k < 32). */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Seed → počiatočný stav cez splitmix32 (štyri po sebe idúce výstupy).
 * Seed 0 je platný (splitmix32 pripočítava zlatý rez, takže stav nie je nulový).
 */
function seedToState(seed: number): RngState {
  let a = seed | 0;
  const step = (): number => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
  const state: RngState = [step(), step(), step(), step()];
  // Poistka: xoshiro so samými nulami uviazne na nule. Prakticky nedosiahnuteľné, ale stav nikdy nesmie byť nulový.
  if ((state[0] | state[1] | state[2] | state[3]) === 0) state[0] = 1;
  return state;
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  /** @param seed celé číslo (bezpečný integer); rovnaký seed → rovnaká sekvencia. */
  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError(`Rng: seed musí byť celé číslo, dostal ${String(seed)}`);
    }
    this.setState(seedToState(seed));
  }

  /** Obnoví generátor z uloženého stavu (pozri `getState`). Vyhodí chybu pri neplatnom alebo nulovom stave. */
  static fromState(state: Readonly<RngState>): Rng {
    const rng = new Rng(0);
    rng.setState(state);
    return rng;
  }

  /** Kópia stavu pre save; zmena vráteného poľa generátor neovplyvní. */
  getState(): RngState {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** Nastaví stav (štyri uint32, nie všetky nulové). Po nastavení pokračuje sekvencia identicky. */
  setState(state: Readonly<RngState>): void {
    if (!Array.isArray(state) || state.length !== 4 || !state.every(isUint32)) {
      throw new RangeError('Rng.setState: očakávané 4 celé čísla v rozsahu uint32');
    }
    if ((state[0] | state[1] | state[2] | state[3]) === 0) {
      throw new RangeError('Rng.setState: stav nesmie byť celý nulový');
    }
    [this.s0, this.s1, this.s2, this.s3] = state;
  }

  /** Ďalšie uint32 (0..2^32-1) presne podľa referenčného xoshiro128**. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Číslo z intervalu [0, 1). */
  next(): number {
    return this.nextU32() / U32_RANGE;
  }

  /** Reálne číslo z intervalu [min, max). Pri `min === max` vráti `min`; `min > max` je chyba. */
  range(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new RangeError(`Rng.range: neplatný interval [${String(min)}, ${String(max)})`);
    }
    return min + this.next() * (max - min);
  }

  /** Celé číslo z uzavretého intervalu [min, maxInclusive]. */
  int(min: number, maxInclusive: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(maxInclusive) || min > maxInclusive) {
      throw new RangeError(`Rng.int: neplatný interval [${String(min)}, ${String(maxInclusive)}]`);
    }
    const span = maxInclusive - min + 1;
    if (span > U32_RANGE) {
      throw new RangeError(`Rng.int: interval je širší než 2^32 (${String(span)})`);
    }
    return min + Math.floor(this.next() * span);
  }

  /** Náhodný prvok poľa (spotrebuje jedno číslo). Na prázdnom poli vyhodí chybu. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Rng.pick: prázdne pole');
    }
    return items[this.int(0, items.length - 1)];
  }

  /**
   * Vážený výber (kumulatívne váhy; spotrebuje jedno číslo). Váha 0 = prvok sa nikdy nevyberie.
   * Chyba pri prázdnom poli, zápornej/nekonečnej/NaN váhe alebo súčte váh ≤ 0.
   */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    if (items.length === 0) {
      throw new RangeError('Rng.weighted: prázdne pole');
    }
    const weights: number[] = [];
    let total = 0;
    for (const item of items) {
      const weight = weightOf(item);
      if (!Number.isFinite(weight) || weight < 0) {
        throw new RangeError(`Rng.weighted: neplatná váha ${String(weight)}`);
      }
      weights.push(weight);
      total += weight;
    }
    if (!(total > 0)) {
      throw new RangeError('Rng.weighted: súčet váh musí byť > 0');
    }
    const target = this.next() * total;
    let cumulative = 0;
    let lastPositive = 0;
    for (let i = 0; i < items.length; i++) {
      if (weights[i] === 0) continue;
      cumulative += weights[i];
      lastPositive = i;
      if (target < cumulative) return items[i];
    }
    // Zaokrúhľovanie súčtu môže nechať `target` tesne nad poslednou kumulatívnou hodnotou.
    return items[lastPositive];
  }
}
