/**
 * Scenár outbound (T04-03; ARCHITECTURE §6 krok 5, §7.1, §7.3 body 2–4; rozhodnutia orchestrátora F4 č. 1 a 4;
 * ADR-023): feeder s 12 TEU → Root žeriav → apron → dve vozidlá → dvory → tie isté vozidlá → staging dock prevádzkovej
 * rampy. Kamióny prídu v T04-04, preto sa staging zaplní (2 docky × 2 = 4 jednotky) a zvyšok ostane v skladoch.
 *
 * Rozloženie: `helpers/f3-layout.ts` (cesty, depo 3, dvory 4 a 5, dve vozidlá, loď) + pozemná časť z
 * `logistics/outbound-fixtures.ts` (cesty, brána, stojisko, rampa) — všetko na ticku 0 cez JSON príkazy. Po každom ticku
 * beží `assertCargoConservation(world)` a krok 12 sveta (`checkInvariants`, vrátane súladu rezervácií dockov s jobmi).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { CargoLocationKind } from '@sim/cargo';
import type { EntityId } from '@sim/core';
import type { CargoMovedEvent, SimEvent } from '@sim/events';
import { StorageModule } from '@sim/modules';
import { World } from '@sim/world';
import { f3Scenario } from '../helpers/f3-layout';
import { assertCargoConservation } from '../helpers/invariants';
import { runScenario, stateHash, type Scenario, type ScenarioEntry } from '../helpers/scenario';
import { LANDSIDE_ROADS, landsideCommand, rampOf, stagingOf, type LandsidePart } from '../logistics/outbound-fixtures';
import { DEFS, MAP } from '../world/world-fixtures';

const UNITS = 12;
const STAGING = 4;
const MAX_TICKS = 6000;
const SETTLE_TICKS = 300;
const STRADDLE = 'straddle_carrier';

/** Cesty pozemnej časti a pozemné moduly na ticku 0 (za príkazmi F3). */
function landsideEntries(parts: readonly LandsidePart[]): ScenarioEntry[] {
  return [
    ...Object.values(LANDSIDE_ROADS).map((cells): ScenarioEntry => ({ atTick: 0, command: { type: 'PlaceRoad', cells } })),
    ...parts.map((part): ScenarioEntry => ({ atTick: 0, command: landsideCommand(part) })),
  ];
}

function outboundScenario(parts: readonly LandsidePart[] = ['gate', 'waiting_area', 'ramp'], later: readonly ScenarioEntry[] = []): Scenario {
  return f3Scenario('f4_outbound', 4031, { vehicles: [STRADDLE, STRADDLE], units: UNITS, extra: [...landsideEntries(parts), ...later] });
}

interface Run {
  readonly world: World;
  readonly events: SimEvent[];
  /** Ticky, v ktorých outbound job dostal vozidlo, hoci po priradení ostal niektorý inbound job `open` (porušenie priority). */
  readonly priorityBreaches: number[];
  /** Ticky, v ktorých inbound job dostal vozidlo, hoci čakal aj `open` outbound job (priorita rozhodla). */
  readonly inboundWins: number[];
}

/** Beh s konzerváciou po každom ticku, kým `done` neplatí (+ `settle` tickov). */
function runOutbound(scenario: Scenario, done: (world: World) => boolean, settle = SETTLE_TICKS): Run {
  const world = World.create(DEFS, MAP, scenario.seed);
  const events: SimEvent[] = [];
  const priorityBreaches: number[] = [];
  const inboundWins: number[] = [];
  const afterTick = (w: World, tickEvents: readonly SimEvent[]): void => {
    assertCargoConservation(w);
    const assignedTo = (kind: CargoLocationKind): boolean =>
      tickEvents.some((event) => event.type === 'JobAssigned' && w.jobs.get(event.jobId)?.to.kind === kind);
    const openTo = (kind: CargoLocationKind): boolean => [...w.jobs.values()].some((job) => job.state === 'open' && job.to.kind === kind);
    if (assignedTo('at_ramp') && openTo('in_storage')) priorityBreaches.push(w.clock.tick);
    if (assignedTo('in_storage') && openTo('at_ramp')) inboundWins.push(w.clock.tick);
  };
  // Príkazy ticku 0 (rozloženie) sa aplikujú pred prvým tickom — podmienka sa kontroluje až po ňom.
  do {
    if (world.clock.tick >= MAX_TICKS) throw new Error(`scenár nedobehol do ${String(MAX_TICKS)} tickov`);
    events.push(...runScenario(world, scenario, world.clock.tick + 1, { afterTick }));
  } while (!done(world));
  events.push(...runScenario(world, scenario, world.clock.tick + settle, { afterTick }));
  return { world, events, priorityBreaches, inboundWins };
}

