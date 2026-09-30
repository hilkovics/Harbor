/**
 * Vzorce kontraktov a bázické body (T05-03, ADR-026; rozhodnutia 1, 6, 7, 8): implementácia v `src/sim` voči ručne
 * spočítaným hodnotám (nezávislým od `helpers/f5.ts`), zaokrúhľovanie nadol, hraničné a chybové vstupy.
 */
import { describe, expect, it } from 'vitest';
import {
  contractRewardCents,
  contractXpGain,
  contractXpReward,
  demurrageStepCents,
  eligibleTemplates,
  lateStepCents,
  maxSlaDaysOf,
  offerClosingTick,
  urgencyBp,
  wholePeriods,
} from '@sim/contracts';
import { BASIS_POINTS, applyBasisPoints, shareOfCents, toBasisPoints } from '@sim/economy';
import { DEFS } from '../world/world-fixtures';

describe('bázické body', () => {
  it('toBasisPoints: 0,005 → 50, 0,05 → 500, 0,6 → 6 000, 0,29 → 2 900 (bez chyby double), 0 → 0', () => {
    expect([0.005, 0.05, 0.6, 0.29, 0, 1.5].map(toBasisPoints)).toEqual([50, 500, 6_000, 2_900, 0, 15_000]);
    expect(BASIS_POINTS).toBe(10_000);
  });

  it.each([-0.1, Number.NaN, Number.POSITIVE_INFINITY])('toBasisPoints(%s) → RangeError', (rate) => {
    expect(() => toBasisPoints(rate)).toThrow(RangeError);
  });

  it('applyBasisPoints zaokrúhľuje nadol a je presná aj pri miere bez binárneho zápisu', () => {
    expect(applyBasisPoints(783_000, 50)).toBe(3_915);
    expect(applyBasisPoints(1_000_007, 50)).toBe(5_000);
    expect(applyBasisPoints(199, 50)).toBe(0);
    expect(shareOfCents(200_000, 0.29)).toBe(58_000);
    expect(applyBasisPoints(0, 9_999)).toBe(0);
  });

  it.each([
    [-1, 50],
    [1.5, 50],
    [10, -1],
    [Number.MAX_SAFE_INTEGER, 10_000],
  ])('applyBasisPoints(%s, %s) → RangeError', (amount, bp) => {
    expect(() => applyBasisPoints(amount, bp)).toThrow(RangeError);
  });
});

describe('urgency, odmena a XP', () => {
  it('maxSlaDays bundled šablón = 8; prázdny zoznam 0', () => {
    expect(maxSlaDaysOf(DEFS.contractTemplates.items)).toBe(8);
    expect(maxSlaDaysOf([])).toBe(0);
  });

  it.each([
    [2, 8, 0.6, 14_500],
    [3, 8, 0.6, 13_750],
    [8, 8, 0.6, 10_000],
    [2, 6, 0.6, 14_000],
    [1, 3, 0.6, 14_000],
    [2, 3, 0.6, 12_000],
    [5, 7, 0.6, 11_714],
    [3, 8, 0, 10_000],
  ])('urgencyBp(sla %s, max %s, factor %s) = %s (10 000 + ⌊factorBp × (max − sla) / max⌋)', (sla, max, factor, bp) => {
    expect(urgencyBp(sla, max, factor)).toBe(bp);
  });

  it.each([
    [0, 8],
    [9, 8],
    [2.5, 8],
  ])('urgencyBp so SLA %s mimo 1…%s → RangeError', (sla, max) => {
    expect(() => urgencyBp(sla, max, 0.6)).toThrow(RangeError);
  });

  it('odmena = ⌊objem × cena × urgencyBp / 10 000⌋', () => {
    expect(contractRewardCents(12, 45_000, 14_500)).toBe(783_000);
    expect(contractRewardCents(51, 45_000, 13_000)).toBe(2_983_500);
    expect(contractRewardCents(7, 333, 11_714)).toBe(2_730);
    expect(() => contractRewardCents(-1, 45_000, 10_000)).toThrow(RangeError);
  });

  it('XP: xpReward = objem × xpPerUnit × xpMultiplier; zisk včas round(xpReward), po SLA round(xpReward × lateXpFactor)', () => {
    expect(contractXpReward(12, 1, 1)).toBe(12);
    expect(contractXpReward(12, 2, 1.5)).toBe(36);
    expect(contractXpGain(12, true, 0.5)).toBe(12);
    expect(contractXpGain(13, false, 0.5)).toBe(7);
    expect(contractXpGain(12.4, true, 0.5)).toBe(12);
    expect(contractXpGain(12, false, 0)).toBe(0);
  });

  it('penalizácie z odmeny: demurrage 50 bp za hodinu, late 500 bp za deň (bundled economy.json)', () => {
    expect(demurrageStepCents(540_000, DEFS.economy)).toBe(2_700);
    expect(lateStepCents(540_000, DEFS.economy)).toBe(27_000);
    expect(lateStepCents(199, DEFS.economy)).toBe(9);
  });
});

describe('čas', () => {
  it('wholePeriods: celé obdobia od since po now, pred since a v ňom 0', () => {
    expect(wholePeriods(100, 100, 360)).toBe(0);
    expect(wholePeriods(459, 100, 360)).toBe(0);
    expect(wholePeriods(460, 100, 360)).toBe(1);
    expect(wholePeriods(1_180, 100, 360)).toBe(3);
    expect(wholePeriods(50, 100, 360)).toBe(0);
  });

  it('offerClosingTick: prvá uzávierka dňa v čase expirácie alebo po nej', () => {
    expect(offerClosingTick(17_281, 8_640)).toBe(25_920);
    expect(offerClosingTick(25_920, 8_640)).toBe(25_920);
    expect(offerClosingTick(1, 8_640)).toBe(8_640);
  });
});

describe('šablóny podľa tieru', () => {
  it('tier 0 ponúka šablóny s minTier 0 (obe feeder), tier 1 aj handy run; váha 0 sa neponúka nikdy', () => {
    const items = DEFS.contractTemplates.items;
    expect(eligibleTemplates(items, 0).map((item) => item.id)).toEqual(['container_feeder_express', 'container_feeder_standard']);
    expect(eligibleTemplates(items, 1).map((item) => item.id)).toEqual(['container_feeder_express', 'container_feeder_standard', 'container_handy_run']);
    expect(eligibleTemplates([{ ...items[0], weight: 0 }], 5)).toEqual([]);
  });
});
