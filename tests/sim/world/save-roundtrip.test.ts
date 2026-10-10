/**
 * Roundtrip save → load presne v rozbehnutých situáciách (T06-02; ADR-030 body 6 a 7; ARCHITECTURE §14, §16):
 * `World.deserialize(JSON.parse(JSON.stringify(world.serialize())))` v ticku, keď
 *  (a) žeriav zdvíha kontajner z lode (`grabbing`, rezervovaný slot) alebo ho spúšťa na apron (`placing`, jednotka
 *      `in_crane`) alebo stojí zablokovaný plným apronom (`blocked`) — v kóde sú fázy cyklu `grabbing → swinging →
 *      placing`; `swinging` je okamžitý prechod a neukladá sa, preto „lifting/lowering“ z karty = `grabbing`/`placing`,
 *  (b) kamión ide k TP bloku (`to_tp`, uprostred úseku) alebo sa obsluhuje na TP (`at_edge_tp`, fáza `handling`),
 *  (c) kontrakt je `unloading` (uprostred vykládky) a (d) `exporting` (prvý tick aj uprostred exportu),
 *  (e) jedna loď je v `arriving` a iná čaká na anchorage (aj loď plávajúca na anchorage, loď vplávajúca pri odchode
 *      predchádzajúcej a odchod s frontou na anchorage) — scenár `multi_ship_queue` (jedno kotvisko, päť lodí),
 *  (f) vozidlo vezie jednotku po ceste (`to_dropoff`, uprostred úseku, jednotka `in_vehicle`),
 * a obnovený svet po ďalších 5 000 tickoch dá **rovnaký hash stavu aj rovnaký prúd udalostí po tickoch** ako
 * nepretržitý beh. Jednotka v tomto súbore: svet po `tick()`, v ktorom `clock.tick` dosiahol T, pred príkazmi
 * s `atTick = T` (rovnako ako `simrun --roundtrip-at T`, `roundtrip-mid-flow.test.ts`).
 *
 * Ticky situácií sa nehľadajú natvrdo: nepretržitý beh sleduje predikáty nad živým svetom a v prvom ticku, kde
 * platí predikát, uloží save. Stráž pokrytia navyše overí nad **uloženým JSON-om** (nie nad živým svetom), že save tú
 * situáciu naozaj obsahuje — zmena balansu, ktorá situáciu posunie, test nezneplatní, len ju prenesie na iný tick;
 * ak situácia v scenári prestane nastávať, zlyhá s vysvetlením (nie nevyhnutne zhodou hashov).
 * Konzervácia nákladu (`assertCargoConservation`) beží po každom ticku nepretržitého behu aj obnovených behov.
 *
 * Dopĺňa `roundtrip-mid-flow.test.ts` (T06-01: pevné ticky 3 000 / 9 000 / 12 000 / 15 000 nad `vertical_slice` a 4 000
 * nad `full_import_chain`, citlivosť na `Rng`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import type { CraneRuntimeState } from '@sim/modules';
import { World, fnv1a32Hex, stateHash, type WorldState } from '@sim/world';
import { cranesOf } from '../helpers/harbor';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario, type RunHooks, type Scenario } from '../helpers/scenario';
import { DEFS, PORT_MAP } from './world-fixtures';

/** Počet tickov po roundtripe, po ktorých sa porovnáva hash (zadanie T06-02). */
const AFTER_TICKS = 5_000;
/** Krok, po ktorom nepretržitý beh prehodnotí, či už všetko našiel (zbytočný dobeh je najviac jeden krok). */
const CHUNK_TICKS = 250;
const HEAVY_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------------------------------------
// Situácie: predikát nad živým svetom (kde zachytiť) + kontrola nad uloženým stavom (že save situáciu obsahuje)
// ---------------------------------------------------------------------------------------------------------

interface Situation {
  readonly id: string;
  readonly title: string;
  /** Platí pre svet po ticku? Prvý tick, kde platí, je bod roundtripu. */
  readonly match: (world: World) => boolean;
  /** Obsahuje uložený stav situáciu? (nezávislé od `match`, číta len JSON savu) */
  readonly inSave: (state: WorldState) => boolean;
  /**
   * Zmena práve toho stavu, ktorý situácia testuje (platný pre `parseWorldState`, ale iný než v nepretržitom behu) —
   * kontrola citlivosti: save s takou zmenou musí dobehnúť inak, inak by porovnanie hashov túto časť stavu nepokrývalo.
   */
  readonly tamper?: (state: WorldState) => WorldState;
}