const stagingFull = (world: World): boolean => world.ships.size === 0 && world.jobs.size === 0 && rampOf(world).stagedCount === STAGING;

const ofType = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  events.filter((event): event is Extract<SimEvent, { type: T }> => event.type === type);

function moveChains(events: readonly SimEvent[]): Map<EntityId, CargoMovedEvent[]> {
  const chains = new Map<EntityId, CargoMovedEvent[]>();
  for (const event of ofType(events, 'CargoMoved')) chains.set(event.unitId, [...(chains.get(event.unitId) ?? []), event]);
  return chains;
}

const kindsOf = (chain: readonly CargoMovedEvent[]): CargoLocationKind[] => (chain.length === 0 ? [] : [chain[0].from.kind, ...chain.map((move) => move.to.kind)]);

const yardsOf = (world: World): StorageModule[] => [...world.modules.values()].filter((module): module is StorageModule => module instanceof StorageModule);

describe('scenár F4 outbound: 12 TEU loď → dvory → staging rampy (bez kamiónov)', () => {
  let run: Run;

  beforeAll(() => {
    run = runOutbound(outboundScenario(), stagingFull);
  });

  it('staging sa zaplní 4 jednotkami (2 docky × 2), 8 ostane v skladoch; nič inde, nič sa nestratilo', () => {
    const { world } = run;
    const ramp = rampOf(world);
    expect(world.isRampOperational(ramp)).toBe(true);
    expect(stagingOf(ramp)).toEqual([
      [2, 0],
      [2, 0],
    ]);
    expect([world.cargo.createdCount, world.cargo.liveCount, world.cargo.exportedCount]).toEqual([UNITS, UNITS, 0]);
    expect([world.cargo.countByKind('at_ramp'), world.cargo.countByKind('in_storage')]).toEqual([STAGING, UNITS - STAGING]);
    for (const kind of ['on_ship', 'in_crane', 'on_apron', 'in_vehicle', 'in_truck'] as const) expect(world.cargo.countByKind(kind), kind).toBe(0);
  });

  it('joby: 12 inbound (apron → sklad) a 4 outbound (sklad → rampa), každý raz priradený a hotový, žiadny zrušený; potom nový nevznikne', () => {
    const { world, events } = run;
    const ramp = rampOf(world);
    const created = ofType(events, 'JobCreated');
    const outbound = created.filter((event) => event.toModuleId === ramp.id);
    const yardIds = new Set<number>(yardsOf(world).map((yard) => yard.id));
    expect([created.length - outbound.length, outbound.length]).toEqual([UNITS, STAGING]);
    expect(outbound.every((event) => yardIds.has(event.fromModuleId))).toBe(true);
    expect(new Set(outbound.flatMap((event) => event.unitIds)).size).toBe(STAGING);
    expect([ofType(events, 'JobAssigned').length, ofType(events, 'JobDone').length, ofType(events, 'JobCancelled').length]).toEqual([UNITS + STAGING, UNITS + STAGING, 0]);
    expect(world.jobs.size).toBe(0);
  });

  it('reťaz pohybov: pripravená jednotka prešla on_ship → in_crane → on_apron → in_vehicle → in_storage → in_vehicle → at_ramp; ostatné končia v sklade', () => {
    const chains = moveChains(run.events);
    expect(chains.size).toBe(UNITS);
    const staged = [...chains.values()].filter((chain) => chain.at(-1)?.to.kind === 'at_ramp');
    expect(staged).toHaveLength(STAGING);
    for (const chain of staged) expect(kindsOf(chain)).toEqual(['on_ship', 'in_crane', 'on_apron', 'in_vehicle', 'in_storage', 'in_vehicle', 'at_ramp']);
    for (const chain of [...chains.values()].filter((entry) => entry.at(-1)?.to.kind !== 'at_ramp')) {
      expect(kindsOf(chain)).toEqual(['on_ship', 'in_crane', 'on_apron', 'in_vehicle', 'in_storage']);
    }
    for (const chain of chains.values()) {
      for (let i = 1; i < chain.length; i++) expect(chain[i].from).toEqual(chain[i - 1].to);
    }
  });

  it('dvory: unitsIn = 12, unitsOut = 4 (recordTaken), bez rezervácií; rampa bez rezervácií', () => {
    const yards = yardsOf(run.world);
    expect(yards.reduce((sum, yard) => sum + yard.unitsIn, 0)).toBe(UNITS);
    expect(yards.reduce((sum, yard) => sum + yard.unitsOut, 0)).toBe(STAGING);
    expect(yards.reduce((sum, yard) => sum + yard.storedCount, 0)).toBe(UNITS - STAGING);
    expect(yards.every((yard) => yard.reservedCount === 0)).toBe(true);
    expect(rampOf(run.world).reservedCount).toBe(0);
  });

  it('priorita: v žiadnom ticku nedostal outbound job vozidlo, kým ostal inbound job open; inbound vyhral aj nad čakajúcim outbound', () => {
    expect(run.priorityBreaches).toEqual([]);
    expect(run.inboundWins.length).toBeGreaterThan(0);
  });

  it('determinizmus: druhý beh má rovnaké udalosti aj stav; roundtrip uprostred outbound pokračuje rovnako', () => {
    const scenario = outboundScenario();
    const again = runOutbound(scenario, stagingFull);
    expect(again.events).toEqual(run.events);
    expect(stateHash(again.world)).toBe(stateHash(run.world));

    const world = World.create(DEFS, MAP, scenario.seed);
    let tick = 0;
    while (![...world.jobs.values()].some((job) => job.to.kind === 'at_ramp' && job.state !== 'open')) {
      tick += 1;
      runScenario(world, scenario, tick);
      if (tick > MAX_TICKS) throw new Error('outbound job s vozidlom nenastal');
    }
    const restored = World.deserialize(DEFS, MAP, JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>);
    expect(stateHash(restored)).toBe(stateHash(world));
    const a = runScenario(world, scenario, tick + 400);
    const b = runScenario(restored, scenario, tick + 400);
    expect(b).toEqual(a);
    expect(stateHash(restored)).toBe(stateHash(world));
  });
});

