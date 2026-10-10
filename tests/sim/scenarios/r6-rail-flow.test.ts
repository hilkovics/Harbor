// Železničný tok (TR6-02, ADR-043 dodatok): scenár `rail_flow` na `harbor_01` — STS, 4 ťahače, železničný terminál `rmg_rail_block` v parcele `rail_yard`, koľaj od portálu (95, 24) s úrovňovým
// priecestím (52, 50), kde ťahače križujú koľaj. Dva kontrakty tej istej voyage súbežne (nakládka exportu a vykládka importu ťahačmi pod jedným hákom sa prekrývajú, TR6-02b):
// - import 12 TEU (celý podiel vlakom): loď → STS → ťahač → RMG → buffer → RMG → vagón po vagóne → vlak odíde (> 50 % importu vlakom, v teste 100 %),
// - export 8 TEU (celý podiel vlakom): vlak privezie → RMG vyloží do bufferu → ťahač → STS → loď.
// Nič sa nestratí, nič neuviazne, beh je deterministický a prežije save uprostred toku.
import { describe, expect, it } from 'vitest';
import type { CargoMovedEvent } from '@sim/events';
import { ExportContract, ImportContract } from '@sim/contracts';
import { railMetrics } from '@sim/logistics';
import { loadMap, parseMapDef } from '@sim/grid';
import { RmgCrane } from '@sim/machines';
import { RailTerminal } from '@sim/modules';
import { trafficMetrics } from '@sim/traffic';
import { World, stateHash } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { acceptCommand, acceptUnchecked, hookDefs, send, TICKS_PER_DAY } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { lost } from '../helpers/f6c';
import { loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const IMPORT_UNITS = 12;
const EXPORT_UNITS = 8;
const MAX_TICKS = 40_000;
const CROSSING = { x: 52, y: 50 };

interface Run {
  readonly world: World;
  readonly events: { readonly tick: number; readonly event: CargoMovedEvent }[];
  readonly trains: { readonly tick: number; readonly type: string; readonly units?: number; readonly delayTicks?: number; readonly turnaroundTicks?: number }[];
  readonly jams: number;
  readonly hash: string;
}

function newWorld(): { readonly world: World } {
  const scenario = loadScenarioFile('rail_flow');
  // Cut-off 1 h pred príchodom lode: vlak s posledným exportom stihne naložiť (cestovný poriadok 3 h).
  const defs = hookDefs(1, { economy: { startingCashCents: 400_000_000, arrivalDaysRange: [1, 1], cutoffHours: 1 }, rail: { timetable: { firstArrivalHour: 1, intervalHours: 3, dwellMinutes: 90 } } });
  const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), scenario.seed, { checkInvariants: true });
  const rejected = runScenario(world, scenario, 1).filter((event) => event.type === 'CommandRejected');
  expect(rejected).toEqual([]);
  const book = world.contractBook;
  const tick = world.clock.tick;
  const terms = { slaDays: 5, rewardCents: 1_000_000, xpReward: 10, offeredTick: tick, offerExpiresTick: tick + 2 * TICKS_PER_DAY, shipClassId: 'feeder', cargoTypeId: 'container_teu', lineId: 'blue_anchor', railShareBp: 10_000 };
  const imp = new ImportContract({ ...terms, id: book.allocateId(), voyageId: book.allocateVoyageId(), templateId: 'container_feeder_standard', volumeUnits: IMPORT_UNITS, volumeTeu: IMPORT_UNITS });
  book.add(imp);
  expect(send(world, acceptCommand(imp.id)).some((event) => event.type === 'ContractAccepted')).toBe(true);
  // Export sa prijíma hneď s importom: nakládka exportu a vykládka importu ťahačmi pod hákom sa prekrývajú (TR6-02b).
  const exp = new ExportContract({ ...terms, id: book.allocateId(), voyageId: imp.voyageId, templateId: 'container_feeder_export', volumeUnits: EXPORT_UNITS, volumeTeu: EXPORT_UNITS, destinationPort: 'Hamburg' });
  book.add(exp);
  acceptUnchecked(world, exp.id);
  return { world };
}

