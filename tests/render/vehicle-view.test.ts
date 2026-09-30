import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { vehicleSprite } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { VehicleView, sameVehicleShape, vehicleLoad, vehiclePose, vehicleSpriteFile } from '@render/vehicle-view';
import type { ShipVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

/** Straddle carrier v strede bunky (36; 24), smer na východ, prázdny. */
function carrier(over: Partial<VehicleVM> = {}): VehicleVM {
  return {
    id: 1,
    defId: 'straddle_carrier',
    x: 36.5,
    y: 24.5,
    prevX: 36.5,
    prevY: 24.5,
    heading: 90,
    loaded: false,
    state: 'to_pickup',
    ...over,
  };
}

function feeder(over: Partial<ShipVM> = {}): ShipVM {
  return {
    id: 50,
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

describe('záznam vozidla v manifeste', () => {
  it('straddle_carrier: footprint 1×1 a stavy empty / loaded', () => {
    const entry = vehicleSprite('straddle_carrier');
    expect(entry?.footprint).toEqual({ w: 1, h: 1 });
    expect(entry?.states.empty).toBe('entities/straddle_carrier_empty.svg');
    expect(entry?.states.loaded).toBe('entities/straddle_carrier_loaded.svg');
  });

  it('lode (majú `variants`, nie `states`), neznáme id a kľúče z prototypu objektu nie sú vozidlá', () => {
    expect(vehicleSprite('ship_feeder')).toBeUndefined();
    expect(vehicleSprite('neexistuje')).toBeUndefined();
    expect(vehicleSprite('constructor')).toBeUndefined();
    expect(vehicleSprite('__proto__')).toBeUndefined();
  });

  it('vehicleSpriteFile: súbor podľa stavu naloženia; neznáme vozidlo → undefined', () => {
    expect(vehicleSpriteFile('straddle_carrier', false)).toBe('entities/straddle_carrier_empty.svg');
    expect(vehicleSpriteFile('straddle_carrier', true)).toBe('entities/straddle_carrier_loaded.svg');
    expect(vehicleSpriteFile('hovercraft', true)).toBeUndefined();
  });

  it('vehicleLoad', () => {
    expect(vehicleLoad(false)).toBe('empty');
    expect(vehicleLoad(true)).toBe('loaded');
  });
});

describe('vehiclePose (lerp(prev, curr, alpha) × cell, rotácia = heading)', () => {
  it('poloha medzi predchádzajúcim a aktuálnym tickom; stred bunky je x + 0,5', () => {
    const pose = vehiclePose(carrier({ prevX: 36.5, x: 37.5, prevY: 24.5, y: 24.5, heading: 90 }), 0.25, CELL);
    expect(pose).toEqual({ x: 36.75 * CELL, y: 24.5 * CELL, angle: 90 });
  });

  it('alpha 0 → predchádzajúca poloha, alpha 1 → aktuálna', () => {
    const vm = carrier({ prevX: 10.5, x: 11.5, prevY: 20.5, y: 21.5, heading: 180 });
    expect(vehiclePose(vm, 0, CELL)).toEqual({ x: 10.5 * CELL, y: 20.5 * CELL, angle: 180 });
    expect(vehiclePose(vm, 1, CELL)).toEqual({ x: 11.5 * CELL, y: 21.5 * CELL, angle: 180 });
  });
});

describe('VehicleView', () => {
  it('prázdne vozidlo: sprite `empty`, vycentrovaný, 1×1 bunka, poloha = stred bunky v px', () => {
    const textures = new StubTextures();
    const view = new VehicleView(carrier(), deps(textures));
    const sprite = view.view.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/entities/straddle_carrier_empty.svg'));
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.anchor.y).toBe(0.5);
    expect(sprite.width).toBeCloseTo(CELL, 6);
    expect(sprite.height).toBeCloseTo(CELL, 6);
    expect(view.view.position.x).toBe(36.5 * CELL);
    expect(view.view.position.y).toBe(24.5 * CELL);
    expect(view.view.angle).toBeCloseTo(90, 9);
  });

  it('naložené vozidlo má sprite `loaded`; textúra sa prepne pri zmene `loaded`', () => {
    const textures = new StubTextures();
    const view = new VehicleView(carrier({ loaded: true }), deps(textures));
    expect(view.texture).toBe(textures.textureFor('file/entities/straddle_carrier_loaded.svg'));
    view.update(carrier({ loaded: false }), 1);
    expect(view.texture).toBe(textures.textureFor('file/entities/straddle_carrier_empty.svg'));
    view.update(carrier({ loaded: true }), 1);
    expect(view.texture).toBe(textures.textureFor('file/entities/straddle_carrier_loaded.svg'));
  });

  it.each([
    [0, 0, -1],
    [90, 1, 0],
    [180, 0, 1],
    [270, -1, 0],
  ] as const)('kurz %i°: predok (hore v sprite) smeruje o (%i; %i) bunky od stredu', (heading, dx, dy) => {
    const view = new VehicleView(carrier({ heading }), deps(new StubTextures()));
    const root = new Container();
    root.addChild(view.view);
    const front = view.view.toGlobal({ x: 0, y: -0.5 * CELL });
    expect(front.x).toBeCloseTo(36.5 * CELL + dx * 0.5 * CELL, 6);
    expect(front.y).toBeCloseTo(24.5 * CELL + dy * 0.5 * CELL, 6);
  });

  it('rotácia je okolo stredu bunky: stred spritu ostáva na (x; y) pri každom kurze', () => {
    for (const heading of [0, 90, 180, 270] as const) {
      const view = new VehicleView(carrier({ heading }), deps(new StubTextures()));
      const root = new Container();
      root.addChild(view.view);
      const center = view.view.toGlobal({ x: 0, y: 0 });
      expect(center.x).toBeCloseTo(36.5 * CELL, 6);
      expect(center.y).toBeCloseTo(24.5 * CELL, 6);
    }
  });

  it('update interpoluje polohu podľa alpha a mení kurz', () => {
    const vm = carrier({ prevX: 36.5, x: 37.5, prevY: 24.5, y: 24.5, heading: 90 });
    const view = new VehicleView(vm, deps(new StubTextures()), 0);
    expect(view.view.x).toBe(36.5 * CELL);
    view.update(vm, 0.5);
    expect(view.view.x).toBe(37 * CELL);
    view.update(vm, 1);
    expect(view.view.x).toBe(37.5 * CELL);
    view.update({ ...vm, heading: 180, prevX: 37.5, x: 37.5, prevY: 24.5, y: 25.5 }, 0.5);
    expect(view.view.angle).toBeCloseTo(180, 9);
    expect(view.view.y).toBe(25 * CELL);
  });

  it('neznáme vozidlo alebo bez textúr → `Graphics` z tokenov (jedna bunka), bez textúry', () => {
    const unknown = new VehicleView(carrier({ defId: 'hovercraft' }), deps(new StubTextures()));
    expect(unknown.view.children[0]).toBeInstanceOf(Graphics);
    expect(unknown.texture).toBeNull();
    const bare = new VehicleView(carrier(), deps(null));
    expect(bare.view.children[0]).toBeInstanceOf(Graphics);
    bare.update(carrier({ loaded: true }), 1); // prepnutie naloženia bez sprite nespadne
    bare.update(carrier({ loaded: false }), 1);
  });

  it('zhoda tvaru: iba defId (poloha a kurz sa menia každý tick)', () => {
    expect(sameVehicleShape(carrier(), carrier({ x: 40.5, heading: 0, loaded: true, state: 'loading' }))).toBe(true);
    expect(sameVehicleShape(carrier(), carrier({ defId: 'agv' }))).toBe(false);
  });

  it('destroy uvoľní view', () => {
    const view = new VehicleView(carrier(), deps(new StubTextures()));
    view.destroy();
    expect(view.view.destroyed).toBe(true);
  });
});

describe('EntityLayer (vozidlá podľa id)', () => {
  it('vytvára a ruší views podľa id, nezmenené ponecháva a interpoluje', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncVehicles([carrier({ id: 1 }), carrier({ id: 2, y: 25.5, prevY: 25.5 })], 1);
    expect(layer.vehicleCount).toBe(2);
    const first = layer.vehicleView(1);
    layer.syncVehicles([carrier({ id: 1, prevX: 36.5, x: 37.5 })], 0.5);
    expect(layer.vehicleView(1)).toBe(first);
    expect(first?.view.x).toBe(37 * CELL);
    expect(layer.vehicleCount).toBe(1);
    expect(layer.vehicleView(2)).toBeUndefined();
    expect(layer.view.children).toHaveLength(1);
  });

  it('nové vozidlo dostane hneď interpolovanú polohu pre aktuálne alpha', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncVehicles([carrier({ prevX: 10.5, x: 11.5 })], 0.5);
    expect(layer.vehicleView(1)?.view.x).toBe(11 * CELL);
  });

  it('zmena defId vytvorí view nanovo, zmena polohy a naloženia nie', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncVehicles([carrier()], 1);
    const first = layer.vehicleView(1);
    layer.syncVehicles([carrier({ x: 40.5, loaded: true })], 1);
    expect(layer.vehicleView(1)).toBe(first);
    layer.syncVehicles([carrier({ defId: 'agv' })], 1);
    expect(layer.vehicleView(1)).not.toBe(first);
    expect(first?.view.destroyed).toBe(true);
  });

  it('lode a vozidlá sa synchronizujú nezávisle; vozidlá sa kreslia nad loďami bez ohľadu na poradie vzniku', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncVehicles([carrier()], 1); // vozidlo vznikne pred loďou
    layer.sync([feeder()], 1);
    expect(layer.shipCount).toBe(1);
    expect(layer.vehicleCount).toBe(1);
    layer.sync([], 1);
    expect(layer.shipCount).toBe(0);
    expect(layer.vehicleCount).toBe(1);
    layer.sync([feeder()], 1);
    const ship = layer.shipView(50)?.view;
    const vehicle = layer.vehicleView(1)?.view;
    expect(layer.view.sortableChildren).toBe(true);
    expect((vehicle?.zIndex ?? 0) > (ship?.zIndex ?? 0)).toBe(true);
    layer.view.sortChildren();
    expect(layer.view.children.indexOf(vehicle as Container)).toBeGreaterThan(layer.view.children.indexOf(ship as Container));
  });

  it('destroy uvoľní lode aj vozidlá', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.sync([feeder()], 1);
    layer.syncVehicles([carrier()], 1);
    const ship = layer.shipView(50);
    const vehicle = layer.vehicleView(1);
    layer.destroy();
    expect(ship?.view.destroyed).toBe(true);
    expect(vehicle?.view.destroyed).toBe(true);
    expect(layer.view.destroyed).toBe(true);
  });
});
