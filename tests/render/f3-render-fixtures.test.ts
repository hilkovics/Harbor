import { describe, expect, it } from 'vitest';
import { ROTATIONS, loadBundledMap, rotateLocalCell, type Grid, type Rotation } from '@sim/grid';
import {
  DEMO_DEPOT_DEF,
  DEMO_YARD_CAPACITY,
  DEMO_YARD_DEF,
  DEPOT_CONNECTED,
  DEPOT_DISCONNECTED,
  MAIN_SCENE,
  SCENE_VIEW,
  YARD_EMPTY,
  YARD_FILLED,
  connectorOutsideCells,
  createDemoGrid,
  depotVM,
  vehicleVM,
  yardVM,
} from '@render/__demo__/f3-render.fixtures';
import { moduleSprite } from '@render/entity-assets';
import { fillState } from '@render/storage-fill';
import type { ModuleVM, VehicleVM } from '@render/view-models';

const map = loadBundledMap();
const grid: Grid = createDemoGrid(map);
const key = (x: number, y: number): string => `${String(x)},${String(y)}`;
const hasRoad = (x: number, y: number): boolean => grid.inBounds(x, y) && grid.at(x, y).road === 'road';

/** Svetové bunky modulu (footprint po rotácii). */
function cellsOf(vm: ModuleVM): Set<string> {
  const footprint = moduleSprite(vm.defId)?.footprint ?? { w: 0, h: 0 };
  const cells = new Set<string>();
  for (let cy = 0; cy < footprint.h; cy += 1) {
    for (let cx = 0; cx < footprint.w; cx += 1) {
      const cell = rotateLocalCell(cx, cy, footprint.w, footprint.h, vm.rotation);
      cells.add(key(vm.x + cell.x, vm.y + cell.y));
    }
  }
  return cells;
}

describe('scéna main (karta T03-08)', () => {
  it('2 dvory (fill 0 a 75), pripojené depo, odpojené depo a 3 vozidlá', () => {
    expect(MAIN_SCENE.modules.map((module) => module.defId)).toEqual([DEMO_YARD_DEF, DEMO_YARD_DEF, DEMO_DEPOT_DEF, DEMO_DEPOT_DEF]);
    expect(MAIN_SCENE.vehicles).toHaveLength(3);
    expect(MAIN_SCENE.cranes).toEqual([]);
    expect(MAIN_SCENE.ships).toEqual([]);
    const [empty, filled] = [YARD_EMPTY, YARD_FILLED];
    expect(fillState(empty.storage?.stored ?? -1, empty.storage?.capacity ?? 0)).toBe(0);
    expect(fillState(filled.storage?.stored ?? -1, filled.storage?.capacity ?? 0)).toBe(75);
    expect(filled.storage?.capacity).toBe(DEMO_YARD_CAPACITY);
  });

  it('vozidlá: prázdny aj naložené, aspoň tri rôzne kurzy', () => {
    const vehicles = MAIN_SCENE.vehicles ?? [];
    expect(vehicles.some((vehicle) => vehicle.loaded)).toBe(true);
    expect(vehicles.some((vehicle) => !vehicle.loaded)).toBe(true);
    expect(new Set(vehicles.map((vehicle) => vehicle.heading)).size).toBeGreaterThanOrEqual(3);
  });

  it('id sú v rámci scény jedinečné; moduly sa neprekrývajú a ležia na starter parcele', () => {
    const ids = [...MAIN_SCENE.modules, ...(MAIN_SCENE.vehicles ?? [])].map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
    const starter = map.parcels.find((parcel) => parcel.ownership === 'owned')?.rect;
    expect(starter).toBeDefined();
    const occupied = new Set<string>();
    for (const module of MAIN_SCENE.modules) {
      for (const cell of cellsOf(module)) {
        expect(occupied.has(cell), `prekrytie v ${cell}`).toBe(false);
        occupied.add(cell);
        const [x, y] = cell.split(',').map(Number);
        expect(x >= (starter?.x ?? 0) && x < (starter?.x ?? 0) + (starter?.w ?? 0)).toBe(true);
        expect(y >= (starter?.y ?? 0) && y < (starter?.y ?? 0) + (starter?.h ?? 0)).toBe(true);
      }
    }
    // cesty ani vozidlá nejdú cez moduly
    for (const vehicle of MAIN_SCENE.vehicles ?? []) expect(occupied.has(key(Math.floor(vehicle.x), Math.floor(vehicle.y)))).toBe(false);
  });

  it('kamera smeruje na scénu: stred je vo vnútri starter parcely', () => {
    const starter = map.parcels.find((parcel) => parcel.ownership === 'owned')?.rect;
    expect(SCENE_VIEW.centerX).toBeGreaterThanOrEqual(starter?.x ?? 0);
    expect(SCENE_VIEW.centerY).toBeGreaterThanOrEqual(starter?.y ?? 0);
  });
});

