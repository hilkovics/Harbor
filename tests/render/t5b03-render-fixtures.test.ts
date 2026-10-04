// Konzistencia scén demo T5B-03 (`src/render/__demo__/t5b03-render.fixtures.ts`): moduly sa neprekrývajú, cesty sú pri
// konektoroch, vozidlá a kamióny stoja na cestách a cesty sa na konektory napájajú (č. 3).
import { describe, expect, it } from 'vitest';
import { Grid, loadBundledMap } from '@sim/grid';
import { autotileMask } from '@render/autotile';
import { ConnectorArmIndex, connectorArm, worldConnectors } from '@render/module-connectors';
import { dockCenter, dockHeading } from '@render/module-slots';
import { RAMP_A } from '@render/__demo__/f4-render.fixtures';
import {
  DOCK_SCENE,
  T5B03_SCENES,
  carrierAt,
  createT5b03Grid,
  dockTruckArriving,
  dockTruckLeaving,
  dockTruckLoading,
  yardScene,
  yardVM,
  type T5b03Scene,
} from '@render/__demo__/t5b03-render.fixtures';
import { RoadLayer } from '@render/road-layer';
import type { ModuleVM } from '@render/view-models';
import { PALETTE } from './stub-textures';

const map = loadBundledMap();

function footprint(module: ModuleVM): string[] {
  const cells: string[] = [];
  for (let y = module.y; y < module.y + module.h; y++) for (let x = module.x; x < module.x + module.w; x++) cells.push(`${String(x)},${String(y)}`);
  return cells;
}

describe.each(Object.entries(T5B03_SCENES))('scéna %s', (_name, scene: T5b03Scene) => {
  const grid = createT5b03Grid(map, scene);

  it('moduly sa neprekrývajú a ležia na pevnine; cesty nevedú cez moduly', () => {
    const used = new Set<string>();
    for (const module of scene.vm.modules) {
      for (const cell of footprint(module)) {
        expect(used.has(cell), `bunka ${cell} je v dvoch moduloch`).toBe(false);
        used.add(cell);
      }
    }
    for (const road of scene.roads) expect(used.has(`${String(road.x)},${String(road.y)}`), `cesta (${String(road.x)}; ${String(road.y)}) v module`).toBe(false);
  });

  it('každý modul s cestným konektorom má pri ňom cestu (vonkajšia bunka) — tá sa na konektor napája ramenom', () => {
    const index = new ConnectorArmIndex(grid);
    index.update(scene.vm.modules);
    for (const module of scene.vm.modules) {
      const arms = worldConnectors(module).filter((connector) => connector.type === 'road').map(connectorArm);
      if (arms.length === 0) continue;
      const connected = arms.filter((arm) => grid.inBounds(arm.x, arm.y) && grid.at(arm.x, arm.y).road === 'road');
      if (module.connected === false) continue; // zámerne odpojený modul
      expect(connected.length, `modul ${String(module.id)} (${module.defId}) nemá cestu pri konektore`).toBeGreaterThan(0);
      for (const arm of connected) {
        // cesta pred konektorom nekončí zaobleným koncom k modulu: maska obsahuje smer k modulu
        expect(autotileMask(grid, arm.x, arm.y, 'road', index.maskAt(arm.x, arm.y)) & arm.bit).toBe(arm.bit);
      }
    }
  });

  it('vozidlá a kamióny mimo stojísk a dokov stoja na cestných bunkách', () => {
    const slotStates = ['waiting', 'loading'];
    for (const vehicle of scene.vm.vehicles ?? []) {
      expect(grid.at(Math.floor(vehicle.x), Math.floor(vehicle.y)).road, `vozidlo ${String(vehicle.id)}`).toBe('road');
    }
    for (const truck of scene.vm.trucks ?? []) {
      if (slotStates.includes(truck.state)) continue;
      expect(grid.at(Math.floor(truck.x), Math.floor(truck.y)).road, `kamión ${String(truck.id)}`).toBe('road');
    }
  });
});

