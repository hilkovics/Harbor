// F6c (T6C-04): empty handler (def `empty_handler`; od R2 sprite `ech` 1×2 so spreaderom) a vozidlá / kamióny s prázdnym kontajnerom
// (stav sprite `carries_empty`, sivý kontajner); bez sivého variantu v manifeste sa kreslí `loaded`.
import { describe, expect, it } from 'vitest';
import { entitySpriteFiles, vehicleSprite } from '@render/entity-assets';
import { EntityLayer } from '@render/entity-layer';
import { TruckView, truckSpriteFile } from '@render/truck-view';
import { VehicleView, vehicleLoad, vehicleSpriteFile } from '@render/vehicle-view';
import type { TruckVM, VehicleVM } from '@render/view-models';
import { ENTITY_PALETTE, PALETTE, StubTextures } from './stub-textures';

const CELL = PALETTE.cellPx;

function deps(textures: StubTextures | null) {
  return { cellPx: CELL, palette: ENTITY_PALETTE, textures, now: () => 0 };
}

function vehicle(over: Partial<VehicleVM> = {}): VehicleVM {
  return { id: 1, defId: 'straddle_carrier', x: 36.5, y: 24.5, prevX: 36.5, prevY: 24.5, heading: 90, loaded: false, state: 'to_pickup', ...over };
}

function truck(over: Partial<TruckVM> = {}): TruckVM {
  return { id: 2, defId: 'truck_container', x: 40.5, y: 25.5, prevX: 40.5, prevY: 25.5, heading: 90, loaded: false, state: 'to_gate_out', ...over };
}

const file = (name: string): string => `file/entities/${name}.svg`;

