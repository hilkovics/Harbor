/**
 * Sadzby v bázických bodoch (docs/tasks/phase-05.md rozhodnutie 1; ADR-015, ADR-026): podiel z defu sa raz prevedie
 * na celé bázické body (`round(rate × 10 000)`) a ďalej sa počíta len v celých číslach, zaokrúhľuje sa nadol. Rovnaký
 * postup ako `refundCents` (ADR-015) — priamy súčin v double (`reward × 0.005`) by pri mierach bez presného binárneho
 * zápisu strácal cent.
 */

/** Počet bázických bodov v celku (100 % = 10 000 bp). Konštanta jednotky, nie herná hodnota. */
export const BASIS_POINTS = 10_000;

/** Podiel (konečné číslo ≥ 0) v celých bázických bodoch: `0.005 → 50`, `0.6 → 6 000`; inak `RangeError`. */
export function toBasisPoints(rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) throw new RangeError(`bázické body: podiel musí byť konečné číslo ≥ 0, dostal ${String(rate)}`);
  return Math.round(rate * BASIS_POINTS);
}

/**
 * `⌊amount × bp / 10 000⌋` pre celé `amount ≥ 0` a celé `bp ≥ 0` — delenie bez zvyšku, výsledok je presné celé číslo.
 * Súčin mimo bezpečného celého rozsahu alebo neplatný vstup → `RangeError`.
 */
export function applyBasisPoints(amount: number, bp: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(bp) || bp < 0) {
    throw new RangeError(`bázické body: suma a sadzba musia byť celé čísla ≥ 0, dostal ${String(amount)} × ${String(bp)} bp`);
  }
  const product = amount * bp;
  if (!Number.isSafeInteger(product)) throw new RangeError(`bázické body: ${String(amount)} × ${String(bp)} presahuje bezpečný celočíselný rozsah`);
  return (product - (product % BASIS_POINTS)) / BASIS_POINTS;
}

/** Podiel `rate` z `amountCents` v celých centoch nadol: `applyBasisPoints(amountCents, toBasisPoints(rate))`. */
export function shareOfCents(amountCents: number, rate: number): number {
  return applyBasisPoints(amountCents, toBasisPoints(rate));
}
