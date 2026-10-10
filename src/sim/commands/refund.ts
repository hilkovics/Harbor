/**
 * Refundácia pri odstránení stavby (ARCHITECTURE §8 bod 8; ADR-012, ADR-015) — jediný vzorec pre cesty, koľaje
 * aj moduly. Miera `economy.removalRefundRate` sa prevedie na celé bázické body (1 = 10 000 bp) a ďalej sa počíta
 * len v celých číslach:
 *
 *   refund = floor(price × round(rate × 10 000) / 10 000)
 *
 * Priamy súčin v double (`price × rate`) by pri mierach, ktoré nemajú presný binárny zápis, strácal cent
 * (200 000 × 0.29 = 57 999.999… → 57 999); v bázických bodoch je výsledok presný (58 000).
 */

/** Počet bázických bodov v celku (100 % = 10 000 bp). Konštanta jednotky, nie herná hodnota. */
export const BASIS_POINTS_PER_UNIT = 10_000;

/**
 * Miera (0 … 1) v celých bázických bodoch, zaokrúhlená na najbližší bod (0.29 → 2 900, 0.5 → 5 000).
 * Miera mimo 0 … 1 alebo nekonečná → `RangeError` (def ju už obmedzuje, toto je poistka volajúceho).
 */
export function rateToBasisPoints(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError(`refundácia: miera musí byť číslo 0 … 1, dostal ${String(rate)}`);
  }
  return Math.round(rate * BASIS_POINTS_PER_UNIT);
}

/**
 * Refundácia v centoch z ceny `priceCents` (celé ≥ 0) pri miere `rate` (0 … 1), zaokrúhlená nadol na cent.
 * Súčin aj delenie sú celočíselné; súčin mimo bezpečného celého rozsahu alebo neplatná cena → `RangeError`.
 */
export function refundCents(priceCents: number, rate: number): number {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    throw new RangeError(`refundácia: cena musí byť celé číslo ≥ 0 (centy), dostal ${String(priceCents)}`);
  }
  const product = priceCents * rateToBasisPoints(rate);
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`refundácia: cena ${String(priceCents)} × miera presahuje bezpečný celočíselný rozsah`);
  }
  // Delenie bez zvyšku: (product − product mod B) je presný násobok B, takže podiel je presné celé číslo.
  return (product - (product % BASIS_POINTS_PER_UNIT)) / BASIS_POINTS_PER_UNIT;
}
