// StatResolver (T02-03, ARCHITECTURE §7.2, §10): resolve('module', defId, stat) = základ z typovaných params defu;
// modifikátory sa aplikujú v poradí add → mul bez ohľadu na poradie v zozname.
import { describe, expect, it } from 'vitest';
import { DefError } from '@sim/defs';
import { STAT_OPS, StatResolver, applyStatModifiers, type ModuleStat, type StatModifier } from '@sim/tech';
import { BERTH, CRANE, DEEP_BERTH, MODULE_DEFS } from '../modules/module-fixtures';

describe('StatResolver — základ z defu', () => {
  const resolver = new StatResolver(MODULE_DEFS);

  const BASES: readonly [string, ModuleStat, number][] = [
    [CRANE, 'cycleTicks', 12],
    [BERTH, 'depthClass', 1],
    [BERTH, 'apronSlots', 8],
    [BERTH, 'maxCranes', 2],
    [BERTH, 'frontWaterCells', 3],
    [DEEP_BERTH, 'depthClass', 3],
    [DEEP_BERTH, 'apronSlots', 6],
  ];
  it.each(BASES)('%s.%s = %i', (defId, stat, expected) => {
    expect(resolver.resolve('module', defId, stat)).toBe(expected);
  });

  it('štatistika, ktorú druh nemá (berth.cycleTicks, crane.apronSlots) → DefError', () => {
    expect(() => resolver.resolve('module', BERTH, 'cycleTicks')).toThrow(DefError);
    expect(() => resolver.resolve('module', CRANE, 'apronSlots')).toThrow(/nemá číselný parameter 'apronSlots'/);
  });

  it('nečíselný parameter (crane.category) → DefError', () => {
    expect(() => resolver.resolve('module', CRANE, 'category' as ModuleStat)).toThrow(DefError);
  });

  it('neznámy def → DefError katalógu', () => {
    expect(() => resolver.resolve('module', 'crane_missing', 'cycleTicks')).toThrow(DefError);
  });
});

describe('StatResolver — modifikátory (§10: base → add → mul)', () => {
  it('STAT_OPS = [add, mul]', () => {
    expect(STAT_OPS).toEqual(['add', 'mul']);
  });

  it('applyStatModifiers: add pred mul bez ohľadu na poradie zoznamu', () => {
    expect(applyStatModifiers(10, [])).toBe(10);
    expect(
      applyStatModifiers(10, [
        { op: 'mul', value: 2 },
        { op: 'add', value: 5 },
      ]),
    ).toBe(30);
    expect(
      applyStatModifiers(10, [
        { op: 'add', value: 5 },
        { op: 'mul', value: 2 },
        { op: 'add', value: -1 },
        { op: 'mul', value: 0.5 },
      ]),
    ).toBe(14);
  });

  it('resolve aplikuje len modifikátory pre rovnaký target, id a stat', () => {
    const modifiers: StatModifier[] = [
      { target: 'module', id: CRANE, stat: 'cycleTicks', op: 'mul', value: 0.5 },
      { target: 'module', id: CRANE, stat: 'cycleTicks', op: 'add', value: 4 },
      { target: 'module', id: CRANE, stat: 'maxCranes', op: 'add', value: 100 },
      { target: 'module', id: BERTH, stat: 'cycleTicks', op: 'add', value: 100 },
    ];
    const resolver = new StatResolver(MODULE_DEFS, modifiers);
    expect(resolver.resolve('module', CRANE, 'cycleTicks')).toBe(8); // (12 + 4) × 0.5
    expect(resolver.resolve('module', BERTH, 'apronSlots')).toBe(8);
  });

  it('zoznam modifikátorov sa pri konštrukcii skopíruje', () => {
    const modifiers: StatModifier[] = [];
    const resolver = new StatResolver(MODULE_DEFS, modifiers);
    modifiers.push({ target: 'module', id: CRANE, stat: 'cycleTicks', op: 'add', value: 1 });
    expect(resolver.resolve('module', CRANE, 'cycleTicks')).toBe(12);
  });
});
