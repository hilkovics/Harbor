import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Grid } from '@sim/grid';
import { vehicleSprite } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { VEHICLE_LANE_SCALE, createRoadMaskAt } from '@render/lane';
import { TRUCK_STYLE, TruckView, sameTruckShape, truckSpriteFile } from '@render/truck-view';
import { VehicleView, vehiclePose } from '@render/vehicle-view';
import type { TruckVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

/** Posun do pravého pruhu dvojpruhovej cesty: 13 px zo 64 px bunky. */
const LANE = 13 / 64;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

/** Kamión v strede bunky (44; 40), kabínou na sever, prázdny. */
function truck(over: Partial<TruckVM> = {}): TruckVM {
  return {
    id: 1,
    defId: 'truck_container',
    x: 44.5,
    y: 40.5,
    prevX: 44.5,
    prevY: 40.5,
    heading: 0,
    loaded: false,
    state: 'to_gate',
    ...over,
  };
}

describe('záznam kamióna v manifeste', () => {
  it('truck_container: entita 1×2 (dlhšia ako straddle carrier 1×1) so stavmi empty / loaded', () => {
    const entry = vehicleSprite('truck_container');
    expect(entry?.footprint).toEqual({ w: 1, h: 2 });
    expect(vehicleSprite('straddle_carrier')?.footprint).toEqual({ w: 1, h: 1 });
  });

  it('truckSpriteFile: súbor podľa naloženia; neznámy kamión → undefined', () => {
    expect(truckSpriteFile('truck_container', false)).toBe('entities/truck_container_empty.svg');
    expect(truckSpriteFile('truck_container', true)).toBe('entities/truck_container_loaded.svg');
    expect(truckSpriteFile('truck_hovercraft', true)).toBeUndefined();
  });
});

describe('TruckView', () => {
  it('prázdny kamión: sprite `empty`, vycentrovaný, 1×2 bunky v mierke pruhu (rovnaká ako vozidlo), label `truck-<id>`', () => {
    const textures = new StubTextures();
    const view = new TruckView(truck(), deps(textures));
    const sprite = view.view.children[0] as Sprite;
    expect(sprite).toBeInstanceOf(Sprite);
    expect(sprite.texture).toBe(textures.textureFor('file/entities/truck_container_empty.svg'));
    expect(sprite.anchor.x).toBe(0.5);
    expect(sprite.anchor.y).toBe(0.5);
    expect(sprite.width).toBeCloseTo(CELL * VEHICLE_LANE_SCALE, 9);
    expect(sprite.height).toBeCloseTo(2 * CELL * VEHICLE_LANE_SCALE, 9);
    expect(view.view.label).toBe('truck-1');
    // dlhší ako straddle carrier v tej istej mierke
    const carrier = new VehicleView({ ...truck(), defId: 'straddle_carrier' }, deps(textures));
    expect((carrier.view.children[0] as Sprite).height).toBeCloseTo(sprite.height / 2, 9);
  });

  it('naložený kamión má sprite `loaded`; textúra sa prepne pri zmene `loaded`', () => {
    const textures = new StubTextures();
    const view = new TruckView(truck({ loaded: true }), deps(textures));
    expect(view.texture).toBe(textures.textureFor('file/entities/truck_container_loaded.svg'));
    view.update(truck({ loaded: false }), 1);
    expect(view.texture).toBe(textures.textureFor('file/entities/truck_container_empty.svg'));
  });

  it.each([
    [0, 0, -1, LANE, 0],
    [90, 1, 0, 0, LANE],
    [180, 0, 1, -LANE, 0],
    [270, -1, 0, 0, -LANE],
  ] as const)('kurz %i°: kabína (hore v sprite) smeruje o (%i; %i) od stredu kamióna v pravom pruhu', (heading, dx, dy, laneX, laneY) => {
    const view = new TruckView(truck({ heading }), deps(new StubTextures()));
    const root = new Container();
    root.addChild(view.view);
    const nose = view.view.toGlobal({ x: 0, y: -0.5 * CELL });
    expect(nose.x).toBeCloseTo((44.5 + laneX + dx * 0.5) * CELL, 6);
    expect(nose.y).toBeCloseTo((40.5 + laneY + dy * 0.5) * CELL, 6);
  });

  it('pozícia je spoločná s vozidlom: TruckView.view = vehiclePose (pruh, interpolácia, uhol)', () => {
    const vm = truck({ prevX: 44.5, x: 44.5, prevY: 41.5, y: 40.5, heading: 0 });
    const view = new TruckView(vm, deps(new StubTextures()), 0);
    for (const alpha of [0, 0.25, 0.5, 1]) {
      view.update(vm, alpha);
      const pose = vehiclePose(vm, alpha, CELL);
      expect(view.view.x).toBeCloseTo(pose.x, 9);
      expect(view.view.y).toBeCloseTo(pose.y, 9);
      expect(view.view.angle).toBeCloseTo(pose.angle, 9);
    }
    expect(view.view.x).toBeCloseTo((44.5 + LANE) * CELL, 9); // kurz 0°: pravý pruh je východne
  });

  it('jednopruhová cesta pod kamiónom: jazdí v strede bunky', () => {
    const view = new TruckView(truck(), { ...deps(new StubTextures()), roadKindAt: () => 'one_lane' });
    expect(view.view.x).toBe(44.5 * CELL);
  });

  it('zákruta: kamión ide po oblúku (stred vozidla), sprite sa otáča plynulo; pozícia = vehiclePose s maskou cesty', () => {
    // zákruta (10; 10): cesta zo juhu (10; 11) na západ (9; 10); kamión ide na sever a práve odbáča
    const grid = new Grid(24, 24, () => ({ terrain: 'land' }));
    for (const [x, y] of [[10, 11], [10, 10], [9, 10]] as const) grid.at(x, y).road = 'road';
    const roadMaskAt = createRoadMaskAt(grid);
    const vm = truck({ x: 10.5, y: 10.75, prevX: 10.5, prevY: 11.15, heading: 0 });
    const view = new TruckView(vm, { ...deps(new StubTextures()), roadMaskAt });
    const pose = vehiclePose(vm, 1, CELL, () => 'two_lane', roadMaskAt);
    expect(view.view.x).toBeCloseTo(pose.x, 9);
    expect(view.view.y).toBeCloseTo(pose.y, 9);
    const angle = ((view.view.angle % 360) + 360) % 360;
    expect(angle).toBeCloseTo(((pose.angle % 360) + 360) % 360, 9);
    expect(angle).toBeGreaterThan(270); // otáča sa zo severu (0°) doľava k západu (270°)
    expect(angle).toBeLessThan(360);
    // bez masky by šiel po priamke pravým pruhom
    const straight = new TruckView(vm, deps(new StubTextures()));
    expect(straight.view.angle).toBe(0);
    expect(view.view.x).not.toBeCloseTo(straight.view.x, 3);
  });

  it('neznámy kamión alebo bez textúr → `Graphics` z tokenov 1×2 v mierke pruhu, bez textúry', () => {
    const unknown = new TruckView(truck({ defId: 'truck_hovercraft' }), deps(new StubTextures()));
    expect(unknown.view.children[0]).toBeInstanceOf(Graphics);
    expect(unknown.texture).toBeNull();
    const bare = new TruckView(truck(), deps(null));
    const body = bare.view.children[0] as Graphics;
    expect(body).toBeInstanceOf(Graphics);
    expect(body.scale.x).toBeCloseTo(VEHICLE_LANE_SCALE, 9);
    // fallback kamióna je 1×2: dvakrát dlhší ako široký (bez odsadenia 56 × 120 px)
    const bounds = body.getLocalBounds();
    expect(bounds.height / bounds.width).toBeGreaterThan(2);
    bare.update(truck({ loaded: true }), 1); // prepnutie naloženia bez sprite nespadne
  });

  it('štýl fallbacku: náves `--truck-trailer`, kabína `--truck-cab` na predku', () => {
    const colors = TRUCK_STYLE.fallback(ENTITY_PALETTE);
    expect(colors.body).toBe(ENTITY_PALETTE.truck.trailer);
    expect(colors.front).toBe(ENTITY_PALETTE.truck.cab);
    expect(colors.outline).toBe(ENTITY_PALETTE.vehicle.dark);
  });

  it('zhoda tvaru: iba defId', () => {
    expect(sameTruckShape(truck(), truck({ x: 50.5, heading: 90, loaded: true, state: 'loading' }))).toBe(true);
    expect(sameTruckShape(truck(), truck({ defId: 'truck_bulk' }))).toBe(false);
  });

  it('destroy uvoľní view', () => {
    const view = new TruckView(truck(), deps(new StubTextures()));
    view.destroy();
    expect(view.view.destroyed).toBe(true);
  });
});

describe('EntityLayer (kamióny podľa id)', () => {
  const carrier = (over: Partial<VehicleVM> = {}): VehicleVM => ({
    id: 90,
    defId: 'straddle_carrier',
    x: 36.5,
    y: 24.5,
    prevX: 36.5,
    prevY: 24.5,
    heading: 90,
    loaded: false,
    state: 'idle',
    ...over,
  });

  it('vytvára a ruší views podľa id, nezmenené ponecháva a interpoluje', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncTrucks([truck({ id: 1 }), truck({ id: 2, y: 41.5, prevY: 41.5 })], 1);
    expect(layer.truckCount).toBe(2);
    const first = layer.truckView(1);
    layer.syncTrucks([truck({ id: 1, prevY: 40.5, y: 39.5 })], 0.5);
    expect(layer.truckView(1)).toBe(first);
    expect(first?.view.y).toBeCloseTo(40 * CELL, 9);
    expect(layer.truckCount).toBe(1);
    expect(layer.truckView(2)).toBeUndefined();
    expect(layer.view.children).toHaveLength(1);
  });

  it('zmena defId vytvorí view nanovo, zmena polohy a naloženia nie', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncTrucks([truck()], 1);
    const first = layer.truckView(1);
    layer.syncTrucks([truck({ y: 30.5, loaded: true })], 1);
    expect(layer.truckView(1)).toBe(first);
    layer.syncTrucks([truck({ defId: 'truck_bulk' })], 1);
    expect(layer.truckView(1)).not.toBe(first);
    expect(first?.view.destroyed).toBe(true);
  });

  it('vozidlá a kamióny sa synchronizujú nezávisle; kamióny sa kreslia nad vozidlami bez ohľadu na poradie vzniku', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncTrucks([truck()], 1); // kamión vznikne pred vozidlom
    layer.syncVehicles([carrier()], 1);
    expect(layer.truckCount).toBe(1);
    expect(layer.vehicleCount).toBe(1);
    layer.syncVehicles([], 1);
    expect(layer.truckCount).toBe(1);
    layer.syncVehicles([carrier()], 1);
    const vehicle = layer.vehicleView(90)?.view as Container;
    const lorry = layer.truckView(1)?.view as Container;
    expect(lorry.zIndex).toBeGreaterThan(vehicle.zIndex);
    layer.view.sortChildren();
    expect(layer.view.children.indexOf(lorry)).toBeGreaterThan(layer.view.children.indexOf(vehicle));
  });

  it('destroy uvoľní aj kamióny', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncTrucks([truck()], 1);
    const view = layer.truckView(1);
    layer.destroy();
    expect(view?.view.destroyed).toBe(true);
  });
});
