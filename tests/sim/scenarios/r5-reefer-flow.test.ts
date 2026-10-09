// Reefery (TR5-01, ADR-042): scenár `reefer_flow` (1 STS, reefer blok so zásuvkami v každej pozícii, 6 ťahačov) vyloží reefery prekládky loď A → reefer blok → loď B.
// S dostatkom zásuviek: 0 reklamácií, 0 preskočení, energia v ledgeri, reefer sa pred zdvihom odpojí. S málo zásuvkami: STS reefery preskakuje s upozornením,
// čakajúce reklamácie vzniknú, nič sa nestratí a nič neuviazne. Beh je deterministický a kontajner nikdy neteleportuje (konzervácia každý tick).
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import { loadMap, parseMapDef } from '@sim/grid';
import { YardBlock } from '@sim/modules';
import type { SimEvent } from '@sim/events';
import { stateHash, World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, hookDefs, send } from '../helpers/f6a';
import { lost, offerTranship } from '../helpers/f6c';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const UNITS = 12;
const ECONOMY = { startingCashCents: 400_000_000, transhipGapDaysRange: [1, 1], arrivalDaysRange: [1, 1] };
const MAX_TICKS = 60_000;
const SCARCE_TICKS = 16_000;
/** Bez alarmov: výsledok nezávisí od náhody, claims = len čakanie a odpojenie. */
const NO_ALARMS = { alarmChancePerDay: 0 };

interface Run {
  readonly world: World;
  readonly events: SimEvent[];
  readonly unpluggedBeforeLift: boolean;
}

function run(options: { readonly capacity?: number; readonly ticks?: number; readonly reefer?: Record<string, unknown>; readonly seed?: number } = {}): Run {
  const { capacity, ticks, reefer = NO_ALARMS, seed } = options;
  const scenario = loadScenarioFile('reefer_flow');
  const defs = hookDefs(0, { economy: ECONOMY, reefer, ...(capacity === undefined ? {} : { moduleParams: { reefer_block_8: { capacityUnits: capacity } } }) });
  const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), seed ?? scenario.seed, { checkInvariants: true });
  runScenario(world, scenario, 1);
  const contract = offerTranship(world, { units: UNITS, containerType: 'reefer' });
  expect(send(world, acceptCommand(contract.id)).some((event) => event.type === 'ContractAccepted')).toBe(true);
  const events: SimEvent[] = [];
  let unpluggedBeforeLift = true;
  const plugged = new Map<EntityId, boolean>();
  const done = (): boolean => (ticks !== undefined ? world.clock.tick >= ticks : world.contractBook.contracts.size > 0 && world.ships.size === 0 && [...world.contractBook.contracts.values()].every((c) => c.state === 'completed' || c.state === 'failed'));
  for (let i = 0; i < (ticks ?? MAX_TICKS) && !done(); i++) {
    const tickEvents = world.tick();
    for (const event of tickEvents) {
      events.push(event);
      // Zdvih reeferu zo skladu: v predchádzajúcom ticku už bol odpojený (stroj ho zdvihne až po odpojení).
      if (event.type === 'CargoMoved' && event.from.kind === 'in_storage' && plugged.get(event.unitId) === true) unpluggedBeforeLift = false;
    }
    for (const id of world.reeferIndex.ids()) plugged.set(id, world.cargo.get(id)?.reefer?.plugged ?? false);
    if (i % 25 === 0) assertCargoConservation(world);
  }
  if (!done()) throw new Error(`scenár nedobehol do ${String(ticks ?? MAX_TICKS)} tickov (tick ${String(world.clock.tick)})`);
  return { world, events, unpluggedBeforeLift };
}

const count = (events: readonly SimEvent[], type: SimEvent['type']): number => events.filter((event) => event.type === type).length;
const energyEntries = (world: World) => world.economy.entries.filter((entry) => entry.category === 'energy');

describe('scenár reefer_flow: dostatok zásuviek', () => {
  const first = run();

  it('rozloženie: STS, reefer blok so zásuvkami v každom rade, 6 ťahačov', () => {
    const block = [...first.world.modules.values()].find((module): module is YardBlock => module instanceof YardBlock) as YardBlock;
    expect(block.def.id).toBe('reefer_block_8');
    expect(block.hasSockets).toBe(true);
    expect(block.plugCells()).toHaveLength(block.geometry.bays * block.geometry.rows);
    expect(first.world.vehicles.size).toBe(6);
  });

  it('všetky reefery prejdú A → blok → B: 0 reklamácií, 0 preskočení, nič sa nestratilo ani nezostalo', () => {
    const { world, events } = first;
    expect(world.cargo.shippedCount).toBe(UNITS);
    expect(count(events, 'ReeferClaim')).toBe(0);
    expect(count(events, 'ReeferSkipped')).toBe(0);
    expect(lost(world)).toBe(0);
    expect(world.cargo.liveCount).toBe(0);
    const { stuckTicks } = world.defs.logistics.traffic;
    expect([...world.vehicles.values()].filter((vehicle) => vehicle.blockedTicks >= stuckTicks)).toHaveLength(0);
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('elektrina je v ledgeri v kategórii `energy` (záporné sumy) a reefer sa pred zdvihom zo skladu vždy odpojí', () => {
    const energy = energyEntries(first.world);
    expect(energy.length).toBeGreaterThan(0);
    expect(energy.every((entry) => entry.amountCents < 0)).toBe(true);
    expect(first.unpluggedBeforeLift).toBe(true);
  });

  it('deterministické: rovnaký seed dá rovnaký stav sveta aj udalosti', () => {
    const again = run();
    expect(stateHash(again.world)).toBe(stateHash(first.world));
    expect(again.events.length).toBe(first.events.length);
  });
}, 600_000);

describe('scenár reefer_flow: málo zásuviek', () => {
  const scarce = run({ capacity: 4, ticks: SCARCE_TICKS });

  it('STS reefery preskakuje s upozornením a čakajúce reklamácie vzniknú; kapacita zásuviek sa neprekročí', () => {
    const { world, events } = scarce;
    const block = [...world.modules.values()].find((module): module is YardBlock => module instanceof YardBlock) as YardBlock;
    expect(count(events, 'ReeferSkipped')).toBeGreaterThan(0);
    const claims = events.filter((event) => event.type === 'ReeferClaim');
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.type === 'ReeferClaim' && claim.reason === 'waiting')).toBe(true);
    expect(block.usedTeu).toBeLessThanOrEqual(4);
    const penalty = world.economy.entries.filter((entry) => entry.category === 'penalty' && entry.refId?.startsWith('reefer:') === true).reduce((sum, entry) => sum + entry.amountCents, 0);
    expect(penalty).toBe(-claims.length * world.defs.economy.reeferClaimCents);
  });

  it('nič sa nestratilo, nič neuviazlo a invarianty platia', () => {
    const { world } = scarce;
    expect(lost(world)).toBe(0);
    const { stuckTicks } = world.defs.logistics.traffic;
    expect([...world.vehicles.values()].filter((vehicle) => vehicle.blockedTicks >= stuckTicks)).toHaveLength(0);
    assertCargoConservation(world);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('deterministické: rovnaký seed dá rovnaký stav a rovnaký počet reklamácií', () => {
    const again = run({ capacity: 4, ticks: SCARCE_TICKS });
    expect(stateHash(again.world)).toBe(stateHash(scarce.world));
    expect(count(again.events, 'ReeferClaim')).toBe(count(scarce.events, 'ReeferClaim'));
  });
}, 600_000);