/** Beh do uzavretia oboch kontraktov. `until` zastaví skôr (save uprostred toku). */
function run(world: World, until?: (world: World) => boolean): Run {
  const book = world.contractBook;
  const events: Run['events'][number][] = [];
  const trains: Run['trains'][number][] = [];
  let jams = 0;
  const exp = [...book.contracts.values()].find((contract): contract is ExportContract => contract instanceof ExportContract) as ExportContract;
  for (let i = 0; i < MAX_TICKS; i++) {
    for (const event of world.tick()) {
      const tick = world.clock.tick;
      if (event.type === 'CargoMoved') events.push({ tick, event });
      else if (event.type === 'TrainArrived') trains.push({ tick, type: event.type, delayTicks: event.delayTicks, units: event.exportUnits });
      else if (event.type === 'TrainDeparted') trains.push({ tick, type: event.type, units: event.units, turnaroundTicks: event.turnaroundTicks });
      else if (event.type === 'TrafficJam') jams += 1;
    }
    if (world.clock.tick % 2_000 === 0) {
      const violation = findWorldViolation(world);
      expect(violation, `tick ${String(world.clock.tick)}`).toBeUndefined();
      assertCargoConservation(world);
    }
    if (until?.(world) === true) break;
    if (exp.state === 'completed' && world.ships.size === 0) break;
  }
  return { world, events, trains, jams, hash: stateHash(world) };
}

function complete(): Run {
  const { world } = newWorld();
  return run(world);
}

