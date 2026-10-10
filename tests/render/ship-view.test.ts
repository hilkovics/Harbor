import { Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { shipSprite } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { ShipView, lerp, shipLoad, shipPose, shipSpriteFile, shipVariantKey } from '@render/ship-view';
import type { ShipVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

/** Feeder (2×6) zakotvený pred berthom: stred (43; 13), predok na východ. */
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
    unitsOnBoard: 4,
    capacityUnits: 8,
    ...over,
  };
}

describe('shipVariantKey (kategória nákladu → variant paluby)', () => {
  const feederVariants = Object.keys(shipSprite('feeder')?.variants ?? {});
  const handyVariants = Object.keys(shipSprite('handy')?.variants ?? {});

  it('manifest: feeder nemá variant gas, handy áno', () => {
    expect(feederVariants).not.toContain('gas');
    expect(handyVariants).toContain('gas');
  });

  it.each([
    ['container', 'container'],
    ['bulk', 'bulk'],
    ['liquid', 'tanker'],
    ['roro', 'roro'],
  ] as const)('%s → %s', (category, variant) => {
    expect(shipVariantKey(category, feederVariants)).toBe(variant);
    expect(shipVariantKey(category, handyVariants)).toBe(variant);
  });

  it('gas → gas, ak ho trieda má, inak tanker', () => {
    expect(shipVariantKey('gas', handyVariants)).toBe('gas');
    expect(shipVariantKey('gas', feederVariants)).toBe('tanker');
  });

  it('neznáma kategória alebo variant, ktorý trieda nemá → undefined', () => {
    expect(shipVariantKey('konstruktor', handyVariants)).toBeUndefined();
    expect(shipVariantKey('constructor', handyVariants)).toBeUndefined();
    expect(shipVariantKey('container', ['bulk'])).toBeUndefined();
  });
});

describe('shipSpriteFile / shipLoad', () => {
  it('loaded pri unitsOnBoard > 0, inak empty', () => {
    expect(shipLoad(0)).toBe('empty');
    expect(shipLoad(1)).toBe('loaded');
  });

  it('názov súboru z manifestu podľa triedy, kategórie a naloženia', () => {
    expect(shipSpriteFile('feeder', 'container', 0)).toBe('entities/ship_feeder_container_empty.svg');
    expect(shipSpriteFile('feeder', 'container', 4)).toBe('entities/ship_feeder_container_loaded.svg');
    expect(shipSpriteFile('handy', 'container', 3)).toBe('entities/ship_handy_container_loaded.svg');
    expect(shipSpriteFile('feeder', 'gas', 2)).toBe('entities/ship_feeder_tanker_loaded.svg');
    expect(shipSpriteFile('handy', 'gas', 2)).toBe('entities/ship_handy_gas_loaded.svg');
  });

  it('neznáma trieda → undefined', () => {
    expect(shipSpriteFile('galeona', 'container', 1)).toBeUndefined();
  });
});

describe('shipPose (lerp(prev, curr, alpha) × cell, rotácia = heading)', () => {
  it('lerp', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });

  it('poloha medzi predchádzajúcim a aktuálnym tickom', () => {
    const pose = shipPose(feeder({ prevX: 40, x: 44, prevY: 12, y: 14, heading: 180 }), 0.25, CELL);
    expect(pose).toEqual({ x: 41 * CELL, y: 12.5 * CELL, angle: 180 });
  });
});

describe('ShipView', () => {
  it('sprite `loaded` z manifestu, vycentrovaný, veľkosť šírka × dĺžka lode × cell, otočený o heading', () => {
    const textures = new StubTextures();
    const view = new ShipView(feeder(), deps(textures));
    const sprite = view.view.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/entities/ship_feeder_container_loaded.svg'));
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.anchor.y).toBe(0.5);
    expect(sprite.width).toBeCloseTo(2 * CELL, 6);
    expect(sprite.height).toBeCloseTo(6 * CELL, 6);
    expect(view.view.position.x).toBe(43 * CELL);
    expect(view.view.position.y).toBe(13 * CELL);
    expect(view.view.angle).toBeCloseTo(90, 9);
  });

  it('predok (hore v sprite) po rotácii o 90° smeruje na východ', () => {
    const view = new ShipView(feeder({ heading: 90 }), deps(new StubTextures()));
    const root = view.view;
    // bod „nad stredom“ (predok) v lokálnych súradniciach → vo svete napravo od stredu
    const bow = root.toGlobal({ x: 0, y: -3 * CELL });
    expect(bow.x).toBeCloseTo(43 * CELL + 3 * CELL, 6);
    expect(bow.y).toBeCloseTo(13 * CELL, 6);
  });

  it('prázdna loď má sprite `empty`; po naložení / vyložení sa textúra prepne', () => {
    const textures = new StubTextures();
    const view = new ShipView(feeder({ unitsOnBoard: 0 }), deps(textures));
    expect(view.texture).toBe(textures.textureFor('file/entities/ship_feeder_container_empty.svg'));
    view.update(feeder({ unitsOnBoard: 2 }), 1);
    expect(view.texture).toBe(textures.textureFor('file/entities/ship_feeder_container_loaded.svg'));
    view.update(feeder({ unitsOnBoard: 0 }), 1);
    expect(view.texture).toBe(textures.textureFor('file/entities/ship_feeder_container_empty.svg'));
  });

  it('update interpoluje polohu podľa alpha', () => {
    const view = new ShipView(feeder({ prevX: 30, x: 34, prevY: 13, y: 13 }), deps(new StubTextures()), 0);
    expect(view.view.x).toBe(30 * CELL);
    view.update(feeder({ prevX: 30, x: 34, prevY: 13, y: 13 }), 0.5);
    expect(view.view.x).toBe(32 * CELL);
    view.update(feeder({ prevX: 30, x: 34, prevY: 13, y: 13 }), 1);
    expect(view.view.x).toBe(34 * CELL);
  });

  it('neznáma trieda alebo bez textúr → trup `Graphics` z tokenov v rozmeroch VM', () => {
    const unknown = new ShipView(feeder({ classId: 'galeona' }), deps(new StubTextures()));
    expect(unknown.view.children[0]).toBeInstanceOf(Graphics);
    expect(unknown.texture).toBeNull();
    const bare = new ShipView(feeder(), deps(null));
    expect(bare.view.children[0]).toBeInstanceOf(Graphics);
    bare.update(feeder({ unitsOnBoard: 0 }), 1); // prepnutie naloženia bez sprite nespadne
  });
});