describe('scenár F4 outbound: rampa bez brány, brána neskôr; odstránenie brány počas outbound', () => {
  it('bez brány sa všetkých 12 TEU uloží a outbound nevznikne; po postavení brány sa staging zaplní', () => {
    const allStored = (world: World): boolean => world.ships.size === 0 && world.jobs.size === 0 && world.cargo.countByKind('in_storage') === UNITS;
    const first = runOutbound(outboundScenario(['waiting_area', 'ramp']), allStored, 100);
    expect(ofType(first.events, 'JobCreated')).toHaveLength(UNITS);
    expect(rampOf(first.world).reservedCount + rampOf(first.world).stagedCount).toBe(0);

    const gateAt = first.world.clock.tick;
    const late = outboundScenario(['waiting_area', 'ramp'], [{ atTick: gateAt, command: landsideCommand('gate') }]);
    const second = runOutbound(late, stagingFull);
    const outbound = ofType(second.events, 'JobCreated').slice(UNITS);
    expect(outbound).toHaveLength(STAGING);
    expect(stagingOf(rampOf(second.world))).toEqual([
      [2, 0],
      [2, 0],
    ]);
    expect(second.world.cargo.liveCount).toBe(UNITS);
  });

  it('brána odstránená pri open outbound joboch: zrušia sa, job s vozidlom sa dokončí, po obnove brány sa staging zaplní; nič sa nestratí', () => {
    const scenario = outboundScenario();
    const probe = World.create(DEFS, MAP, scenario.seed);
    let tick = 0;
    while (![...probe.jobs.values()].some((job) => job.to.kind === 'at_ramp' && job.state === 'open')) {
      tick += 1;
      runScenario(probe, scenario, tick);
      if (tick > MAX_TICKS) throw new Error('open outbound job nenastal');
    }
    const gateId = [...probe.modules.values()].find((module) => module.kind === 'gate')?.id;
    if (gateId === undefined) throw new Error('chýba brána');
    const later: ScenarioEntry[] = [
      { atTick: tick, command: { type: 'RemoveModule', moduleId: gateId } },
      { atTick: tick + 200, command: landsideCommand('gate') },
    ];
    const result = runOutbound(outboundScenario(['gate', 'waiting_area', 'ramp'], later), (world) => world.clock.tick > tick + 200 && stagingFull(world));
    const cancelled = ofType(result.events, 'JobCancelled');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every((event) => event.reason === 'ramp_inoperative')).toBe(true);
    expect(stagingOf(rampOf(result.world))).toEqual([
      [2, 0],
      [2, 0],
    ]);
    expect([result.world.cargo.liveCount, result.world.cargo.countByKind('in_storage')]).toEqual([UNITS, UNITS - STAGING]);
    const outboundDone = ofType(result.events, 'JobDone').length - UNITS;
    expect(outboundDone).toBe(STAGING);
  });
});
