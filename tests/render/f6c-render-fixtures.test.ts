// Konzistencia scén demo F6c (`src/render/__demo__/f6c-render.fixtures.ts`): moduly sa neprekrývajú, cesty nevedú cez moduly a
// stoja pri konektoroch, lode ležia na vode a navzájom sa neprekrývajú, polia VM (`cargoSplit.empty`, `apron.units[].empty`,
// `ramp.stagedEmpty`, `depot`, `carriesEmpty`) sedia na manifest a pravidlá F6c.
import { describe, expect, it } from 'vitest';
import { Grid, TERRAIN_TRAITS, loadBundledMap } from '@sim/grid';
import {
  COMPARE_YARD,
  DECK_ROW,
  DEPOT,
  DEPOT_CLEAN,
  DEPOT_SCENE,
  DOCKED_FEEDER,
  F6C_SCENES,
  RAMP,
  RAMP_SCENE,
  SHIPS_BERTH,
  SHIPS_SCENE,
  craneLoadingEmpty,
  craneLoadingFull,
  truckInCell,
  vehicleAt,
} from '@render/__demo__/f6c-render.fixtures';
import { createT5b03Grid, type T5b03Scene } from '@render/__demo__/t5b03-render.fixtures';
import { moduleSprite, shipDeck, vehicleSprite } from '@render/entity-assets';
import { worldConnectors } from '@render/module-connectors';
import { LINE_COLOR_TOKENS } from '@render/tokens';
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

