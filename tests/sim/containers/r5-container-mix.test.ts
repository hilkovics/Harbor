// Zmes typov kontajnerov kontraktu (TR5-01, ADR-042): `drawUnitTypes` (Rng pri vzniku ponuky), `rateTeuOf` (rateMultiplier v odmene) a ponuky poolu s `typeMix`.
import { describe, expect, it } from 'vitest';
import { Rng } from '@sim/core';
import { drawContainerCount, drawUnitTypes, rateTeuOf, unitSizeFt, unitTypeAt } from '@sim/contracts';
import { DEFS } from '../helpers/f5';

const TYPES = DEFS.containerTypes;
const MIX = [
  { type: 'reefer', share: 0.3 },
  { type: 'tank', share: 0.2 },
];

describe('drawUnitTypes', () => {
  it('bez zmesi: prázdne pole (všetky dry) a Rng sa nespotrebuje', () => {
    const rng = new Rng(5);
    const before = rng.getState();
    expect(drawUnitTypes(rng, 10, 15, undefined, TYPES, true)).toEqual([]);
    expect(drawUnitTypes(rng, 10, 15, [], TYPES, true)).toEqual([]);
    expect(rng.getState()).toEqual(before);
  });

  it('jedno číslo Rng na kontajner; typ pozná veľkosť (tank len 20′), podiely približne sedia', () => {
    const rng = new Rng(9);
    const units = 400;
    const teu = 600;
    const before = new Rng(9);
    const types = drawUnitTypes(rng, units, teu, MIX, TYPES, true);
    for (let i = 0; i < units; i++) before.next();
    expect(rng.getState()).toEqual(before.getState());
    expect(types).toHaveLength(units);
    types.forEach((type, index) => {
      if (type === 'tank') expect(unitSizeFt(index, units, teu)).toBe(20);
    });
    const reefers = types.filter((type) => type === 'reefer').length;
    expect(reefers).toBeGreaterThan(units * 0.2);
    expect(reefers).toBeLessThan(units * 0.4);
  });

  it('svet bez bloku so zásuvkami: žiadny reefer; zmes len z reeferov nespotrebuje Rng', () => {
    const onlyReefer = new Rng(9);
    const stateBefore = onlyReefer.getState();
    expect(drawUnitTypes(onlyReefer, 50, 50, [{ type: 'reefer', share: 0.5 }], TYPES, false)).toEqual([]);
    expect(onlyReefer.getState()).toEqual(stateBefore);
    const rng = new Rng(9);
    const types = drawUnitTypes(rng, 200, 200, MIX, TYPES, false);
    expect(types).not.toContain('reefer');
    expect(types).toContain('tank');
    const reference = new Rng(9);
    for (let i = 0; i < 200; i++) reference.next();
    expect(rng.getState()).toEqual(reference.getState());
  });

  it('deterministické: rovnaký seed dá rovnaké typy', () => {
    expect(drawUnitTypes(new Rng(3), 80, 120, MIX, TYPES, true)).toEqual(drawUnitTypes(new Rng(3), 80, 120, MIX, TYPES, true));
  });

  it('unitTypeAt: chýbajúci prvok je dry', () => {
    expect(unitTypeAt([], 4)).toBe('dry');
    expect(unitTypeAt(['reefer'], 0)).toBe('reefer');
    expect(unitTypeAt(['reefer'], 1)).toBe('dry');
  });
});

describe('rateTeuOf: rateMultiplier v odmene', () => {
  it('bez typov presne volumeTeu; reefery (1,6) a tank (1,3) zvyšujú efektívne TEU', () => {
    expect(rateTeuOf([], 10, 10, TYPES)).toBe(10);
    expect(rateTeuOf(Array<string>(10).fill('reefer'), 10, 10, TYPES)).toBe(16);
    expect(rateTeuOf([...Array<string>(5).fill('tank'), ...Array<string>(5).fill('dry')], 10, 10, TYPES)).toBe(12);
  });

  it('40′ kontajner sa počíta ako 2 TEU × násobiteľ', () => {
    const units = drawContainerCount(new Rng(1), 20, 1);
    const all = Array<string>(units).fill('reefer');
    expect(rateTeuOf(all, units, 20, TYPES)).toBe(32);
  });
});
