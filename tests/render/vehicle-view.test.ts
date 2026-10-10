import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { vehicleSprite } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import type { RoadKind } from '@sim/grid';
import { VEHICLE_OFFSET_CELLS, VEHICLE_SCALE, type RoadKindAt } from '@render/lane';
import { VehicleView, sameVehicleShape, vehicleLoad, vehiclePose, vehicleSpriteFile } from '@render/vehicle-view';
import type { ShipVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

/** Posun vozidla od osi dvojpruhovej cesty doprava: rezerva asfaltu po stranách vozidla (2 px zo 64 px bunky). */
const LANE = VEHICLE_OFFSET_CELLS;

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
  it('straddle_carrier: footprint 1×2, jediný sprite pre stavy empty / loaded (kontajner kreslí hra pod rám)', () => {
    const entry = vehicleSprite('straddle_carrier');
    expect(entry?.footprint).toEqual({ w: 1, h: 2 });
    expect(entry?.states.empty).toBe('entities/straddle_carrier.svg');
    expect(entry?.states.loaded).toBe('entities/straddle_carrier.svg');
  });

  it('lode (majú `variants`, nie `states`), neznáme id a kľúče z prototypu objektu nie sú vozidlá', () => {
    expect(vehicleSprite('ship_feeder')).toBeUndefined();
    expect(vehicleSprite('neexistuje')).toBeUndefined();
    expect(vehicleSprite('constructor')).toBeUndefined();
    expect(vehicleSprite('__proto__')).toBeUndefined();
  });

  it('vehicleSpriteFile: súbor podľa stavu naloženia; neznáme vozidlo → undefined', () => {
    expect(vehicleSpriteFile('straddle_carrier', false)).toBe('entities/straddle_carrier.svg');
    expect(vehicleSpriteFile('straddle_carrier', true)).toBe('entities/straddle_carrier.svg');
    expect(vehicleSpriteFile('hovercraft', true)).toBeUndefined();
  });

  it('vehicleLoad', () => {
    expect(vehicleLoad(false)).toBe('empty');
    expect(vehicleLoad(true)).toBe('loaded');
  });
});

