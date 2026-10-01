// Refundácia v bázických bodoch (T02-04, ADR-015; spresňuje ADR-012): floor(price × round(rate × 10 000) / 10 000)
// celočíselne. Referenčný výpočet v testoch ide cez BigInt, aby nezávisel od implementácie.
import { describe, expect, it } from 'vitest';
import { BASIS_POINTS_PER_UNIT, rateToBasisPoints, refundCents } from '@sim/commands';

const reference = (price: number, rate: number): number =>
  Number((BigInt(price) * BigInt(Math.round(rate * 10_000))) / 10_000n);

describe('rateToBasisPoints', () => {
  it.each([
    [0, 0],
    [0.5, 5_000],
    [0.29, 2_900],
    [0.1, 1_000],
    [0.07, 700],
    [0.12345, 1_235],
    [1, 10_000],
  ])('%d → %d bp', (rate, bp) => {
    expect(rateToBasisPoints(rate)).toBe(bp);
  });

  it('jednotka je 10 000 bp', () => {
    expect(BASIS_POINTS_PER_UNIT).toBe(10_000);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])('miera %d mimo 0 … 1 → RangeError', (rate) => {
    expect(() => rateToBasisPoints(rate)).toThrow(RangeError);
  });
});

describe('refundCents', () => {
  it('miera 0.29 a cena 200 000 → 58 000 (double by dal 57 999)', () => {
    expect(Math.floor(200_000 * 0.29)).toBe(57_999);
    expect(refundCents(200_000, 0.29)).toBe(58_000);
  });

  it.each([
    [40_000_000, 0.5, 20_000_000],
    [60_000_000, 0.5, 30_000_000],
    [0, 0.5, 0],
    [200_000, 0, 0],
    [200_000, 1, 200_000],
    [3, 0.5, 1], // zaokrúhlenie nadol
    [9_999, 0.0001, 0],
    [10_000, 0.0001, 1],
  ])('refundCents(%d, %d) = %d', (price, rate, expected) => {
    expect(refundCents(price, rate)).toBe(expected);
  });

  it('zhoda s BigInt referenciou pre mriežku cien a mier (aj miery bez presného binárneho zápisu)', () => {
    const prices = [1, 7, 99, 200_000, 400_000, 1_234_567, 40_000_000, 60_000_000, 999_999_999];
    const rates = [0, 0.01, 0.07, 0.1, 0.29, 0.3, 0.33, 0.5, 0.57, 0.7, 0.99, 1];
    for (const price of prices) {
      for (const rate of rates) expect(refundCents(price, rate), `${String(price)} × ${String(rate)}`).toBe(reference(price, rate));
    }
  });

  it('veľká cena pri hranici bezpečných celých čísel: podiel je presný (bez chyby delenia v double)', () => {
    // price × bp = 9 007 199 254 740 000 (< 2^53); presný podiel je 900 719 925 474 (zvyšok 0).
    const price = 900_719_925_474;
    expect(refundCents(price, 1)).toBe(price);
    expect(refundCents(price - 1, 0.9999)).toBe(reference(price - 1, 0.9999));
  });

  it.each([
    ['záporná cena', -1, 0.5],
    ['necelá cena', 1.5, 0.5],
    ['cena NaN', Number.NaN, 0.5],
    ['súčin mimo bezpečného rozsahu', Number.MAX_SAFE_INTEGER, 0.5],
    ['miera > 1', 100, 1.5],
  ])('%s → RangeError', (_name, price, rate) => {
    expect(() => refundCents(price, rate)).toThrow(RangeError);
  });
});