describe.each(Object.entries(F6C_SCENES))('scéna %s', (_name, scene: T5b03Scene) => {
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

  it('konektory skladov a rampy majú vonkajšiu bunku na ceste scény', () => {
    const roads = new Set(scene.roads.map((cell) => `${String(cell.x)},${String(cell.y)}`));
    for (const module of scene.vm.modules.filter((candidate) => candidate.kind === 'storage' || candidate.kind === 'ramp')) {
      for (const connector of worldConnectors(module)) {
        const outside = { x: connector.x + (connector.side === 'e' ? 1 : connector.side === 'w' ? -1 : 0), y: connector.y + (connector.side === 's' ? 1 : connector.side === 'n' ? -1 : 0) };
        expect(roads.has(`${String(outside.x)},${String(outside.y)}`), `modul ${String(module.id)}: vonkajšia bunka (${String(outside.x)}; ${String(outside.y)})`).toBe(true);
      }
    }
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

  it('vozidlá a kamióny majú sprite v manifeste a stoja na ceste scény', () => {
    const roads = new Set(scene.roads.map((cell) => `${String(cell.x)},${String(cell.y)}`));
    for (const vehicle of [...(scene.vm.vehicles ?? []), ...(scene.vm.trucks ?? [])]) {
      expect(vehicleSprite(vehicle.defId), vehicle.defId).toBeDefined();
      expect(roads.has(`${String(Math.floor(vehicle.x))},${String(Math.floor(vehicle.y))}`), `vozidlo ${String(vehicle.id)}`).toBe(true);
    }
  });
});

describe('scéna ships', () => {
  it('loď pri berthe nesie import, export aj prázdne; súčty smerov = jednotky na palube, v kapacite lode', () => {
    for (const ship of [DOCKED_FEEDER, ...DECK_ROW]) {
      expect(shipDeck(ship.classId), `trieda ${ship.classId} nemá paluby`).toBeDefined();
      const split = ship.cargoSplit;
      expect((split?.import ?? 0) + (split?.export ?? 0) + (split?.empty ?? 0)).toBe(ship.unitsOnBoard);
      expect(ship.unitsOnBoard).toBeLessThanOrEqual(ship.capacityUnits);
    }
    expect(DOCKED_FEEDER.cargoSplit).toEqual({ import: 40, export: 20, empty: 20 });
  });

  it('rad lodí pokrýva import + prázdne, export + prázdne, len prázdne a všetky tri smery', () => {
    const kinds = DECK_ROW.map((ship) => [(ship.cargoSplit?.import ?? 0) > 0, (ship.cargoSplit?.export ?? 0) > 0, (ship.cargoSplit?.empty ?? 0) > 0]);
    expect(kinds).toEqual([
      [true, false, true],
      [false, true, true],
      [false, false, true],
      [true, true, true],
    ]);
  });

  it('berth: prázdne jednotky majú farbu linky z paliet, plné nie; sloty sú v manifeste', () => {
    const entry = moduleSprite(SHIPS_BERTH.defId);
    const units = SHIPS_BERTH.apron?.units ?? [];
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect(entry?.apronSlots?.[unit.slot]).toBeDefined();
      if (unit.empty === true) expect(LINE_COLOR_TOKENS).toContain(unit.lineToken);
      else expect(unit.lineToken).toBeUndefined();
    }
    expect(units.some((unit) => unit.empty === true)).toBe(true);
    expect(units.some((unit) => unit.empty !== true)).toBe(true);
    expect(new Set(units.map((unit) => unit.unitId)).size).toBe(units.length);
  });

  it('žeriav nakladá prázdny alebo plný kontajner na berthe', () => {
    expect(craneLoadingEmpty().holding?.empty).toBe(true);
    expect(craneLoadingFull().holding?.empty).toBeUndefined();
    expect(craneLoadingEmpty().berthId).toBe(SHIPS_BERTH.id);
    expect(SHIPS_SCENE.vm.cranes[0].cycle).toBe('load');
  });
});

describe('scéna depot', () => {
  it('depo nesie stav kontroly v rozsahu depa (kapacita z manifestu, miesta opráv ≥ v oprave)', () => {
    const entry = moduleSprite(DEPOT.defId);
    const capacity = (entry?.slots ?? 0) * (entry?.layers ?? 0);
    for (const depot of [DEPOT, DEPOT_CLEAN]) {
      expect(depot.storage?.capacity).toBe(capacity);
      const state = depot.depot;
      expect(state).toBeDefined();
      expect((state?.available ?? 0) + (state?.damaged ?? 0) + (state?.inRepair ?? 0)).toBeLessThanOrEqual(depot.storage?.stored ?? 0);
      expect(state?.inRepair ?? 0).toBeLessThanOrEqual(state?.repairBays ?? 0);
    }
    expect(DEPOT.depot?.damaged).toBeGreaterThan(0);
    expect(DEPOT.depot?.inRepair).toBeGreaterThan(0);
    expect(DEPOT_CLEAN.depot?.damaged).toBe(0);
    expect(COMPARE_YARD.depot).toBeUndefined();
    expect(COMPARE_YARD.defId).toBe('container_yard_small');
  });

  it('vozidlá: empty handler s kontajnerom aj bez, straddle carrier s prázdnym aj plným kontajnerom a kamión s prázdnym', () => {
    const vehicles = DEPOT_SCENE.vm.vehicles ?? [];
    const handlers = vehicles.filter((vehicle) => vehicle.defId === 'empty_handler');
    expect(handlers.map((vehicle) => vehicle.loaded)).toEqual([false, true]);
    expect(handlers.find((vehicle) => vehicle.loaded)?.carriesEmpty).toBe(true);
    const carriers = vehicles.filter((vehicle) => vehicle.defId === 'straddle_carrier');
    expect(carriers.map((vehicle) => vehicle.carriesEmpty === true)).toEqual([true, false]);
    expect((DEPOT_SCENE.vm.trucks ?? []).every((truck) => truck.loaded && truck.carriesEmpty === true)).toBe(true);
  });

  it('stavitelia vozidiel nastavia `carriesEmpty` len na požiadanie', () => {
    expect(vehicleAt(1, 'empty_handler', 1, 1, 0, true).carriesEmpty).toBeUndefined();
    expect(vehicleAt(1, 'empty_handler', 1, 1, 0, true, true).carriesEmpty).toBe(true);
    expect(truckInCell(2, 1, 1, 90, true, 'to_gate_out').carriesEmpty).toBeUndefined();
    expect(truckInCell(2, 1, 1, 90, true, 'to_gate_out', true).carriesEmpty).toBe(true);
  });
});

describe('scéna ramp', () => {
  it('prázdne na doku nie sú viac než pripravené jednotky; rampa je prevádzková a pri ceste', () => {
    const { ramp } = RAMP;
    expect(ramp?.operational).toBe(true);
    ramp?.staged.forEach((staged, dock) => {
      expect(ramp.stagedEmpty?.[dock] ?? 0).toBeLessThanOrEqual(staged);
    });
    expect(ramp?.stagedEmpty).toEqual([1, 2]);
    expect(RAMP_SCENE.roads.length).toBeGreaterThan(0);
  });

  it('kamióny: jeden s prázdnym kontajnerom (príchod), druhý s plným (odchod)', () => {
    const [arriving, leaving] = RAMP_SCENE.vm.trucks ?? [];
    expect([arriving?.loaded, arriving?.carriesEmpty]).toEqual([true, true]);
    expect([leaving?.loaded, leaving?.carriesEmpty]).toEqual([true, undefined]);
  });
});
