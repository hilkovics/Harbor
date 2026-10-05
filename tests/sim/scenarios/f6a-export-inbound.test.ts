/**
 * Scenár `export_inbound` (F6a, T6A-04, ADR-032): vertikálny rez exportu po súši bez lode — export booking #8 (36 TEU = 20 kontajnerov, Gdańsk)
 * prijatý v ticku 8 641, kamióny prichádzajú naložené pred cut-off, brána ich zaregistruje (jednotka s chýbajúcim VGM → hold 6 h; po R2 losuje
 * `Rng` iné jednotky než predtým, v tomto behu žiadnu), posledný kamión zablokuje chýbajúca cesta pred portálom (RemoveRoad ticku 29 000, PlaceRoad ticku 29 700), takže
 * prejde bránou po cut-off (rolled), vyloží sa na rampe a vozidlá odvezú všetky jednotky do skladu. Žiadna jednotka sa
 * nestratí, každý presun je legálny a booking ostane v `accepted` (loď príde až po konci behu).
 */
import { describe, expect, it } from 'vitest';
import { World, stateHash, type WorldState } from '@sim/world';
import { exportGroupingShare } from '@sim/world/cargo-queries';
import { findWorldViolation } from '@sim/world/world-invariants';
import type { SimEvent } from '@sim/events';
import { MAP, TICKS_PER_HOUR, lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS } from '../world/world-fixtures';

const SCENARIO = loadScenarioFile('export_inbound');
const TICKS = 30_000;
const CONTRACT_ID = 8;
/** Booking #8: 36 TEU = 20 kontajnerov pri `sizeMix` 0,6 (ADR-039); po R2 ho losuje pool ako export leg roundtripu (id #7 je teraz import). */
const BOOKED = 20;
const RUN_TIMEOUT_MS = 300_000;

interface Run {
  readonly world: World;
  readonly events: readonly { readonly tick: number; readonly event: SimEvent }[];
}

function run(): Run {
  const world = World.create(DEFS, MAP, SCENARIO.seed);
  const events: { tick: number; event: SimEvent }[] = [];
  runScenario(world, SCENARIO, TICKS, {
    afterTick: (w, tickEvents) => {
      assertCargoConservation(w);
      for (const event of tickEvents) events.push({ tick: w.clock.tick, event });
    },
  });
  return { world, events };
}

const of = <T extends SimEvent['type']>(events: Run['events'], type: T): { tick: number; event: Extract<SimEvent, { type: T }> }[] =>
  events.filter((entry): entry is { tick: number; event: Extract<SimEvent, { type: T }> } => entry.event.type === type);

