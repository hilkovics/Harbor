// R2 (TR2-03): kontajner na vozidle, kamióne a ECH podľa `cargo` z VM (veľkosť, typ, linka); bez `cargo` ostáva kontajner TEU.
import { Container, Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { MANIFEST_CELL_PX, articulatedSprite, manifestScale, vehicleSpreader } from '@render/entity-assets';
import { TruckView } from '@render/truck-view';
import { VEHICLE_STYLE, VehicleView, type PoseDirector } from '@render/vehicle-view';
import type { ContainerVM, TruckVM, VehicleVM } from '@render/view-models';
import { VEHICLE_SCALE } from '@render/world-scale';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;
const UNIT = manifestScale(CELL) * VEHICLE_SCALE;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures, now: () => 0 };
}

function box(over: Partial<ContainerVM> = {}): ContainerVM {
  return { sizeFt: 20, containerType: 'dry', lineId: 'blue_anchor', direction: 'import', ...over };
}

function vehicle(over: Partial<VehicleVM> = {}): VehicleVM {
  return { id: 1, defId: 'straddle_carrier', x: 36.5, y: 24.5, prevX: 36.5, prevY: 24.5, heading: 90, loaded: false, state: 'to_pickup', ...over };
}

function truck(over: Partial<TruckVM> = {}): TruckVM {
  return { id: 2, defId: 'truck_container', x: 40.5, y: 25.5, prevX: 40.5, prevY: 25.5, heading: 90, loaded: false, state: 'to_gate_out', ...over };
}

/** Index dieťaťa `child` v `parent` (−1 = nie je priamym dieťaťom). */
const indexOf = (parent: Container, child: Container): number => parent.children.indexOf(child);

describe('straddle carrier: kontajner podľa cargo', () => {
  it('40′ dry s linkou: sprite 40′ tónovaný farbou linky pod rámom (pred spritom vozidla), v strede, dlhšou stranou v smere jazdy', () => {
    const textures = new StubTextures();
    const view = new VehicleView(vehicle({ loaded: true, cargo: box({ sizeFt: 40, lineId: 'golden_wave' }) }), deps(textures));
    expect(view.cargoContainer).toMatchObject({ sizeFt: 40, lineId: 'golden_wave' });
    const cargo = view.cargoSprite!;
    expect(cargo.textureFile).toBe('cargo/container_40_dry.svg');
    expect(cargo.tintColor).toBe(ENTITY_PALETTE.line['line-teal'].color);
    expect(cargo.angle).toBe(90);
    expect(cargo.position.x).toBe(0);
    expect(cargo.position.y).toBe(0);
    const frame = view.view.children.find((child) => child instanceof Sprite && child.texture === textures.textureFor('file/entities/straddle_carrier.svg'))!;
    expect(indexOf(view.view, cargo)).toBeLessThan(indexOf(view.view, frame));
    expect(view.cargoState).toBe('none'); // kontajner TEU (starý) sa nekreslí
    expect(view.spreaderSizeFt).toBeNull();
  });

  it('prázdny kontajner je sivý (sprite _empty bez tónu); zmena štítkov vytvorí sprite nanovo, rovnaké štítky nie', () => {
    const view = new VehicleView(vehicle({ loaded: true, cargo: box({ direction: 'empty' }) }), deps(new StubTextures()));
    expect(view.cargoSprite!.textureFile).toBe('cargo/container_20_empty.svg');
    expect(view.cargoSprite!.tintColor).toBeNull();
    const first = view.cargoSprite;
    view.update(vehicle({ loaded: true, cargo: box({ direction: 'empty' }) }), 1);
    expect(view.cargoSprite).toBe(first);
    view.update(vehicle({ loaded: true, cargo: box({ sizeFt: 40 }) }), 1);
    expect(view.cargoSprite).not.toBe(first);
    expect(view.cargoSprite!.textureFile).toBe('cargo/container_40_dry.svg');
    expect(view.view.children.filter((child) => child.label.startsWith('cargo-'))).toHaveLength(3); // dva staré (skryté) a jeden nový
  });

  it('po vyložení (loaded false, cargo null) kontajner zmizne; bez cargo sa kreslí kontajner TEU podľa loaded / carriesEmpty ako doteraz', () => {
    const textures = new StubTextures();
    const view = new VehicleView(vehicle({ loaded: true, cargo: box() }), deps(textures));
    view.update(vehicle({ loaded: false, cargo: null }), 1);
    expect(view.cargoSprite).toBeNull();
    expect(view.cargoContainer).toBeNull();
    const legacy = new VehicleView(vehicle({ loaded: true }), deps(textures));
    expect(legacy.cargoState).toBe('full');
    expect(legacy.cargoSprite).toBeNull();
    // carriesEmpty sa pri `cargo` ignoruje: sivý je len prázdny kontajner podľa štítkov
    const typed = new VehicleView(vehicle({ loaded: true, carriesEmpty: true, cargo: box() }), deps(textures));
    expect(typed.cargoState).toBe('none');
    expect(typed.cargoSprite!.textureFile).toBe('cargo/container_20_dry.svg');
  });

  it('vozidlo bez textúr (fallback) s cargo nepadne a nič nekreslí', () => {
    const view = new VehicleView(vehicle({ loaded: true, cargo: box() }), deps(null));
    expect(view.cargoSprite).toBeNull();
  });
});

