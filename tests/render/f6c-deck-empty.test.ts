// F6c (T6C-04): prázdne kontajnery na palube lode — tri smery (import od predku, prázdne tesne pred exportom, export od zadku),
// zhoda s F6a pri nulovom počte prázdnych a kreslenie z tokenov (`container-box.ts`).
import { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { drawContainerBox, RIB_COUNT } from '@render/container-box';
import { DeckCargo, deckDirections, deckFill, deckSlots } from '@render/ship-deck';
import { ShipView, hasDeckCargo } from '@render/ship-view';
import type { ShipVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function feeder(over: Partial<ShipVM> = {}): ShipVM {
  return {
    id: 5,
    classId: 'feeder',
    cargoCategory: 'container',
    state: 'docked',
    x: 43,
    y: 13,
    prevX: 43,
    prevY: 13,
    heading: 90,
    lengthCells: 6,
    widthCells: 2,
    unitsOnBoard: 60,
    capacityUnits: 120,
    ...over,
  };
}

describe('deckFill s prázdnymi kontajnermi', () => {
  it.each([
    // [import, export, empty, kapacita, miesta, importSlots, exportSlots, emptySlots]
    [0, 0, 60, 120, 6, 0, 0, 3], // len prázdne
    [0, 0, 1, 120, 6, 0, 0, 1], // aspoň jedno miesto
    [60, 0, 40, 120, 6, 3, 0, 2], // import + prázdne: 5 z 6 miest, 3 + 2
    [0, 50, 50, 120, 6, 0, 2, 3], // export + prázdne: export sa zaokrúhľuje prvý (polovica nadol)
    [40, 20, 20, 120, 6, 2, 1, 1], // všetky tri smery: 4 z 6 miest
    [40, 40, 40, 120, 6, 2, 2, 2], // plná loď: po dvoch
    [200, 40, 20, 300, 14, 10, 2, 1], // veľká loď
    [20, 20, 20, 120, 6, 1, 1, 1], // po jednom (3 z 6 miest)
  ] as const)('import %i, export %i, prázdne %i, kapacita %i, %i miest → %i + %i + %i', (imports, exports, empties, capacity, slots, importSlots, exportSlots, emptySlots) => {
    expect(deckFill({ import: imports, export: exports, empty: empties }, capacity, slots)).toEqual({ importSlots, exportSlots, emptySlots });
  });

  it('bez poľa `empty` alebo s nulou je výsledok rovnaký ako vo F6a (len import a export)', () => {
    for (let imports = 0; imports <= 60; imports += 7) {
      for (let exports = 0; exports <= 60; exports += 7) {
        const without = deckFill({ import: imports, export: exports }, 120, 6);
        expect(deckFill({ import: imports, export: exports, empty: 0 }, 120, 6)).toEqual(without);
        expect(without.emptySlots).toBe(0);
      }
    }
  });

  it('nedostatok miest: po jednom dostanú najpočetnejšie smery (pri zhode import, prázdne, export)', () => {
    // 3 smery, 1 miesto z 14 (3 z 300 jednotiek → 1)
    expect(deckFill({ import: 1, export: 1, empty: 1 }, 300, 14)).toEqual({ importSlots: 1, exportSlots: 0, emptySlots: 0 });
    expect(deckFill({ import: 1, export: 1, empty: 2 }, 300, 14)).toEqual({ importSlots: 0, exportSlots: 0, emptySlots: 1 });
    expect(deckFill({ import: 1, export: 3, empty: 1 }, 300, 14)).toEqual({ importSlots: 0, exportSlots: 1, emptySlots: 0 });
    // 3 smery, 2 miesta (zaokrúhlené z 14 jednotiek z 120 pre 6 miest = 1 → 2 pri 24 jednotkách)
    const two = deckFill({ import: 8, export: 8, empty: 8 }, 120, 6);
    expect(two.importSlots + two.exportSlots + two.emptySlots).toBe(2);
    expect(two).toEqual({ importSlots: 1, exportSlots: 0, emptySlots: 1 });
  });

  it('smer s jednotkami má aspoň jedno miesto, ak sa zmestia všetky; súčet nikdy neprekročí počet miest', () => {
    for (let imports = 0; imports <= 30; imports += 5) {
      for (let exports = 0; exports <= 30; exports += 5) {
        for (let empties = 0; empties <= 30; empties += 5) {
          const fill = deckFill({ import: imports, export: exports, empty: empties }, 60, 6);
          const total = fill.importSlots + fill.exportSlots + fill.emptySlots;
          expect(total).toBeLessThanOrEqual(6);
          const kinds = [imports, exports, empties].filter((count) => count > 0).length;
          if (kinds > 0) expect(total).toBeGreaterThanOrEqual(1);
          if (total >= kinds) {
            if (imports > 0) expect(fill.importSlots).toBeGreaterThanOrEqual(1);
            if (exports > 0) expect(fill.exportSlots).toBeGreaterThanOrEqual(1);
            if (empties > 0) expect(fill.emptySlots).toBeGreaterThanOrEqual(1);
          }
          if (imports === 0) expect(fill.importSlots).toBe(0);
          if (exports === 0) expect(fill.exportSlots).toBe(0);
          if (empties === 0) expect(fill.emptySlots).toBe(0);
        }
      }
    }
  });

  it('záporné a desatinné počty prázdnych sa orežú', () => {
    expect(deckFill({ import: 0, export: 0, empty: -4 }, 120, 6)).toEqual({ importSlots: 0, exportSlots: 0, emptySlots: 0 });
    expect(deckFill({ import: 0, export: 0, empty: 2.9 }, 120, 6)).toEqual({ importSlots: 0, exportSlots: 0, emptySlots: 1 });
  });
});

describe('deckDirections s prázdnymi kontajnermi', () => {
  it('import od predku, export od zadku, prázdne tesne pred exportom', () => {
    expect(deckDirections({ importSlots: 2, exportSlots: 1, emptySlots: 1 }, 6)).toEqual(['import', 'import', null, null, 'empty', 'export']);
    expect(deckDirections({ importSlots: 2, exportSlots: 2, emptySlots: 2 }, 6)).toEqual(['import', 'import', 'empty', 'empty', 'export', 'export']);
    expect(deckDirections({ importSlots: 0, exportSlots: 0, emptySlots: 3 }, 6)).toEqual([null, null, null, 'empty', 'empty', 'empty']);
    expect(deckDirections({ importSlots: 3, exportSlots: 0, emptySlots: 2 }, 6)).toEqual(['import', 'import', 'import', null, 'empty', 'empty']);
  });

  it('prázdne nikdy neprepíšu import ani export', () => {
    // výplň nad počet miest (nesúlad): import a export majú prednosť
    const directions = deckDirections({ importSlots: 3, exportSlots: 2, emptySlots: 4 }, 6);
    expect(directions.filter((direction) => direction === 'import')).toHaveLength(3);
    expect(directions.filter((direction) => direction === 'export')).toHaveLength(2);
    expect(directions.filter((direction) => direction === 'empty')).toHaveLength(1);
    expect(deckDirections({ importSlots: 0, exportSlots: 0, emptySlots: 9 }, 2)).toEqual(['empty', 'empty']);
  });
});

describe('DeckCargo s prázdnymi kontajnermi', () => {
  it('kreslí tri bloky a prekreslí len pri zmene obsadenia', () => {
    const deck = new DeckCargo('feeder', { cellPx: CELL, palette: ENTITY_PALETTE });
    deck.setCargo({ import: 40, export: 20, empty: 20 }, 120);
    expect(deck.currentFill).toEqual({ importSlots: 2, exportSlots: 1, emptySlots: 1 });
    expect(deck.directions).toEqual(['import', 'import', null, null, 'empty', 'export']);
    const fill = deck.currentFill;
    deck.setCargo({ import: 41, export: 19, empty: 20 }, 120); // rovnaké obsadenie: nič sa nemení
    expect(deck.currentFill).toBe(fill);
    deck.setCargo({ import: 40, export: 20, empty: 40 }, 120); // viac prázdnych
    expect(deck.currentFill).not.toBe(fill);
    deck.setCargo({ import: 40, export: 20 }, 120); // `empty` chýba = žiadne prázdne
    expect(deck.directions.includes('empty')).toBe(false);
  });

  it('kontajnery sú procedurálne (`Graphics`), každé miesto s kontajnerom pridá výplň a obrys', () => {
    const deck = new DeckCargo('feeder', { cellPx: CELL, palette: ENTITY_PALETTE });
    deck.setCargo({ import: 0, export: 0, empty: 120 }, 120);
    expect(deck.directions.filter((direction) => direction === 'empty')).toHaveLength(6);
    expect(deck.children[0]).toBeInstanceOf(Graphics);
  });

  it('ShipView prenesie `cargoSplit.empty` na palubu', () => {
    const view = new ShipView(feeder({ cargoSplit: { import: 40, export: 20, empty: 20 } }), { cellPx: CELL, palette: ENTITY_PALETTE, textures: new StubTextures() });
    expect(hasDeckCargo(feeder({ cargoSplit: { import: 0, export: 0, empty: 5 } }))).toBe(true);
    expect(view.deckCargo?.directions).toEqual(['import', 'import', null, null, 'empty', 'export']);
    view.update(feeder({ cargoSplit: { import: 0, export: 0, empty: 120 } }), 1);
    expect(view.deckCargo?.currentFill).toEqual({ importSlots: 0, exportSlots: 0, emptySlots: 6 });
  });
});

describe('drawContainerBox', () => {
  const colors = ENTITY_PALETTE.direction.empty;

  /** Rozsah obsahu `Graphics` (px sveta). */
  function bounds(graphics: Graphics): { width: number; height: number } {
    const box = graphics.getLocalBounds();
    return { width: box.width, height: box.height };
  }

  it('obdĺžnik vyplnený farbou smeru: rozsah zodpovedá `rect` (obrys vnútri)', () => {
    const graphics = new Graphics();
    drawContainerBox(graphics, { left: -32, top: -13, w: 64, h: 26 }, colors, 2, 'x');
    const box = bounds(graphics);
    expect(box.width).toBeCloseTo(64, 5);
    expect(box.height).toBeCloseTo(26, 5);
  });

  it('počet rebier je `RIB_COUNT` a odlesk (`light`) pridá cestu navyše', () => {
    expect(RIB_COUNT).toBe(2);
    const plain = new Graphics();
    drawContainerBox(plain, { left: 0, top: 0, w: 26, h: 64 }, { base: colors.base, dark: colors.dark }, 2, 'y');
    const lit = new Graphics();
    drawContainerBox(lit, { left: 0, top: 0, w: 26, h: 64 }, colors, 2, 'y');
    expect(lit.context.instructions.length).toBeGreaterThan(plain.context.instructions.length);
  });

  /** Záznamník volaní kresliaceho API (`rect`, `fill`, `stroke`, `moveTo`, `lineTo`) — overí geometriu rebier bez rasterizácie. */
  function recorder(): { graphics: Graphics; calls: { name: string; args: number[] }[] } {
    const calls: { name: string; args: number[] }[] = [];
    const target: Record<string, unknown> = {};
    for (const name of ['rect', 'fill', 'stroke', 'moveTo', 'lineTo']) {
      target[name] = (...args: unknown[]) => {
        calls.push({ name, args: args.filter((arg): arg is number => typeof arg === 'number') });
        return target;
      };
    }
    return { graphics: target as unknown as Graphics, calls };
  }

  it('os x: rebrá sú zvislé v tretinách dĺžky; os y: vodorovné v tretinách výšky (kolmo na dlhšiu stranu)', () => {
    const along = recorder();
    drawContainerBox(along.graphics, { left: 0, top: 0, w: 60, h: 24 }, { base: colors.base, dark: colors.dark }, 2, 'x');
    const ribsX = along.calls.filter((call) => call.name === 'moveTo').map((call) => call.args);
    expect(ribsX).toEqual([
      [20, 2],
      [40, 2],
    ]);
    expect(along.calls.filter((call) => call.name === 'lineTo').map((call) => call.args)).toEqual([
      [20, 22],
      [40, 22],
    ]);
    const across = recorder();
    drawContainerBox(across.graphics, { left: 0, top: 0, w: 24, h: 60 }, { base: colors.base, dark: colors.dark }, 2, 'y');
    expect(across.calls.filter((call) => call.name === 'moveTo').map((call) => call.args)).toEqual([
      [2, 20],
      [2, 40],
    ]);
    expect(across.calls.filter((call) => call.name === 'lineTo').map((call) => call.args)).toEqual([
      [22, 20],
      [22, 40],
    ]);
  });
});

describe('deckSlots (kontrola nezmenenej geometrie)', () => {
  it('feeder má 6 miest', () => {
    expect(deckSlots('feeder', CELL)).toHaveLength(6);
  });
});
