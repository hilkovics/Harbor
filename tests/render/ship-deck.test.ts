// F6a (T6A-06): náklad na palube lode podľa počtu jednotiek, import / export rozlíšené farbou z tokenov.
import { describe, expect, it } from 'vitest';
import { MANIFEST_CELL_PX, manifestScale, shipDeck, shipSprite } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { DeckCargo, deckDirections, deckFill, deckSlots } from '@render/ship-deck';
import { ShipView, hasDeckCargo, shipDisplayLoad } from '@render/ship-view';
import { TEU_PX } from '@render/world-scale';
import type { ShipVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures, TOKENS } from './stub-textures';
import { readAsset, svgRects } from './svg-geometry';

const CELL = PALETTE.cellPx;
const CLASSES = ['feeder', 'handy', 'panamax', 'mega'] as const;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

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

describe('manifest: paluba kontajnerových lodí (`entities.ship_<class>.deck`)', () => {
  it.each(CLASSES)('%s: polia a stĺpce zodpovedajú sprite `empty` aj `loaded`', (classId) => {
    const entry = shipSprite(classId);
    const deck = shipDeck(classId);
    expect(deck, 'deck v manifeste').toBeDefined();
    const emptyFile = entry?.variants['container'].empty ?? '';
    const loadedFile = entry?.variants['container'].loaded ?? '';
    const bays = svgRects(readAsset(emptyFile)).filter((rect) => rect.fill === '#A5AFB9' && rect.height === 64);
    expect(deck?.bays).toEqual(bays.map((rect) => ({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })));
    const firstBayContainers = svgRects(readAsset(loadedFile)).filter((rect) => rect.height === 64 && rect.y === bays[0].y);
    expect(deck?.columns).toBe(firstBayContainers.length);
  });

  it('polia ležia v sprite lode a v poradí od predku (rastúce y), bez prekrytia', () => {
    for (const classId of CLASSES) {
      const entry = shipSprite(classId);
      const deck = shipDeck(classId);
      if (entry === undefined || deck === undefined) throw new Error(classId);
      let previousEnd = 0;
      for (const bay of deck.bays) {
        expect(bay.x).toBeGreaterThanOrEqual(0);
        expect(bay.x + bay.w).toBeLessThanOrEqual(entry.footprint.w * MANIFEST_CELL_PX);
        expect(bay.y).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = bay.y + bay.h;
      }
      expect(previousEnd).toBeLessThanOrEqual(entry.footprint.h * MANIFEST_CELL_PX);
    }
  });

  it('neznáma trieda → bez paluby', () => {
    expect(shipDeck('galeona')).toBeUndefined();
    expect(deckSlots('galeona', CELL)).toBeUndefined();
  });
});

describe('deckSlots', () => {
  it.each(CLASSES)('%s: počet miest = polia × stĺpce, kontajner TEU (26 px naprieč, 64 px pozdĺž lode)', (classId) => {
    const deck = shipDeck(classId);
    const slots = deckSlots(classId, CELL) ?? [];
    expect(slots).toHaveLength((deck?.bays.length ?? 0) * (deck?.columns ?? 0));
    const unit = manifestScale(CELL);
    for (const slot of slots) {
      expect(slot.w).toBeCloseTo(TEU_PX.h * unit, 9);
      expect(slot.h).toBeCloseTo(TEU_PX.w * unit, 9);
    }
  });

  it('feeder: 3 polia × 2 stĺpce, súmerné okolo osi lode, od predku (záporné y) k zadku', () => {
    const slots = deckSlots('feeder', CELL) ?? [];
    expect(slots).toHaveLength(6);
    expect(slots[0].y).toBeLessThan(slots[5].y);
    expect(slots[0].y).toBeCloseTo(slots[1].y, 9); // dva stĺpce toho istého poľa
    expect(slots[0].x).toBeCloseTo(-slots[1].x, 9);
    // prvé pole: y 108…172 v súbore 128×384 → stred 140 − 192 = −52 px zdroja
    expect(slots[0].y).toBeCloseTo(-52 * manifestScale(CELL), 9);
  });

  it('kontajnery sa neprekrývajú a ležia v palube lode', () => {
    for (const classId of CLASSES) {
      const slots = deckSlots(classId, CELL) ?? [];
      const entry = shipSprite(classId);
      const halfW = ((entry?.footprint.w ?? 0) * CELL) / 2;
      const halfL = ((entry?.footprint.h ?? 0) * CELL) / 2;
      for (const [i, a] of slots.entries()) {
        expect(Math.abs(a.x) + a.w / 2).toBeLessThanOrEqual(halfW);
        expect(Math.abs(a.y) + a.h / 2).toBeLessThanOrEqual(halfL);
        for (const b of slots.slice(i + 1)) {
          const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 1e-9 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 - 1e-9;
          expect(apart, `${classId}: miesta ${String(i)} a ďalšie sa prekrývajú`).toBe(true);
        }
      }
    }
  });
});

