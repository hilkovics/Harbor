// Opravy sim-review R4 (TR4-06b): def-ová dĺžka státia a strop dual transaction, prednosť kamiónov z odstavnej plochy pred novými pri rezervácii TP, index obsadenia (zhoda so skenom),
// plná predbránová plocha pri príchode (`no_path`, nie ticho na ceste).
import { describe, expect, it, vi } from 'vitest';
import { holdingParams } from '@sim/defs';
import { YardBlock } from '@sim/modules';
import { reserveToken } from '@sim/trucks/destination';
import { stopReady } from '@sim/trucks/stop-ready';
import { tpCellsOf } from '@sim/trucks/tp-points';
import { assertCargoConservation } from '../helpers/invariants';
import { GATES_DEFS, gatesWorld, stageUnits } from '../helpers/r4-gates-layout';

describe('hodnoty z defov (nie magické čísla)', () => {
  it('dĺžka státia je param truck_holding a strop dual transaction je logistics.dualCandidateLimit', () => {
    expect(holdingParams(GATES_DEFS.modules.get('truck_holding')).stallLengthCells).toBe(3);
    expect(GATES_DEFS.logistics.dualCandidateLimit).toBe(64);
    const { holdings } = gatesWorld(40);
    const a = holdings[0].stallCell(0);
    const b = holdings[0].stallCell(holdings[0].params.stalls > 3 ? 3 : 0);
    expect(Number.isInteger(a.x) && Number.isInteger(b.y)).toBe(true);
  });
});

describe('index obsadenia a prednosť čakajúcich', () => {
  it('index zodpovedá skenu kamiónov v každom ticku a nový záujemca nezoberie TP, na ktoré čaká pripravený kamión z odstavnej plochy', () => {
    const layout = gatesWorld(41);
    const { world } = layout;
    stageUnits(layout, 120);
    let guarded = 0;
    for (let tick = 0; tick < 1500; tick++) {
      world.tick();
      assertCargoConservation(world);
      for (const truck of world.trucks.values()) {
        if (truck.tpCell !== null) expect(world.truckIndex.tpHolder(truck.tpCell)?.id).toBe(truck.id);
        if (truck.holdingId !== null && truck.stall !== null) expect(world.truckIndex.stallHolder(truck.holdingId, truck.stall)?.id).toBe(truck.id);
      }
      for (const yard of layout.yards) {
        if (!(yard instanceof YardBlock)) continue;
        const ready = world.truckIndex.holdingFor(yard.id).filter((truck) => stopReady(world, truck)).length;
        if (ready === 0) continue;
        const free = tpCellsOf(world, yard).filter((cell) => world.truckIndex.tpHolder(cell) === undefined).length;
        const token = reserveToken(world, yard, undefined, false);
        if (free <= ready) {
          expect(token, `blok #${String(yard.id)}: voľné ${String(free)} ≤ čakajúce ${String(ready)}`).toBeNull();
          guarded += 1;
        }
      }
    }
    expect(guarded).toBeGreaterThan(0);
  });
});

describe('plná predbránová plocha pri príchode', () => {
  it('kamión, ktorý dorazí k plnej ploche, prejde do no_path (nestojí ticho na ceste)', () => {
    const layout = gatesWorld(42);
    const { world, buffers } = layout;
    stageUnits(layout, 6);
    let victim: number | undefined;
    for (let tick = 0; tick < 400 && victim === undefined; tick++) {
      world.tick();
      for (const truck of world.trucks.values()) if (truck.state === 'to_pre_gate') victim = truck.id;
    }
    expect(victim).toBeDefined();
    const truck = world.trucks.get(victim as never);
    const buffer = buffers.find((candidate) => candidate.id === truck?.preGateId);
    expect(buffer).toBeDefined();
    // Prestavba: plocha je pri príchode plná (rezervácia miesta to inak nepripustí).
    if (buffer !== undefined) vi.spyOn(buffer, 'shortestRow').mockReturnValue(-1);
    for (let tick = 0; tick < 400 && truck?.state === 'to_pre_gate'; tick++) world.tick();
    expect(truck?.state).toBe('no_path');
    expect(truck?.resume).toBe('to_pre_gate');
  });
});
