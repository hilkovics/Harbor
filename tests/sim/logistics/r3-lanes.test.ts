// Jednosmerné pruhy kotviska 8 × 4 a RTG bloku (TR3-02, ADR-040): smer krokov (`QuayLanes.stepAllowed`), pomocník `moduleLanes` pre VM, ťahač vchádza do pruhu RTG bloku
// a stojí na TP, poloha vozíka a náklad žeriava (`craneTrolley`, `craneCargo`).
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { loadMap, parseMapDef } from '@sim/grid';
import { moduleLanes, terminalMetrics } from '@sim/logistics';
import { BerthModule, CraneModule, RtgBlock, craneCargo, craneTrolley } from '@sim/modules';
import { RtgCrane } from '@sim/machines';
import { World } from '@sim/world';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { offerTranship } from '../helpers/f6c';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const ECONOMY = { transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };

function scenarioWorld(): World {
  const scenario = loadScenarioFile('tt_rtg');
  const world = World.create(hookDefs(0, { economy: ECONOMY }), loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed, { checkInvariants: true });
  runScenario(world, scenario, 1);
  return world;
}

const berthOf = (world: World): BerthModule => [...world.modules.values()].find((module): module is BerthModule => module instanceof BerthModule) as BerthModule;
const blockOf = (world: World): RtgBlock => [...world.modules.values()].find((module): module is RtgBlock => module instanceof RtgBlock) as RtgBlock;
const indexOf = (world: World, x: number, y: number): number => y * world.grid.width + x;

describe('kotvisko 8 × 4: dva jednosmerné pruhy pod žeriavom a obchádzka', () => {
  const world = scenarioWorld();
  const berth = berthOf(world);

  it('def: footprint 8 × 4, pevninské riadky smú byť pevnina; riadok pri vode nie je jazdný', () => {
    expect(berth.def.footprint).toEqual({ w: 8, h: 4 });
    expect(berth.size).toEqual({ w: 8, h: 4 });
    const owners = world.quay.owners();
    for (let x = berth.origin.x; x < berth.origin.x + 8; x++) {
      expect(owners[indexOf(world, x, berth.origin.y)], `riadok pri vode (${String(x)})`).toBe(0);
      for (let row = 1; row < 4; row++) expect(owners[indexOf(world, x, berth.origin.y + row)]).toBe(berth.id);
    }
  });

  it('moduleLanes: 3 riadky × 8 buniek smerom `E`; pevninský riadok je obchádzka (`bypass`), dva riadky pod žeriavom `lane`', () => {
    const lanes = moduleLanes(berth);
    expect(lanes).toHaveLength(24);
    expect(new Set(lanes.map((cell) => cell.dir))).toEqual(new Set(['E']));
    const roleOfRow = (row: number) => new Set(lanes.filter((cell) => cell.y === berth.origin.y + row).map((cell) => cell.role));
    expect(roleOfRow(1)).toEqual(new Set(['lane']));
    expect(roleOfRow(2)).toEqual(new Set(['lane']));
    expect(roleOfRow(3)).toEqual(new Set(['bypass']));
    expect(lanes.some((cell) => cell.y === berth.origin.y)).toBe(false);
  });

  it('stepAllowed: pozdĺž pruhu (E) a kolmo medzi pruhmi áno, proti smeru (W) nie; vstup z cesty zľava a zdola áno, zprava nie', () => {
    const { x, y } = berth.origin;
    const at = (dx: number, dy: number): number => indexOf(world, x + dx, y + dy);
    const quay = world.quay;
    expect(quay.stepAllowed(at(2, 2), at(3, 2), 1)).toBe(true);
    expect(quay.stepAllowed(at(3, 2), at(2, 2), 3)).toBe(false);
    // Kolmý prejazd medzi pruhmi: v prvej polovici kotviska (pozdĺž pruhov) len k vode (sever), v druhej len k pevnine (juh) — čelné stretnutie v jednej bunke je vylúčené.
    expect(quay.stepAllowed(at(3, 3), at(3, 2), 0)).toBe(true);
    expect(quay.stepAllowed(at(3, 2), at(3, 3), 2)).toBe(false);
    expect(quay.stepAllowed(at(5, 2), at(5, 3), 2)).toBe(true);
    expect(quay.stepAllowed(at(5, 3), at(5, 2), 0)).toBe(false);
    expect(quay.stepAllowed(at(-1, 3), at(0, 3), 1)).toBe(true);
    expect(quay.stepAllowed(at(0, 3), at(-1, 3), 3)).toBe(false);
    expect(quay.stepAllowed(at(8, 3), at(7, 3), 3)).toBe(false);
    expect(quay.stepAllowed(at(7, 3), at(8, 3), 1)).toBe(true);
    expect(quay.stepAllowed(at(1, 4), at(1, 3), 0)).toBe(true); // vjazd z južného konektora v prvej polovici
    expect(quay.stepAllowed(at(6, 3), at(6, 4), 2)).toBe(true); // výjazd južným konektorom v druhej polovici
    expect(quay.stepAllowed(at(6, 4), at(6, 3), 0)).toBe(false); // vjazd tam nie je
  });
});