describe('vehiclePose (lerp(prev + pruh, curr + pruh, alpha) × cell, rotácia = heading)', () => {
  it('poloha medzi predchádzajúcim a aktuálnym tickom; stred bunky je x + 0,5; kurz 90° jazdí v južnom pruhu (+y)', () => {
    const pose = vehiclePose(carrier({ prevX: 36.5, x: 37.5, prevY: 24.5, y: 24.5, heading: 90 }), 0.25, CELL);
    expect(pose.x).toBeCloseTo(36.75 * CELL, 9);
    expect(pose.y).toBeCloseTo((24.5 + LANE) * CELL, 9);
    expect(pose.angle).toBe(90);
  });

  it('alpha 0 → predchádzajúca poloha, alpha 1 → aktuálna (obe v pruhu); kurz 180° jazdí v západnom pruhu (−x)', () => {
    const vm = carrier({ prevX: 10.5, x: 11.5, prevY: 20.5, y: 21.5, heading: 180 });
    const start = vehiclePose(vm, 0, CELL);
    const end = vehiclePose(vm, 1, CELL);
    expect(start.x).toBeCloseTo((10.5 - LANE) * CELL, 9);
    expect(start.y).toBeCloseTo(20.5 * CELL, 9);
    expect(end.x).toBeCloseTo((11.5 - LANE) * CELL, 9);
    expect(end.y).toBeCloseTo(21.5 * CELL, 9);
    expect(end.angle).toBe(180);
  });

  it.each([
    [0, LANE, 0],
    [90, 0, LANE],
    [180, -LANE, 0],
    [270, 0, -LANE],
  ] as const)('stojace vozidlo v strede bunky, kurz %i°: pravý pruh je posun (%f; %f) bunky kolmo na smer jazdy', (heading, dx, dy) => {
    const pose = vehiclePose(carrier({ heading }), 1, CELL);
    expect(pose.x).toBeCloseTo((36.5 + dx) * CELL, 9);
    expect(pose.y).toBeCloseTo((24.5 + dy) * CELL, 9);
  });

  it('jednopruhová a jednosmerná cesta: vozidlo jazdí v strede bunky', () => {
    for (const kind of ['one_lane', 'one_way'] as const) {
      const pose = vehiclePose(carrier({ heading: 270 }), 1, CELL, () => kind);
      expect(pose).toEqual({ x: 36.5 * CELL, y: 24.5 * CELL, angle: 270 });
    }
  });

  it('typ cesty sa pýta pre bunku pod predchádzajúcou aj aktuálnou polohou (podlaha súradníc)', () => {
    const calls: string[] = [];
    const roadKindAt: RoadKindAt = (x, y) => {
      calls.push(`${String(x)};${String(y)}`);
      return 'two_lane';
    };
    vehiclePose(carrier({ prevX: 36.9, prevY: 24.5, x: 37.1, y: 24.5 }), 0.5, CELL, roadKindAt);
    expect(calls).toEqual(['36;24', '37;24']);
  });

  it('prechod medzi typmi ciest: posun sa interpoluje z pruhu (dvojpruhová) do stredu (jednopruhová)', () => {
    const roadKindAt: RoadKindAt = (x): RoadKind => (x < 10 ? 'two_lane' : 'one_lane');
    const vm = carrier({ prevX: 9.9, x: 10.1, prevY: 24.5, y: 24.5, heading: 90 });
    expect(vehiclePose(vm, 0, CELL, roadKindAt).y).toBeCloseTo((24.5 + LANE) * CELL, 9);
    expect(vehiclePose(vm, 0.5, CELL, roadKindAt).y).toBeCloseTo((24.5 + LANE / 2) * CELL, 9);
    expect(vehiclePose(vm, 1, CELL, roadKindAt).y).toBeCloseTo(24.5 * CELL, 9);
  });

  it('zákruta: pruh sa interpoluje medzi kurzom predchádzajúceho a aktuálneho úseku (prevHeading)', () => {
    // východ → juh v zákrute (48; 24): pred zákrutou južný pruh (+y), po nej západný pruh (−x)
    const vm = carrier({ prevX: 47.9, prevY: 24.5, x: 48.5, y: 24.6, prevHeading: 90, heading: 180 });
    const start = vehiclePose(vm, 0, CELL);
    const middle = vehiclePose(vm, 0.5, CELL);
    const end = vehiclePose(vm, 1, CELL);
    expect(start.x).toBeCloseTo(47.9 * CELL, 9);
    expect(start.y).toBeCloseTo((24.5 + LANE) * CELL, 9);
    expect(end.x).toBeCloseTo((48.5 - LANE) * CELL, 9);
    expect(end.y).toBeCloseTo(24.6 * CELL, 9);
    expect(middle.x).toBeCloseTo(((47.9 + 48.5 - LANE) / 2) * CELL, 9);
    expect(middle.y).toBeCloseTo(((24.5 + LANE + 24.6) / 2) * CELL, 9);
    expect(end.angle).toBe(180); // kurz sa nemení plynulo, iba poloha
  });

  it('bez prevHeading sa berie aktuálny kurz (staré VM)', () => {
    const vm = carrier({ prevX: 36.5, x: 37.5, heading: 90 });
    expect(vehiclePose(vm, 0, CELL)).toEqual(vehiclePose({ ...vm, prevHeading: 90 }, 0, CELL));
  });

  it('jazda cez zákrutu nemá skok: krok medzi susednými vzorkami polohy je malý aj na hranici ticku', () => {
    // trasa: východ po y = 24,5 do stredu bunky (48; 24), potom juh po x = 48,5; krok 0,25 bunky za tick
    const step = 0.25;
    const points: { x: number; y: number; heading: 90 | 180 }[] = [];
    for (let x = 46.5; x < 48.5; x += step) points.push({ x, y: 24.5, heading: 90 });
    for (let y = 24.5; y <= 26.5; y += step) points.push({ x: 48.5, y, heading: 180 });
    const samples: { x: number; y: number }[] = [];
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      const vm = carrier({ prevX: prev.x, prevY: prev.y, prevHeading: prev.heading, x: curr.x, y: curr.y, heading: curr.heading });
      for (let alpha = 0; alpha <= 1.0001; alpha += 0.05) samples.push(vehiclePose(vm, alpha, CELL));
    }
    let largest = 0;
    for (let i = 1; i < samples.length; i += 1) {
      largest = Math.max(largest, Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y) / CELL);
    }
    // bez prevHeading by v zákrute vznikol skok LANE·√2 ≈ 0,29 bunky; s ním je najväčší krok ≈ krok ticku / 20 + zmena pruhu / 20
    expect(largest).toBeLessThan(0.05);
  });

  it('kontrola testu: bez prevHeading by tá istá zákruta skočila cez stredovú čiaru', () => {
    const withHeading = carrier({ prevX: 47.9, prevY: 24.5, x: 48.5, y: 24.6, prevHeading: 90, heading: 180 });
    const without = { ...withHeading, prevHeading: undefined };
    const jump = Math.hypot(
      vehiclePose(without, 0, CELL).x - vehiclePose(withHeading, 0, CELL).x,
      vehiclePose(without, 0, CELL).y - vehiclePose(withHeading, 0, CELL).y,
    );
    expect(jump / CELL).toBeCloseTo(Math.SQRT2 * LANE, 9);
  });
});