function craneRuntimes(state: WorldState): CraneRuntimeState[] {
  return state.modules.filter((entry) => DEFS.modules.get(entry.defId).kind === 'crane').map((entry) => entry.runtime as unknown as CraneRuntimeState);
}

function unitsAt(state: WorldState, kind: string): number {
  return state.cargo.units.filter((unit) => unit.location.kind === kind).length;
}

/** Fáza žeriavu beží a nie je na hranici (ostáva aspoň jeden tick, a jeden už uplynul). */
function midPhase(runtime: CraneRuntimeState): boolean {
  return runtime.phaseTicksLeft > 1 && runtime.phaseTicksLeft < runtime.phaseTicksTotal;
}

/** Zmena `Rng` v save (jeden bit prvého slova) — platný stav, ale iný ako v nepretržitom behu. */
function tamperRng(state: WorldState): WorldState {
  const [s0, s1, s2, s3] = state.rng;
  return { ...state, rng: [(s0 + 1) >>> 0, s1, s2, s3] };
}

/** Žeriav, ktorý práve beží fázu `phase`, dostane o tick dlhší zvyšok fázy (stále `≤ phaseTicksTotal`, lebo fáza je uprostred). */
function tamperCranePhase(phase: CraneRuntimeState['state']): (state: WorldState) => WorldState {
  return (state) => ({
    ...state,
    modules: state.modules.map((entry) => {
      if (DEFS.modules.get(entry.defId).kind !== 'crane') return entry;
      const runtime = entry.runtime as unknown as CraneRuntimeState;
      if (runtime.state !== phase) return entry;
      return { ...entry, runtime: { ...runtime, phaseTicksLeft: runtime.phaseTicksLeft + 1 } as unknown as WorldState['modules'][number]['runtime'] };
    }),
  });
}

/** Kontrakt, v ktorom je vyložená/exportovaná práve polovica objemu. */
function halfway(done: number, volume: number): boolean {
  return done === Math.floor(volume / 2);
}

const CRANE_LIFTING: Situation = {
  id: 'crane_lifting',
  title: 'žeriav zdvíha kontajner z lode (grabbing, uprostred fázy, slot apronu rezervovaný, jednotka ešte na lodi)',
  match: (world) => cranesOf(world).some((crane) => crane.state === 'grabbing' && midPhase(crane.getRuntimeState())),
  inSave: (state) =>
    craneRuntimes(state).some((runtime) => runtime.state === 'grabbing' && midPhase(runtime) && runtime.reservedSlot !== null) &&
    unitsAt(state, 'in_crane') === 0 &&
    unitsAt(state, 'on_ship') > 0,
  tamper: tamperCranePhase('grabbing'),
};

const CRANE_LOWERING: Situation = {
  id: 'crane_lowering',
  title: 'žeriav spúšťa kontajner na apron (placing, uprostred fázy, jednotka in_crane)',
  match: (world) => cranesOf(world).some((crane) => crane.state === 'placing' && midPhase(crane.getRuntimeState()) && crane.heldUnitId !== null),
  inSave: (state) =>
    craneRuntimes(state).some((runtime) => runtime.state === 'placing' && midPhase(runtime) && runtime.reservedSlot !== null) && unitsAt(state, 'in_crane') === 1,
  tamper: tamperCranePhase('placing'),
};

const TRUCK_TO_TP: Situation = {
  id: 'truck_to_tp',
  title: 'kamión ide k TP bloku (to_tp, uprostred úseku trasy, token TP rezervovaný)',
  match: (world) => [...world.trucks.values()].some((truck) => truck.state === 'to_tp' && truck.progress > 0),
  inSave: (state) => state.trucks.some((truck) => truck.state === 'to_tp' && truck.progress > 0 && truck.route.length >= 2 && truck.tpCell !== null),
};