describe('kamión: kontajner na návese', () => {
  const trailer = articulatedSprite('truck_container')!.trailer;
  const trailerLength = trailer.footprint.h * MANIFEST_CELL_PX;

  it('20′ leží na návese vpredu (predná hrana pri čape), 40′ je na strede návesu; dlhšou stranou v smere jazdy', () => {
    const textures = new StubTextures();
    const t20 = new TruckView(truck({ loaded: true, cargo: box() }), deps(textures));
    const t40 = new TruckView(truck({ loaded: true, cargo: box({ sizeFt: 40 }) }), deps(textures));
    const c20 = t20.cargoSprite!;
    const c40 = t40.cargoSprite!;
    expect(c20.parent).toBe(t20.trailerView);
    expect(c40.parent).toBe(t40.trailerView);
    expect(c20.angle).toBe(90);
    expect(c20.position.x).toBe(0);
    expect(c20.position.y).toBeCloseTo((64 / 2) * UNIT, 6); // predná hrana v čape: stred o polovicu dĺžky 20′ za ním
    expect(c40.position.y).toBeCloseTo((trailerLength / 2 - trailer.pivot.y) * UNIT, 6); // stred návesu
    expect(c20.position.y).toBeLessThan(c40.position.y);
    expect(c20.textureFile).toBe('cargo/container_20_dry.svg');
    expect(c40.textureFile).toBe('cargo/container_40_dry.svg');
  });

  it('prázdny 40′ je sivý; kamión bez cargo kreslí kontajner TEU podľa loaded / carriesEmpty', () => {
    const textures = new StubTextures();
    const view = new TruckView(truck({ loaded: true, cargo: box({ sizeFt: 40, direction: 'empty' }) }), deps(textures));
    expect(view.cargoSprite!.textureFile).toBe('cargo/container_40_empty.svg');
    expect(view.cargoState).toBe('none');
    const legacy = new TruckView(truck({ loaded: true, carriesEmpty: true }), deps(textures));
    expect(legacy.cargoState).toBe('empty');
    expect(legacy.cargoSprite).toBeNull();
  });

  it('naložený kamión sa vyloží: cargo null a loaded false kontajner skryje', () => {
    const view = new TruckView(truck({ loaded: true, cargo: box() }), deps(new StubTextures()));
    view.update(truck({ loaded: false, cargo: null }), 1);
    expect(view.cargoSprite).toBeNull();
  });
});

