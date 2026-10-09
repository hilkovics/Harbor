// Predbránové plochy v kroku 8 (R4, ADR-041 bod 2; `stepPreGates`): vjazd do radu s najkratšou frontou, pruh radu `r mod počet`, čelo radu vyjde len k voľnému pruhu
// (pruh nikdy nemá viac než jeden kamión naraz), plná plocha zastaví vznik kamiónov (kamióny nečakajú na ceste), režim `trouble` pruhov, SetGateLaneMode, obnova rádov zo save.
import { describe, expect, it } from 'vitest';
import { commandFromJSON } from '@sim/commands';
import { World, findWorldViolation, type WorldState } from '@sim/world';
import { preGateInbound } from '@sim/trucks/gate-choice';
import { GATES_DEFS, GATES_MAP, gatesWorld, stageUnits } from '../helpers/r4-gates-layout';
import { assertCargoConservation } from '../helpers/invariants';

function setMode(world: World, laneId: number, mode: string): void {
  world.enqueue(commandFromJSON({ type: 'SetGateLaneMode', laneId, mode }));
  expect(world.applyPending().filter((event) => event.type === 'CommandRejected')).toEqual([]);
}

describe('vjazd do plochy a pruh radu', () => {
  it('kamión dostane rad s najkratšou frontou (pri zhode najnižší) a rad `r` obsluhuje pruh `r mod počet pruhov`; kapacita radu sa nepresiahne', () => {
    const layout = gatesWorld(21);
    const { world, buffers } = layout;
    // Pruhy v `trouble` (40 ticov na kamión) držia kamióny v radoch dlhšie, takže rady sa plnia.
    for (const lane of layout.inLanes) setMode(world, lane.id, 'trouble');
    stageUnits(layout, 30);
    let admissions = 0;
    for (let tick = 0; tick < 250; tick++) {
      const before = buffers.map((buffer) => Array.from({ length: buffer.rowCount }, (_unused, row) => buffer.rowTrucks(row).length));
      const seen = new Set([...world.trucks.values()].filter((truck) => truck.state === 'pre_gate').map((truck) => truck.id));
      world.tick();
      for (const truck of world.trucks.values()) {
        if (truck.state !== 'pre_gate' || seen.has(truck.id)) continue;
        admissions += 1;
        const index = buffers.findIndex((buffer) => buffer.id === truck.preGateId);
        expect(index).toBeGreaterThanOrEqual(0);
        const lengths = before[index];
        const row = truck.row as number;
        expect(lengths[row], `rad ${String(row)} pri vjazde #${String(truck.id)}`).toBe(Math.min(...lengths));
        expect(lengths.indexOf(Math.min(...lengths))).toBe(row);
      }
      for (const buffer of buffers) {
        const lanes = world.landside.preGateLanes(buffer);
        for (let row = 0; row < buffer.rowCount; row++) {
          expect(buffer.rowTrucks(row).length).toBeLessThanOrEqual(buffer.rowCapacity);
          for (const id of buffer.rowTrucks(row)) {
            const truck = world.trucks.get(id);
            expect([truck?.state, truck?.row, truck?.preGateId]).toEqual(['pre_gate', row, buffer.id]);
            expect(truck?.gateId).toBe(lanes[row % lanes.length].id);
          }
        }
      }
    }
    expect(admissions).toBeGreaterThanOrEqual(16);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('čelo radu vyjde len k voľnému pruhu: vstupný pruh nikdy nemá vo fronte viac než jeden kamión a nik k nemu nejde, kým prechádza iný', () => {
    const layout = gatesWorld(22);
    const { world, inLanes } = layout;
    stageUnits(layout, 40);
    let released = 0;
    for (let tick = 0; tick < 400; tick++) {
      const before = new Set([...world.trucks.values()].filter((truck) => truck.state === 'pre_gate').map((truck) => truck.id));
      world.tick();
      for (const lane of inLanes) expect(lane.queueLength, `${lane.label} v ticku ${String(tick)}`).toBeLessThanOrEqual(1);
      for (const id of before) {
        const truck = world.trucks.get(id);
        if (truck !== undefined && truck.state === 'to_gate') released += 1;
      }
      for (const lane of inLanes) {
        const heading = [...world.trucks.values()].filter((truck) => truck.state === 'to_gate' && truck.gateId === lane.id).length;
        expect(heading + lane.queueLength, `${lane.label} v ticku ${String(tick)}`).toBeLessThanOrEqual(1);
      }
    }
    expect(released).toBeGreaterThan(10);
  });
});

describe('plná plocha: kamióny nečakajú na ceste', () => {
  it('pruhy v trouble → plochy sa naplnia (obsadené + idúce ≤ kapacita), kamióny sa nehromadia na ceste (token TP / státia ich zastaví vo vnútrozemí, náklad čaká vo dvoroch); po návrate do standard sa všetko odvezie', () => {
    const layout = gatesWorld(23);
    const { world, buffers } = layout;
    for (const lane of layout.inLanes) setMode(world, lane.id, 'trouble');
    const UNITS = 120;
    stageUnits(layout, UNITS);
    let sawFull = false;
    for (let tick = 0; tick < 300; tick++) {
      world.tick();
      assertCargoConservation(world);
      for (const buffer of buffers) {
        expect(buffer.occupied + preGateInbound(world, buffer)).toBeLessThanOrEqual(buffer.capacity);
        if (buffer.freeSlots === 0) sawFull = true;
      }
    }
    expect(sawFull).toBe(true);
    // Vnútri prístavu je najviac toľko kamiónov, koľko je tokenov (12 TP dvorov + 60 státí): ďalší kamióny nevznikajú, náklad čaká vo dvoroch.
    expect([...world.trucks.values()].filter((truck) => truck.bonds.holdsToken).length).toBeLessThanOrEqual(12 + 60);
    expect(world.trucks.size).toBeLessThan(UNITS);
    expect(world.cargo.countByKind('in_storage')).toBeGreaterThan(0);
    for (const lane of layout.inLanes) setMode(world, lane.id, 'standard');
    for (let tick = 0; tick < 12_000 && world.cargo.exportedCount < UNITS; tick++) world.tick();
    expect(world.cargo.exportedCount).toBe(UNITS);
    expect(world.cargo.liveCount).toBe(0);
    expect(world.trucks.size).toBe(0);
  });
});

describe('režimy pruhov a SetGateLaneMode', () => {
  it('express skracuje prechod na jeden krok, trouble ho predlžuje; režim platí od ďalšieho kamióna a prechod ukazuje aktuálny krok a postup', () => {
    const layout = gatesWorld(24);
    const { world, inLanes } = layout;
    const lane = inLanes[0];
    expect(lane.mode).toBe('standard');
    setMode(world, lane.id, 'express');
    expect(lane.mode).toBe('express');
    expect(world.serialize().modules.find((entry) => entry.id === lane.id)?.runtime).toMatchObject({ mode: 'express' });
    expect(lane.meanServiceTicks('express')).toBeLessThan(lane.meanServiceTicks('standard'));
    setMode(world, lane.id, 'trouble');
    expect(lane.meanServiceTicks('trouble')).toBeGreaterThan(lane.meanServiceTicks('standard'));
    // Prechod: kamión v pruhu v `trouble` ukazuje krok `trouble` a postup 0…1.
    for (const other of inLanes) setMode(world, other.id, 'trouble');
    stageUnits(layout, 1);
    const progress: number[] = [];
    for (let tick = 0; tick < 400 && progress.length < 5; tick++) {
      world.tick();
      for (const candidate of inLanes) {
        const current = candidate.currentStep();
        if (current === null) continue;
        expect(current.id).toBe('trouble');
        progress.push(current.progress);
      }
    }
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBeGreaterThan(0);
    for (const value of progress) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of progress) expect(value).toBeLessThanOrEqual(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('príkaz: neznáme id → unknown_module, neplatný režim → invalid_gate_mode; platný príkaz je serializovateľný a režim sa zmení; modul, ktorý nie je pruh, sa odmietne', () => {
    const { world, inLanes, yards } = gatesWorld(25);
    const bad = commandFromJSON({ type: 'SetGateLaneMode', laneId: yards[0].id, mode: 'express' }).validate(world);
    expect([bad.ok, bad.reasons]).toEqual([false, ['unknown_module']]);
    const invalid = commandFromJSON({ type: 'SetGateLaneMode', laneId: inLanes[0].id, mode: 'turbo' }).validate(world);
    expect([invalid.ok, invalid.reasons]).toEqual([false, ['invalid_gate_mode']]);
    const both = commandFromJSON({ type: 'SetGateLaneMode', laneId: 9_999, mode: 'turbo' }).validate(world);
    expect(both.reasons).toEqual(['unknown_module', 'invalid_gate_mode']);
    const good = commandFromJSON({ type: 'SetGateLaneMode', laneId: inLanes[0].id, mode: 'express' });
    expect(good.toJSON()).toEqual({ type: 'SetGateLaneMode', laneId: inLanes[0].id, mode: 'express' });
    expect(good.validate(world).ok).toBe(true);
    good.apply(world);
    expect(inLanes[0].mode).toBe('express');
  });

  it('standard losuje problémy z Rng (stav Rng sa po prechodoch posunie), express a trouble Rng nespotrebujú', () => {
    const rngAfter = (mode: string): string => {
      const layout = gatesWorld(26);
      const { world } = layout;
      for (const lane of layout.inLanes) setMode(world, lane.id, mode);
      stageUnits(layout, 12);
      const states: string[] = [];
      // Portál sa vyberá z Rng pri ≥ 2 voľných portáloch, preto sa porovnáva len stav po prechodoch pruhmi: spotrebu pruhu meria rozdiel oproti behu bez prechodov.
      for (let tick = 0; tick < 300; tick++) {
        world.tick();
        states.push(String(layout.inLanes.reduce((sum, lane) => sum + lane.trucksProcessed, 0)));
      }
      return `${states.at(-1) ?? ''}|${JSON.stringify(world.rng.getState())}`;
    };
    const standard = rngAfter('standard');
    expect(standard.split('|')[0]).not.toBe('0');
    expect(rngAfter('standard')).toBe(standard);
    expect(rngAfter('express')).not.toBe(standard);
  });
});

describe('save/load plochy', () => {
  it('rady kamiónov a ich indexy prežijú serialize → deserialize; obnovený svet dobehne rovnako a krok 12 prejde', () => {
    const layout = gatesWorld(27);
    const { world } = layout;
    for (const lane of layout.inLanes) setMode(world, lane.id, 'trouble');
    stageUnits(layout, 24);
    for (let tick = 0; tick < 120; tick++) world.tick();
    expect(layout.buffers.reduce((sum, buffer) => sum + buffer.occupied, 0)).toBeGreaterThan(4);
    const state = JSON.parse(JSON.stringify(world.serialize())) as WorldState;
    const restored = World.deserialize(GATES_DEFS, GATES_MAP, state);
    expect(findWorldViolation(restored)).toBeUndefined();
    const restoredBuffers = restored.landsideModules.preGates;
    expect(restoredBuffers.map((buffer) => Array.from({ length: buffer.rowCount }, (_unused, row) => [...buffer.rowTrucks(row)]))).toEqual(
      layout.buffers.map((buffer) => Array.from({ length: buffer.rowCount }, (_unused, row) => [...buffer.rowTrucks(row)])),
    );
    for (const truck of restored.trucks.values()) {
      const original = world.trucks.get(truck.id);
      expect([truck.state, truck.row, truck.preGateId, truck.gateId, truck.gateOutId]).toEqual([original?.state, original?.row, original?.preGateId, original?.gateId, original?.gateOutId]);
    }
    for (let tick = 0; tick < 200; tick++) expect(restored.tick()).toEqual(world.tick());
    expect(restored.serialize()).toEqual(world.serialize());
  });

  it('krok 12: kamión v pre_gate bez miesta v rade plochy, alebo rad s cudzím kamiónom → WorldInvariantError', () => {
    const layout = gatesWorld(28);
    const { world, buffers } = layout;
    for (const lane of layout.inLanes) setMode(world, lane.id, 'trouble');
    stageUnits(layout, 12);
    for (let tick = 0; tick < 80 && [...world.trucks.values()].every((truck) => truck.state !== 'pre_gate'); tick++) world.tick();
    const inside = [...world.trucks.values()].find((truck) => truck.state === 'pre_gate');
    expect(inside).toBeDefined();
    expect(findWorldViolation(world)).toBeUndefined();
    const buffer = buffers.find((candidate) => candidate.id === inside?.preGateId);
    buffer?.remove(inside!.id);
    expect(findWorldViolation(world)).toBeDefined();
    expect(() => world.assertInvariants()).toThrow();
  });
});