describe('RTG blok: pruh pre ťahače', () => {
  const world = scenarioWorld();
  const block = blockOf(world);

  it('pruh má bunku pri každom bayi (od vjazdu k výjazdu) a jeden povolený smer `S`', () => {
    const lane = world.quay.laneCellsOf(block.id);
    expect(lane).toBeDefined();
    expect(lane).toHaveLength(12);
    const cells = moduleLanes(block);
    expect(cells).toHaveLength(12);
    expect(cells.map((cell) => indexOf(world, cell.x, cell.y))).toEqual([...(lane as Int32Array)]);
    expect(new Set(cells.map((cell) => cell.dir))).toEqual(new Set(['S']));
    const mid = (lane as Int32Array)[5];
    expect(world.quay.stepAllowed(mid, (lane as Int32Array)[6], 2)).toBe(true);
    expect(world.quay.stepAllowed((lane as Int32Array)[6], mid, 0)).toBe(false);
    expect(world.quay.stepAllowed(mid, mid + 1, 1)).toBe(false); // bočný východ z pruhu na susednú cestu
    expect(world.quay.stepAllowed(mid + 1, mid, 3)).toBe(false); // bočný vstup do pruhu z cesty
  });

  it('ťahač vchádza do pruhu: pri odovzdaní RTG stojí na bunke pruhu (nie na vonkajšej bunke konektora) a po uložení pokračuje pruhom k výjazdu', () => {
    const run = scenarioWorld();
    const contract = offerTranship(run, { units: 12 });
    send(run, acceptCommand(contract.id));
    const lane = run.quay.laneCellsOf(blockOf(run).id) as Int32Array;
    const machine = [...run.machines.values()][0] as RtgCrane;
    const standing = new Set<number>();
    const visited = new Set<number>();
    let released = 0;
    for (let i = 0; i < 60_000 && machine.moves < 24; i++) {
      run.tick();
      // Ťahač je voľný hneď po zdvihu RTG (put): cyklus pokračuje bez vozidla a jobu, jednotka je v in_handler a nemá job.
      const cycle = machine.cycle;
      if (cycle?.kind === 'put' && cycle.vehicleId === null) {
        released += 1;
        expect(cycle.jobId).toBeNull();
        expect(run.jobOfUnit(cycle.unitId as EntityId)).toBeUndefined();
        expect(run.cargo.get(cycle.unitId as EntityId)?.location.kind).toBe('in_handler');
      }
      for (const vehicle of run.vehicles.values()) {
        if (lane.includes(vehicle.cell)) visited.add(lane.indexOf(vehicle.cell));
        if ((vehicle.state === 'unloading' || vehicle.state === 'loading') && machine.cycle?.vehicleId === vehicle.id) standing.add(lane.indexOf(vehicle.cell));
      }
    }
    expect(machine.moves).toBeGreaterThanOrEqual(24);
    expect(released).toBeGreaterThan(0);
    expect([...standing].every((bay) => bay >= 0)).toBe(true);
    expect(visited.size).toBeGreaterThan(1);
  });
});

describe('žeriav STS: poloha vozíka a náklad pre VM', () => {
  it('vozík 0 … 1 počas cyklu a náklad = držaná jednotka; mimo cyklu pri háku (1) a bez nákladu', () => {
    const world = scenarioWorld();
    const crane = [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
    expect(craneTrolley(crane)).toBe(1);
    expect(craneCargo(crane)).toBeNull();
    const contract = offerTranship(world, { units: 6 });
    send(world, acceptCommand(contract.id));
    const seen = new Set<string>();
    for (let i = 0; i < 40_000 && crane.moves < 3; i++) {
      world.tick();
      const trolley = craneTrolley(crane);
      expect(trolley).toBeGreaterThanOrEqual(0);
      expect(trolley).toBeLessThanOrEqual(1);
      if (crane.state === 'placing' || crane.state === 'grabbing') seen.add(`${crane.state}:${trolley === 0 ? 'sea' : trolley === 1 ? 'land' : 'mid'}`);
      if (crane.heldUnitId !== null) expect(craneCargo(crane)).toBe(crane.heldUnitId as EntityId);
    }
    expect(seen.has('placing:mid')).toBe(true);
    expect(crane.moves).toBeGreaterThanOrEqual(3);
  });
});

describe('terminalMetrics', () => {
  it('po prekládke 24 TEU: presuny STS a RTG za hodinu > 0, čakanie STS na ťahač je podiel v percentách', () => {
    const world = scenarioWorld();
    const contract = offerTranship(world, { units: 24 });
    send(world, acceptCommand(contract.id));
    for (let i = 0; i < 60_000 && world.cargo.shippedCount < 24; i++) world.tick();
    const metrics = terminalMetrics(world);
    expect(metrics.stsMoves).toBe(48);
    expect(metrics.rtgMoves).toBe(48);
    expect(metrics.stsMovesPerHour).toBeCloseTo(48 / metrics.hours, 6);
    expect(metrics.rtgMovesPerHour).toBeCloseTo(48 / metrics.hours, 6);
    expect(metrics.stsWaitForTractorPct).not.toBeNull();
    expect(metrics.stsWaitForTractorPct as number).toBeGreaterThanOrEqual(0);
  });

  it('bez presunov: 0 za hodinu a bez práce žeriavov `null`', () => {
    const metrics = terminalMetrics(scenarioWorld());
    expect([metrics.stsMovesPerHour, metrics.rtgMovesPerHour, metrics.stsWaitForTractorPct]).toEqual([0, 0, null]);
  });
});