describe('príznak `connected` zodpovedá ceste pri konektore (§8 bod 5, „Rozhodnutia orchestrátora“ 3)', () => {
  it.each([
    ['dvor A', YARD_EMPTY],
    ['dvor B', YARD_FILLED],
    ['pripojené depo', DEPOT_CONNECTED],
    ['odpojené depo', DEPOT_DISCONNECTED],
  ])('%s', (_name, module) => {
    const outside = connectorOutsideCells(module);
    expect(outside).toHaveLength(1);
    const anyRoad = outside.some((cell) => hasRoad(cell.x, cell.y));
    expect(module.connected).toBe(anyRoad);
    // vonkajšia bunka je mimo footprintu modulu
    for (const cell of outside) expect(cellsOf(module).has(key(cell.x, cell.y))).toBe(false);
  });

  it('presne jeden modul scény je odpojený (odznak) a je to depo', () => {
    const disconnected = MAIN_SCENE.modules.filter((module) => module.connected === false);
    expect(disconnected).toEqual([DEPOT_DISCONNECTED]);
  });
});

describe('vozidlá stoja na cestách a smerujú po nich', () => {
  const step: Record<VehicleVM['heading'], readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };

  it.each((MAIN_SCENE.vehicles ?? []).map((vehicle) => [vehicle.id, vehicle] as const))('vozidlo %i', (_id, vehicle) => {
    const cellX = Math.floor(vehicle.x);
    const cellY = Math.floor(vehicle.y);
    expect(hasRoad(cellX, cellY)).toBe(true);
    expect(vehicle.x - cellX).toBeCloseTo(0.5, 9); // stred bunky
    expect(vehicle.y - cellY).toBeCloseTo(0.5, 9);
    const [dx, dy] = step[vehicle.heading];
    // po kurze pokračuje cesta (susedná bunka vpredu) alebo aspoň vzadu (opačný smer)
    expect(hasRoad(cellX + dx, cellY + dy) || hasRoad(cellX - dx, cellY - dy)).toBe(true);
    // predchádzajúca poloha leží na tej istej osi (jazda po úseku, nie skok)
    expect(vehicle.prevX === vehicle.x || vehicle.prevY === vehicle.y).toBe(true);
  });
});

describe('pomocné konštruktory', () => {
  it.each(ROTATIONS)('dvor a depo rot %i: rozmery footprintu po rotácii (4×4, 3×3), konektor mimo footprintu', (rotation: Rotation) => {
    const yard = yardVM(1, 10, 10, rotation, 0, true);
    const depot = depotVM(2, 20, 10, rotation, true);
    expect([yard.w, yard.h]).toEqual([4, 4]);
    expect([depot.w, depot.h]).toEqual([3, 3]);
    for (const module of [yard, depot]) {
      const [outside] = connectorOutsideCells(module);
      expect(cellsOf(module).has(key(outside.x, outside.y))).toBe(false);
      // vonkajšia bunka susedí s footprintom (Manhattan 1 od nejakej bunky modulu)
      const neighbours = [
        [outside.x + 1, outside.y],
        [outside.x - 1, outside.y],
        [outside.x, outside.y + 1],
        [outside.x, outside.y - 1],
      ];
      expect(neighbours.some(([x, y]) => cellsOf(module).has(key(x, y)))).toBe(true);
    }
  });

  it('vehicleVM: stred bunky = bunka + 0,5; prev predvolene rovnaké', () => {
    const vehicle = vehicleVM(9, 3, 4, 180, true, 'loading');
    expect([vehicle.x, vehicle.y, vehicle.prevX, vehicle.prevY]).toEqual([3.5, 4.5, 3.5, 4.5]);
    expect([vehicle.heading, vehicle.loaded, vehicle.state]).toEqual([180, true, 'loading']);
  });

  it('demo mriežka: štartová cesta mapy aj cesty scény sú `road`, ostatné nie', () => {
    for (const cell of map.starter.roads) expect(hasRoad(cell.x, cell.y)).toBe(true);
    expect(hasRoad(36, 24)).toBe(true);
    expect(hasRoad(44, 30)).toBe(true);
    expect(hasRoad(51, 24)).toBe(false);
    expect(map.createGrid().at(36, 24).road).toBe('none'); // šablóna mapy sa nemení
  });
});