const TRUCK_AT_TP: Situation = {
  id: 'truck_at_tp',
  title: 'kamión sa obsluhuje na TP na hrane bloku (at_edge_tp, fáza beží, job in_storage ↔ in_truck)',
  match: (world) => [...world.trucks.values()].some((truck) => truck.state === 'at_edge_tp' && truck.phase === 'handling'),
  inSave: (state) => state.trucks.some((truck) => truck.state === 'at_edge_tp' && truck.phase === 'handling' && truck.jobId !== null),
};

const CRANE_BLOCKED: Situation = {
  id: 'crane_blocked',
  title: 'žeriav stojí zablokovaný plným apronom (blocked, počítadlo blockedTicks beží, nič nedrží ani nerezervuje)',
  match: (world) => cranesOf(world).some((crane) => crane.state === 'blocked'),
  inSave: (state) => craneRuntimes(state).some((runtime) => runtime.state === 'blocked' && runtime.reservedSlot === null) && unitsAt(state, 'in_crane') === 0,
};

const CONTRACT_UNLOADING: Situation = {
  id: 'contract_unloading',
  title: 'kontrakt unloading, vyložená polovica objemu',
  match: (world) => [...world.contracts.values()].some((contract) => contract.state === 'unloading' && halfway(contract.unitsUnloaded, contract.volumeUnits)),
  inSave: (state) => state.contracts.some((contract) => contract.state === 'unloading' && contract.unitsUnloaded > 0 && contract.unitsUnloaded < contract.volumeUnits),
};

const CONTRACT_EXPORTING_FIRST: Situation = {
  id: 'contract_exporting_first_tick',
  title: 'kontrakt exporting hneď v ticku prechodu z unloading (vyložené všetko, nič neexportované)',
  match: (world) => [...world.contracts.values()].some((contract) => contract.state === 'exporting'),
  inSave: (state) => state.contracts.some((contract) => contract.state === 'exporting' && contract.unitsExported === 0 && contract.unitsUnloaded === contract.volumeUnits),
};

const CONTRACT_EXPORTING_MID: Situation = {
  id: 'contract_exporting_mid',
  title: 'kontrakt exporting, exportovaná polovica objemu (kamióny v bráne, pri docku aj na ceste von)',
  match: (world) => [...world.contracts.values()].some((contract) => contract.state === 'exporting' && halfway(contract.unitsExported, contract.volumeUnits)),
  inSave: (state) =>
    state.contracts.some((contract) => contract.state === 'exporting' && contract.unitsExported > 0 && contract.unitsExported < contract.volumeUnits) &&
    state.trucks.length > 0,
};

const VEHICLE_LOADED_ON_ROAD: Situation = {
  id: 'vehicle_loaded_on_road',
  title: 'vozidlo vezie kontajner po ceste (to_dropoff, uprostred úseku, jednotka in_vehicle, job beží)',
  match: (world) => world.cargo.countByKind('in_vehicle') > 0 && [...world.vehicles.values()].some((vehicle) => vehicle.state === 'to_dropoff' && vehicle.progress > 0),
  inSave: (state) =>
    state.vehicles.some((vehicle) => vehicle.state === 'to_dropoff' && vehicle.progress > 0 && vehicle.jobId !== null) &&
    unitsAt(state, 'in_vehicle') > 0 &&
    state.jobs.length > 0,
};

const SHIP_ARRIVING_AND_ANCHORAGE: Situation = {
  id: 'ship_arriving_and_anchorage',
  title: 'jedna loď čaká pred vstupom (arriving), iná na anchorage (waiting_anchorage), tretia pri kotvisku',
  match: (world) => {
    const states = [...world.ships.values()].map((ship) => ship.state);
    return states.includes('arriving') && states.includes('waiting_anchorage') && states.includes('docked');
  },
  inSave: (state) =>
    state.ships.some((ship) => ship.state === 'arriving' && ship.route.length === 0) &&
    state.ships.some((ship) => ship.state === 'waiting_anchorage' && ship.anchorageIndex !== null) &&
    state.ships.some((ship) => ship.state === 'docked' && ship.berthIds.length > 0),
};

/** Loď pláva na svoju anchorage (`waiting_anchorage`, trasa ešte nie je dokončená) — od T6D-03 priamo zo vstupu, nie po sea lane. */
const sailingToAnchorage = (ship: { readonly state: string; readonly waypointIndex: number; readonly route: readonly unknown[] }): boolean =>
  ship.state === 'waiting_anchorage' && ship.waypointIndex < ship.route.length;

