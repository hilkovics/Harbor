import { describe, expect, it } from 'vitest';
import { TERRAIN_TRAITS, loadBundledMap, type Grid } from '@sim/grid';
import {
  DEMO_SCENES,
  LANES_ROADS,
  LANES_SCENE,
  LANES_VIEW,
  SCENE_VIEW,
  MAIN_SCENE,
  createDemoGrid,
  createLanesGrid,
  ROAD_KINDS_SCENE,
  ROAD_KINDS_VIEW,
  createRoadKindsGrid,
  vehicleAt,
  vehicleVM,
} from '@render/__demo__/f3-render.fixtures';
import { createRoadMaskAt } from '@render/lane';
import { cornerTurn } from '@render/turn-arc';
import type { VehicleVM } from '@render/view-models';

const map = loadBundledMap();
const grid: Grid = createLanesGrid(map);
const hasRoad = (x: number, y: number): boolean => grid.inBounds(x, y) && grid.at(x, y).road === 'road';
const step: Record<VehicleVM['heading'], readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const vehicles = LANES_SCENE.vehicles ?? [];
const maskAt = createRoadMaskAt(grid);

describe('scéna lanes (karta T03-17, screenshot f3-lanes.png)', () => {
  it('registr scén: main, lanes a road-kinds; každá má VM, pohľad a mriežku', () => {
    expect(Object.keys(DEMO_SCENES)).toEqual(['main', 'lanes', 'road-kinds']);
    expect(DEMO_SCENES.main).toEqual({ vm: MAIN_SCENE, view: SCENE_VIEW, createGrid: createDemoGrid });
    expect(DEMO_SCENES.lanes).toEqual({ vm: LANES_SCENE, view: LANES_VIEW, createGrid: createLanesGrid });
    expect(DEMO_SCENES['road-kinds']).toEqual({ vm: ROAD_KINDS_SCENE, view: ROAD_KINDS_VIEW, createGrid: createRoadKindsGrid });
  });

  it('bez modulov, lodí a žeriavov; id vozidiel sú jedinečné', () => {
    expect(LANES_SCENE.modules).toEqual([]);
    expect(LANES_SCENE.ships).toEqual([]);
    expect(LANES_SCENE.cranes).toEqual([]);
    expect(new Set(vehicles.map((vehicle) => vehicle.id)).size).toBe(vehicles.length);
    expect(vehicles.length).toBeGreaterThanOrEqual(16);
  });

  it('cesty ležia na stavateľnom teréne starter parcely a bez duplicít', () => {
    const starter = map.parcels.find((parcel) => parcel.ownership === 'owned')?.rect;
    expect(starter).toBeDefined();
    const keys = new Set<string>();
    for (const { x, y } of LANES_ROADS) {
      keys.add(`${String(x)},${String(y)}`);
      expect(TERRAIN_TRAITS[grid.at(x, y).terrain].roadBuildable, `terén ${String(x)};${String(y)}`).toBe(true);
      expect(x >= (starter?.x ?? 0) && x < (starter?.x ?? 0) + (starter?.w ?? 0)).toBe(true);
      expect(y >= (starter?.y ?? 0) && y < (starter?.y ?? 0) + (starter?.h ?? 0)).toBe(true);
    }
    expect(keys.size).toBe(LANES_ROADS.length);
  });

  it('obsahuje priamu cestu, T-križovatku a tri zákruty', () => {
    const neighbours = (x: number, y: number): number => [hasRoad(x, y - 1), hasRoad(x + 1, y), hasRoad(x, y + 1), hasRoad(x - 1, y)].filter(Boolean).length;
    expect(neighbours(40, 24)).toBe(2); // priama
    expect(neighbours(42, 24)).toBe(3); // T-križovatka
    for (const [x, y] of [
      [48, 24],
      [48, 28],
      [42, 28],
    ]) {
      expect(neighbours(x, y)).toBe(2);
      expect(hasRoad(x, y - 1) !== hasRoad(x, y + 1)).toBe(true); // zákruta: vertikálne aj horizontálne sused
      expect(hasRoad(x - 1, y) !== hasRoad(x + 1, y)).toBe(true);
    }
  });

  it.each(vehicles.map((vehicle) => [vehicle.id, vehicle] as const))('vozidlo %i stojí na ceste a smeruje po nej', (_id, vehicle) => {
    const cellX = Math.floor(vehicle.x);
    const cellY = Math.floor(vehicle.y);
    expect(hasRoad(cellX, cellY)).toBe(true);
    if (cornerTurn(maskAt(cellX, cellY), vehicle.heading) !== null) return; // v zákrute kurz sedí s oblúkom (test nižšie)
    const [dx, dy] = step[vehicle.heading];
    expect(hasRoad(cellX + dx, cellY + dy)).toBe(true); // vpredu pokračuje cesta
  });

  it('vozidlá s prevHeading sú v zákrute: koleno ticku je stred bunky zákruty so vstupným a výstupným kurzom', () => {
    const turning = vehicles.filter((vehicle) => vehicle.prevHeading !== undefined && vehicle.prevHeading !== vehicle.heading);
    expect(turning.length).toBeGreaterThanOrEqual(3);
    for (const vehicle of turning) {
      const prevHeading = vehicle.prevHeading ?? vehicle.heading;
      // koleno = priesečník osi predchádzajúceho úseku (cez prev) a aktuálneho (cez curr)
      const vertical = prevHeading === 0 || prevHeading === 180;
      const knee = { x: vertical ? vehicle.prevX : vehicle.x, y: vertical ? vehicle.y : vehicle.prevY };
      expect(knee.x - Math.floor(knee.x)).toBeCloseTo(0.5, 9);
      expect(knee.y - Math.floor(knee.y)).toBeCloseTo(0.5, 9);
      const turn = cornerTurn(maskAt(Math.floor(knee.x), Math.floor(knee.y)), prevHeading);
      expect(turn, `vozidlo ${String(vehicle.id)}`).toEqual({ from: prevHeading, to: vehicle.heading });
    }
  });

  it('oblúky (T03-19): vozidlá v bunkách zákrut sú v pravej aj ľavej zákrute, vo vstupnej aj výstupnej polovici', () => {
    const inCorner = vehicles.filter((vehicle) => cornerTurn(maskAt(Math.floor(vehicle.x), Math.floor(vehicle.y)), vehicle.heading) !== null);
    expect(inCorner.length).toBeGreaterThanOrEqual(6);
    const turns = new Set(
      inCorner.map((vehicle) => {
        const turn = cornerTurn(maskAt(Math.floor(vehicle.x), Math.floor(vehicle.y)), vehicle.heading);
        return ((((turn?.to ?? 0) - (turn?.from ?? 0)) % 360) + 360) % 360 === 90 ? 'pravá' : 'ľavá';
      }),
    );
    expect(turns).toEqual(new Set(['pravá', 'ľavá']));
  });

  it('protismerné dvojice stoja v tej istej bunke (dôkaz, že sa v pruhoch nekrížia)', () => {
    const pair = (a: number, b: number): void => {
      const first = vehicles.find((vehicle) => vehicle.id === a);
      const second = vehicles.find((vehicle) => vehicle.id === b);
      expect([first?.x, first?.y]).toEqual([second?.x, second?.y]);
      expect(((first?.heading ?? 0) + 180) % 360).toBe(second?.heading);
    };
    pair(21, 22);
    pair(25, 26);
  });

  it('všetky štyri kurzy a prázdne aj naložené vozidlá', () => {
    expect(new Set(vehicles.map((vehicle) => vehicle.heading))).toEqual(new Set([0, 90, 180, 270]));
    expect(vehicles.some((vehicle) => vehicle.loaded)).toBe(true);
    expect(vehicles.some((vehicle) => !vehicle.loaded)).toBe(true);
  });

  it('pohľad: stred vo vnútri starter parcely, zoom čitateľný pre pruhy', () => {
    expect(LANES_VIEW.zoom).toBeGreaterThan(SCENE_VIEW.zoom);
    expect(LANES_VIEW.centerX).toBeGreaterThanOrEqual(30);
    expect(LANES_VIEW.centerY).toBeGreaterThanOrEqual(14);
  });
});

describe('konštruktory vozidiel', () => {
  it('vehicleAt: voľná poloha a prevHeading len ak je zadaný', () => {
    const plain = vehicleAt(1, 3.25, 4.75, 90, false, 'idle');
    expect(plain).not.toHaveProperty('prevHeading');
    expect([plain.x, plain.y, plain.prevX, plain.prevY]).toEqual([3.25, 4.75, 3.25, 4.75]);
    const turning = vehicleAt(2, 3.25, 4.75, 180, true, 'to_dropoff', { x: 3, y: 4.5, heading: 90 });
    expect([turning.prevX, turning.prevY, turning.prevHeading]).toEqual([3, 4.5, 90]);
  });

  it('vehicleVM: predchádzajúci kurz z `prev.heading`', () => {
    expect(vehicleVM(1, 3, 4, 0, false, 'idle', { x: 3.5, y: 4.9, heading: 270 }).prevHeading).toBe(270);
    expect(vehicleVM(1, 3, 4, 0, false, 'idle')).not.toHaveProperty('prevHeading');
  });
});
