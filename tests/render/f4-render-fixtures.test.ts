import { describe, expect, it } from 'vitest';
import { ROTATIONS, loadBundledMap, rotateLocalCell, type Grid, type Rotation } from '@sim/grid';
import { connectorOutsideCells } from '@render/__demo__/f3-render.fixtures';
import {
  DEMO_GATE_DEF,
  DEMO_RAMP_DEF,
  DEMO_TRUCK_DEF,
  DEMO_WAITING_AREA_DEF,
  F4_MAIN_SCENE,
  F4_MAIN_VIEW,
  F4_TRUCKS,
  GATE,
  RAMP_A,
  RAMP_B,
  WAITING_AREA,
  createF4Grid,
  gateVM,
  rampVM,
  truckAt,
  truckInCell,
  waitingAreaVM,
} from '@render/__demo__/f4-render.fixtures';
import { moduleSprite } from '@render/entity-assets';
import { dockCenter, stallCenter } from '@render/module-slots';
import type { ModuleVM, TruckVM } from '@render/view-models';

const map = loadBundledMap();
const grid: Grid = createF4Grid(map);
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

/** Kamión stojí vo vnútri obdĺžnika stojiska / doku (px súboru pri rot 0 → svet) — stred kamióna leží v jeho bunkách modulu. */
function insideModule(truck: TruckVM, module: ModuleVM): boolean {
  return truck.x >= module.x && truck.x <= module.x + module.w && truck.y >= module.y && truck.y <= module.y + module.h;
}

