// Konzistencia scén demo TR1-06 (`src/render/__demo__/r1-traffic.fixtures.ts`): stopy nosičov sú súvislé a ležia na cestách,
// nosiče na ceste nezdieľajú bunky, moduly sa neprekrývajú a nestoja na cestách, zaparkované vozidlá majú VM v stave `parked`.
import { describe, expect, it } from 'vitest';
import { loadBundledMap } from '@sim/grid';
import { R1_SCENES, createR1Grid, type R1Scene } from '@render/__demo__/r1-traffic.fixtures';
import { parkingStalls } from '@render/entity-assets';
import type { ModuleVM, TruckVM, VehicleVM } from '@render/view-models';

const map = loadBundledMap();

type Carrier = VehicleVM | TruckVM;

const key = (x: number, y: number): string => `${String(Math.floor(x))},${String(Math.floor(y))}`;

function carriers(scene: R1Scene): Carrier[] {
  return [...(scene.vm.vehicles ?? []), ...(scene.vm.trucks ?? [])];
}

function onRoad(scene: R1Scene): Carrier[] {
  return carriers(scene).filter((carrier) => carrier.offRoad !== true);
}

function footprint(module: ModuleVM): string[] {
  const cells: string[] = [];
  for (let y = module.y; y < module.y + module.h; y++) for (let x = module.x; x < module.x + module.w; x++) cells.push(key(x, y));
  return cells;
}

describe.each(Object.entries(R1_SCENES))('scéna %s', (_name, scene: R1Scene) => {
  const grid = createR1Grid(map, scene);
  const roads = new Set(scene.roads.map((cell) => key(cell.x, cell.y)));

  it('moduly sa neprekrývajú a nestoja na cestách', () => {
    const used = new Set<string>();
    for (const module of scene.vm.modules) {
      for (const cell of footprint(module)) {
        expect(used.has(cell), `bunka ${cell} je v dvoch moduloch`).toBe(false);
        expect(roads.has(cell) && module.kind !== 'berth', `bunka ${cell}: cesta pod modulom`).toBe(false);
        used.add(cell);
      }
    }
  });

  it('mriežka má iba cesty scény (štartová cesta mapy je odstránená)', () => {
    let count = 0;
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) if (grid.at(x, y).road === 'road') count++;
    expect(count).toBe(roads.size);
  });

  it('cesty ležia na pevnine alebo nábreží', () => {
    for (const cell of scene.roads) expect(['land', 'quay'], `cesta (${String(cell.x)}; ${String(cell.y)})`).toContain(grid.at(cell.x, cell.y).terrain);
  });

  it('hlava a stopa každého nosiča na ceste ležia na cestách, stopa je súvislá a dlhá najviac lengthCells − 1', () => {
    for (const carrier of onRoad(scene)) {
      const label = `nosič ${String(carrier.id)}`;
      const body = carrier.body ?? [];
      expect(body.length, label).toBeLessThanOrEqual((carrier.lengthCells ?? 1) - 1);
      const line = [{ x: carrier.x, y: carrier.y }, ...body];
      for (const point of line) {
        if (scene.vm.modules.some((module) => footprint(module).includes(key(point.x, point.y)) && module.kind !== 'berth')) continue; // stopa v depe
        expect(roads.has(key(point.x, point.y)), `${label}: (${String(point.x)}; ${String(point.y)}) nie je na ceste`).toBe(true);
      }
      for (let i = 1; i < line.length; i++) {
        const step = Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
        expect(step, `${label}: medzera v stope`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('nosiče na ceste nezdieľajú bunky (hlava ani stopa)', () => {
    const owner = new Map<string, number>();
    for (const carrier of onRoad(scene)) {
      const cells = new Set([key(carrier.x, carrier.y), ...(carrier.body ?? []).map((point) => key(point.x, point.y))]);
      for (const cell of cells) {
        expect(owner.has(cell), `bunka ${cell}: nosiče ${String(owner.get(cell))} a ${String(carrier.id)}`).toBe(false);
        owner.set(cell, carrier.id);
      }
    }
  });

  it('id nosičov sú jedinečné a stavy `jammed` / `blocked` sú pravdivostné', () => {
    const ids = carriers(scene).map((carrier) => carrier.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const carrier of carriers(scene)) {
      if (carrier.jammed === true) expect(carrier.blocked, `nosič ${String(carrier.id)}: jammed bez blocked`).toBe(true);
    }
  });
});

describe('scéna depot', () => {
  const scene = R1_SCENES.depot;
  const depot = scene.vm.modules[0];

  it('zaparkované vozidlá sú v poli modulu aj vo VM v stave `parked`, mimo cesty; kapacita depa ich pojme', () => {
    const parked = depot.parkedVehicles ?? [];
    expect(parked).toHaveLength(5);
    expect(parked.length).toBeLessThanOrEqual(parkingStalls('vehicle_depot') ?? 0);
    for (const vehicle of parked) {
      const vm = (scene.vm.vehicles ?? []).find((candidate) => candidate.id === vehicle.id);
      expect(vm?.state).toBe('parked');
      expect(vm?.offRoad).toBe(true);
      expect(vm?.defId).toBe(vehicle.defId);
    }
  });
});

describe('scéna jam', () => {
  it('práve jeden nosič je v zápche', () => {
    expect(carriers(R1_SCENES.jam).filter((carrier) => carrier.jammed === true)).toHaveLength(1);
  });
});