const SHIP_SAILING_TO_ANCHORAGE: Situation = {
  id: 'ship_sailing_to_anchorage',
  title: 'loď pláva priamo na rejdu (waiting_anchorage, trasa nedokončená; T6D-03) popri lodi na rejde v pokoji, lodi pri kotvisku a lodi pred vstupom',
  match: (world) => {
    const ships = [...world.ships.values()];
    return (
      ships.some(sailingToAnchorage) &&
      ships.some((ship) => ship.state === 'waiting_anchorage' && !sailingToAnchorage(ship)) &&
      ships.some((ship) => ship.state === 'docked') &&
      ships.some((ship) => ship.state === 'arriving')
    );
  },
  inSave: (state) =>
    state.ships.some((ship) => sailingToAnchorage(ship) && ship.anchorageIndex !== null) &&
    state.ships.some((ship) => ship.state === 'waiting_anchorage' && !sailingToAnchorage(ship)) &&
    state.ships.some((ship) => ship.state === 'arriving'),
};

const SHIP_UNDOCKING_WITH_QUEUE: Situation = {
  id: 'ship_undocking_with_queue',
  title: 'loď odchádza od kotviska (undocking) a tri lode čakajú na anchorage',
  match: (world) => {
    const states = [...world.ships.values()].map((ship) => ship.state);
    return states.includes('undocking') && states.filter((state) => state === 'waiting_anchorage').length >= 3;
  },
  inSave: (state) => state.ships.some((ship) => ship.state === 'undocking') && state.ships.filter((ship) => ship.state === 'waiting_anchorage').length >= 3,
};

const SHIP_BERTHING_WHILE_OUTBOUND: Situation = {
  id: 'ship_berthing_while_outbound',
  title: 'loď z anchorage vplýva k uvoľnenému kotvisku (berthing), kým predchádzajúca odpláva (outbound)',
  match: (world) => {
    const states = [...world.ships.values()].map((ship) => ship.state);
    return states.includes('berthing') && states.includes('outbound');
  },
  inSave: (state) => state.ships.some((ship) => ship.state === 'berthing' && ship.berthIds.length > 0) && state.ships.some((ship) => ship.state === 'outbound'),
};

// ---------------------------------------------------------------------------------------------------------
// Nepretržitý beh so zachytením savov a opätovný beh z savu
// ---------------------------------------------------------------------------------------------------------

interface Capture {
  readonly tick: number;
  /** JSON text savu — presne to, čo by app zapísala do súboru / `localStorage`. */
  readonly saveText: string;
  /** Hash savu v momente uloženia (`fnv1a32Hex(saveText)` = `stateHash` sveta). */
  readonly savedHash: string;
}

interface Baseline {
  readonly captures: ReadonlyMap<string, Capture>;
  /** Hash nepretržitého behu v ticku `capture.tick + AFTER_TICKS` pre každú situáciu. */
  readonly hashAfter: ReadonlyMap<string, string>;
  /** Odtlačok udalostí každého ticku (index = `clock.tick` po ticku). */
  readonly eventPrints: readonly string[];
}

/**
 * Nepretržitý beh scenára: v prvom ticku, kde platí predikát situácie, uloží save, a o `AFTER_TICKS` ticky neskôr zapíše
 * hash. Hľadá najviac do ticku `searchLimit`; nenájdená situácia chýba v `captures` (test ju ohlási).
 */
function recordBaseline(scenario: Scenario, situations: readonly Situation[], searchLimit: number): Baseline {
  const world = World.create(DEFS, PORT_MAP, scenario.seed);
  const captures = new Map<string, Capture>();
  const hashAfter = new Map<string, string>();
  const dueHashes = new Map<number, string[]>();
  const eventPrints: string[] = [];

  const hooks: RunHooks = {
    afterTick: (w: World, events: readonly SimEvent[]) => {
      assertCargoConservation(w);
      const tick = w.clock.tick;
      eventPrints[tick] = fnv1a32Hex(JSON.stringify(events));
      const due = dueHashes.get(tick);
      if (due !== undefined) {
        const hash = stateHash(w);
        for (const id of due) hashAfter.set(id, hash);
      }
      if (tick > searchLimit) return;
      for (const situation of situations) {
        if (captures.has(situation.id) || !situation.match(w)) continue;
        const saveText = JSON.stringify(w.serialize());
        captures.set(situation.id, { tick, saveText, savedHash: fnv1a32Hex(saveText) });
        dueHashes.set(tick + AFTER_TICKS, [...(dueHashes.get(tick + AFTER_TICKS) ?? []), situation.id]);
      }
    },
  };

  for (;;) {
    const searching = captures.size < situations.length && world.clock.tick < searchLimit;
    const lastDue = Math.max(0, ...dueHashes.keys());
    if (!searching && world.clock.tick >= lastDue) break;
    runScenario(world, scenario, world.clock.tick + CHUNK_TICKS, hooks);
  }
  return { captures, hashAfter, eventPrints };
}

