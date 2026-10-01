import { describe, expect, it } from 'vitest';
import { ROAD_KINDS, ROAD_KIND_TRAITS, TERRAIN_TRAITS, dragDirections, loadBundledMap, type Direction4Name, type RoadKind } from '@sim/grid';
import {
  RING_CELLS,
  RING_DIRS,
  ROAD_KINDS_ROADS,
  ROAD_KINDS_SCENE,
  ROAD_KINDS_VIEW,
  createRoadKindsGrid,
} from '@render/__demo__/f3-render.fixtures';
import { createRoadKindAt, createRoadMaskAt } from '@render/lane';
import { RoadLayer } from '@render/road-layer';
import { RoadMarkLayer } from '@render/road-mark-layer';
import { cornerAlpha, cornerTurn } from '@render/turn-arc';
import { PALETTE, StubTextures } from './stub-textures';

const map = loadBundledMap();
const grid = createRoadKindsGrid(map);
const maskAt = createRoadMaskAt(grid);
const kindAt = createRoadKindAt(grid);
const vehicles = ROAD_KINDS_SCENE.vehicles ?? [];
const HEADING_DIR: Record<number, Direction4Name> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

describe('scéna road-kinds (karta T03-19, screenshot f3-road-kinds.png)', () => {
  it('bez modulov, lodí a žeriavov; id vozidiel sú jedinečné', () => {
    expect(ROAD_KINDS_SCENE.modules).toEqual([]);
    expect(ROAD_KINDS_SCENE.ships).toEqual([]);
    expect(ROAD_KINDS_SCENE.cranes).toEqual([]);
    expect(new Set(vehicles.map((vehicle) => vehicle.id)).size).toBe(vehicles.length);
  });

  it('cesty ležia na stavateľnom teréne starter parcely a bez duplicít', () => {
    const starter = map.parcels.find((parcel) => parcel.ownership === 'owned')?.rect;
    expect(starter).toBeDefined();
    const keys = new Set<string>();
    for (const { x, y } of ROAD_KINDS_ROADS) {
      keys.add(`${String(x)},${String(y)}`);
      expect(TERRAIN_TRAITS[grid.at(x, y).terrain].roadBuildable, `terén ${String(x)};${String(y)}`).toBe(true);
      expect(x >= (starter?.x ?? 0) && x < (starter?.x ?? 0) + (starter?.w ?? 0)).toBe(true);
      expect(y >= (starter?.y ?? 0) && y < (starter?.y ?? 0) + (starter?.h ?? 0)).toBe(true);
    }
    expect(keys.size).toBe(ROAD_KINDS_ROADS.length);
  });

  it('mriežka: všetky tri typy ciest, smer len pri jednosmerke; štartové cesty mapy ostávajú dvojpruhové', () => {
    const counts = new Map<RoadKind, number>();
    for (const { x, y, kind, dir } of ROAD_KINDS_ROADS) {
      const cell = grid.at(x, y);
      expect(cell.road).toBe('road');
      expect(cell.roadKind).toBe(kind);
      expect(cell.roadDir).toBe(ROAD_KIND_TRAITS[kind].oneWay ? (dir ?? null) : null);
      if (ROAD_KIND_TRAITS[kind].oneWay) expect(dir).toBeDefined();
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...ROAD_KINDS].sort());
    for (const road of map.starter.roads) {
      expect(grid.at(road.x, road.y).roadKind).toBe('two_lane');
      expect(grid.at(road.x, road.y).roadDir).toBeNull();
    }
  });

  it('jednosmerný okruh: 20 buniek, súvislá slučka po smere hodinových ručičiek so smermi ako `dragDirections`', () => {
    expect(RING_CELLS).toHaveLength(20);
    expect(RING_DIRS).toHaveLength(20);
    let rightTurns = 0;
    RING_CELLS.forEach((cell, i) => {
      const next = RING_CELLS[(i + 1) % RING_CELLS.length];
      expect(Math.abs(next.x - cell.x) + Math.abs(next.y - cell.y), `krok ${String(i)}`).toBe(1);
      const dir = RING_DIRS[i];
      const after = RING_DIRS[(i + 1) % RING_DIRS.length];
      const order = ['N', 'E', 'S', 'W'];
      if ((order.indexOf(dir) + 1) % 4 === order.indexOf(after)) rightTurns += 1;
      expect(grid.at(cell.x, cell.y).roadDir).toBe(dir);
      expect(grid.at(cell.x, cell.y).roadKind).toBe('one_way');
    });
    expect(rightTurns).toBe(4); // štyri zákruty, všetky doprava
    // smery vnútri jednej otvorenej poloslučky zodpovedajú ťahu myšou
    expect(dragDirections(RING_CELLS.slice(0, 7))?.slice(0, 6)).toEqual(RING_DIRS.slice(0, 6));
  });

  it('križovatky rôznych typov: široká × úzka (kríž, T zo západu aj z východu), zákruta úzkej pri širokej a zúženie na rovine', () => {
    const shape = (x: number, y: number): number => maskAt(x, y);
    expect(shape(43, 22)).toBe(15); // kríž dvojpruhovej zvislej cesty s jednopruhovou vodorovnou
    expect(kindAt(43, 22)).toBe('two_lane');
    expect(kindAt(42, 22)).toBe('one_lane');
    expect(kindAt(44, 22)).toBe('one_lane');
    expect(shape(43, 24)).toBe(1 | 4 | 8); // T zo západu (jednopruhová vetva)
    expect(kindAt(42, 24)).toBe('one_lane');
    expect(shape(43, 26)).toBe(1 | 2 | 4); // T na východ (jednosmerná vetva)
    expect(kindAt(44, 26)).toBe('one_way');
    expect(shape(42, 28)).toBe(2 | 4); // zákruta úzkej cesty hneď pri širokej (E je široká cesta x 43)
    expect(kindAt(43, 28)).toBe('two_lane');
    expect(kindAt(42, 28)).toBe('one_lane');
    expect(shape(43, 28)).toBe(1 | 8); // koniec zvislej cesty je široká zákruta, na ktorú nadväzuje úzka zákruta
    expect(kindAt(37, 27)).toBe('two_lane'); // zúženie: široká rovina ...
    expect(kindAt(38, 27)).toBe('one_lane'); // ... nadväzuje na úzku
  });

  it('RoadLayer: úzke cesty pri širokých susedoch majú lievik, ostatné nie', () => {
    const layer = new RoadLayer(grid, PALETTE, new StubTextures());
    expect(layer.tileStyleAt(38, 27)).not.toBe('narrow:0'); // zúženie
    expect(layer.tileStyleAt(42, 22)).not.toBe('narrow:0');
    expect(layer.tileStyleAt(44, 22)).not.toBe('narrow:0');
    expect(layer.tileStyleAt(42, 24)).not.toBe('narrow:0');
    expect(layer.tileStyleAt(44, 26)).not.toBe('narrow:0');
    expect(layer.tileStyleAt(42, 28)).not.toBe('narrow:0'); // zákruta pri širokej ceste
    expect(layer.tileStyleAt(36, 23)).toBe('narrow:0'); // rovná úzka, susedia úzki
    expect(layer.tileStyleAt(51, 21)).toBe('narrow:0'); // okruh
    expect(layer.tileStyleAt(36, 21)).toBe('wide');
  });

  it('RoadMarkLayer: šípka na každej bunke jednosmerky (okruh 20 + rovná cesta 6 + odbočka 4), inde nie', () => {
    const marks = new RoadMarkLayer(grid, PALETTE, new StubTextures().overlay('path_arrow'));
    expect(marks.arrowCount).toBe(30);
    expect(marks.arrowAt(36, 25)).toBe(90);
    expect(marks.arrowAt(54, 24)).toBe(180);
    expect(marks.arrowAt(51, 26)).toBe(270);
    expect(marks.arrowAt(49, 23)).toBe(0);
    // zákruty okruhu: šípka v strede oblúka pruhu (posunutá k vnútornému rohu), uhol = os medzi vstupným a výstupným kurzom
    expect(marks.arrowPoseAt(54, 21)?.angle).toBe(135); // z východu na juh
    expect(marks.arrowPoseAt(54, 26)?.angle).toBe(225); // z juhu na západ
    expect(marks.arrowPoseAt(49, 26)?.angle).toBe(315); // zo západu na sever
    expect(marks.arrowPoseAt(49, 21)?.angle).toBe(45); // zo severu na východ
    const corner = marks.arrowPoseAt(54, 21);
    expect(corner?.dx).toBeCloseTo(-(45.254834 - 32) / Math.SQRT2 / 64, 6);
    expect(corner?.dy).toBeCloseTo(-(corner?.dx ?? 0), 9);
    expect(marks.arrowAt(36, 21)).toBeUndefined();
    expect(marks.arrowAt(36, 23)).toBeUndefined();
  });

  it('vozidlá: stoja na ceste, nepretínajú sa a idú po nej (v zákrute kurz sedí s oblúkom, na jednosmerke so smerom cesty)', () => {
    for (const vehicle of vehicles) {
      const cellX = Math.floor(vehicle.x);
      const cellY = Math.floor(vehicle.y);
      const cell = grid.at(cellX, cellY);
      expect(cell.road, `vozidlo ${String(vehicle.id)}`).toBe('road');
      const turn = cornerTurn(maskAt(cellX, cellY), vehicle.heading);
      if (ROAD_KIND_TRAITS[cell.roadKind].oneWay) {
        // jednosmerka: v zákrute sa vozidlo pohybuje vstupným kurzom, potom smerom cesty (výstup)
        const allowed = turn === null ? [cell.roadDir] : [cell.roadDir, HEADING_DIR[turn.from]];
        expect(allowed, `vozidlo ${String(vehicle.id)}`).toContain(HEADING_DIR[vehicle.heading]);
      }
    }
    for (let i = 0; i < vehicles.length; i++) {
      for (let j = i + 1; j < vehicles.length; j++) {
        const distance = Math.hypot(vehicles[i].x - vehicles[j].x, vehicles[i].y - vehicles[j].y);
        expect(distance, `vozidlá ${String(vehicles[i].id)} a ${String(vehicles[j].id)}`).toBeGreaterThanOrEqual(0.9);
      }
    }
    // každý typ cesty má aspoň dve vozidlá
    for (const kind of ROAD_KINDS) {
      expect(vehicles.filter((vehicle) => kindAt(Math.floor(vehicle.x), Math.floor(vehicle.y)) === kind).length, kind).toBeGreaterThanOrEqual(2);
    }
  });

  it('vozidlá v oblúku zákruty: aspoň tri na okruhu, s parametrom oblúka vnútri (0; 1) — štvrtina, stred a po strede', () => {
    const inArc = vehicles
      .map((vehicle) => {
        const cellX = Math.floor(vehicle.x);
        const cellY = Math.floor(vehicle.y);
        const turn = cornerTurn(maskAt(cellX, cellY), vehicle.heading);
        return turn === null ? null : cornerAlpha({ x: vehicle.x, y: vehicle.y }, { x: cellX + 0.5, y: cellY + 0.5 }, vehicle.heading);
      })
      .filter((alpha): alpha is number => alpha !== null);
    expect(inArc.length).toBeGreaterThanOrEqual(3);
    expect(inArc.some((alpha) => Math.abs(alpha - 0.25) < 0.01)).toBe(true);
    expect(inArc.some((alpha) => Math.abs(alpha - 0.5) < 0.01)).toBe(true);
    expect(inArc.some((alpha) => alpha > 0.6 && alpha < 0.9)).toBe(true);
  });

  it('pohľad: stred vo vnútri starter parcely, zoom 0,9 (scéna sa zmestí do 1280 px)', () => {
    expect(ROAD_KINDS_VIEW.zoom).toBeCloseTo(0.9, 9);
    expect(1280 / (PALETTE.cellPx * ROAD_KINDS_VIEW.zoom)).toBeGreaterThan(20); // x 35–54 = 20 buniek
    expect(ROAD_KINDS_VIEW.centerX).toBeGreaterThanOrEqual(35);
    expect(ROAD_KINDS_VIEW.centerX).toBeLessThanOrEqual(54);
  });
});