describe('scéna scale: napojenie a mierka', () => {
  const scene = T5B03_SCENES.scale;

  it('obsahuje prázdny aj naložený carrier a kamión vedľa seba, kontajnery na aprone, dvor, rampu a obe lode', () => {
    const vehicles = scene.vm.vehicles ?? [];
    expect(vehicles.some((vehicle) => vehicle.loaded)).toBe(true);
    expect(vehicles.some((vehicle) => !vehicle.loaded)).toBe(true);
    const trucks = scene.vm.trucks ?? [];
    expect(trucks.some((truck) => truck.loaded)).toBe(true);
    expect(trucks.some((truck) => !truck.loaded)).toBe(true);
    expect(scene.vm.modules.some((module) => (module.apron?.units.length ?? 0) > 0)).toBe(true);
    expect(scene.vm.modules.map((module) => module.defId)).toEqual(expect.arrayContaining(['berth_standard', 'container_yard_small', 'loading_ramp_container']));
    expect(scene.vm.ships.map((ship) => ship.classId).sort()).toEqual(['feeder', 'handy']);
  });

  it('cesty sú pri všetkých troch moduloch napojené: RoadLayer nekreslí zaoblený koniec pred konektorom', () => {
    const grid = createT5b03Grid(map, scene);
    const index = new ConnectorArmIndex(grid);
    const layer = new RoadLayer(grid, PALETTE, null, index.maskAt);
    const before = new Map<string, string>();
    for (const module of scene.vm.modules) {
      for (const connector of worldConnectors(module).map(connectorArm)) {
        if (grid.inBounds(connector.x, connector.y) && grid.at(connector.x, connector.y).road === 'road') {
          before.set(`${String(connector.x)},${String(connector.y)}`, JSON.stringify(layer.tileAt(connector.x, connector.y)));
        }
      }
    }
    expect(before.size).toBeGreaterThan(0);
    layer.updateRoads(index.update(scene.vm.modules));
    let changed = 0;
    for (const [key, tile] of before) {
      const [x, y] = key.split(',').map(Number);
      if (JSON.stringify(layer.tileAt(x, y)) !== tile) changed += 1;
    }
    expect(changed).toBe(before.size); // každá bunka pred konektorom dostala rameno k modulu
  });
});

describe('scéna dock a pomocné VM', () => {
  it('dva kamióny pri rampe A stoja na vonkajších bunkách konektorov (31; 25) a (32; 25) a sú to cestné bunky', () => {
    const grid: Grid = createT5b03Grid(map, DOCK_SCENE);
    for (const truck of DOCK_SCENE.vm.trucks ?? []) {
      expect(truck.state).toBe('to_dock');
      expect(grid.at(Math.floor(truck.x), Math.floor(truck.y)).road).toBe('road');
    }
  });

  it('`dockTruckLoading`: póza v doku (stred docku, kabína von z rampy) a `approach` na vonkajšej bunke s kurzom príjazdu', () => {
    const side = dockTruckLoading(1, 31, 25, 270, 0);
    const center = dockCenter(RAMP_A, 0);
    expect([side.x, side.y, side.heading, side.state, side.prevState]).toEqual([center.x, center.y, 180, 'loading', 'to_dock']);
    expect(side.approach).toEqual({ x: 31.5, y: 25.5, heading: 270 });
    // kurz v doku je kabína von: opak smeru od vonkajšej bunky ku dokom
    expect(dockHeading({ x: 31.5, y: 25.5 }, center)).toBe(180);
    const arriving = dockTruckArriving(2, 32, 25, 0);
    expect([arriving.x, arriving.y, arriving.state]).toEqual([32.5, 25.5, 'to_dock']);
    const leaving = dockTruckLeaving(3, 31.5, 25.5, 90);
    expect([leaving.state, leaving.prevState, leaving.loaded]).toEqual(['to_gate_out', 'loading', true]);
  });

  it('`yardScene`: dvor s operáciou a carrier pri konektore; `carrierAt` je v strede bunky', () => {
    const scene = yardScene({ slot: 13, tick: 5, kind: 'put' });
    expect(scene.vm.modules[0].lastStorageOp).toEqual({ slot: 13, tick: 5, kind: 'put' });
    expect(yardVM(1, 0, 0, 5).lastStorageOp).toBeUndefined();
    expect(carrierAt(1, 3, 4, 90, true)).toMatchObject({ x: 3.5, y: 4.5, prevX: 3.5, heading: 90, loaded: true });
    const grid = createT5b03Grid(map, scene);
    expect(grid.at(45, 23).road).toBe('road');
  });
});
