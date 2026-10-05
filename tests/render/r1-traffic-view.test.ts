import { Container, Graphics, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { rotateFootprint } from '@sim/grid';
import { moduleSprite, parkingStalls } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { VEHICLE_OFFSET_CELLS } from '@render/lane';
import { ModuleView } from '@render/module-view';
import { MODULE_DECORS } from '@render/module-decors';
import {
  PARKING_FILL,
  ParkedVehiclesDecor,
  parkedScale,
  parkingGrid,
  parkingSlots,
  sortedParked,
} from '@render/parked-vehicles-decor';
import { TrafficJamLayer } from '@render/traffic-jam-layer';
import { TruckView } from '@render/truck-view';
import { BRAKE_LIGHT_PX, VehicleView } from '@render/vehicle-view';
import type { ModuleVM, TruckVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

// R1 / TR1-06: kĺbové vozidlá po stope, brzdové svetlá, zaparkované vozidlá v depe, zvýraznenie zápchy.

const CELL = PALETTE.cellPx;
const LANE = VEHICLE_OFFSET_CELLS;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures };
}

/** Kamión s hlavou v (5,5; 3,5) idúci na sever, stopa o 2 bunky južnejšie, dĺžka 3. */
function truck(over: Partial<TruckVM> = {}): TruckVM {
  return {
    id: 1,
    defId: 'truck_container',
    x: 5.5,
    y: 3.5,
    prevX: 5.5,
    prevY: 3.5,
    heading: 0,
    loaded: false,
    state: 'to_gate',
    body: [
      { x: 5.5, y: 4.5 },
      { x: 5.5, y: 5.5 },
    ],
    lengthCells: 3,
    ...over,
  };
}

