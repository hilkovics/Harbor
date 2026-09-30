// BerthModule (T02-03, ARCHITECTURE §5.3, §5.4; rozhodnutie 4): waterSide po rotácii, lengthCells = dlhá hrana,
// efektívna hĺbka = min(def.params.depthClass, min(cell.depthClass) footprintu), ApronBuffer(apronSlots), craneIds.
import { describe, expect, it } from 'vitest';
import { berthParams } from '@sim/defs';
import { ROTATIONS } from '@sim/grid';
import { ApronBuffer, BerthModule, ModuleError, ModuleStateError, effectiveBerthDepth, type BerthRuntimeState } from '@sim/modules';
import { MAP } from '../world/world-fixtures';
import { BERTH, DEEP_BERTH, MODULE_DEFS, berthOn, id, quayGrid } from './module-fixtures';

describe('BerthModule — geometria', () => {
  it.each([
    [0, 'n'],
    [90, 'e'],
    [180, 's'],
    [270, 'w'],
  ] as const)('rot %i → waterSide %s, lengthCells 8 (dlhá hrana), rozmery po rotácii', (rotation, side) => {
    const berth = berthOn(quayGrid(20, 20), 1, { x: 2, y: 2 }, rotation);
    expect(berth.waterSide).toBe(side);
    expect(berth.lengthCells).toBe(8);
    expect(berth.size).toEqual(rotation % 180 === 0 ? { w: 8, h: 3 } : { w: 3, h: 8 });
  });

  it('typované params, prázdny stav: bez žeriavov, bez lode, groupId 0 mimo sveta', () => {
    const berth = berthOn(quayGrid(20, 20), 1, { x: 0, y: 0 });
    expect(berth.params).toEqual(berthParams(MODULE_DEFS.modules.get(BERTH)));
    expect(berth.craneIds).toEqual([]);
    expect(berth.dockedShipId).toBeNull();
    expect(berth.groupId).toBe(0);
    expect(berth.getRuntimeState()).toEqual({ lastNoStorageHour: null });
    expect(berth.lastNoStorageHour).toBeNull();
  });

  it('apron = ApronBuffer s kapacitou apronSlots defu', () => {
    const standard = berthOn(quayGrid(20, 20), 1, { x: 0, y: 0 });
    const deep = berthOn(quayGrid(20, 20), 2, { x: 0, y: 5 }, 0, DEEP_BERTH);
    expect(standard.apron).toBeInstanceOf(ApronBuffer);
    expect(standard.apron.capacity).toBe(4);
    expect(deep.apron.capacity).toBe(6);
  });

  it('attachCrane/detachCrane: poradie pripojenia, duplicita a neznámy žeriav sú chyby', () => {
    const berth = berthOn(quayGrid(20, 20), 1, { x: 0, y: 0 });
    berth.attachCrane(id(5));
    berth.attachCrane(id(3));
    expect(berth.craneIds).toEqual([5, 3]);
    expect(() => berth.attachCrane(id(5))).toThrow(ModuleError);
    berth.detachCrane(id(5));
    expect(berth.craneIds).toEqual([3]);
    expect(() => berth.detachCrane(id(5))).toThrow(ModuleError);
  });
});

describe('BerthModule — efektívna hĺbka (rozhodnutie 4)', () => {
  // harbor_01: hĺbka nábrežia x 10–29 → 2, x 30–57 → 1, x 58–59 → 1 (mimo zón), x 60–85 → 3.
  const CASES: readonly [string, string, number, number][] = [
    ['štandardný (1) na hĺbke 1', BERTH, 40, 1],
    ['štandardný (1) na hĺbke 3 — obmedzuje typ kotviska', BERTH, 70, 1],
    ['hlboký (3) na hĺbke 3', DEEP_BERTH, 70, 3],
    ['hlboký (3) na hĺbke 2 — obmedzuje mapa', DEEP_BERTH, 12, 2],
    ['hlboký (3) na hĺbke 1', DEEP_BERTH, 40, 1],
    ['hlboký (3) cez hranicu zón 2 | 1 (x 26–33) — najplytšia bunka', DEEP_BERTH, 26, 1],
    ['hlboký (3) cez x 58–65 (1 mimo zón | 3) — najplytšia bunka', DEEP_BERTH, 58, 1],
  ];
  it.each(CASES)('%s', (_name, defId, x, expected) => {
    const berth = berthOn(MAP.createGrid(), 1, { x, y: 14 }, 0, defId);
    expect(berth.depthClass).toBe(expected);
  });

  it('effectiveBerthDepth = min(params.depthClass, min cell.depthClass)', () => {
    const grid = quayGrid(10, 10, 3);
    const params = berthParams(MODULE_DEFS.modules.get(DEEP_BERTH));
    const cells = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ];
    expect(effectiveBerthDepth(params, cells, grid)).toBe(3);
    expect(effectiveBerthDepth(params, cells, quayGrid(10, 10, 2))).toBe(2);
    expect(effectiveBerthDepth(berthParams(MODULE_DEFS.modules.get(BERTH)), cells, grid)).toBe(1);
  });

  it.each(ROTATIONS)('rotácia %i nemení efektívnu hĺbku na rovnomernej mriežke', (rotation) => {
    expect(berthOn(quayGrid(20, 20, 2), 1, { x: 2, y: 2 }, rotation, DEEP_BERTH).depthClass).toBe(2);
  });

  it('BerthModule je trieda pre def kind berth', () => {
    expect(berthOn(MAP.createGrid(), 1, { x: 40, y: 14 })).toBeInstanceOf(BerthModule);
  });
});

describe('BerthModule — runtime stav v save (throttle NoStorageAvailable, ADR-018)', () => {
  it('getRuntimeState = { lastNoStorageHour }; restore na novej inštancii dá rovnakú hodinu (aj null)', () => {
    const berth = berthOn(quayGrid(20, 20), 1, { x: 0, y: 0 });
    berth.lastNoStorageHour = 7;
    const state = berth.getRuntimeState();
    expect(state).toEqual({ lastNoStorageHour: 7 } satisfies BerthRuntimeState);
    const copy = berthOn(quayGrid(20, 20), 1, { x: 0, y: 0 });
    copy.restoreRuntimeState(JSON.parse(JSON.stringify(state)));
    expect(copy.lastNoStorageHour).toBe(7);
    copy.restoreRuntimeState({ lastNoStorageHour: null });
    expect(copy.lastNoStorageHour).toBeNull();
  });

  it.each<[string, unknown, string]>([
    ['prázdny objekt (v2 tvar)', {}, '/lastNoStorageHour'],
    ['záporná hodina', { lastNoStorageHour: -1 }, '/lastNoStorageHour'],
    ['necelá hodina', { lastNoStorageHour: 1.5 }, '/lastNoStorageHour'],
    ['neznámy kľúč', { lastNoStorageHour: null, extra: 1 }, '/extra'],
  ])('%s → ModuleStateError na %s, stav sa nezmení', (_name, raw, path) => {
    const berth = berthOn(quayGrid(20, 20), 1, { x: 0, y: 0 });
    berth.lastNoStorageHour = 3;
    let error: unknown;
    try {
      berth.restoreRuntimeState(raw);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ModuleStateError);
    expect((error as ModuleStateError).path).toBe(path);
    expect(berth.lastNoStorageHour).toBe(3);
  });
});
