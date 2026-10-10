// R2 / TR2-01 (ADR-039): zmes veľkostí kontajnerov kontraktu — `drawContainerCount` (Rng pri vzniku ponuky), `unitSizeFt` (poradie veľkostí) a ponuky poolu.
import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/core';
import { drawContainerCount, largeContainerCount, unitSizeFt } from '@sim/contracts';
import { DEFS, offeredContracts, worldWithPool } from '../helpers/f5';

/** Súčet TEU kontajnerov `0 … units − 1` kontraktu. */
function teuOfSizes(units: number, teu: number): number {
  let sum = 0;
  for (let i = 0; i < units; i++) sum += unitSizeFt(i, units, teu) / 20;
  return sum;
}

describe('drawContainerCount', () => {
  it('bez sizeMix (0) sú všetky 20′: počet = TEU a Rng sa nespotrebuje', () => {
    const rng = new Rng(11);
    const before = rng.getState();
    expect(drawContainerCount(rng, 37, 0)).toBe(37);
    expect(rng.getState()).toEqual(before);
  });

  it('sizeMix 1: samé 40′ (nepárne TEU končí jedným 20′), počet = ⌈TEU / 2⌉', () => {
    const rng = new Rng(11);
    expect(drawContainerCount(rng, 24, 1)).toBe(12);
    expect(drawContainerCount(rng, 25, 1)).toBe(13);
  });

  it('deterministické: rovnaký seed dá rovnaký počet, iný seed (spravidla) iný; počet je medzi ⌈TEU / 2⌉ a TEU', () => {
    const counts = (seed: number): number[] => {
      const rng = new Rng(seed);
      return Array.from({ length: 20 }, () => drawContainerCount(rng, 48, 0.6));
    };
    expect(counts(7)).toEqual(counts(7));
    expect(counts(7)).not.toEqual(counts(8));
    for (const count of counts(7)) {
      expect(count).toBeGreaterThanOrEqual(24);
      expect(count).toBeLessThanOrEqual(48);
    }
  });

  it('podiel 40′ medzi kontajnermi zodpovedá sizeMix (0,6 ±0,05 na 4000 kontajneroch) a každý ťah spotrebuje najviac jedno číslo na kontajner', () => {
    const rng = new Rng(2024);
    let units = 0;
    let large = 0;
    for (let i = 0; i < 200; i++) {
      const teu = 40;
      const count = drawContainerCount(rng, teu, 0.6);
      units += count;
      large += largeContainerCount(count, teu);
    }
    expect(large / units).toBeGreaterThan(0.55);
    expect(large / units).toBeLessThan(0.65);
  });
});

describe('unitSizeFt — poradie veľkostí kontajnerov kontraktu', () => {
  it.each([
    [10, 10],
    [10, 14],
    [7, 12],
    [20, 40],
    [5, 5],
    [1, 2],
    [1, 1],
    [33, 49],
  ])('%i kontajnerov / %i TEU: súčet TEU sedí a počet 40′ je volumeTeu − volumeUnits', (units, teu) => {
    expect(teuOfSizes(units, teu)).toBe(teu);
    let large = 0;
    for (let i = 0; i < units; i++) if (unitSizeFt(i, units, teu) === 40) large += 1;
    expect(large).toBe(teu - units);
  });

  it('40′ sú rozložené rovnomerne (žiadne dva 40′ vedľa seba, kým je ich najviac polovica) a index mimo rozsahu je 20′', () => {
    const sizes = Array.from({ length: 10 }, (_, i) => unitSizeFt(i, 10, 14));
    expect(sizes).toEqual([20, 20, 40, 20, 40, 20, 20, 40, 20, 40]);
    for (let i = 1; i < 10; i++) if (unitSizeFt(i, 10, 14) === 40) expect(unitSizeFt(i - 1, 10, 14)).toBe(20);
    expect([unitSizeFt(-1, 10, 14), unitSizeFt(10, 10, 14)]).toEqual([20, 20]);
  });
});

describe('ponuky poolu: objem v TEU a zmes veľkostí (bundled defy so sizeMix 0,6)', () => {
  it('každá ponuka: volumeUnits ≤ volumeTeu ≤ 2 × volumeUnits, volumeTeu v rozsahu šablóny a najviac kapacita lode (v TEU)', () => {
    let mixed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      for (const offer of offeredContracts(worldWithPool(DEFS, seed))) {
        const template = DEFS.contractTemplates.get(offer.templateId);
        const ship = DEFS.ships.get(offer.shipClassId);
        expect(offer.volumeTeu, `seed ${String(seed)}, ${offer.templateId}`).toBeGreaterThanOrEqual(offer.volumeUnits);
        expect(offer.volumeTeu).toBeLessThanOrEqual(2 * offer.volumeUnits);
        expect(offer.volumeTeu).toBeGreaterThanOrEqual(template.volumeUnitsRange[0]);
        expect(offer.volumeTeu).toBeLessThanOrEqual(Math.min(template.volumeUnitsRange[1], ship.capacityUnits));
        if (offer.volumeTeu > offer.volumeUnits) mixed += 1;
      }
    }
    expect(mixed).toBeGreaterThan(0);
  });

  it('rovnaký seed dá rovnaké objemy (kontajnery aj TEU)', () => {
    const shape = (seed: number): unknown[] => offeredContracts(worldWithPool(DEFS, seed)).map((offer) => [offer.id, offer.volumeUnits, offer.volumeTeu]);
    expect(shape(41)).toEqual(shape(41));
  });
});