describe('scéna F4 main (karta T04-06)', () => {
  it('brána, čakacia plocha a dve rampy; kamióny bez žeriavov, lodí a vozidiel', () => {
    expect(F4_MAIN_SCENE.modules.map((module) => module.defId)).toEqual([DEMO_GATE_DEF, DEMO_WAITING_AREA_DEF, DEMO_RAMP_DEF, DEMO_RAMP_DEF]);
    expect(F4_MAIN_SCENE.cranes).toEqual([]);
    expect(F4_MAIN_SCENE.ships).toEqual([]);
    expect(F4_MAIN_SCENE.vehicles).toEqual([]);
    expect(F4_MAIN_SCENE.trucks).toBe(F4_TRUCKS);
    expect(F4_TRUCKS).toHaveLength(10);
    expect(F4_TRUCKS.every((truck) => truck.defId === DEMO_TRUCK_DEF)).toBe(true);
  });

  it('zadanie karty: brána s frontou 3, stojisko 4 z 6, rampa s 2 pripravenými a kamiónom v doku, neprevádzková rampa', () => {
    expect(GATE.gate).toEqual({ queueLength: 3, open: false, entryConnector: 1 });
    expect(WAITING_AREA.waitingArea?.bays).toBe(6);
    expect(WAITING_AREA.waitingArea?.occupied.filter(Boolean)).toHaveLength(4);
    expect(RAMP_A.ramp?.staged.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(RAMP_A.ramp?.operational).toBe(true);
    expect(RAMP_B.ramp?.operational).toBe(false);
  });

  it('id sú jedinečné; moduly sa neprekrývajú, ležia na starter parcele a nie na cestách', () => {
    const ids = [...F4_MAIN_SCENE.modules, ...F4_TRUCKS].map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
    const starter = map.parcels.find((parcel) => parcel.ownership === 'owned')?.rect;
    expect(starter).toBeDefined();
    const occupied = new Set<string>();
    for (const module of F4_MAIN_SCENE.modules) {
      for (const cell of cellsOf(module)) {
        expect(occupied.has(cell), `prekrytie v ${cell}`).toBe(false);
        occupied.add(cell);
        const [x, y] = cell.split(',').map(Number);
        expect(x >= (starter?.x ?? 0) && x < (starter?.x ?? 0) + (starter?.w ?? 0)).toBe(true);
        expect(y >= (starter?.y ?? 0) && y < (starter?.y ?? 0) + (starter?.h ?? 0)).toBe(true);
        expect(hasRoad(x, y), `cesta pod modulom v ${cell}`).toBe(false);
      }
    }
  });

  it('kamera smeruje na scénu: stred je vo vnútri starter parcely', () => {
    const starter = map.parcels.find((parcel) => parcel.ownership === 'owned')?.rect;
    expect(F4_MAIN_VIEW.centerX).toBeGreaterThanOrEqual(starter?.x ?? 0);
    expect(F4_MAIN_VIEW.centerY).toBeLessThanOrEqual((starter?.y ?? 0) + (starter?.h ?? 0));
  });
});

describe('príznak `connected` zodpovedá ceste pri konektore', () => {
  it.each([
    ['brána', GATE],
    ['čakacia plocha', WAITING_AREA],
    ['rampa A', RAMP_A],
    ['rampa B', RAMP_B],
  ])('%s: oba konektory majú vonkajšiu bunku mimo modulu a aspoň jedna leží na ceste', (_name, module) => {
    const outside = connectorOutsideCells(module);
    expect(outside).toHaveLength(2);
    for (const cell of outside) expect(cellsOf(module).has(key(cell.x, cell.y))).toBe(false);
    expect(module.connected).toBe(outside.some((cell) => hasRoad(cell.x, cell.y)));
  });

  it('neprevádzková rampa B je pripojená k ceste: odznak vyvolá iba `operational: false`', () => {
    expect(RAMP_B.connected).toBe(true);
    expect(connectorOutsideCells(RAMP_B).every((cell) => hasRoad(cell.x, cell.y))).toBe(true);
  });

  it('vstupný konektor brány (`entryConnector: 1`, juh) leží na štartovej ceste z portálu a čelo fronty stojí na jeho vonkajšej bunke', () => {
    const [north, south] = connectorOutsideCells(GATE);
    expect(south).toEqual({ x: 44, y: 34 });
    expect(map.starter.roads.some((cell) => cell.x === south.x && cell.y === south.y)).toBe(true);
    expect(north).toEqual({ x: 44, y: 31 });
    const head = F4_TRUCKS.find((truck) => truck.state === 'gate_queue');
    expect([Math.floor(head?.x ?? 0), Math.floor(head?.y ?? 0)]).toEqual([south.x, south.y]);
  });
});

describe('kamióny stoja na cestách, stojiskách a dokoch', () => {
  const step: Record<TruckVM['heading'], readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
  const parked = F4_TRUCKS.filter((truck) => truck.state === 'waiting');
  const docked = F4_TRUCKS.filter((truck) => truck.state === 'loading');
  const driving = F4_TRUCKS.filter((truck) => !['waiting', 'loading'].includes(truck.state));

  it('4 čakajúce kamióny stoja presne na obsadených stojiskách (1 kamión na stojisko)', () => {
    expect(parked).toHaveLength(4);
    const occupied = (WAITING_AREA.waitingArea?.occupied ?? []).flatMap((taken, index) => (taken ? [index] : []));
    expect(parked.map((truck) => ({ x: truck.x, y: truck.y }))).toEqual(occupied.map((index) => stallCenter(WAITING_AREA, index)));
    for (const truck of parked) expect(insideModule(truck, WAITING_AREA)).toBe(true);
  });

  it('kamión v doku 1 rampy A stojí v jeho strede; dok 0 s pripravenými kontajnermi je voľný', () => {
    expect(docked).toHaveLength(1);
    expect({ x: docked[0].x, y: docked[0].y }).toEqual(dockCenter(RAMP_A, 1));
    expect(insideModule(docked[0], RAMP_A)).toBe(true);
    expect(RAMP_A.ramp?.staged[0]).toBe(2);
    expect(dockCenter(RAMP_A, 0).x).toBeLessThan(dockCenter(RAMP_A, 1).x);
  });

  it.each(driving.map((truck) => [truck.id, truck] as const))('kamión %i na ceste', (_id, truck) => {
    const cellX = Math.floor(truck.x);
    const cellY = Math.floor(truck.y);
    expect(hasRoad(cellX, cellY)).toBe(true);
    expect(truck.x - cellX).toBeCloseTo(0.5, 9);
    const [dx, dy] = step[truck.heading];
    expect(hasRoad(cellX + dx, cellY + dy) || hasRoad(cellX - dx, cellY - dy)).toBe(true);
    // predchádzajúca poloha leží na tej istej osi (jazda po úseku, nie skok)
    expect(truck.prevX === truck.x || truck.prevY === truck.y).toBe(true);
  });

  it('kamióny sú prázdne aj naložené a idú aspoň v dvoch smeroch', () => {
    expect(F4_TRUCKS.some((truck) => truck.loaded)).toBe(true);
    expect(F4_TRUCKS.some((truck) => !truck.loaded)).toBe(true);
    expect(new Set(F4_TRUCKS.map((truck) => truck.heading)).size).toBeGreaterThanOrEqual(2);
  });

  it('kamión v zákrute (44; 28) je vo vnútri bunky zákruty, nie v jej strede (cesta zo juhu na západ)', () => {
    const turning = F4_TRUCKS.find((truck) => truck.state === 'to_bay');
    expect([Math.floor(turning?.x ?? 0), Math.floor(turning?.y ?? 0)]).toEqual([44, 28]);
    expect(turning?.y).toBeGreaterThan(28.5);
    expect(hasRoad(43, 28)).toBe(true);
    expect(hasRoad(44, 29)).toBe(true);
    expect(hasRoad(44, 27)).toBe(false);
    expect(hasRoad(45, 28)).toBe(false);
  });
});

describe('pomocné konštruktory', () => {
  it.each(ROTATIONS)('rot %i: rozmery footprintu po rotácii (2×2, 4×3, 4×2), stred stojiska aj doku leží v module', (rotation: Rotation) => {
    const gate = gateVM(1, 10, 10, rotation, { queueLength: 0, open: false });
    const waiting = waitingAreaVM(2, 20, 10, rotation, [false, true, false, false, false, false]);
    const ramp = rampVM(3, 30, 10, rotation, [1, 0], true);
    expect([gate.w, gate.h]).toEqual([2, 2]);
    expect([waiting.w, waiting.h].sort()).toEqual([3, 4]);
    expect([ramp.w, ramp.h].sort()).toEqual([2, 4]);
    for (let index = 0; index < 6; index += 1) {
      const at = stallCenter(waiting, index);
      expect(at.x).toBeGreaterThan(waiting.x);
      expect(at.x).toBeLessThan(waiting.x + waiting.w);
      expect(at.y).toBeGreaterThan(waiting.y);
      expect(at.y).toBeLessThan(waiting.y + waiting.h);
    }
    for (let index = 0; index < 2; index += 1) {
      const at = dockCenter(ramp, index);
      expect(at.x).toBeGreaterThan(ramp.x);
      expect(at.x).toBeLessThan(ramp.x + ramp.w);
      expect(at.y).toBeGreaterThan(ramp.y);
      expect(at.y).toBeLessThan(ramp.y + ramp.h);
    }
  });

  it('stred stojiska pri rot 0: x = roh + (x + w/2) / 64, y = roh + (y + h/2) / 64', () => {
    expect(stallCenter(WAITING_AREA, 0)).toEqual({ x: 33 + 28 / 64, y: 26 + 70 / 64 });
    expect(stallCenter(WAITING_AREA, 5)).toEqual({ x: 33 + 228 / 64, y: 26 + 70 / 64 });
    expect(() => stallCenter(WAITING_AREA, 6)).toThrow('stojisko');
    expect(() => dockCenter(RAMP_A, 2)).toThrow('dok');
  });

  it('truckInCell: stred bunky = bunka + 0,5; prev predvolene rovnaké; truckAt s prevHeading', () => {
    const truck = truckInCell(9, 3, 4, 180, true, 'loading');
    expect([truck.x, truck.y, truck.prevX, truck.prevY]).toEqual([3.5, 4.5, 3.5, 4.5]);
    expect([truck.heading, truck.loaded, truck.state]).toEqual([180, true, 'loading']);
    expect(truck.prevHeading).toBeUndefined();
    expect(truckAt(1, 2, 3, 90, false, 's', { x: 1, y: 3, heading: 0 }).prevHeading).toBe(0);
  });

  it('demo mriežka: štartová cesta mapy aj cesty scény sú `road`, ostatné nie', () => {
    for (const cell of map.starter.roads) expect(hasRoad(cell.x, cell.y)).toBe(true);
    expect(hasRoad(44, 30)).toBe(true);
    expect(hasRoad(40, 28)).toBe(true);
    expect(hasRoad(32, 26)).toBe(true);
    expect(hasRoad(31, 25)).toBe(true);
    expect(hasRoad(36, 24)).toBe(false);
    expect(map.createGrid().at(44, 30).road).toBe('none'); // šablóna mapy sa nemení
  });
});