describe('manifest: stav `carries_empty`', () => {
  it('straddle_carrier a truck_container nemajú sprite `carries_empty` (sivý kontajner kreslí hra), empty_handler je vozidlo 1×2 (R2: sprite `ech`) s jedným súborom', () => {
    expect(vehicleSprite('straddle_carrier')?.states.carries_empty).toBeUndefined();
    expect(vehicleSprite('truck_container')).toBeUndefined();
    const handler = vehicleSprite('empty_handler');
    expect(handler?.footprint).toEqual({ w: 1, h: 2 });
    expect(handler?.states).toEqual({ empty: 'entities/ech.svg', loaded: 'entities/ech.svg' });
  });

  it('atlas načíta empty_handler aj sivé varianty (a súbor sa neopakuje)', () => {
    const files = entitySpriteFiles();
    for (const expected of [
      'entities/ech.svg',
      'entities/ech_spreader_20.svg',
      'entities/ech_spreader_40.svg',
      'modules/empty_depot_fill00.svg',
      'modules/empty_depot_fill100.svg',
    ]) {
      expect(files, expected).toContain(expected);
    }
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('vehicleLoad / vehicleSpriteFile s prázdnym kontajnerom', () => {
  it('vehicleLoad: prázdny kontajner sa ráta len pri naloženom vozidle', () => {
    expect(vehicleLoad(false)).toBe('empty');
    expect(vehicleLoad(true)).toBe('loaded');
    expect(vehicleLoad(true, true)).toBe('carries_empty');
    expect(vehicleLoad(false, true)).toBe('empty');
  });

  it('vehicleSpriteFile: sivý variant, ak ho def má; inak `loaded`; nezmenené správanie bez príznaku', () => {
    expect(vehicleSpriteFile('straddle_carrier', true, true)).toBe('entities/straddle_carrier.svg'); // jeden sprite, kontajner kreslí hra
    expect(vehicleSpriteFile('straddle_carrier', true)).toBe('entities/straddle_carrier.svg');
    expect(vehicleSpriteFile('straddle_carrier', false, true)).toBe('entities/straddle_carrier.svg');
    expect(vehicleSpriteFile('empty_handler', true, true)).toBe('entities/ech.svg'); // ECH má jeden sprite (rám), kontajner skladá hra pod spreaderom
    expect(vehicleSpriteFile('hovercraft', true, true)).toBeUndefined();
    expect(truckSpriteFile('truck_container', true, true)).toBeUndefined(); // kamión je z častí (kabína + náves), nie jeden sprite
  });
});

describe('VehicleView: vozidlo s prázdnym kontajnerom', () => {
  it('textúra podľa stavu: prázdne vozidlo, plný kontajner, prázdny kontajner', () => {
    const textures = new StubTextures();
    const view = new VehicleView(vehicle(), deps(textures));
    expect(view.loadState).toBe('empty');
    expect(view.cargoState).toBe('none');
    expect(view.texture).toBe(textures.textureFor(file('straddle_carrier')));
    view.update(vehicle({ loaded: true }), 1);
    expect(view.loadState).toBe('loaded');
    expect(view.cargoState).toBe('full');
    expect(view.texture).toBe(textures.textureFor(file('straddle_carrier')));
    view.update(vehicle({ loaded: true, carriesEmpty: true }), 1);
    expect(view.loadState).toBe('carries_empty');
    expect(view.cargoState).toBe('empty'); // sivý prázdny kontajner pod rámom
    view.update(vehicle({ loaded: false, carriesEmpty: true }), 1); // vyložené: príznak sa ignoruje
    expect(view.loadState).toBe('empty');
    expect(view.cargoState).toBe('none');
  });

  it('nový view vznikne rovno so sivým kontajnerom', () => {
    const textures = new StubTextures();
    const view = new VehicleView(vehicle({ loaded: true, carriesEmpty: true }), deps(textures));
    expect(view.cargoState).toBe('empty');
  });

  it('empty handler: jeden sprite `ech` pre všetky stavy, sivý prázdny kontajner visí pod spreaderom (hra)', () => {
    const textures = new StubTextures();
    const view = new VehicleView(vehicle({ defId: 'empty_handler' }), deps(textures));
    expect(view.texture).toBe(textures.textureFor(file('ech')));
    expect(view.cargoState).toBe('none');
    view.update(vehicle({ defId: 'empty_handler', loaded: true, carriesEmpty: true }), 1);
    expect(view.loadState).toBe('carries_empty');
    expect(view.texture).toBe(textures.textureFor(file('ech'))); // rám sa nemení
    expect(view.cargoState).toBe('empty'); // sivý kontajner TEU pod spreaderom
    view.update(vehicle({ defId: 'empty_handler', loaded: true }), 1);
    expect(view.texture).toBe(textures.textureFor(file('ech')));
  });

  it('vozidlo bez textúr (fallback `Graphics`) s prázdnym kontajnerom nepadne', () => {
    const view = new VehicleView(vehicle({ loaded: true, carriesEmpty: true }), deps(null));
    expect(view.texture).toBeNull();
    expect(view.loadState).toBe('carries_empty');
  });

  it('EntityLayer prenesie `carriesEmpty` vozidlám aj kamiónom', () => {
    const textures = new StubTextures();
    const layer = new EntityLayer(deps(textures));
    layer.syncVehicles([vehicle({ loaded: true, carriesEmpty: true }), vehicle({ id: 3, defId: 'empty_handler', loaded: true, carriesEmpty: true })], 1);
    layer.syncTrucks([truck({ loaded: true, carriesEmpty: true })], 1);
    expect(layer.vehicleView(1)?.loadState).toBe('carries_empty');
    expect(layer.vehicleView(3)?.texture).toBe(textures.textureFor(file('ech')));
    expect(layer.truckView(2)?.loadState).toBe('carries_empty');
  });
});

describe('TruckView: kamión s prázdnym kontajnerom', () => {
  it('návrat prázdneho: naložený sivým kontajnerom; po vyložení prázdny; výdaj exportérovi: z prázdneho na sivý', () => {
    const textures = new StubTextures();
    const view = new TruckView(truck({ loaded: true, carriesEmpty: true }), deps(textures));
    expect(view.cargoState).toBe('empty');
    view.update(truck({ loaded: false, carriesEmpty: true, state: 'to_gate_out' }), 1);
    expect(view.cargoState).toBe('none');
    view.update(truck({ loaded: true, carriesEmpty: true }), 1);
    expect(view.cargoState).toBe('empty');
    view.update(truck({ loaded: true }), 1); // plný kontajner
    expect(view.cargoState).toBe('full');
  });
});