function carrier(over: Partial<VehicleVM> = {}): VehicleVM {
  return {
    id: 2,
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

describe('kĺbové vozidlá po stope (VehicleView, TruckView)', () => {
  it('kamión so stopou: predok pri hlave, stred o bunku späť (sprite 2 bunky), pravý pruh, natočenie 0', () => {
    const view = new TruckView(truck(), deps(new StubTextures()));
    expect(view.view.x).toBeCloseTo((5.5 + LANE) * CELL, 9);
    expect(view.view.y).toBeCloseTo(4.5 * CELL, 9);
    expect(view.view.angle).toBe(0);
  });

  it('straddle carrier (sprite 1 bunka, dĺžka 2): stred je pol bunky za hlavou; východ jazdí v južnom pruhu', () => {
    const vm = carrier({ x: 8.5, y: 2.5, prevX: 8.5, prevY: 2.5, body: [{ x: 7.5, y: 2.5 }], lengthCells: 2 });
    const view = new VehicleView(vm, deps(new StubTextures()));
    expect(view.view.x).toBeCloseTo(8 * CELL, 9);
    expect(view.view.y).toBeCloseTo((2.5 + LANE) * CELL, 9);
    expect(view.view.angle).toBe(90);
  });

  it('zákruta: sprite sa láme podľa tetivy stopy (135° medzi východom a juhom), predok ostáva pri hlave', () => {
    const vm = truck({
      x: 5.5,
      y: 6.5,
      prevX: 5.5,
      prevY: 6.5,
      heading: 180,
      body: [
        { x: 5.5, y: 5.5 },
        { x: 4.5, y: 5.5 },
      ],
    });
    const view = new TruckView(vm, deps(new StubTextures()));
    expect(view.view.angle).toBeCloseTo(135, 9);
    // stred je o bunku späť od hlavy (5,5; 6,5) v smere natočenia, posunutý doprava od smeru 135° (juhozápad) o pruh
    const side = LANE * Math.SQRT1_2;
    expect(view.view.x).toBeCloseTo((5.5 - Math.SQRT1_2 - side) * CELL, 6);
    expect(view.view.y).toBeCloseTo((6.5 - Math.SQRT1_2 + side) * CELL, 6);
  });

  it('interpolácia: stred a natočenie sa menia spojito pri jazde cez roh (žiadny skok medzi vzorkami alpha)', () => {
    const vm = truck({
      x: 5.5,
      y: 6.0,
      prevX: 5.1,
      prevY: 5.5,
      prevHeading: 90,
      heading: 180,
      body: [
        { x: 5.5, y: 5.5 },
        { x: 4.5, y: 5.5 },
        { x: 3.5, y: 5.5 },
      ],
    });
    const view = new TruckView(vm, deps(new StubTextures()), 0);
    let previous = { x: view.view.x, y: view.view.y, angle: view.view.angle };
    for (let alpha = 0.05; alpha <= 1.0001; alpha += 0.05) {
      view.update(vm, alpha);
      const now = { x: view.view.x, y: view.view.y, angle: view.view.angle };
      expect(Math.hypot(now.x - previous.x, now.y - previous.y)).toBeLessThan(0.25 * CELL);
      expect(Math.abs(now.angle - previous.angle)).toBeLessThan(20);
      previous = now;
    }
  });

  it('bez `body` (staré VM) sa vozidlo správa ako doteraz: sprite vycentrovaný na x, y v pravom pruhu', () => {
    const view = new VehicleView(carrier({ heading: 90 }), deps(new StubTextures()));
    expect(view.view.x).toBeCloseTo(36.5 * CELL, 9);
    expect(view.view.y).toBeCloseTo((24.5 + LANE) * CELL, 9);
    expect(view.view.angle).toBe(90);
  });

  it('`offRoad` ignoruje stopu: vozidlo sa kreslí vycentrované ako doteraz', () => {
    const vm = truck({ offRoad: true, y: 3.5, heading: 180 });
    const view = new TruckView(vm, deps(new StubTextures()));
    expect(view.view.y).toBeCloseTo(3.5 * CELL, 9);
  });

  it('stopa sa dá meniť za behu: update s novým VM presunie sprite (hlava ide dopredu)', () => {
    const view = new TruckView(truck(), deps(new StubTextures()));
    view.update(truck({ y: 2.5, prevY: 3.5, body: [{ x: 5.5, y: 3.5 }, { x: 5.5, y: 4.5 }] }), 1);
    expect(view.view.y).toBeCloseTo(3.5 * CELL, 9);
  });
});

describe('brzdové svetlá', () => {
  it('stojaci kamión na ceste (`blocked`, nie `offRoad`): dva červené obdĺžniky 4 × 3 px pri zadnom okraji', () => {
    const view = new TruckView(truck({ blocked: true }), deps(new StubTextures()));
    expect(view.brakeLightsOn).toBe(true);
    const lights = view.brakeLightsView as Graphics;
    const bounds = lights.getLocalBounds();
    expect(bounds.height).toBeCloseTo(BRAKE_LIGHT_PX.h, 6);
    // dva obdĺžniky pri bočných okrajoch tela kamióna (28 px), každý 4 px široký
    expect(bounds.width).toBeCloseTo(28 - 2 * BRAKE_LIGHT_PX.inset, 6);
    expect(bounds.maxY).toBeCloseTo(116 / 2, 6); // zadný okraj obsahu kamióna (116 px)
    expect(lights.parent).toBe(view.view);
  });

  it('farba brzdových svetiel je z tokenu `--vehicle-brake`', () => {
    expect(ENTITY_PALETTE.vehicle.brake.color).toBe(0xe5484d);
    expect(ENTITY_PALETTE.jam.alpha).toBeGreaterThan(0);
    expect(ENTITY_PALETTE.jam.alpha).toBeLessThan(1);
  });

  it('nesvietia bez `blocked`, pri `offRoad` ani pri starom VM; vznikajú lenivo a zhasnú, keď vozidlo pôjde', () => {
    const plain = new TruckView(truck(), deps(new StubTextures()));
    expect(plain.brakeLightsView).toBeNull();
    const parkedAtDock = new TruckView(truck({ blocked: true, offRoad: true }), deps(new StubTextures()));
    expect(parkedAtDock.brakeLightsOn).toBe(false);
    const legacy = new VehicleView(carrier(), deps(new StubTextures()));
    expect(legacy.brakeLightsView).toBeNull();
    plain.update(truck({ blocked: true }), 1);
    expect(plain.brakeLightsOn).toBe(true);
    plain.update(truck({ blocked: false }), 1);
    expect(plain.brakeLightsOn).toBe(false);
    expect(plain.view.children[0]).toBeInstanceOf(Sprite); // sprite ostáva prvým dieťaťom
  });

  it('straddle carrier má svetlá pri zadku svojho tela (62 px)', () => {
    const view = new VehicleView(carrier({ blocked: true, body: [{ x: 35.5, y: 24.5 }], lengthCells: 2 }), deps(new StubTextures()));
    expect(view.brakeLightsOn).toBe(true);
    expect(view.brakeLightsView?.getLocalBounds().maxY).toBeCloseTo(62 / 2, 6);
  });
});

describe('zaparkované vozidlá', () => {
  it('EntityLayer nekreslí vozidlo v stave `parked`; po výjazde z depa (iný stav) sa nakreslí', () => {
    const layer = new EntityLayer(deps(new StubTextures()));
    layer.syncVehicles([carrier({ id: 1, state: 'parked' }), carrier({ id: 2, state: 'idle' })], 1);
    expect(layer.vehicleCount).toBe(1);
    expect(layer.vehicleView(1)).toBeUndefined();
    layer.syncVehicles([carrier({ id: 1, state: 'depot_exit' }), carrier({ id: 2, state: 'idle' })], 1);
    expect(layer.vehicleCount).toBe(2);
    layer.syncVehicles([carrier({ id: 1, state: 'parked' }), carrier({ id: 2, state: 'idle' })], 1);
    expect(layer.vehicleCount).toBe(1);
  });

  const base = moduleSprite('vehicle_depot')?.footprint ?? { w: 3, h: 3 };
  function depot(parked?: ModuleVM['parkedVehicles'], rotation: 0 | 90 | 180 | 270 = 0): ModuleVM {
    const size = rotateFootprint(base.w, base.h, rotation);
    return {
      id: 9,
      defId: 'vehicle_depot',
      kind: 'depot',
      x: 20,
      y: 10,
      rotation,
      w: size.w,
      h: size.h,
      connected: true,
      ...(parked === undefined ? {} : { parkedVehicles: parked }),
    };
  }

  it('kapacita depa je v manifeste (10 miest) a mriežka 10 miest je 5 × 2', () => {
    expect(parkingStalls('vehicle_depot')).toBe(10);
    expect(parkingStalls('truck_waiting_area')).toBeUndefined();
    expect(parkingStalls('berth_standard')).toBeUndefined();
    expect(parkingGrid(10)).toEqual({ rows: 2, columns: 5 });
    expect(parkingGrid(1)).toEqual({ rows: 1, columns: 1 });
    expect(parkingGrid(3)).toEqual({ rows: 2, columns: 2 });
  });

  it('stojiská: 10 miest na 3 × 3 bunkách sa zmestí do footprintu, po riadkoch zľava doprava a zhora nadol, bez prekrytia', () => {
    const size = base.w * CELL;
    const slots = parkingSlots(size, size, 10);
    expect(slots).toHaveLength(10);
    for (const slot of slots) {
      expect(slot.x - slot.width / 2).toBeGreaterThanOrEqual(-size / 2);
      expect(slot.x + slot.width / 2).toBeLessThanOrEqual(size / 2);
      expect(slot.y - slot.height / 2).toBeGreaterThanOrEqual(-size / 2);
      expect(slot.y + slot.height / 2).toBeLessThanOrEqual(size / 2);
    }
    for (let i = 1; i < 5; i++) expect(slots[i].x).toBeGreaterThan(slots[i - 1].x); // prvý rad zľava doprava
    expect(slots[0].y).toBe(slots[4].y);
    expect(slots[5].y).toBeGreaterThan(slots[0].y); //                               druhý rad pod prvým
    expect(slots[5].x).toBe(slots[0].x);
  });

  it('vozidlo sa zmenší do stojiska (nezväčšuje sa nad pôvodnú mierku)', () => {
    const slot = parkingSlots(base.w * CELL, base.h * CELL, 10)[0];
    const scale = parkedScale({ w: CELL, h: CELL }, slot);
    expect(scale).toBeLessThan(1);
    expect(scale * CELL).toBeLessThanOrEqual(PARKING_FILL * slot.width + 1e-9);
    expect(parkedScale({ w: 4, h: 4 }, slot)).toBe(1);
  });

  it('bez poľa `parkedVehicles` sa depo kreslí ako doteraz: ozdoba nevznikne', () => {
    const textures = new StubTextures();
    const view = new ModuleView(depot(), deps(textures));
    expect(view.decor('parked_vehicles')).toBeUndefined();
    expect(MODULE_DECORS.map((factory) => factory.id)).toContain('parked_vehicles');
  });

  it('5 zaparkovaných vozidiel: mriežka zmenšených spritov v poradí podľa id, vozidlá sú vnútri footprintu', () => {
    const textures = new StubTextures();
    const parked = [
      { id: 40, defId: 'straddle_carrier' },
      { id: 12, defId: 'truck_container' },
      { id: 33, defId: 'empty_handler' },
      { id: 7, defId: 'straddle_carrier' },
      { id: 21, defId: 'straddle_carrier' },
    ];
    const view = new ModuleView(depot(parked), deps(textures));
    const decor = view.decor<ParkedVehiclesDecor>('parked_vehicles');
    expect(decor).toBeDefined();
    expect(decor?.count).toBe(5);
    const order = sortedParked(parked).map((vehicle) => vehicle.id);
    expect(order).toEqual([7, 12, 21, 33, 40]);
    const xs = order.map((id) => decor?.vehicle(id)?.x ?? Number.NaN);
    const ys = order.map((id) => decor?.vehicle(id)?.y ?? Number.NaN);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]); // prvých 5 miest je jeden rad zľava doprava
    expect(new Set(ys).size).toBe(1);
    const half = (base.w * CELL) / 2;
    for (const id of order) {
      const container = decor?.vehicle(id) as Container;
      const bounds = container.getBounds();
      expect(Math.abs(container.x)).toBeLessThan(half);
      expect(Math.abs(container.y)).toBeLessThan(half);
      expect(container.scale.x).toBeLessThan(1);
      expect(bounds.width).toBeGreaterThan(0);
    }
    // sprity z manifestu (stav `empty`), nie `Graphics`
    expect(decor?.vehicle(7)?.children[0]).toBeInstanceOf(Sprite);
    expect((decor?.vehicle(7)?.children[0] as Sprite).texture).toBe(textures.textureFor('file/entities/straddle_carrier_empty.svg'));
    expect((decor?.vehicle(12)?.children[0] as Sprite).texture).toBe(textures.textureFor('file/entities/truck_container_empty.svg'));
  });

  it('zmena zoznamu prekreslí ozdobu; nezmenený zoznam nič nealokuje; bez textúr sa použije `Graphics` z tokenov', () => {
    const view = new ModuleView(depot([{ id: 1, defId: 'straddle_carrier' }], 90), deps(null));
    const decor = view.decor<ParkedVehiclesDecor>('parked_vehicles') as ParkedVehiclesDecor;
    const first = decor.vehicle(1);
    expect(first?.children[0]).toBeInstanceOf(Graphics);
    view.update(depot([{ id: 1, defId: 'straddle_carrier' }], 90));
    expect(decor.vehicle(1)).toBe(first); // ten istý objekt
    view.update(depot([{ id: 1, defId: 'straddle_carrier' }, { id: 2, defId: 'straddle_carrier' }], 90));
    expect(decor.count).toBe(2);
    view.update(depot([], 90));
    expect(decor.count).toBe(0);
    view.update(depot(undefined, 90)); // pole chýba → ozdoba ostane, ale prázdna
    expect(decor.count).toBe(0);
  });
});