describe('lode na kotve na rejde (T6D-03): jednotné natočenie podľa kurzu simu', () => {
  /** Čakajúca loď na rejde (rad y 3,5 severne od prístavu): predok na východ = kurz mapy `anchorageHeading` 90. */
  const onRoadstead = (over: Partial<ShipVM> = {}): ShipVM => feeder({ state: 'waiting_anchorage', x: 60.5, y: 3.5, prevX: 60.5, prevY: 3.5, unitsOnBoard: 40, capacityUnits: 120, ...over });

  it('feeder aj handy na rôznych anchorage majú rovnaký uhol view = kurz z VM (predok smeruje na východ)', () => {
    const textures = new StubTextures();
    const ships = [onRoadstead({ id: 1, x: 60.5, prevX: 60.5 }), onRoadstead({ id: 2, classId: 'handy', lengthCells: 10, x: 36.5, prevX: 36.5 }), onRoadstead({ id: 3, x: 72.5, prevX: 72.5 })];
    const views = ships.map((vm) => new ShipView(vm, deps(textures)));
    expect(views.map((view) => view.view.angle)).toEqual([90, 90, 90]);
    for (const view of views) {
      const bow = view.view.toGlobal({ x: 0, y: -3 * CELL });
      const stern = view.view.toGlobal({ x: 0, y: 3 * CELL });
      expect(bow.x).toBeGreaterThan(stern.x); // všetky lode smerujú na východ
      expect(bow.y).toBeCloseTo(stern.y, 6);
    }
  });

  it('loď, ktorá priplávala na západnú anchorage kurzom 270, sa na kotve natočí na kurz mapy (update zmení uhol, poloha ostane)', () => {
    const view = new ShipView(onRoadstead({ heading: 270, x: 40, prevX: 41 }), deps(new StubTextures()), 1);
    expect(view.view.angle).toBe(270);
    view.update(onRoadstead({ heading: 90, x: 36.5, prevX: 36.5 }), 1);
    expect(view.view.angle).toBe(90);
    expect([view.view.x, view.view.y]).toEqual([36.5 * CELL, 3.5 * CELL]);
  });

  it('shipPose: kotviaca loď stojí (prev = curr), uhol = kurz VM', () => {
    expect(shipPose(onRoadstead(), 0.5, CELL)).toEqual({ x: 60.5 * CELL, y: 3.5 * CELL, angle: 90 });
  });
});

describe('EntityLayer (lode podľa id)', () => {
  it('vytvára a ruší views podľa id, nezmenené ponecháva', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.sync([feeder({ id: 1 }), feeder({ id: 2, y: 20, prevY: 20 })], 1);
    expect(layer.shipCount).toBe(2);
    const first = layer.shipView(1);
    layer.sync([feeder({ id: 1, x: 44, prevX: 43 })], 0.5);
    expect(layer.shipView(1)).toBe(first);
    expect(first?.view.x).toBe(43.5 * CELL);
    expect(layer.shipCount).toBe(1);
    expect(layer.view.children).toHaveLength(1);
  });

  it('nová loď dostane hneď interpolovanú polohu pre aktuálne alpha', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.sync([feeder({ prevX: 10, x: 20 })], 0.5);
    expect(layer.shipView(5)?.view.x).toBe(15 * CELL);
  });

  it('zmena triedy alebo kategórie nákladu vytvorí view nanovo', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.sync([feeder()], 1);
    const first = layer.shipView(5);
    layer.sync([feeder({ classId: 'handy', lengthCells: 10 })], 1);
    expect(layer.shipView(5)).not.toBe(first);
    expect(first?.view.destroyed).toBe(true);
  });

  it('destroy uvoľní všetky views', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.sync([feeder()], 1);
    const view = layer.shipView(5);
    layer.destroy();
    expect(view?.view.destroyed).toBe(true);
    expect(layer.view.destroyed).toBe(true);
  });
});
