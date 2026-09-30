// BerthGroup (T02-03, ARCHITECTURE §5.4, ADR-014): berthy s rovnakou waterSide, ktorých krátke hrany sa dotýkajú na
// tej istej línii pobrežia, tvoria skupinu; totalLength = súčet lengthCells, minDepth = minimum. Poradie berthov po
// pobreží: stúpajúce x pri n/s, stúpajúce y pri e/w; skupiny zoradené podľa (waterSide, línia, začiatok), id od 1.
// Skupiny vo svete (prepočet pri place/remove, harbor_01) sú vo world-berth-groups.test.ts.
import { describe, expect, it } from 'vitest';
import type { Rotation } from '@sim/grid';
import { computeBerthGroups, type BerthModule } from '@sim/modules';
import { berthOn, quayGrid } from './module-fixtures';

describe('computeBerthGroups — geometria vo všetkých rotáciách (syntetická mriežka)', () => {
  // Mriežka má hĺbku 3, štandardný berth (depthClass 1) → efektívna hĺbka 1.
  const grid = quayGrid(40, 40);
  let nextId = 1;
  const berth = (x: number, y: number, rotation: Rotation = 0): BerthModule => berthOn(grid, nextId++, { x, y }, rotation);
  const groupsOf = (...berths: BerthModule[]) => computeBerthGroups(berths).map((g) => ({ ...g, berthIds: [...g.berthIds] }));

  it('waterSide e (rot 90): berthy pod sebou (y 0–7, 8–15) na línii x = 7 → skupina 16 zoradená podľa y', () => {
    const lower = berth(5, 8, 90);
    const upper = berth(5, 0, 90);
    expect(groupsOf(lower, upper)).toEqual([{ id: 1, berthIds: [upper.id, lower.id], totalLength: 16, minDepth: 1 }]);
  });

  it('waterSide w (rot 270) a s (rot 180) sa spájajú rovnako', () => {
    const w1 = berth(20, 10, 270);
    const w2 = berth(20, 18, 270);
    const s1 = berth(8, 30, 180);
    const s2 = berth(0, 30, 180);
    const groups = groupsOf(w1, w2, s1, s2);
    // Poradie strán n, e, s, w → skupina 's' pred skupinou 'w'.
    expect(groups).toEqual([
      { id: 1, berthIds: [s2.id, s1.id], totalLength: 16, minDepth: 1 },
      { id: 2, berthIds: [w1.id, w2.id], totalLength: 16, minDepth: 1 },
    ]);
  });

  it('rôzna waterSide → rôzne skupiny, aj keď sa footprinty dotýkajú', () => {
    const north = berth(0, 0, 0);
    const south = berth(8, 0, 180);
    expect(groupsOf(north, south).map((g) => g.berthIds)).toEqual([[north.id], [south.id]]);
  });

  it('rovnaká strana, iná línia pobrežia (posun o riadok) → rôzne skupiny', () => {
    const a = berth(0, 5, 0);
    const b = berth(8, 6, 0);
    expect(groupsOf(a, b).map((g) => g.berthIds)).toEqual([[a.id], [b.id]]);
  });

  it('dotyk len rohom (diagonála) → rôzne skupiny', () => {
    const a = berth(0, 20, 0);
    const b = berth(8, 23, 0);
    expect(groupsOf(a, b)).toHaveLength(2);
  });

  it('skupiny sú zoradené podľa (waterSide, línia, začiatok) a číslované od 1', () => {
    const eastFacing = berth(30, 0, 90); // strana e
    const northLow = berth(10, 12, 0); // strana n, línia 12
    const northHighRight = berth(20, 2, 0); // strana n, línia 2, začiatok 20
    const northHighLeft = berth(0, 2, 0); // strana n, línia 2, začiatok 0
    const groups = groupsOf(eastFacing, northLow, northHighRight, northHighLeft);
    expect(groups.map((g) => g.id)).toEqual([1, 2, 3, 4]);
    expect(groups.map((g) => g.berthIds[0])).toEqual([northHighLeft.id, northHighRight.id, northLow.id, eastFacing.id]);
  });

  it('výsledok nezávisí od poradia vstupu', () => {
    const list = [berth(0, 36, 0), berth(16, 36, 0), berth(8, 36, 0), berth(24, 36, 0)];
    const expected = groupsOf(...list);
    expect(groupsOf(...[...list].reverse())).toEqual(expected);
    expect(groupsOf(list[2], list[0], list[3], list[1])).toEqual(expected);
    expect(expected).toEqual([{ id: 1, berthIds: [list[0].id, list[2].id, list[1].id, list[3].id], totalLength: 32, minDepth: 1 }]);
  });

  it('prázdny vstup → žiadne skupiny', () => {
    expect(computeBerthGroups([])).toEqual([]);
  });
});