interface Resumed {
  readonly loadedHash: string;
  readonly tickAfterLoad: number;
  /** Prvý tick, v ktorom sa udalosti obnoveného behu líšia od nepretržitého; `null` = všetky rovnaké. */
  readonly firstEventMismatch: number | null;
  readonly finalHash: string;
}

/** Obnoví svet zo savu situácie a dobehne `AFTER_TICKS` ticky so scenárom. */
function resume(scenario: Scenario, baseline: Baseline, capture: Capture): Resumed {
  const world = World.deserialize(DEFS, PORT_MAP, JSON.parse(capture.saveText) as WorldState);
  const loadedHash = stateHash(world);
  const tickAfterLoad = world.clock.tick;
  world.assertInvariants();
  let firstEventMismatch: number | null = null;
  runScenario(world, scenario, capture.tick + AFTER_TICKS, {
    afterTick: (w, events) => {
      assertCargoConservation(w);
      if (firstEventMismatch === null && fnv1a32Hex(JSON.stringify(events)) !== baseline.eventPrints[w.clock.tick]) firstEventMismatch = w.clock.tick;
    },
  });
  return { loadedHash, tickAfterLoad, firstEventMismatch, finalHash: stateHash(world) };
}

/** Reťazený roundtrip: svet sa nahradí obnoveným v každom zachytenom ticku (v poradí ticku) a dobehne do konca. */
function resumeChained(scenario: Scenario, captures: readonly Capture[]): { readonly finalTick: number; readonly finalHash: string } {
  const ordered = [...captures].sort((a, b) => a.tick - b.tick);
  let world = World.create(DEFS, PORT_MAP, scenario.seed);
  for (const capture of ordered) {
    runScenario(world, scenario, capture.tick, { afterTick: assertCargoConservation });
    world = World.deserialize(DEFS, PORT_MAP, JSON.parse(JSON.stringify(world.serialize())) as WorldState);
  }
  const finalTick = (ordered.at(-1)?.tick ?? 0) + AFTER_TICKS;
  runScenario(world, scenario, finalTick, { afterTick: assertCargoConservation });
  return { finalTick, finalHash: stateHash(world) };
}

/** Dobehne `AFTER_TICKS` ticky zo savu situácie upraveného `tamper` a vráti hash na konci. */
function resumeTampered(scenario: Scenario, capture: Capture, tamper: (state: WorldState) => WorldState): string {
  const world = World.deserialize(DEFS, PORT_MAP, tamper(JSON.parse(capture.saveText) as WorldState));
  runScenario(world, scenario, capture.tick + AFTER_TICKS, { afterTick: assertCargoConservation });
  return stateHash(world);
}

