// Zlom uviaznutia (TR1-09b, dodatok ADR-037 TR1-09b): obrat uprostred úseku berie pruh cesty späť, ústup a uvoľnenie chvosta
// u nosiča a regresia stress_f6 so 16 vozidlami (pred opravou ≥ 8 vozidiel trvalo uviazlo).
import { describe, expect, it } from 'vitest';
import { takePath } from '@sim/movement';
import { loadMap, parseMapDef } from '@sim/grid';
import { carrierOverlapProblem, slotKey, trafficMetrics } from '@sim/traffic';
import { World } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';
import { BUNDLED_DEFS } from '../world/world-fixtures';
import { bodyCells, idx, keyAt, lay, line, spawn, tickTraffic, trafficBed } from './traffic-fixtures';

describe('obrat uprostred úseku berie pruh cesty späť', () => {
  it('pruh späť voľný: vozidlo sa otočí a pruh drží ako slot vpredu (nie pruh, ktorým prišlo)', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 28]));
    const v = spawn(bed, line([40, 22], [40, 28]), { speed: 0.5 });
    tickTraffic(world, 5);
    expect(v.progress).toBeGreaterThan(0);
    const cell = v.cell;
    const next = v.nextCell as number;
    takePath(world, v, [next, cell, cell - world.grid.width]);
    expect(v.cell).toBe(next);
    // do bunky `cell` ide teraz smerom na sever (vjazd z juhu): pruh 1, nie južný pruh 0
    expect(v.ahead).toEqual([slotKey(cell, 1)]);
    expect(carrierOverlapProblem(world)).toBeNull();
  });

  it('pruh späť obsadený protiidúcim vozidlom: vozidlo sa neotáča, úsek dokončí a vráti sa z nextCell', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 28]));
    const v = spawn(bed, line([40, 22], [40, 28]), { speed: 0.5 });
    tickTraffic(world, 5);
    const cell = v.cell;
    const next = v.nextCell as number;
    const at: [number, number] = [cell % world.grid.width, Math.floor(cell / world.grid.width)];
    const blocker = spawn(bed, [at], { length: 1, body: [slotKey(cell, 1)] });
    expect(world.laneSlots.holderOfKey(slotKey(cell, 1))).toBe(blocker.id);
    takePath(world, v, [next, cell, cell - world.grid.width]);
    expect(v.cell).toBe(cell);
    expect(v.nextCell).toBe(next);
    expect(v.remainingRoute()).toEqual([cell, next, cell, cell - world.grid.width]);
    expect(carrierOverlapProblem(world)).toBeNull();
  });
});

describe('Carrier.retreat a dropTail', () => {
  it('ústup uvoľní slot hlavy, vozidlo je na druhej bunke tela a doterajšia bunka je prvá bunka zvyšku trasy', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 28]));
    const v = spawn(bed, line([40, 24], [40, 28]), { body: [keyAt(world, [40, 24], 1), keyAt(world, [40, 23], 1)] });
    world.laneSlots.claim(keyAt(world, [40, 24], 1), v.id);
    world.laneSlots.claim(keyAt(world, [40, 23], 1), v.id);
    v.attachSlots(world.laneSlots);
    v.retreat(world.grid.width);
    expect(bodyCells(world, v)).toEqual([[40, 23]]);
    expect(v.cell).toBe(idx(world, [40, 23]));
    expect(v.remainingRoute().slice(0, 2)).toEqual([idx(world, [40, 23]), idx(world, [40, 24])]);
    expect(world.laneSlots.holderOfKey(keyAt(world, [40, 24], 1))).toBe(0);
    expect(world.laneSlots.holderOfKey(keyAt(world, [40, 23], 1))).toBe(v.id);
  });

  it('dropTail uvoľní len posledný slot tela', () => {
    const bed = trafficBed();
    const { world } = bed;
    lay(world, line([40, 22], [40, 28]));
    const body = [keyAt(world, [40, 24], 1), keyAt(world, [40, 23], 1)];
    const v = spawn(bed, line([40, 24], [40, 28]), { body });
    v.dropTail();
    expect(v.body).toEqual([body[0]]);
    expect(world.laneSlots.holderOfKey(body[1])).toBe(0);
    expect(world.laneSlots.holderOfKey(body[0])).toBe(v.id);
  });
});

describe('stress_f6 so 16 vozidlami dobehne bez trvalého uviaznutia', () => {
  it('16 vozidiel: po 30 000 tickoch stuckAtEnd 0, nič sa nestratilo, sloty sú konzistentné, export je blízko stavu pred R1', () => {
    const scenario = loadScenarioFile('stress_f6');
    const buys = scenario.commands.filter((entry) => (entry.command as { type: string }).type === 'BuyVehicle');
    expect(buys).toHaveLength(16);
    const world = World.create(BUNDLED_DEFS, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed);
    runScenario(world, scenario, 30_000, {});
    expect(world.vehicles.size).toBe(16);
    const metrics = trafficMetrics(world);
    expect(metrics.jammed).toBe(0);
    expect(carrierOverlapProblem(world)).toBeNull();
    assertCargoConservation(world);
    expect(world.assertInvariants()).toBeUndefined();
    // pred R1: 656 exportovaných jednotiek; s dopravou bez prekrývania menej, ale rádovo rovnako (nie 7 ako pri uviaznutí)
    expect(world.cargo.exportedCount).toBeGreaterThan(400);
  }, 120_000);
});
