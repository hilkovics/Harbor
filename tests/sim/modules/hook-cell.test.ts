// Bunka pod hákom žeriava (F6d, ADR-033 dodatok T6D-02): pevninský riadok footprintu žeriava na osi výložníka — vozidlo tam stojí pri
// odovzdaní jednotky. Poloha závisí len od geometrie (footprint žeriava, strana kotviska pri vode), nie od stavu sveta.
import { describe, expect, it } from 'vitest';
import { BerthModule, CraneModule, hookCellCoord, hookCellIndex } from '@sim/modules';
import { World } from '@sim/world';
import { BUNDLED_DEFS, MAP } from '../world/world-fixtures';

type Side = 'n' | 'e' | 's' | 'w';

/** Žeriav a kotvisko len s poľami, ktoré `hookCellCoord` číta (footprint žeriava po rotácii a strana pri vode). */
function fake(origin: { x: number; y: number }, size: { w: number; h: number }, waterSide: Side): [CraneModule, BerthModule] {
  return [{ origin, size } as unknown as CraneModule, { waterSide } as unknown as BerthModule];
}

describe('hookCellCoord: pevninský riadok footprintu žeriava, stred šírky (pri párnej šírke ľavá / horná zo stredných buniek)', () => {
  it.each<[Side, { w: number; h: number }, { x: number; y: number }]>([
    ['n', { w: 2, h: 3 }, { x: 10, y: 22 }], // voda hore → pevnina dole: spodný riadok, ľavý zo stredných stĺpcov
    ['s', { w: 2, h: 3 }, { x: 10, y: 20 }], // voda dole → horný riadok
    ['e', { w: 3, h: 2 }, { x: 10, y: 20 }], // voda vpravo → ľavý stĺpec, horný zo stredných riadkov
    ['w', { w: 3, h: 2 }, { x: 12, y: 20 }], // voda vľavo → pravý stĺpec
  ])('voda %s, footprint %j → %j', (waterSide, size, expected) => {
    expect(hookCellCoord(...fake({ x: 10, y: 20 }, size, waterSide))).toEqual(expected);
  });

  it('nepárna šírka: presný stred (3 × 3 s vodou hore → [11, 22])', () => {
    expect(hookCellCoord(...fake({ x: 10, y: 20 }, { w: 3, h: 3 }, 'n'))).toEqual({ x: 11, y: 22 });
  });

  it('bunka pod hákom vždy leží vo footprinte žeriava', () => {
    for (const side of ['n', 'e', 's', 'w'] as const) {
      for (const size of [{ w: 2, h: 3 }, { w: 3, h: 2 }, { w: 1, h: 2 }, { w: 3, h: 3 }]) {
        const { x, y } = hookCellCoord(...fake({ x: 5, y: 7 }, size, side));
        expect(x).toBeGreaterThanOrEqual(5);
        expect(x).toBeLessThan(5 + size.w);
        expect(y).toBeGreaterThanOrEqual(7);
        expect(y).toBeLessThan(7 + size.h);
      }
    }
  });
});

describe('hookCellIndex: skutočný žeriav root kotviska', () => {
  const world = World.create(BUNDLED_DEFS, MAP, 1);
  const crane = [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
  const berth = world.modules.get(crane.berthId) as BerthModule;

  it('žeriav 2 × 3 na (43, 14) s vodou hore má bunku pod hákom (43, 16): pevninský riadok, hneď nad cestou y = 17', () => {
    expect(berth.waterSide).toBe('n');
    expect(hookCellCoord(crane, berth)).toEqual({ x: 43, y: 16 });
    expect(hookCellIndex(world.grid, crane, berth)).toBe(world.grid.index(43, 16));
  });

  it('nábrežie kotviska pod hákom (world.quay) obsahuje bunku pod hákom a nie bunky mimo footprintu kotviska', () => {
    const hook = hookCellIndex(world.grid, crane, berth);
    expect(world.quay.ownerAt(hook)).toBe(berth.id);
    expect(world.quay.isQuay(world.grid.index(43, 17))).toBe(false); // cesta pod kotviskom
  });
});
