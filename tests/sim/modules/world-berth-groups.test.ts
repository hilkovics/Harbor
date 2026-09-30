// BerthGroup vo svete (T02-03, ARCHITECTURE §5.4, ADR-014): World prepočíta skupiny a groupId pri každom
// placeModule/removeModule; poradie a id skupín nezávisia od poradia stavby. Mapa harbor_01, nábrežie y 14–16.
import { describe, expect, it } from 'vitest';
import { newWorld, placeBerth } from './harbor-fixtures';
import { DEEP_BERTH } from './module-fixtures';

describe('BerthGroup vo svete (harbor_01, nábrežie y 14–16)', () => {
  it('2 dotýkajúce sa berthy (x 40–47 a 48–55) → 1 skupina totalLength 16, poradie po pobreží', () => {
    const world = newWorld();
    const east = placeBerth(world, 48);
    const west = placeBerth(world, 40);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [west.id, east.id], totalLength: 16, minDepth: 1 }]);
    expect([west.groupId, east.groupId]).toEqual([1, 1]);
  });

  it('medzera 1 bunka (x 40–47 a 49–56) → 2 skupiny po 8', () => {
    const world = newWorld();
    const a = placeBerth(world, 40);
    const b = placeBerth(world, 49);
    expect(world.berthGroups).toEqual([
      { id: 1, berthIds: [a.id], totalLength: 8, minDepth: 1 },
      { id: 2, berthIds: [b.id], totalLength: 8, minDepth: 1 },
    ]);
    expect([a.groupId, b.groupId]).toEqual([1, 2]);
  });

  it('id skupín idú podľa polohy po pobreží, nie podľa poradia stavby', () => {
    const world = newWorld();
    const east = placeBerth(world, 60);
    const west = placeBerth(world, 30);
    expect(world.berthGroups.map((g) => g.berthIds)).toEqual([[west.id], [east.id]]);
    expect([west.groupId, east.groupId]).toEqual([1, 2]);
  });

  it('tri berthy postavené v poradí 48, 32, 40 → jedna skupina 24 zoradená podľa x', () => {
    const world = newWorld();
    const c = placeBerth(world, 48);
    const a = placeBerth(world, 32);
    expect(world.berthGroups).toHaveLength(2);
    const b = placeBerth(world, 40);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [a.id, b.id, c.id], totalLength: 24, minDepth: 1 }]);
  });

  it('minDepth = najmenšia efektívna hĺbka v skupine (hlava móla E1: hĺbka 3; hlava móla W1: x 6–13 → 2, x 14–21 → 1)', () => {
    const world = newWorld();
    const deepA = placeBerth(world, 66, 12, 0, DEEP_BERTH); // hĺbka 3
    const deepB = placeBerth(world, 74, 12, 0, DEEP_BERTH); // hĺbka 3
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [deepA.id, deepB.id], totalLength: 16, minDepth: 3 }]);
    const middle = placeBerth(world, 6, 12, 0, DEEP_BERTH); // hĺbka 2
    const shallow = placeBerth(world, 14, 12, 0, DEEP_BERTH); // hĺbka 1
    expect(world.berthGroups).toEqual([
      { id: 1, berthIds: [middle.id, shallow.id], totalLength: 16, minDepth: 1 },
      { id: 2, berthIds: [deepA.id, deepB.id], totalLength: 16, minDepth: 3 },
    ]);
  });

  it('odstránenie stredného berthu rozdelí skupinu a prečísluje id', () => {
    const world = newWorld();
    const a = placeBerth(world, 32);
    const b = placeBerth(world, 40);
    const c = placeBerth(world, 48);
    world.removeModule(b.id);
    expect(world.berthGroups).toEqual([
      { id: 1, berthIds: [a.id], totalLength: 8, minDepth: 1 },
      { id: 2, berthIds: [c.id], totalLength: 8, minDepth: 1 },
    ]);
    expect([a.groupId, c.groupId]).toEqual([1, 2]);
    world.removeModule(a.id);
    expect(world.berthGroups).toEqual([{ id: 1, berthIds: [c.id], totalLength: 8, minDepth: 1 }]);
    expect(c.groupId).toBe(1);
  });

  it('svet bez berthov nemá skupiny; berthGroups je zmrazené pole', () => {
    const world = newWorld();
    expect(world.berthGroups).toEqual([]);
    placeBerth(world, 40);
    expect(Object.isFrozen(world.berthGroups)).toBe(true);
    expect(Object.isFrozen(world.berthGroups[0].berthIds)).toBe(true);
  });
});
