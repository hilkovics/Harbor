// Bunka pod hákom žeriava (F6d, ADR-033 dodatok T6D-02): pevninský riadok footprintu žeriava na osi výložníka — vozidlo tam stojí pri
// odovzdaní jednotky. Poloha závisí len od geometrie (footprint žeriava, strana kotviska pri vode), nie od stavu sveta.
import { describe, expect, it } from 'vitest';
import { BerthModule, CraneModule, hookCellCoord, hookCellIndex } from '@sim/modules';
import { commandFromJSON } from '@sim/commands';
import { hookCellOfCrane } from '@sim/vehicles';
import { World } from '@sim/world';
import { SECOND_CRANE_CELL, placeModuleCommand, removeModuleCommand } from '../helpers/harbor';
import { BUNDLED_DEFS, DEFS, MAP } from '../world/world-fixtures';

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

describe('QuayLanes.hookCellOf: bunka pod hákom v odvodenej cache (T6D-05b), rovnaká ako hookCellIndex', () => {
  const craneOf = (world: World, index = 0): CraneModule => [...world.modules.values()].filter((module): module is CraneModule => module instanceof CraneModule)[index];

  it('under_hook: cache vráti index bunky pod hákom (aj cez hookCellOfCrane) a pri opakovaní to isté číslo bez ďalšieho výpočtu', () => {
    const world = World.create(BUNDLED_DEFS, MAP, 1);
    const crane = craneOf(world);
    const berth = world.modules.get(crane.berthId) as BerthModule;
    const expected = hookCellIndex(world.grid, crane, berth);
    expect(world.quay.hookCellOf(crane.id)).toBe(expected);
    expect(hookCellOfCrane(world, crane.id)).toBe(expected);
    expect(world.quay.hookCellOf(crane.id)).toBe(expected);
  });

  it('apron: kotvisko nemá jazdné nábrežie, takže žiadna bunka pod hákom; neznámy žeriav tiež nie', () => {
    const world = World.create(DEFS, MAP, 1);
    expect(world.quay.hookCellOf(craneOf(world).id)).toBeUndefined();
    expect(hookCellOfCrane(world, 9_999 as never)).toBeUndefined();
  });

  it('po zmene modulov sa cache prepočíta: nový žeriav má svoju bunku pod hákom, odstránený žiadnu', () => {
    const world = World.create(BUNDLED_DEFS, MAP, 1);
    const first = craneOf(world);
    expect(world.quay.hookCellOf(first.id)).toBeDefined(); // cache sa naplnila pred pridaním
    world.enqueue(commandFromJSON(placeModuleCommand('crane_container_gantry', SECOND_CRANE_CELL)));
    world.applyPending();
    const second = craneOf(world, 1);
    expect(second.id).not.toBe(first.id);
    const berth = world.modules.get(second.berthId) as BerthModule;
    expect(world.quay.hookCellOf(second.id)).toBe(hookCellIndex(world.grid, second, berth));
    expect(world.quay.hookCellOf(second.id)).toBe(world.grid.index(45, 16));
    world.enqueue(commandFromJSON(removeModuleCommand(second.id)));
    world.applyPending();
    expect(world.quay.hookCellOf(second.id)).toBeUndefined();
    expect(world.quay.hookCellOf(first.id)).toBe(world.grid.index(43, 16));
  });
});