/** Spoločné testy jednej skupiny situácií nad jedným scenárom. */
function describeRoundtrips(name: string, scenarioId: string, situations: readonly Situation[], searchLimit: number): void {
  describe(name, () => {
    const scenario = loadScenarioFile(scenarioId);
    let baseline: Baseline;

    beforeAll(() => {
      baseline = recordBaseline(scenario, situations, searchLimit);
    }, HEAVY_TIMEOUT_MS);

    it.each(situations)(
      '$id: $title → save v tom ticku obsahuje situáciu, hash aj udalosti po ďalších 5 000 tickoch = nepretržitý beh',
      (situation) => {
        const capture = baseline.captures.get(situation.id);
        expect(capture, `situácia '${situation.id}' (${situation.title}) nenastala v scenári '${scenarioId}' do ticku ${String(searchLimit)}`).toBeDefined();
        if (capture === undefined) return;

        const saved = JSON.parse(capture.saveText) as WorldState;
        expect(situation.inSave(saved), `uložený stav v ticku ${String(capture.tick)} neobsahuje situáciu '${situation.id}'`).toBe(true);

        const run = resume(scenario, baseline, capture);
        expect(run.tickAfterLoad).toBe(capture.tick);
        expect(run.loadedHash, 'hash obnoveného sveta = hash savu').toBe(capture.savedHash);
        expect(run.firstEventMismatch, 'prvý tick s odlišnými udalosťami po načítaní').toBeNull();
        expect(run.finalHash, `hash v ticku ${String(capture.tick + AFTER_TICKS)}`).toBe(baseline.hashAfter.get(situation.id));
      },
      HEAVY_TIMEOUT_MS,
    );

    it(
      'situácie nastávajú v rôznych tickoch (každý roundtrip testuje iný stav sveta): odlišné savy',
      () => {
        const texts = new Set([...baseline.captures.values()].map((capture) => capture.saveText));
        expect(texts.size).toBe(baseline.captures.size);
        expect(baseline.captures.size).toBe(situations.length);
      },
    );

    it.each(situations.slice(0, 1))(
      'kontrola citlivosti $id: save so zmeneným Rng dobehne do iného stavu (porovnanie hashov by stratu stavu odhalilo)',
      (situation) => {
        const capture = baseline.captures.get(situation.id);
        if (capture === undefined) throw new Error(`situácia '${situation.id}' nenastala`);
        expect(resumeTampered(scenario, capture, tamperRng)).not.toBe(baseline.hashAfter.get(situation.id));
      },
      HEAVY_TIMEOUT_MS,
    );

    it.each(situations.filter((situation) => situation.tamper !== undefined))(
      'kontrola citlivosti $id: save s inou dynamikou testovaného stavu (fáza žeriavu o tick dlhšia) dobehne do iného stavu',
      (situation) => {
        const capture = baseline.captures.get(situation.id);
        if (capture === undefined || situation.tamper === undefined) throw new Error(`situácia '${situation.id}' nenastala`);
        expect(resumeTampered(scenario, capture, situation.tamper)).not.toBe(baseline.hashAfter.get(situation.id));
      },
      HEAVY_TIMEOUT_MS,
    );

    it(
      'reťazený roundtrip vo všetkých týchto situáciách po sebe dá rovnaký hash ako nepretržitý beh',
      () => {
        const captures = [...baseline.captures.values()];
        const chained = resumeChained(scenario, captures);
        const last = [...baseline.captures.entries()].sort((a, b) => a[1].tick - b[1].tick).at(-1);
        expect(last).toBeDefined();
        if (last === undefined) return;
        expect(chained.finalTick).toBe(last[1].tick + AFTER_TICKS);
        expect(chained.finalHash).toBe(baseline.hashAfter.get(last[0]));
      },
      HEAVY_TIMEOUT_MS,
    );
  });
}

describeRoundtrips(
  'roundtrip uprostred vertical_slice (žeriav, vozidlo na ceste, kontrakt unloading / exporting, kamión pri rampe)',
  'vertical_slice',
  [
    CRANE_LIFTING,
    CRANE_LOWERING,
    CRANE_BLOCKED,
    CONTRACT_UNLOADING,
    VEHICLE_LOADED_ON_ROAD,
    CONTRACT_EXPORTING_FIRST,
    TRUCK_TO_TP,
    TRUCK_AT_TP,
    CONTRACT_EXPORTING_MID,
  ],
  14_000,
);

describeRoundtrips(
  'roundtrip uprostred multi_ship_queue (jedno kotvisko, päť lodí: arriving, plavba na rejdu, waiting_anchorage, odchod)',
  'multi_ship_queue',
  [SHIP_ARRIVING_AND_ANCHORAGE, SHIP_SAILING_TO_ANCHORAGE, SHIP_UNDOCKING_WITH_QUEUE, SHIP_BERTHING_WHILE_OUTBOUND],
  15_000, // R2 (ADR-039): vykládka lodí je pomalšia (fyzická kapacita dvora 48 TEU) — situácia nastane neskôr (pôvodne 6 000)
);
