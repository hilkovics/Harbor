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
 * Seed (uint32) → počiatočný stav cez splitmix32 (štyri po sebe idúce výstupy). `seed | 0` len reinterpretuje
 * 32 bitov ako int32 (seedy ≥ 2^31 dajú rovnaké bity), takže každý uint32 seed má vlastnú sekvenciu.
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

  /**
   * @param seed uint32 — celé číslo 0 … 2^32 − 1; rovnaký seed → rovnaká sekvencia. Iná hodnota (záporná, necelá,
   *   ≥ 2^32, NaN) → `RangeError`: splitmix32 berie len 32 bitov, takže väčší seed by sa potichu zlial s iným
   *   (1 ≡ 2^32 + 1) a uložený seed v save by neurčoval sekvenciu jednoznačne.
   */
  constructor(seed: number) {
    if (!isUint32(seed)) {
      throw new RangeError(`Rng: seed musí byť celé číslo 0 … 2^32 − 1 (uint32), dostal ${String(seed)}`);
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

  /**
   * Reálne číslo z intervalu [min, max) ako `min + next() × (max − min)`; spotrebuje jedno číslo.
   * Pri `min === max` vráti `min`.
   *
   * Chyba (`RangeError`, nič nespotrebuje): nekonečná alebo NaN hranica, `min > max`, alebo rozpätie `max − min`
   * pretečie do `Infinity` (napr. `range(-Number.MAX_VALUE, Number.MAX_VALUE)`).
   *
   * Presnosť pri veľkých magnitúdach: `next()` má krok 2^−32, výsledok sa zaokrúhľuje na double. Horná hranica
   * je výlučná zaručene, ak `max(|min|, |max|) < 2^20 × (max − min)` (napr. `range(1e6, 1e6 + 1)` áno). Pri väčšom
   * pomere (veľké čísla s malým rozpätím, napr. `range(2^40, 2^40 + 1)`) môže zaokrúhlenie vrátiť presne `max`;
   * dolná hranica `min` platí vždy. Pre diskrétne hodnoty použi `int`.
   */
  range(min: number, max: number): number {
    const span = max - min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || !Number.isFinite(span)) {
      throw new RangeError(`Rng.range: neplatný interval [${String(min)}, ${String(max)})`);
    }
    return min + this.next() * span;
  }

  /**
   * Celé číslo z uzavretého intervalu [min, maxInclusive] ako `min + floor(next() × span)`,
   * `span = maxInclusive − min + 1`; spotrebuje jedno číslo. Výsledok nikdy neopustí interval (ani pri span = 2^32).
   *
   * Skreslenie: 2^32 hodnôt `nextU32` sa rozdelí medzi `span` výsledkov; ak `span` nie je mocnina dvojky, niektoré
   * výsledky dostanú o jednu hodnotu viac → pravdepodobnosť výsledku sa od `1 / span` líši relatívne najviac
   * o `span / 2^32` (pre span ≤ 2^16 menej ako 0,002 %). Pre span ≤ 2^21 je mapovanie presné; pri väčšom rozpätí
   * môže zaokrúhlenie double posunúť ojedinelé hodnoty do susedného výsledku.
   *
   * Chyba (`RangeError`, nič nespotrebuje): hranica nie je bezpečné celé číslo, `min > maxInclusive`, `span > 2^32`.
   */
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

  /**
   * Pravdepodobnostné rozhodnutie: `true` s pravdepodobnosťou `probability` (`0 … 1`) ako `next() < probability`;
   * spotrebuje vždy jedno číslo (aj pri 0 a 1), takže dĺžka prúdu nezávisí od hodnoty. `0` nikdy, `1` vždy (`next() < 1`).
   *
   * Chyba (`RangeError`, nič nespotrebuje): pravdepodobnosť nie je konečné číslo v `[0, 1]`.
   */
  chance(probability: number): boolean {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError(`Rng.chance: pravdepodobnosť musí byť číslo 0 … 1, dostal ${String(probability)}`);
    }
    return this.next() < probability;
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
