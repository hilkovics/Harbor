// Konzistencia scén demo F6a (`src/render/__demo__/f6a-render.fixtures.ts`): moduly sa neprekrývajú, lode ležia na vode a
// navzájom sa neprekrývajú, polia VM (`cargoSplit`, `lashing`, `held`, `cycle`) sedia na manifest a pravidlá F6a.
import { describe, expect, it } from 'vitest';
import { Grid, TERRAIN_TRAITS, loadBundledMap } from '@sim/grid';
import { CRANE_CYCLES } from '@sim/modules';
import {
  CRANE_ID,
  DECK_ROW,
  DOCK_SCENE,
  DOCK_SIDE_CELL,
  DOCK_STRAIGHT_CELL,
  DOCKED_FEEDER,
  EXPORT_TRUCK_SIDE,
  EXPORT_TRUCK_STRAIGHT,
  F6A_SCENES,
  HOLD_SCENE,
  LASHING_HANDY,
  SHIPS_SCENE,
  craneAt,
  dockRamp,
  dockScene,
  exportTruckArriving,
  exportTruckDual,
  exportTruckLeaving,
  exportTruckUnloading,
} from '@render/__demo__/f6a-render.fixtures';
import { createT5b03Grid, type T5b03Scene } from '@render/__demo__/t5b03-render.fixtures';
import { shipDeck, moduleSprite } from '@render/entity-assets';
import { dockCenter } from '@render/module-slots';
import { deckSlots } from '@render/ship-deck';
import type { ModuleVM, ShipVM } from '@render/view-models';

const map = loadBundledMap();

function footprint(module: ModuleVM): string[] {
  const cells: string[] = [];
  for (let y = module.y; y < module.y + module.h; y++) for (let x = module.x; x < module.x + module.w; x++) cells.push(`${String(x)},${String(y)}`);
  return cells;
}

function shipCells(ship: ShipVM): [number, number][] {
  const sideways = ship.heading === 90 || ship.heading === 270;
  const w = sideways ? ship.lengthCells : ship.widthCells;
  const h = sideways ? ship.widthCells : ship.lengthCells;
  const cells: [number, number][] = [];
  for (let y = Math.floor(ship.y - h / 2); y < Math.ceil(ship.y + h / 2); y++) for (let x = Math.floor(ship.x - w / 2); x < Math.ceil(ship.x + w / 2); x++) cells.push([x, y]);
  return cells;
}

describe.each(Object.entries(F6A_SCENES))('scéna %s', (_name, scene: T5b03Scene) => {
  const grid: Grid = createT5b03Grid(map, scene);

  it('moduly sa neprekrývajú a cesty nevedú cez moduly', () => {
    const used = new Set<string>();
    for (const module of scene.vm.modules) {
      for (const cell of footprint(module)) {
        expect(used.has(cell), `bunka ${cell} je v dvoch moduloch`).toBe(false);
        used.add(cell);
      }
    }
    for (const road of scene.roads) expect(used.has(`${String(road.x)},${String(road.y)}`)).toBe(false);
  });

  it('lode ležia celé na vode a neprekrývajú sa navzájom', () => {
    const used = new Set<string>();
    for (const ship of scene.vm.ships) {
      for (const [x, y] of shipCells(ship)) {
        expect(TERRAIN_TRAITS[grid.at(x, y).terrain].water, `loď ${String(ship.id)} na (${String(x)}; ${String(y)}) nie je na vode`).toBe(true);
        const key = `${String(x)},${String(y)}`;
        expect(used.has(key), `bunka ${key} je v dvoch lodiach`).toBe(false);
        used.add(key);
      }
    }
  });

  it('VM polia F6a sedia na manifest: cargoSplit na lodi s palubou, held v rozsahu modulu, cycle zo simu', () => {
    for (const ship of scene.vm.ships) {
      if (ship.cargoSplit !== undefined) {
        expect(shipDeck(ship.classId), `trieda ${ship.classId} nemá paluby`).toBeDefined();
        expect(ship.cargoSplit.import + ship.cargoSplit.export).toBe(ship.unitsOnBoard);
        expect(ship.unitsOnBoard).toBeLessThanOrEqual(ship.capacityUnits);
      }
      if (ship.state === 'lashing') {
        expect(ship.lashing).toBeDefined();
        expect(ship.lashing?.ticksLeft).toBeGreaterThanOrEqual(1);
        expect(ship.lashing?.ticksLeft).toBeLessThanOrEqual(ship.lashing?.ticksTotal ?? 0);
      }
    }
    for (const module of scene.vm.modules) {
      const held = module.held;
      if (held === undefined) continue;
      const entry = moduleSprite(module.defId);
      expect(held.count).toBeGreaterThan(0);
      if (held.docks !== undefined) {
        expect(held.docks.length).toBeLessThanOrEqual(entry?.docks?.length ?? 0);
        expect(held.docks.reduce((sum, count) => sum + count, 0)).toBe(held.count);
        held.docks.forEach((count, dock) => {
          expect(count, `dok ${String(dock)}: jednotka v hold musí byť medzi pripravenými`).toBeLessThanOrEqual(module.ramp?.staged[dock] ?? 0);
        });
      }
      for (const slot of held.slots ?? []) {
        expect(module.apron?.units.some((unit) => unit.slot === slot), `slot ${String(slot)} nemá jednotku`).toBe(true);
        expect(entry?.apronSlots?.[slot]).toBeDefined();
      }
    }
    for (const crane of scene.vm.cranes) expect(crane.cycle === undefined || CRANE_CYCLES.includes(crane.cycle)).toBe(true);
  });
});