describe('zvýraznenie zápchy', () => {
  function jam(textures: StubTextures | null = new StubTextures()): TrafficJamLayer {
    return new TrafficJamLayer(deps(textures));
  }

  it('bez nosiča v zápche nič nekreslí', () => {
    const layer = jam();
    layer.sync([carrier({ blocked: true })], [truck({ blocked: true })], 1);
    expect(layer.cellCount).toBe(0);
    expect(layer.badgeCount).toBe(0);
  });

  it('nosič s `jammed`: červené bunky pod hlavou a stopou (každá raz) a odznak nad hlavou', () => {
    const layer = jam();
    layer.sync([], [truck({ jammed: true })], 1);
    expect(layer.cellCount).toBe(3); // hlava (5; 3) a stopa (5; 4), (5; 5)
    expect(layer.badgeCount).toBe(1);
    const badge = layer.badge('t1') as Container;
    expect(badge.x).toBeCloseTo(5.5 * CELL, 9);
    expect(badge.y).toBeCloseTo(3 * CELL, 9); // nad hlavou: horný okraj bunky hlavy
    expect(badge.parent).toBe(layer.badges);
    expect(layer.cells.children[0]).toBeInstanceOf(Graphics);
    const bounds = (layer.cells.children[0] as Graphics).getLocalBounds();
    expect(bounds.x).toBeCloseTo(5 * CELL, 9);
    expect(bounds.y).toBeCloseTo(3 * CELL, 9);
    expect(bounds.width).toBeCloseTo(CELL, 9);
    expect(bounds.height).toBeCloseTo(3 * CELL, 9);
  });

  it('prekrývajúce sa stopy dvoch nosičov sa spoja; vozidlo aj kamión majú vlastný odznak', () => {
    const layer = jam();
    layer.sync(
      [carrier({ id: 5, jammed: true, x: 5.5, y: 6.5, prevX: 5.5, prevY: 6.5, body: [{ x: 5.5, y: 7.5 }] })],
      [truck({ jammed: true })],
      1,
    );
    expect(layer.cellCount).toBe(5); // x = 5, y 3–7
    expect(layer.badgeCount).toBe(2);
    expect(layer.badge('v5')).toBeDefined();
  });

  it('keď zápcha skončí, bunky aj odznak zmiznú; zoom mení veľkosť odznaku', () => {
    const layer = jam();
    layer.sync([], [truck({ jammed: true })], 1);
    layer.setZoom(0.5);
    expect(layer.badge('t1')?.scale.x).toBeCloseTo(2, 9);
    layer.sync([], [truck({ jammed: false })], 1);
    expect(layer.cellCount).toBe(0);
    expect(layer.badgeCount).toBe(0);
  });

  it('bez textúr sa odznak nakreslí z tokenov (Graphics)', () => {
    const layer = jam(null);
    layer.sync([], [truck({ jammed: true })], 1);
    expect(layer.badge('t1')?.children[0]).toBeInstanceOf(Graphics);
  });
});