describe('scenár export_inbound', () => {
  const result = run();
  const { world, events } = result;
  const contract = world.contracts.get(CONTRACT_ID as never)!;

  it('booking je prijatý v ticku 8 641 a naplánovaný: 20 príchodov pred cut-off (36 TEU), loď po konci behu', () => {
    expect(contract.kind).toBe('export');
    expect(contract.acceptedTick).toBe(8641);
    expect(contract.booking?.bookedUnits).toBe(BOOKED);
    expect(contract.shipArrivalTick).toBeGreaterThan(TICKS);
    expect(contract.booking?.cutoffTick).toBe((contract.shipArrivalTick as number) - 12 * TICKS_PER_HOUR);
    expect(contract.state).toBe('accepted');
    expect(world.clock.tick).toBe(TICKS);
  });

  it('20 kamiónov s exportom (36 TEU) prešlo bránou a vyložilo; všetky odišli prázdne (units 0)', () => {
    expect(of(events, 'TruckSpawned')).toHaveLength(BOOKED);
    expect(of(events, 'ExportArrived')).toHaveLength(BOOKED);
    expect(of(events, 'TruckUnloaded')).toHaveLength(BOOKED);
    for (const entry of of(events, 'TruckUnloaded')) expect(entry.event.dualTransaction).toBe(false);
    expect(of(events, 'TruckExited').map((entry) => entry.event.units)).toEqual(Array<number>(BOOKED).fill(0));
    expect(world.trucks.size).toBe(0);
    expect(contract.booking?.arrivedUnits).toBe(BOOKED);
  });

  it('kamióny prichádzajú rozložene pred cut-off; jediná výnimka je rolled jednotka po cut-off', () => {
    const cutoff = contract.booking?.cutoffTick as number;
    const arrivals = of(events, 'ExportArrived');
    const late = arrivals.filter((entry) => entry.tick > cutoff);
    expect(late).toHaveLength(1);
    expect(arrivals.filter((entry) => entry.tick <= cutoff)).toHaveLength(BOOKED - 1);
    const first = arrivals[0].tick;
    const last = arrivals.filter((entry) => entry.tick <= cutoff).at(-1)?.tick as number;
    expect(last - first).toBeGreaterThan(5 * TICKS_PER_HOUR);
    // Najviac 4 kamióny v jednom ticku brány je nereálne — brána púšťa po jednom (processTicks).
    const ticks = arrivals.map((entry) => entry.tick);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('rolled: zablokovaná cesta oneskorí posledný kamión za cut-off; UnitRolled hneď po ExportArrived', () => {
    const rolled = of(events, 'UnitRolled');
    expect(rolled).toHaveLength(1);
    const cutoff = contract.booking?.cutoffTick as number;
    expect(rolled[0].tick).toBeGreaterThan(cutoff);
    expect(rolled[0].tick).toBeGreaterThan(29_700);
    expect(contract.booking?.rolledUnitIds).toEqual([rolled[0].event.unitId]);
    const sameTick = events.filter((entry) => entry.tick === rolled[0].tick).map((entry) => entry.event.type);
    expect(sameTick.indexOf('ExportArrived')).toBeLessThan(sameTick.indexOf('UnitRolled'));
    // CutoffPassed nastal pred príchodom rolled jednotky: pri cut-off bolo prijatých BOOKED − 1 jednotiek.
    const passed = of(events, 'CutoffPassed');
    expect(passed).toEqual([{ tick: cutoff, event: { type: 'CutoffPassed', contractId: CONTRACT_ID, arrivedUnits: BOOKED - 1, bookedUnits: BOOKED } }]);
    expect(of(events, 'CutoffWarning').map((entry) => entry.tick)).toEqual([cutoff - 6 * TICKS_PER_HOUR]);
  });

  it('VGM: každá jednotka v hold je zadržaná vgmHoldHours a uvoľnená presne v untilTick (počet holdov losuje Rng, nie je pinnutý)', () => {
    const started = of(events, 'VgmHoldStarted');
    for (const entry of started) expect(entry.event.untilTick - entry.tick).toBe(6 * TICKS_PER_HOUR);
    const released = of(events, 'VgmHoldReleased');
    expect(released).toEqual(started.map((entry) => ({ tick: entry.event.untilTick, event: { type: 'VgmHoldReleased', contractId: CONTRACT_ID, unitId: entry.event.unitId } })));
    expect(contract.booking?.heldUnits).toBe(0);
    expect(world.holdIndex.size).toBe(0);
  });

  it('každá jednotka exportu prešla presne in_truck → at_ramp → in_vehicle → in_storage (nič sa neteleportuje)', () => {
    const chains = new Map<number, string[]>();
    for (const entry of of(events, 'CargoMoved')) {
      const chain = chains.get(entry.event.unitId) ?? [];
      chain.push(`${entry.event.from.kind}→${entry.event.to.kind}`);
      chains.set(entry.event.unitId, chain);
    }
    expect(chains.size).toBe(BOOKED);
    for (const chain of chains.values()) expect(chain).toEqual(['in_truck→at_ramp', 'at_ramp→in_vehicle', 'in_vehicle→in_storage']);
  });

  it('všetky exporty skončia v sklade, žiadna sa nestratila a nič neodišlo mimo mapy', () => {
    expect(world.cargo.countByKind('in_storage')).toBe(BOOKED);
    expect(world.cargo.createdCount).toBe(BOOKED);
    expect(world.cargo.exportedCount).toBe(0);
    expect(world.cargo.shippedCount).toBe(0);
    expect(lostUnits(world)).toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('exporty voyage sú zoskupené v jednom sklade (exportGroupingShare = 1)', () => {
    expect(exportGroupingShare(world, CONTRACT_ID as never)).toBe(1);
  });

  it('bez penalizácií a výplaty: export sa uzavrie až pri odchode lode (T6A-05)', () => {
    expect(contract.penaltiesCents).toBe(0);
    expect(of(events, 'ContractCompleted')).toEqual([]);
    expect(of(events, 'ContractFailed')).toEqual([]);
  });

  it('deterministický: rovnaký beh dá rovnaký hash; roundtrip uprostred príchodov (aj pri rolled) dá zhodný stateHash', () => {
    expect(stateHash(run().world)).toBe(stateHash(world));
    for (const at of [12_000, 20_000, 29_000, 29_100, 29_750]) {
      const half = World.create(DEFS, MAP, SCENARIO.seed);
      runScenario(half, SCENARIO, at);
      const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(half.serialize())) as WorldState);
      runScenario(restored, SCENARIO, TICKS);
      expect(stateHash(restored), `roundtrip v ticku ${String(at)}`).toBe(stateHash(world));
    }
  }, RUN_TIMEOUT_MS);
});