describe('scéna ships', () => {
  it('loď pri berthe nesie import aj export, handy je v lashingu s exportom, rad lodí pokrýva prázdnu / import / export / zmiešanú', () => {
    expect(DOCKED_FEEDER.cargoSplit).toEqual({ import: 40, export: 20 });
    expect(LASHING_HANDY.state).toBe('lashing');
    expect(LASHING_HANDY.cargoSplit?.import).toBe(0);
    const splits = DECK_ROW.map((ship) => ship.cargoSplit);
    expect(splits[0]).toEqual({ import: 0, export: 0 });
    expect(splits[1]?.export).toBe(0);
    expect(splits[2]?.import).toBe(0);
    expect(splits[3]?.import).toBeGreaterThan(0);
    expect(splits[3]?.export).toBeGreaterThan(0);
  });

  it('palubné kontajnery handy lode sú v jej obryse (miesta z manifestu)', () => {
    const slots = deckSlots('handy', 64) ?? [];
    expect(slots).toHaveLength(14);
  });

  it('žeriav pri nakládke drží jednotku v placing a nič v grabbing; stojí na berthe', () => {
    const [berth] = SHIPS_SCENE.vm.modules;
    const placing = craneAt('placing', 0.5, 'load', true);
    expect(placing.id).toBe(CRANE_ID);
    expect(placing.berthId).toBe(berth.id);
    expect(placing.cycle).toBe('load');
    expect(placing.holding).not.toBeNull();
    expect(craneAt('grabbing', 0.5, 'load').holding).toBeNull();
    expect(SHIPS_SCENE.vm.cranes[0].cycle).toBe('load');
  });
});

describe('scéna dock', () => {
  const ramp = DOCK_SCENE.vm.modules.find((module) => module.kind === 'ramp' && module.id === 3);

  it('exportné kamióny prichádzajú naložené na vonkajšie bunky konektorov', () => {
    const [side, straight] = DOCK_SCENE.vm.trucks ?? [];
    expect([side?.id, straight?.id]).toEqual([EXPORT_TRUCK_SIDE, EXPORT_TRUCK_STRAIGHT]);
    for (const truck of [side, straight]) {
      expect(truck?.loaded).toBe(true);
      expect(truck?.state).toBe('to_dock');
    }
    expect([side?.x, side?.y, side?.heading]).toEqual([DOCK_SIDE_CELL.x + 0.5, DOCK_SIDE_CELL.y + 0.5, DOCK_SIDE_CELL.heading]);
    expect([straight?.x, straight?.y, straight?.heading]).toEqual([DOCK_STRAIGHT_CELL.x + 0.5, DOCK_STRAIGHT_CELL.y + 0.5, DOCK_STRAIGHT_CELL.heading]);
  });

  it('vykládka: cieľ v strede docku s kabínou na juh, approach = sim poloha na vonkajšej bunke, prevState to_dock', () => {
    if (ramp === undefined) throw new Error('rampa');
    for (const [dock, cell] of [
      [0, DOCK_SIDE_CELL],
      [1, DOCK_STRAIGHT_CELL],
    ] as const) {
      const truck = exportTruckUnloading(7, cell.x, cell.y, cell.heading, dock, true);
      const at = dockCenter(ramp, dock);
      expect(truck.state).toBe('unloading');
      expect(truck.prevState).toBe('to_dock');
      expect([truck.x, truck.y, truck.heading]).toEqual([at.x, at.y, 180]);
      expect(truck.approach).toEqual({ x: cell.x + 0.5, y: cell.y + 0.5, heading: cell.heading });
      expect(truck.loaded).toBe(true);
      expect(exportTruckUnloading(7, cell.x, cell.y, cell.heading, dock, false).loaded).toBe(false);
    }
  });

  it('odchod prázdny alebo s importom; dual transaction ostáva v doku v stave loading po unloading', () => {
    expect(exportTruckLeaving(7, 31.5, 25.5, 90).loaded).toBe(false);
    expect(exportTruckLeaving(7, 31.5, 25.5, 90, true).loaded).toBe(true);
    expect(exportTruckLeaving(7, 31.5, 25.5, 90).prevState).toBe('unloading');
    const dual = exportTruckDual(7, DOCK_STRAIGHT_CELL.x, DOCK_STRAIGHT_CELL.y, DOCK_STRAIGHT_CELL.heading, 1, false);
    expect([dual.state, dual.prevState]).toEqual(['loading', 'unloading']);
    expect(dual.approach).toBeDefined();
    expect(exportTruckArriving(8, 31, 25, 270).loaded).toBe(true);
  });

  it('rampa nesie jednotku v hold na doku 0 a staged sa dá meniť spolu s kamiónom', () => {
    expect(dockRamp([2, 1]).ramp?.staged).toEqual([2, 1]);
    expect(dockRamp([1, 0]).held).toEqual({ count: 1, docks: [1, 0] });
    expect(() => dockRamp([0, 1])).toThrow('staged[0]');
    expect(dockScene([], [2, 0]).vm.modules.find((module) => module.id === 3)?.ramp?.staged).toEqual([2, 0]);
  });
});

describe('scéna hold', () => {
  it('sklad s odznakom (3), rampa pri dokoch (2 + 1) a berth so slotom v hold; sklad a rampa stoja pri ceste', () => {
    const [berth, yard, ramp] = HOLD_SCENE.vm.modules;
    expect(berth.held?.slots).toEqual([2]);
    expect(yard.held).toEqual({ count: 3 });
    expect(ramp.held).toEqual({ count: 3, docks: [2, 1] });
    expect(HOLD_SCENE.roads.length).toBeGreaterThan(0);
  });
});