describe('scenár rail_flow: import vlakom, export vlakom a loďou', () => {
  const first = complete();

  it('rozloženie: STS, depo s 4 ťahačmi, železničný terminál s RMG, koľaj napojená na portál s priecestím (52, 50)', () => {
    const { world } = first;
    const terminal = [...world.modules.values()].find((module): module is RailTerminal => module instanceof RailTerminal);
    expect(terminal).toBeDefined();
    const machine = world.machineOfBlock((terminal as RailTerminal).id);
    expect(machine).toBeInstanceOf(RmgCrane);
    expect(machine?.defId).toBe('rmg');
    expect(world.hasRailService).toBe(true);
    expect(world.rail.crossings.has(world.grid.index(CROSSING.x, CROSSING.y))).toBe(true);
    expect(world.grid.at(CROSSING.x, CROSSING.y).road).toBe('road');
    expect([...world.vehicles.values()].map((vehicle) => vehicle.defId)).toEqual(Array<string>(4).fill('terminal_tractor'));
  });

  it('oba kontrakty sa uzavreli: lostUnits 0, nič neostalo, žiadna zápcha ani uviaznutý nosič', () => {
    const { world, jams } = first;
    expect([...world.contractBook.contracts.values()].map((contract) => contract.state)).toEqual(['completed', 'completed']);
    expect(lost(world)).toBe(0);
    expect(world.cargo.liveCount).toBe(0);
    expect(world.cargo.exportedCount).toBe(IMPORT_UNITS);
    expect(world.cargo.shippedCount).toBe(EXPORT_UNITS);
    expect(jams, 'udalosti TrafficJam').toBe(0);
    expect(trafficMetrics(world).jammed, 'stuckAtEnd').toBe(0);
    expect(findWorldViolation(world)).toBeUndefined();
    assertCargoConservation(world);
  });

  it('viac než 50 % importu odišlo vlakom (tu 100 %): každá jednotka prešla loď → STS → ťahač → RMG → buffer → RMG → vlak → export', () => {
    const { world, events } = first;
    expect(railMetrics(world).railImportSharePct).toBeGreaterThan(50);
    const chains = new Map<number, string[]>();
    for (const { event } of events) {
      const chain = chains.get(event.unitId) ?? [event.from.kind];
      chain.push(event.to.kind);
      chains.set(event.unitId, chain);
    }
    const imports = [...chains.values()].filter((chain) => chain[0] === 'on_ship' && chain.at(-1) === 'exported');
    expect(imports).toHaveLength(IMPORT_UNITS);
    for (const chain of imports) {
      expect(chain.join(' → ')).toBe('on_ship → in_crane → in_vehicle → in_handler → in_storage → in_handler → in_train → exported');
    }
  });

  it('export prišiel vlakom a odišiel loďou: in_train → RMG → buffer → RMG → ťahač → STS → loď', () => {
    const { events } = first;
    const chains = new Map<number, string[]>();
    for (const { event } of events) {
      const chain = chains.get(event.unitId) ?? [event.from.kind];
      chain.push(event.to.kind);
      chains.set(event.unitId, chain);
    }
    const exports = [...chains.values()].filter((chain) => chain[0] === 'in_train');
    expect(exports).toHaveLength(EXPORT_UNITS);
    // Pod hákom buď priamo vozidlo → žeriav, alebo cez apron, keď vozidlo ustúpi vykládke importu (`yieldHook`, TR6-02b).
    for (const chain of exports) expect(chain.join(' → ')).toMatch(/^in_train → in_handler → in_storage → in_handler → in_vehicle → (on_apron → )?in_crane → on_ship → shipped$/);
  });

  it('import a export bežia súbežne na jednej lodi pod hákom: nakládka exportu začne pred koncom vykládky importu a nikto neuviazne (TR6-02b)', () => {
    const { events } = first;
    const discharge = events.filter(({ event }) => event.from.kind === 'on_ship' && event.to.kind === 'in_crane').map(({ tick }) => tick);
    const loads = events.filter(({ event }) => event.to.kind === 'on_ship').map(({ tick }) => tick);
    expect(discharge).toHaveLength(IMPORT_UNITS);
    expect(loads).toHaveLength(EXPORT_UNITS);
    expect(Math.min(...loads), 'prvá nakládka exportu pred poslednou vykládkou importu').toBeLessThan(Math.max(...discharge));
  });

  it('vagóny sa nakladajú po celých vagónoch od lokomotívy: nový vagón sa začne, až keď predchádzajúci má 3 TEU', () => {
    const { events, trains } = first;
    const departures = trains.filter((entry) => entry.type === 'TrainDeparted' && (entry.units ?? 0) > 0);
    expect(departures.length).toBeGreaterThan(0);
    const byTrain = new Map<number, number[]>();
    for (const { event } of events) {
      if (event.to.kind !== 'in_train' || event.from.kind !== 'in_handler') continue;
      const slots = byTrain.get(event.to.trainId) ?? [];
      slots.push(event.to.slot);
      byTrain.set(event.to.trainId, slots);
    }
    expect(byTrain.size).toBeGreaterThan(0);
    for (const [, slots] of byTrain) {
      const wagons = slots.map((slot) => Math.floor(slot / 3));
      // Poradie nakládky: vagóny neklesajú a každý vagón okrem posledného je plný (3 jednotky 20′).
      expect(wagons).toEqual([...wagons].sort((a, b) => a - b));
      const counts = new Map<number, number>();
      for (const wagon of wagons) counts.set(wagon, (counts.get(wagon) ?? 0) + 1);
      const used = [...counts.keys()].sort((a, b) => a - b);
      for (const wagon of used.slice(0, -1)) expect(counts.get(wagon)).toBe(3);
    }
    expect([...byTrain.values()].reduce((sum, slots) => sum + slots.length, 0)).toBe(IMPORT_UNITS);
  });

  it('metriky: meškanie vlakov 0 min, obrat ≥ plánovaný pobyt (90 min), vlaky odišli v pláne alebo plné', () => {
    const { world, trains } = first;
    const metrics = railMetrics(world);
    expect(metrics.trainDelayMin).toBe(0);
    expect(metrics.trainTurnaroundMin).toBeGreaterThanOrEqual(90);
    expect(metrics.trainsDeparted).toBeGreaterThan(5);
    expect(metrics.importUnitsByTrain).toBe(IMPORT_UNITS);
    const full = trains.filter((entry) => entry.type === 'TrainDeparted' && entry.units === IMPORT_UNITS);
    // Plný vlak (12 TEU = 4 vagóny) odíde pred koncom plánovaného pobytu (90 min = 540 tickov + jazda).
    for (const entry of full) expect(entry.turnaroundTicks).toBeLessThan(540 + 600);
  });

  it('beh je deterministický: druhý beh dá rovnaký odtlačok stavu', () => {
    expect(complete().hash).toBe(first.hash);
  });
});

describe('save uprostred toku', () => {
  it('svet uložený počas pobytu vlaka s nákladom sa obnoví a beh pokračuje bit po bite rovnako', () => {
    const { world } = newWorld();
    run(world, (w) => [...w.trains.values()].some((train) => train.state === 'dwelling' && w.cargo.countAt('in_train', train.id) > 0));
    expect([...world.trains.values()].some((train) => train.state === 'dwelling')).toBe(true);
    const saved = JSON.parse(JSON.stringify(world.serialize())) as ReturnType<World['serialize']>;
    const copy = World.deserialize(world.defs, world.map, saved, { checkInvariants: true });
    expect(stateHash(copy)).toBe(stateHash(world));
    const original = run(world);
    const restored = run(copy);
    expect(restored.hash).toBe(original.hash);
    expect(lost(copy)).toBe(0);
  });
});
