import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Grid } from '@sim/grid';
import { articulatedSprite, vehicleSprite } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { VEHICLE_OFFSET_CELLS, VEHICLE_SCALE, createRoadMaskAt } from '@render/lane';
import { TRUCK_STYLE, TruckView, sameTruckShape, truckSpriteFile } from '@render/truck-view';
import { VehicleView, vehiclePose } from '@render/vehicle-view';
import type { TruckVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

/** Posun vozidla od osi dvojpruhovej cesty doprava (rezerva asfaltu). */
const LANE = VEHICLE_OFFSET_CELLS;

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
  it('truck_container: kĺbová entita 1×3 (kabína 1×1 + náves 1×2), dlhšia ako straddle carrier 1×2', () => {
    expect(articulatedSprite('truck_container')?.footprint).toEqual({ w: 1, h: 3 });
    expect(vehicleSprite('straddle_carrier')?.footprint).toEqual({ w: 1, h: 2 });
  });

  it('truckSpriteFile: kamión nemá jediný sprite (časti kabína + náves); neznámy kamión → undefined', () => {
    expect(truckSpriteFile('truck_container', false)).toBeUndefined();
    expect(truckSpriteFile('truck_hovercraft', true)).toBeUndefined();
  });
});

describe('TruckView', () => {
  const spriteOf = (group: Container | null): Sprite => group!.children.find((child): child is Sprite => child instanceof Sprite)!;

  it('prázdny kamión: kabína (točnica 32, 54) a náves (čap 32, 4) v jednotnej mierke vozidiel, čap je v počiatku častí, label `truck-<id>`', () => {
    const textures = new StubTextures();
    const view = new TruckView(truck(), deps(textures));
    const cab = spriteOf(view.cabView);
    const trailer = spriteOf(view.trailerView);
    expect(cab.texture).toBe(textures.textureFor('file/entities/truck_cab.svg'));
    expect(trailer.texture).toBe(textures.textureFor('file/entities/truck_trailer_40.svg'));
    expect([cab.anchor.x, cab.anchor.y]).toEqual([32 / 64, 54 / 64]);
    expect([trailer.anchor.x, trailer.anchor.y]).toEqual([32 / 64, 4 / 128]);
    expect(cab.width).toBeCloseTo(CELL * VEHICLE_SCALE, 9);
    expect(cab.height).toBeCloseTo(CELL * VEHICLE_SCALE, 9);
    expect(trailer.width).toBeCloseTo(CELL * VEHICLE_SCALE, 9);
    expect(trailer.height).toBeCloseTo(2 * CELL * VEHICLE_SCALE, 9);
    expect(view.view.label).toBe('truck-1');
    expect(view.cargoState).toBe('none');
    expect(view.cabView!.position.x).toBe(view.trailerView!.position.x); // točnica = čap, v priamej jazde kabína rovno s návesom
    expect(view.cabView!.angle).toBe(0);
    // kabína (hlava) je o 54 px pred čapom: predok vozidla je v 1/2 rozpätia pred stredom
    const span = (54 + (128 - 4)) / 64;
    expect(view.cabView!.position.y).toBeCloseTo((-span / 2 + 54 / 64) * CELL, 9);
    // dlhší ako straddle carrier v tej istej mierke
    const carrier = new VehicleView({ ...truck(), defId: 'straddle_carrier' }, deps(textures));
    expect((carrier.view.children.find((child): child is Sprite => child instanceof Sprite)!).height).toBeLessThan(span * CELL);
  });

  it('naložený kamión nesie kontajner na návese (CargoSprite); zmena `loaded` ho zobrazí / skryje', () => {
    const textures = new StubTextures();
    const view = new TruckView(truck({ loaded: true }), deps(textures));
    expect(view.cargoState).toBe('full');
    view.update(truck({ loaded: false }), 1);
    expect(view.cargoState).toBe('none');
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

  it('neznámy kamión alebo bez textúr → `Graphics` z tokenov 1×2 v jednotnej mierke vozidiel, bez textúry', () => {
    const unknown = new TruckView(truck({ defId: 'truck_hovercraft' }), deps(new StubTextures()));
    expect(unknown.view.children[0]).toBeInstanceOf(Graphics);
    expect(unknown.texture).toBeNull();
    const bare = new TruckView(truck(), deps(null));
    const body = bare.view.children[0] as Graphics;
    expect(body).toBeInstanceOf(Graphics);
    expect(body.scale.x).toBeCloseTo(VEHICLE_SCALE, 9);
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

describe('TruckView: manéver kamióna pri rampe (F5b č. 11)', () => {
  /** Rampa A (30; 23): dok 0 má stred (31,5; 24,42), vonkajšia bunka konektora (31; 25). */
  const DOCK_Y = 24 + (60 + 62 / 2) / 64 - 1;
  let time = 0;
  const maneuverDeps = (roadMaskAt?: (x: number, y: number) => number) => ({ ...deps(new StubTextures()), now: () => time, ...(roadMaskAt ? { roadMaskAt } : {}) });

  /** Kamión v stave `loading`: cieľ v doku (kabína na juh) a sim poloha na vonkajšej bunke s kurzom príjazdu. */
  const loading = (over: Partial<TruckVM> = {}): TruckVM =>
    truck({ x: 31.5, y: DOCK_Y, prevX: 31.5, prevY: DOCK_Y, heading: 180, state: 'loading', prevState: 'to_dock', approach: { x: 31.5, y: 25.5, heading: 270 }, ...over });
  const driving = (): TruckVM => truck({ x: 31.5, y: 25.5, prevX: 31.5, prevY: 25.5, heading: 270, state: 'to_dock', prevState: 'to_bay' });

  it('`to_dock` → `loading`: kamión najprv stojí na vonkajšej bunke, potom cúva a skončí v strede docku s kabínou na juh', () => {
    time = 1000;
    const view = new TruckView(driving(), maneuverDeps(), 1);
    expect(view.dockPhase).toBe('free');
    const arrived = { x: view.view.x, y: view.view.y, angle: view.view.angle };
    view.update(loading(), 1);
    expect(view.dockPhase).toBe('entering');
    expect([view.view.x, view.view.y, view.view.angle]).toEqual([arrived.x, arrived.y, arrived.angle]); // zastavenie: nič sa nehýbe
    time = 1000 + 1000;
    view.update(loading(), 1);
    expect(Math.hypot(view.view.x - arrived.x, view.view.y - arrived.y)).toBeGreaterThan(5);
    time = 1000 + 5000;
    view.update(loading(), 1);
    expect(view.dockPhase).toBe('docked');
    expect(view.view.x).toBeCloseTo(31.5 * CELL, 9);
    expect(view.view.y).toBeCloseTo(DOCK_Y * CELL, 9);
    expect(view.view.angle).toBeCloseTo(180, 9);
  });

  it('výjazd `loading` → `to_gate_out`: začína v doku a plynule dobieha pózu zo simu', () => {
    time = 0;
    const view = new TruckView(driving(), maneuverDeps(), 1);
    view.update(loading(), 1);
    time = 6000;
    view.update(loading(), 1);
    const out = truck({ x: 31.5, y: 25.5, prevX: 31.5, prevY: 25.5, heading: 90, loaded: true, state: 'to_gate_out', prevState: 'loading' });
    view.update(out, 1);
    expect(view.dockPhase).toBe('leaving');
    expect(view.view.y).toBeCloseTo(DOCK_Y * CELL, 6); // ešte v doku
    time = 6000 + 2000;
    view.update(out, 1);
    expect(view.dockPhase).toBe('free');
    expect(view.view.angle).toBeCloseTo(90, 9);
  });

  it('kamión bez `approach` alebo v iných stavoch sa kreslí ako doteraz (póza zo simu, fáza `free`)', () => {
    time = 0;
    const view = new TruckView(truck(), maneuverDeps(), 1);
    expect(view.dockPhase).toBe('free');
    expect(view.view.position.x).toBeCloseTo((44.5 + LANE) * CELL, 9);
    view.update(loading({ approach: undefined }), 1);
    expect(view.dockPhase).toBe('free');
  });

  it('príjazd priamo na modul: kamión vycúva do boku tam, kde pokračuje cesta (vľavo od kurzu príjazdu = západ)', () => {
    time = 0;
    // bunka (32; 25): cesta pokračuje na západ (31; 25) a na juh (32; 26); na východ nie
    const W = 8;
    const S = 4;
    const maskAt = (x: number, y: number): number => (x === 32 && y === 25 ? W | S | 1 : 0);
    const arrival = truck({ x: 32.5, y: 25.5, prevX: 32.5, prevY: 25.5, heading: 0, state: 'to_dock', prevState: 'to_bay' });
    const straight = loading({ x: 32.5, approach: { x: 32.5, y: 25.5, heading: 0 } });
    const view = new TruckView(arrival, maneuverDeps(maskAt), 1);
    view.update(straight, 1);
    let widest = 0;
    let sideways = 0;
    for (let ms = 0; ms <= 1700; ms += 50) {
      time = ms;
      view.update(straight, 1);
      const offset = view.view.x / CELL - 32.5;
      widest = Math.max(widest, Math.abs(offset));
      sideways = Math.min(sideways, offset);
    }
    expect(widest).toBeGreaterThan(0.3);
    expect(sideways).toBeLessThan(-0.3); // vybočenie na západ (−x)
    // bez cesty na žiadnej strane vycúva vpravo (východ)
    time = 0;
    const plain = new TruckView(arrival, maneuverDeps(), 1);
    plain.update(straight, 1);
    let east = 0;
    for (let ms = 0; ms <= 1700; ms += 50) {
      time = ms;
      plain.update(straight, 1);
      east = Math.max(east, plain.view.x / CELL - 32.5);
    }
    expect(east).toBeGreaterThan(0.3);
  });

  it('manéver je nezávislý od alpha: rovnaký čas dá rovnakú pózu pri iných podieloch ticku', () => {
    time = 0;
    const view = new TruckView(driving(), maneuverDeps(), 0.25);
    view.update(loading(), 0.25);
    time = 1200;
    view.update(loading(), 0.1);
    const a = { x: view.view.x, y: view.view.y, angle: view.view.angle };
    view.update(loading(), 0.9);
    expect({ x: view.view.x, y: view.view.y, angle: view.view.angle }).toEqual(a);
  });
});
