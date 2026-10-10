// OOG a reach stacker (TR5-02, ADR-042): scenár `oog_flow` (1 STS, RTG blok + OOG plocha, 10 ťahačov) prevezme prekládku loď A → blok → loď B so zmesou typov
// (open top / flat rack s nadrozmerom a bez, tank, dry). OOG ide výlučne na OOG plochu k reach stackeru, STS ho spúšťa dlhšie, nič sa na OOG nestohuje, flat rack je len navrchu.
// Druhý test: kamión na TP OOG plochy (export z ledgera) zaisťuje OOG `logistics.oog.lashTicks`. Beh je deterministický a nič sa nestratí ani neuviazne.
import { describe, expect, it } from 'vitest';
import type { CargoUnit } from '@sim/cargo';
import { loadMap, parseMapDef } from '@sim/grid';
import { ReachStacker } from '@sim/machines';
import { CraneModule, YardBlock } from '@sim/modules';
import { stateHash, World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { lost, offerTranship } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { addOogArea, gatesWorld } from '../helpers/r4-gates-layout';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

/** 0–3 open top (OOG), 4–5 flat rack (OOG), 6 flat rack bez nadrozmeru, 7–8 tank, 9–11 dry. */
const TYPES = ['open_top', 'open_top', 'open_top', 'open_top', 'flat_rack', 'flat_rack', 'flat_rack', 'tank', 'tank', 'dry', 'dry', 'dry'];
const OOG_UNITS = [0, 1, 2, 3, 4, 5];
const MAX_TICKS = 60_000;
const ECONOMY = { startingCashCents: 400_000_000, transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };

interface Run {
  readonly world: World;
  readonly oogMoves: number;
  readonly oogPlacingTicks: number[];
  readonly normalPlacingTicks: number[];
  readonly badStack: string[];
  readonly offBlock: string[];
}

/** Jednotka, ktorá leží na stohu a má niečo nad sebou, hoci je flat rack / OOG (musí byť navrchu). */
function coveredBelow(world: World, block: YardBlock): CargoUnit[] {
  const bad: CargoUnit[] = [];
  const at = new Map<string, CargoUnit>();
  const units = world.cargo.getState().units;
  for (const state of units) {
    if (state.location.kind !== 'in_storage' || state.location.moduleId !== block.id) continue;
    const unit = world.cargo.get(state.id as never);
    if (unit === undefined) continue;
    const { bay, row, tier } = block.positionOfSlot(state.location.slot);
    at.set(`${String(bay)}/${String(row)}/${String(tier)}`, unit);
  }
  for (const [key, unit] of at) {
    const [bay, row, tier] = key.split('/').map(Number);
    if (tier === 0) continue;
    const below = at.get(`${String(bay)}/${String(row)}/${String(tier - 1)}`);
    if (below !== undefined && (below.oog || world.defs.containerTypes.get(below.containerType).stacking === 'top_only')) bad.push(unit);
  }
  return bad;
}

function run(seed?: number): Run {
  const scenario = loadScenarioFile('oog_flow');
  const world = World.create(hookDefs(0, { economy: ECONOMY }), loadMap(parseMapDef(readRepoJson(scenario.map))), seed ?? scenario.seed, { checkInvariants: true });
  runScenario(world, scenario, 1);
  const contract = offerTranship(world, { units: TYPES.length, unitTypes: TYPES, oogUnits: OOG_UNITS });
  expect(send(world, acceptCommand(contract.id)).some((event) => event.type === 'ContractAccepted')).toBe(true);
  const crane = [...world.modules.values()].find((module): module is CraneModule => module instanceof CraneModule) as CraneModule;
  const oogPlacingTicks: number[] = [];
  const normalPlacingTicks: number[] = [];
  const badStack: string[] = [];
  const offBlock: string[] = [];
  let oogMoves = 0;
  const done = (): boolean => world.contractBook.contracts.size > 0 && world.ships.size === 0 && [...world.contractBook.contracts.values()].every((c) => c.state === 'completed' || c.state === 'failed');
  for (let i = 0; i < MAX_TICKS && !done(); i++) {
    const events = world.tick();
    if (crane.state === 'placing' && crane.phaseTicksLeft === crane.phaseTicksTotal && crane.heldUnitId !== null) {
      const held = world.cargo.get(crane.heldUnitId);
      if (held?.oog === true) oogPlacingTicks.push(crane.phaseTicksTotal);
      else if (held !== undefined) normalPlacingTicks.push(crane.phaseTicksTotal);
    }
    for (const event of events) {
      if (event.type !== 'CargoMoved' || event.to.kind !== 'in_storage') continue;
      const unit = world.cargo.get(event.unitId);
      const block = world.modules.get(event.to.moduleId);
      if (unit === undefined || !(block instanceof YardBlock)) continue;
      if (unit.oog !== block.acceptsOog) offBlock.push(`${String(unit.id)}:${unit.containerType}:${block.def.id}`);
    }
    if (i % 50 === 0) {
      assertCargoConservation(world);
      for (const block of world.modules.values()) if (block instanceof YardBlock) badStack.push(...coveredBelow(world, block).map((unit) => String(unit.id)));
    }
  }
  if (!done()) throw new Error(`scenár nedobehol do ${String(MAX_TICKS)} tickov`);
  for (const machine of world.machines.values()) if (machine instanceof ReachStacker) oogMoves += machine.moves;
  return { world, oogMoves, oogPlacingTicks, normalPlacingTicks, badStack, offBlock };
}

describe('scenár oog_flow: STS → ťahač → reach stacker na OOG ploche → ťahač → STS', () => {
  const first = run();

  it('rozloženie: RTG blok a OOG plocha, každý s jedným strojom (OOG plocha má reach stacker)', () => {
    const { world } = first;
    const blocks = [...world.modules.values()].filter((module): module is YardBlock => module instanceof YardBlock);
    expect(blocks.map((block) => block.def.id).sort()).toEqual(['oog_area', 'rtg_block']);
    expect(world.machines.size).toBe(2);
    const stackers = [...world.machines.values()].filter((machine) => machine instanceof ReachStacker);
    expect(stackers).toHaveLength(1);
    expect(stackers[0].defId).toBe('reach_stacker');
    expect(blocks.find((block) => block.acceptsOog)?.id).toBe(stackers[0].blockId);
  });

  it('všetkých 12 kontajnerov prejde: nič sa nestratilo ani nezostalo, nič neuviazlo, invarianty platia', () => {
    const { world } = first;
    expect(world.cargo.shippedCount).toBe(TYPES.length);
    expect(lost(world)).toBe(0);
    expect(world.cargo.liveCount).toBe(0);
    const { stuckTicks } = world.defs.logistics.traffic;
    expect([...world.vehicles.values()].filter((vehicle) => vehicle.blockedTicks >= stuckTicks)).toHaveLength(0);
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('OOG ide len na OOG plochu a bežné jednotky nie; nič neleží na OOG ani na flat racku (len navrchu)', () => {
    expect(first.offBlock).toEqual([]);
    expect(first.badStack).toEqual([]);
  });

  it('reach stacker odbavil každé OOG dvakrát (položenie a zdvih) a STS ho spúšťa o `extraCycleTicks` dlhšie', () => {
    expect(first.oogMoves).toBe(2 * OOG_UNITS.length);
    const extra = first.world.defs.logistics.oog.extraCycleTicks;
    expect(first.oogPlacingTicks.length).toBeGreaterThan(0);
    expect(first.normalPlacingTicks.length).toBeGreaterThan(0);
    expect(Math.min(...first.oogPlacingTicks)).toBe(Math.min(...first.normalPlacingTicks) + extra);
  });

  it('deterministické: rovnaký seed dá rovnaký stav sveta', () => {
    expect(stateHash(run().world)).toBe(stateHash(first.world));
  });
}, 600_000);

describe('OOG na kamióne (export z OOG plochy)', () => {
  it('kamión na TP OOG plochy zaisťuje OOG `oog.lashTicks` (nie `lashTicks` kamióna); jednotka prejde in_storage → in_handler → in_truck → exported', () => {
    const layout = gatesWorld(31);
    const area = addOogArea(layout);
    const { world } = layout;
    const staged = world.cargo.create('container_teu', { kind: 'on_ship', shipId: 900 as never }, null, { direction: 'import', voyageId: null, lineId: null, destinationPort: null, weightClass: 'medium', sizeFt: 20, containerType: 'flat_rack', oog: true }).id;
    for (const location of [{ kind: 'in_crane', craneId: 901 }, { kind: 'on_apron', berthId: 1, slot: 0 }, { kind: 'in_vehicle', vehicleId: 902 }, { kind: 'in_storage', moduleId: area.id, slot: 0 }] as const) {
      world.cargo.move(staged, location as never);
    }
    expect(area.acceptsOog).toBe(true);
    const lashTicks = world.defs.logistics.oog.lashTicks;
    let lashing = 0;
    const kinds: string[] = [];
    for (let i = 0; i < 4000 && world.cargo.exportedCount < 1; i++) {
      world.tick();
      const truck = [...world.trucks.values()][0];
      if (truck?.phase === 'lash') lashing += 1;
      const kind = world.cargo.get(staged)?.location.kind ?? 'exported';
      if (kinds[kinds.length - 1] !== kind) kinds.push(kind);
      assertCargoConservation(world);
    }
    expect(kinds).toEqual(['in_storage', 'in_handler', 'in_truck', 'exported']);
    expect(lashing).toBe(lashTicks);
    expect(world.defs.trucks.get('truck_container').lashTicks).not.toBe(lashTicks);
    expect(lost(world)).toBe(0);
  });
});