describe('VehicleView', () => {
  it('prázdne vozidlo: sprite rámu, vycentrovaný, v jednotnej mierke vozidiel, bez kontajnera; poloha = stred bunky posunutý doprava od osi', () => {
    const textures = new StubTextures();
    const view = new VehicleView(carrier(), deps(textures));
    const sprite = view.view.children.find((child): child is Sprite => child instanceof Sprite)!;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/entities/straddle_carrier.svg'));
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.anchor.y).toBe(0.5);
    expect(view.cargoState).toBe('none');
    // sprite 1×2 bunky × VEHICLE_SCALE (jediná mierka vozidiel, kontajner na vozidle = TEU na aprone)
    expect(sprite.width).toBeCloseTo(CELL * VEHICLE_SCALE, 6);
    expect(sprite.height).toBeCloseTo(2 * CELL * VEHICLE_SCALE, 6);
    expect(view.view.position.x).toBe(36.5 * CELL);
    expect(view.view.position.y).toBeCloseTo((24.5 + LANE) * CELL, 9); // kurz 90°: pravý pruh je južne
    expect(view.view.angle).toBeCloseTo(90, 9);
  });

  it('naložené vozidlo nesie kontajner POD rámom (kreslí sa pred spritom rámu); zmena `loaded` ho zobrazí / skryje', () => {
    const textures = new StubTextures();
    const view = new VehicleView(carrier({ loaded: true }), deps(textures));
    expect(view.cargoState).toBe('full');
    const order = view.view.children.map((child) => child.constructor.name);
    expect(order.indexOf('CargoSprite')).toBeLessThan(order.indexOf('Sprite'));
    view.update(carrier({ loaded: false }), 1);
    expect(view.cargoState).toBe('none');
    view.update(carrier({ loaded: true }), 1);
    expect(view.cargoState).toBe('full');
  });

  it.each([
    [0, 0, -1, LANE, 0],
    [90, 1, 0, 0, LANE],
    [180, 0, 1, -LANE, 0],
    [270, -1, 0, 0, -LANE],
  ] as const)('kurz %i°: predok (hore v sprite) smeruje o (%i; %i) bunky od stredu vozidla v pravom pruhu', (heading, dx, dy, laneX, laneY) => {
    const view = new VehicleView(carrier({ heading }), deps(new StubTextures()));
    const root = new Container();
    root.addChild(view.view);
    const front = view.view.toGlobal({ x: 0, y: -0.5 * CELL });
    expect(front.x).toBeCloseTo((36.5 + laneX + dx * 0.5) * CELL, 6);
    expect(front.y).toBeCloseTo((24.5 + laneY + dy * 0.5) * CELL, 6);
  });

  it('rotácia je okolo stredu vozidla: stred spritu je v pravom pruhu bunky (x; y) pri každom kurze', () => {
    for (const [heading, laneX, laneY] of [
      [0, LANE, 0],
      [90, 0, LANE],
      [180, -LANE, 0],
      [270, 0, -LANE],
    ] as const) {
      const view = new VehicleView(carrier({ heading }), deps(new StubTextures()));
      const root = new Container();
      root.addChild(view.view);
      const center = view.view.toGlobal({ x: 0, y: 0 });
      expect(center.x).toBeCloseTo((36.5 + laneX) * CELL, 6);
      expect(center.y).toBeCloseTo((24.5 + laneY) * CELL, 6);
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
    expect(view.view.x).toBeCloseTo((37.5 - LANE) * CELL, 9); // kurz 180°: západný pruh
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

  it('fallback `Graphics` má rovnakú mierku ako sprite (`VEHICLE_SCALE`)', () => {
    const view = new VehicleView(carrier({ defId: 'hovercraft' }), deps(new StubTextures()));
    const body = view.view.children[0];
    expect(body.scale.x).toBeCloseTo(VEHICLE_SCALE, 9);
    expect(body.scale.y).toBeCloseTo(VEHICLE_SCALE, 9);
  });

  it('F5b č. 10: prázdny a naložený straddle carrier majú rovnakú veľkosť sprite (naloženie ju nemení)', () => {
    const view = new VehicleView(carrier({ loaded: false }), deps(new StubTextures()));
    const sprite = view.view.children[0] as Sprite;
    const empty = { width: sprite.width, height: sprite.height, scaleX: sprite.scale.x, scaleY: sprite.scale.y };
    view.update(carrier({ loaded: true }), 1);
    expect(view.view.children[0]).toBe(sprite); // ten istý sprite, len iná textúra
    expect({ width: sprite.width, height: sprite.height, scaleX: sprite.scale.x, scaleY: sprite.scale.y }).toEqual(empty);
    view.update(carrier({ loaded: false }), 1);
    expect(sprite.width).toBe(empty.width);
    expect(sprite.height).toBe(empty.height);
  });

  it('typ cesty z `roadKindAt` v deps: jednopruhová cesta = stred bunky; po prestavbe na dvojpruhovú skočí do pruhu', () => {
    let kind: RoadKind = 'one_lane';
    const view = new VehicleView(carrier({ heading: 0 }), { ...deps(new StubTextures()), roadKindAt: () => kind });
    expect(view.view.x).toBe(36.5 * CELL);
    kind = 'two_lane';
    view.update(carrier({ heading: 0 }), 1);
    expect(view.view.x).toBeCloseTo((36.5 + LANE) * CELL, 9);
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