describe('deckFill (podiel zaplnenia lode → obsadené miesta)', () => {
  it.each([
    // [import, export, kapacita, miesta, importSlots, exportSlots]
    [0, 0, 120, 6, 0, 0],
    [60, 0, 120, 6, 3, 0],
    [0, 60, 120, 6, 0, 3],
    [1, 0, 120, 6, 1, 0], // aspoň jedno miesto, kým je na palube niečo
    [0, 1, 120, 6, 0, 1],
    [120, 0, 120, 6, 6, 0],
    [30, 30, 120, 6, 2, 1], // 60/120 → 3 miesta: pomer 1:1 → 1,5 zaokrúhlené nadol pre export (zhoda ide v prospech importu)
    [100, 20, 120, 6, 5, 1], // plná loď 6 miest: 5 : 1
    [20, 100, 120, 6, 1, 5],
    [1, 59, 120, 6, 1, 2], // oba smery majú aspoň jedno miesto
    [1, 1, 120, 6, 1, 0], // jediné miesto: pri zhode import
    [1, 5, 300, 14, 0, 1], // 6 z 300 → 1 miesto z 14: dostane ho väčší smer
    [5, 1, 300, 14, 1, 0],
    [10, 10, 0, 6, 3, 3], // neznáma kapacita: jedna jednotka = jedno miesto
    [500, 500, 100, 6, 3, 3], // nad kapacitou: orezané na všetky miesta, polovica / polovica
  ] as const)('import %i, export %i, kapacita %i, %i miest → %i + %i', (imports, exports, capacity, slots, expectedImport, expectedExport) => {
    const fill = deckFill({ import: imports, export: exports }, capacity, slots);
    expect(fill.importSlots + fill.exportSlots).toBeLessThanOrEqual(slots);
    if (capacity === 0) {
      expect(fill.importSlots + fill.exportSlots).toBe(Math.min(slots, imports + exports));
      return;
    }
    expect(fill).toEqual({ importSlots: expectedImport, exportSlots: expectedExport });
  });

  it('smer s jednotkami má vždy aspoň jedno miesto, ak sa zmestia obe; súčet nikdy neprekročí počet miest', () => {
    for (let imports = 0; imports <= 40; imports += 3) {
      for (let exports = 0; exports <= 40; exports += 3) {
        const fill = deckFill({ import: imports, export: exports }, 40, 6);
        expect(fill.importSlots + fill.exportSlots).toBeLessThanOrEqual(6);
        if (imports > 0 && exports > 0 && fill.importSlots + fill.exportSlots >= 2) {
          expect(fill.importSlots).toBeGreaterThanOrEqual(1);
          expect(fill.exportSlots).toBeGreaterThanOrEqual(1);
        }
        if (imports > 0) expect(fill.importSlots + fill.exportSlots).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('záporné a desatinné vstupy sa orežú (nikdy záporný počet miest)', () => {
    expect(deckFill({ import: -3, export: 0 }, 120, 6)).toEqual({ importSlots: 0, exportSlots: 0 });
    expect(deckFill({ import: 2.9, export: 0 }, 120, 6)).toEqual({ importSlots: 1, exportSlots: 0 });
    expect(deckFill({ import: 5, export: 5 }, 120, 0)).toEqual({ importSlots: 0, exportSlots: 0 });
  });
});

describe('deckDirections', () => {
  it('import od predku, export od zadku, medzi nimi prázdne miesta', () => {
    expect(deckDirections({ importSlots: 2, exportSlots: 1 }, 6)).toEqual(['import', 'import', null, null, null, 'export']);
    expect(deckDirections({ importSlots: 0, exportSlots: 3 }, 6)).toEqual([null, null, null, 'export', 'export', 'export']);
    expect(deckDirections({ importSlots: 3, exportSlots: 3 }, 6)).toEqual(['import', 'import', 'import', 'export', 'export', 'export']);
    expect(deckDirections({ importSlots: 0, exportSlots: 0 }, 2)).toEqual([null, null]);
  });
});

describe('farby smeru z tokenov', () => {
  it('import = farba kontajnera (--cargo-container), export = --ui-accent; obrysy tmavšie', () => {
    const { direction } = ENTITY_PALETTE;
    expect(direction.import.base).toEqual(ENTITY_PALETTE.cargo.base);
    expect(direction.import.dark).toEqual(ENTITY_PALETTE.cargo.dark);
    expect(direction.export.base.color).toBe(0x3aa0ff);
    expect(direction.export.base.color).toBe(ENTITY_PALETTE.accent.color);
    expect(direction.export.base.color).not.toBe(direction.import.base.color);
    const luminance = (color: number): number => ((color >> 16) & 0xff) + ((color >> 8) & 0xff) + (color & 0xff);
    expect(luminance(direction.export.dark.color)).toBeLessThan(luminance(direction.export.base.color));
    expect(luminance(direction.import.dark.color)).toBeLessThan(luminance(direction.import.base.color));
  });

  it('žiadna farba nie je v kóde: tokeny existujú v design/tokens.css', () => {
    for (const name of ['--cargo-container', '--cargo-container-dark', '--ui-accent', '--ui-border', '--ui-warning']) {
      expect(TOKENS(name), name).not.toBe('');
    }
  });
});

describe('DeckCargo', () => {
  it('kreslí obsadenie podľa počtu jednotiek a prekreslí len pri zmene', () => {
    const deck = new DeckCargo('feeder', { cellPx: CELL, palette: ENTITY_PALETTE });
    expect(deck.slotCount).toBe(6);
    expect(deck.directions.every((direction) => direction === null)).toBe(true);
    deck.setCargo({ import: 40, export: 20 }, 120);
    expect(deck.currentFill).toEqual({ importSlots: 2, exportSlots: 1 });
    expect(deck.directions).toEqual(['import', 'import', null, null, null, 'export']);
    const fill = deck.currentFill;
    deck.setCargo({ import: 41, export: 19 }, 120); // rovnaké obsadenie: nič sa nemení
    expect(deck.currentFill).toBe(fill);
    deck.setCargo({ import: 0, export: 0 }, 120);
    expect(deck.directions.every((direction) => direction === null)).toBe(true);
  });

  it('trieda bez paluby v manifeste → 0 miest a nič sa nekreslí', () => {
    const deck = new DeckCargo('galeona', { cellPx: CELL, palette: ENTITY_PALETTE });
    deck.setCargo({ import: 10, export: 10 }, 100);
    expect(deck.slotCount).toBe(0);
    expect(deck.currentFill).toEqual({ importSlots: 0, exportSlots: 0 });
  });
});

describe('ShipView: náklad na palube', () => {
  it('bez cargoSplit sa správa ako v F2–F6 (sprite `loaded`, bez paluby)', () => {
    const textures = new StubTextures();
    const view = new ShipView(feeder(), deps(textures));
    expect(view.texture).toBe(textures.textureFor('file/entities/ship_feeder_container_loaded.svg'));
    expect(view.deckCargo).toBeNull();
    expect(hasDeckCargo(feeder())).toBe(false);
    expect(shipDisplayLoad(feeder())).toBe('loaded');
  });

  it('s cargoSplit: sprite `empty` a kontajnery na palube podľa počtu (import + export)', () => {
    const textures = new StubTextures();
    const vm = feeder({ cargoSplit: { import: 40, export: 20 } });
    const view = new ShipView(vm, deps(textures));
    expect(view.texture).toBe(textures.textureFor('file/entities/ship_feeder_container_empty.svg'));
    expect(view.deckCargo?.directions).toEqual(['import', 'import', null, null, null, 'export']);
    expect(view.view.children.indexOf(view.deckCargo as DeckCargo)).toBe(1); // nad spritom
  });

  it('počas nakládky a vykládky sa paluba mení s počtom: import ubúda, export pribúda', () => {
    const view = new ShipView(feeder({ cargoSplit: { import: 100, export: 0 } }), deps(new StubTextures()));
    expect(view.deckCargo?.currentFill).toEqual({ importSlots: 5, exportSlots: 0 });
    view.update(feeder({ cargoSplit: { import: 40, export: 20 } }), 1);
    expect(view.deckCargo?.currentFill).toEqual({ importSlots: 2, exportSlots: 1 });
    view.update(feeder({ cargoSplit: { import: 0, export: 90 } }), 1);
    expect(view.deckCargo?.currentFill).toEqual({ importSlots: 0, exportSlots: 5 });
    view.update(feeder({ cargoSplit: { import: 0, export: 0 } }), 1);
    expect(view.deckCargo?.directions.every((direction) => direction === null)).toBe(true);
  });

  it('cargoSplit zmizne → paluba sa zruší a vráti sa sprite podľa unitsOnBoard', () => {
    const textures = new StubTextures();
    const view = new ShipView(feeder({ cargoSplit: { import: 10, export: 10 } }), deps(textures));
    const deck = view.deckCargo;
    view.update(feeder({ unitsOnBoard: 20 }), 1);
    expect(view.deckCargo).toBeNull();
    expect(deck?.destroyed).toBe(true);
    expect(view.texture).toBe(textures.textureFor('file/entities/ship_feeder_container_loaded.svg'));
  });

  it('nekontajnerová loď alebo trieda bez paluby cargoSplit ignoruje', () => {
    const bulk = feeder({ cargoCategory: 'bulk', cargoSplit: { import: 10, export: 0 } });
    expect(hasDeckCargo(bulk)).toBe(false);
    expect(new ShipView(bulk, deps(new StubTextures())).deckCargo).toBeNull();
    const unknown = feeder({ classId: 'galeona', cargoSplit: { import: 10, export: 0 } });
    expect(hasDeckCargo(unknown)).toBe(false);
    const bare = new ShipView(feeder({ cargoSplit: { import: 10, export: 10 } }), deps(null));
    expect(bare.deckCargo).not.toBeNull(); // aj fallback trupu nesie kontajnery
  });

  it('kontajnery sa otáčajú s loďou (predok hore pri heading 0, na východ pri 90°)', () => {
    const view = new ShipView(feeder({ heading: 90, cargoSplit: { import: 120, export: 0 } }), deps(new StubTextures()));
    expect(view.view.angle).toBeCloseTo(90, 9);
    expect(view.deckCargo?.parent).toBe(view.view);
  });

  it('EntityLayer prenesie cargoSplit do view', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.sync([feeder({ cargoSplit: { import: 40, export: 20 } })], 1);
    expect(layer.shipView(5)?.deckCargo?.currentFill).toEqual({ importSlots: 2, exportSlots: 1 });
  });
});