describe('zobrazené naloženie (režisér): kontajner ostáva z príchodu', () => {
  /** Režisér, ktorý drží zobrazené naloženie, kým `held` je `true` (ako manéver kamióna pri rampe). */
  function director(held: { value: boolean }): PoseDirector {
    return { pose: (vm, alpha, poseOf) => poseOf(vm, alpha), displayLoaded: (vm) => held.value || vm.loaded };
  }

  it('po vyložení (cargo null) ostáva posledný kontajner, kým zobrazené naloženie neskončí; nový kamión nič nezdedí', () => {
    const held = { value: false };
    const view = new VehicleView(vehicle({ loaded: true, cargo: box({ sizeFt: 40 }) }), deps(new StubTextures()), 1, VEHICLE_STYLE, director(held));
    expect(view.cargoSprite!.textureFile).toBe('cargo/container_40_dry.svg');
    held.value = true;
    view.update(vehicle({ loaded: false, cargo: null }), 1);
    expect(view.cargoSprite!.textureFile).toBe('cargo/container_40_dry.svg'); // vyložené v sime, manéver ešte trvá
    held.value = false;
    view.update(vehicle({ loaded: false, cargo: null }), 1);
    expect(view.cargoSprite).toBeNull();
    const fresh = new VehicleView(vehicle({ loaded: true, cargo: null }), deps(new StubTextures()), 1, VEHICLE_STYLE, director({ value: true }));
    expect(fresh.cargoSprite).toBeNull(); // nikdy nevidel kontajner
  });
});

describe('ECH: kontajner visí pod spreaderom pred vozidlom', () => {
  const mount = vehicleSpreader('empty_handler')!;
  const offsetX = (mount.mount.x - MANIFEST_CELL_PX / 2) * UNIT;
  const offsetY = (mount.mount.y - (2 * MANIFEST_CELL_PX) / 2) * UNIT;

  function ech(over: Partial<VehicleVM> = {}): VehicleVM {
    return vehicle({ defId: 'empty_handler', ...over });
  }

  it('kontajner je v bode spreaderMount, naprieč smeru jazdy (uhol 0), nad rámom a pod spreaderom', () => {
    const textures = new StubTextures();
    const view = new ECHView(ech({ loaded: true, cargo: box({ direction: 'empty' }) }), textures);
    const cargo = view.cargoSprite!;
    expect(cargo.textureFile).toBe('cargo/container_20_empty.svg');
    expect(cargo.angle).toBe(0);
    const layer = cargo.parent!.parent!;
    expect(layer.position.x).toBeCloseTo(offsetX, 6);
    expect(layer.position.y).toBeCloseTo(offsetY, 6);
    expect(offsetY).toBeLessThan(0); // pred vozidlom (predok hore)
    const frame = view.view.children.find((child) => child instanceof Sprite && child.texture === textures.textureFor('file/entities/ech.svg'))!;
    expect(indexOf(view.view, layer)).toBeGreaterThan(indexOf(view.view, frame));
    const spreaders = layer.children.filter((child): child is Sprite => child instanceof Sprite);
    expect(spreaders).toHaveLength(2);
    expect(indexOf(layer, cargo.parent!)).toBe(0); // spreadery sú nad kontajnerom
  });

  it('spreader zodpovedá veľkosti kontajnera: bez kontajnera 20′, 20′ → 20′, 40′ → 40′ (viditeľný je jeden)', () => {
    const textures = new StubTextures();
    const view = new ECHView(ech(), textures);
    expect(view.spreaderSizeFt).toBe(20);
    view.update(ech({ loaded: true, cargo: box({ sizeFt: 40, direction: 'empty' }) }), 1);
    expect(view.spreaderSizeFt).toBe(40);
    expect(view.cargoSprite!.textureFile).toBe('cargo/container_40_empty.svg');
    view.update(ech({ loaded: true, cargo: box({ direction: 'empty' }) }), 1);
    expect(view.spreaderSizeFt).toBe(20);
    view.update(ech({ loaded: false, cargo: null }), 1);
    expect(view.cargoSprite).toBeNull();
    expect(view.spreaderSizeFt).toBe(20);
  });

  it('bez cargo vo VM ostáva starý kontajner TEU (sivý pri carriesEmpty) pod spreaderom', () => {
    const view = new ECHView(ech({ loaded: true, carriesEmpty: true }), new StubTextures());
    expect(view.cargoState).toBe('empty');
    expect(view.cargoSprite).toBeNull();
    expect(view.spreaderSizeFt).toBe(20);
  });

  it('bez textúr spreaderov sa kontajner aj tak kreslí a spreaderSizeFt je null', () => {
    const view = new VehicleView(ech({ loaded: true, cargo: box() }), deps(null));
    expect(view.spreaderSizeFt).toBeNull();
  });
});

/** ECH s textúrami (skratka pre testy). */
class ECHView extends VehicleView {
  constructor(vm: VehicleVM, textures: StubTextures) {
    super(vm, deps(textures));
  }
}
