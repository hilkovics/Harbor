/**
 * Špička na bráne (R4, TR4-01, ADR-041; TR4-02 bez rampy): 8 vstupných pruhov v dvoch blokoch po 4 (každý s vlastnou predbránovou plochou 8×8), 4 výstupné pruhy, 12 dvorov s TP na hrane, 10 odstavných plôch
 * (60 státí) a 10 straddle carrierov (`helpers/r4-gates-layout.ts`). Test kladie jednotky priamo do dvorov tempom 100 jednotiek za hodinu (1 jednotka na kamión) počas jednej hernej hodiny; kamióny
 * vznikajú na dvoch portáloch vjazdu (`Rng` podľa `trafficShare`) po jednom na jednotku s tokenom (TP dvora, alebo státie), prechádzajú plochou, pruhom a odstavnou plochou / TP a odchádzajú výstupným
 * pruhom na portál výjazdu.
 *
 * Overuje sa: špička naozaj dosiahla 100 vzniknutých kamiónov za hodinu; na verejnej ceste pred vjazdom plochy nevznikol front (kamión v `to_pre_gate` nestál ≥ `QUEUE_BLOCK_TICKS`);
 * plochy aj rady držali kapacitu; všetky pruhy aj oba bloky pracovali; nič sa nestratilo (konzervácia každý tick, `lostUnits` 0); nič neuviazlo (žiadny kamión nestál
 * v jednom stave dlhšie než `STUCK_TICKS`, na konci žiadny kamión a všetky jednotky exportované); beh je deterministický (rovnaký seed → rovnaký stav a udalosti, iný seed → iný stav) a
 * obnova zo save uprostred špičky dá rovnaký výsledok ako nepretržitý beh.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { adjacentLaneGroups } from '@sim/modules';
import { World, findWorldViolation, type WorldState } from '@sim/world';
import { lostUnits } from '../helpers/f6a';
import { assertCargoConservation } from '../helpers/invariants';
import { stockYard } from '../logistics/outbound-fixtures';
import { GATES_DEFS, GATES_MAP, IN_LANES, LANES_PER_BLOCK, OUT_LANES, gatesWorld, type GatesWorld } from '../helpers/r4-gates-layout';
import { stateHash } from '../helpers/scenario';

const SEED = 4101;
const PEAK_TRUCKS_PER_HOUR = 100;
const TICKS_PER_HOUR = 3600 / GATES_DEFS.time.tickGameSeconds;
/** Jednotky sa kladú počas jednej hernej hodiny; potom sa beh dobieha, kým sa všetko neodvezie. */
const PEAK_TICKS = TICKS_PER_HOUR;
const RUN_TICKS = 7_000;
/** Kamióny vznikajú, len kým je voľný token (TP dvora, alebo státie): špička sa rozloží za čas, kým straddle carriery uvoľňujú tokeny (namerané ≈ 69 za hodinu). */
const MIN_BEST_HOUR = 60;
/** Kamión v `to_pre_gate`, ktorý stojí aspoň toľko tickov, je front na verejnej ceste (krátke zastavenie za predchádzajúcim kamiónom front nie je). */
const QUEUE_BLOCK_TICKS = 10;
/** Najdlhší pobyt v jednom stave: kamión čaká v stojisku na dock najviac niekoľko stoviek tickov (namerané ≈ 530). */
const STUCK_TICKS = 1_500;
const SPLIT_TICK = 200;
const INVARIANT_EVERY = 100;

interface Observed {
  readonly layout: GatesWorld;
  readonly spawnTicks: number[];
  readonly eventDigest: string;
  maxQueueBlocked: number;
  maxDwell: number;
  maxBufferOccupied: number;
  maxRowOccupied: number;
  maxTrucks: number;
  staged: number;
}

/** Jednotka do dvora (striedavo po dvoroch podľa počtu doterajších; bezstavové: obnova uprostred behu dáva rovnaké rozhodnutia). */
function stageOne(layout: GatesWorld, staged: number): boolean {
  const yard = layout.yards[staged % layout.yards.length];
  stockYard(layout.world, yard, 1);
  return true;
}

/** Špička: v ticku `t` (1…PEAK_TICKS) pribudne jednotka, keď celočíselný súčet `t × 100 / tickov za hodinu` narastie. */
const stagesAt = (tick: number): boolean => tick <= PEAK_TICKS && (tick * PEAK_TRUCKS_PER_HOUR) % TICKS_PER_HOUR < PEAK_TRUCKS_PER_HOUR;

function drive(layout: GatesWorld, observed: Observed, fromTick: number, toTick: number, since: Map<number, { state: string; tick: number }>): void {
  const { world, buffers } = layout;
  for (let tick = fromTick + 1; tick <= toTick; tick++) {
    if (stagesAt(tick) && stageOne(layout, observed.staged)) observed.staged += 1;
    const events = world.tick();
    let digest = observed.eventDigest;
    for (const event of events) {
      if (event.type === 'TruckSpawned') observed.spawnTicks.push(tick);
      digest = foldEvent(digest, tick, event);
    }
    (observed as { eventDigest: string }).eventDigest = digest;
    assertCargoConservation(world);
    if (tick % INVARIANT_EVERY === 0) expect(findWorldViolation(world)).toBeUndefined();
    observed.maxTrucks = Math.max(observed.maxTrucks, world.trucks.size);
    let blocked = 0;
    for (const truck of world.trucks.values()) {
      if (truck.state === 'to_pre_gate' && truck.blockedTicks >= QUEUE_BLOCK_TICKS) blocked += 1;
      const seen = since.get(truck.id);
      if (seen === undefined || seen.state !== truck.state) since.set(truck.id, { state: truck.state, tick });
      else if (truck.state !== 'holding') observed.maxDwell = Math.max(observed.maxDwell, tick - seen.tick);
    }
    observed.maxQueueBlocked = Math.max(observed.maxQueueBlocked, blocked);
    for (const buffer of buffers) {
      observed.maxBufferOccupied = Math.max(observed.maxBufferOccupied, buffer.occupied);
      for (let row = 0; row < buffer.rowCount; row++) observed.maxRowOccupied = Math.max(observed.maxRowOccupied, buffer.rowTrucks(row).length);
    }
  }
}

/** Jednoduchý priebežný odtlačok udalostí (FNV-1a nad ticku a JSON udalosti), aby sa dalo porovnať celý priebeh bez uchovávania. */
function foldEvent(digest: string, tick: number, event: SimEvent): string {
  const text = `${digest}@${String(tick)}${JSON.stringify(event)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function newObserved(layout: GatesWorld): Observed {
  return { layout, spawnTicks: [], eventDigest: '', maxQueueBlocked: 0, maxDwell: 0, maxBufferOccupied: 0, maxRowOccupied: 0, maxTrucks: 0, staged: 0 };
}

function run(seed: number): Observed {
  const layout = gatesWorld(seed);
  const observed = newObserved(layout);
  drive(layout, observed, 0, RUN_TICKS, new Map());
  return observed;
}

/** Najviac vzniknutých kamiónov v ľubovoľnom okne dĺžky jednej hernej hodiny. */
function bestHour(ticks: readonly number[]): number {
  let best = 0;
  let end = 0;
  for (let start = 0; start < ticks.length; start++) {
    while (end < ticks.length && ticks[end] - ticks[start] < TICKS_PER_HOUR) end += 1;
    best = Math.max(best, end - start);
  }
  return best;
}

describe('špička na bráne: 8 vstupných pruhov, predbránové plochy, 100 kamiónov za hodinu', () => {
  let observed: Observed;

  beforeAll(() => {
    observed = run(SEED);
  }, 300_000);

  it('rozloženie: 8 vstupných a 4 výstupné pruhy, dve plochy po 8 radoch, dva portály vjazdu s podielmi z `Rng`; pruhy v bloku tvoria jednu strechu (left, mid, mid, right)', () => {
    const { world, inLanes, outLanes, buffers } = observed.layout;
    expect([inLanes.length, outLanes.length, buffers.length]).toEqual([IN_LANES, OUT_LANES, 2]);
    expect(buffers.map((buffer) => buffer.rowCount)).toEqual([8, 8]);
    expect(world.landside.inPortals).toHaveLength(2);
    expect(world.landside.inPortals.map((portal) => portal.share)).toEqual([0.5, 0.5]);
    for (const buffer of buffers) expect(world.landside.preGateLanes(buffer)).toHaveLength(LANES_PER_BLOCK);
    const groups = adjacentLaneGroups(world.modules.values());
    expect(inLanes.map((lane) => groups.get(lane.id)?.position)).toEqual(['left', 'mid', 'mid', 'right', 'left', 'mid', 'mid', 'right']);
    expect(outLanes.map((lane) => groups.get(lane.id)?.position)).toEqual(['left', 'mid', 'mid', 'right']);
    expect(new Set(inLanes.map((lane) => groups.get(lane.id)?.group)).size).toBe(2);
  });

  it('špička: vzniklo 100 kamiónov (po jednom na jednotku) a v ľubovoľnej hodine aspoň 60 (limit tokenov)', () => {
    expect(observed.staged).toBe(PEAK_TRUCKS_PER_HOUR);
    expect(observed.spawnTicks).toHaveLength(PEAK_TRUCKS_PER_HOUR);
    expect(bestHour(observed.spawnTicks)).toBeGreaterThanOrEqual(MIN_BEST_HOUR);
  });

  it('na verejnej ceste nevznikol front: žiadny kamión v to_pre_gate nestál ≥ 10 tickov; plochy a rady držali kapacitu', () => {
    expect(observed.maxQueueBlocked).toBe(0);
    const [buffer] = observed.layout.buffers;
    expect(observed.maxBufferOccupied).toBeLessThanOrEqual(buffer.capacity);
    expect(observed.maxRowOccupied).toBeLessThanOrEqual(buffer.rowCapacity);
    expect(observed.maxBufferOccupied).toBeGreaterThan(0);
  });

  it('všetky vstupné aj výstupné pruhy pracovali, oba bloky (portály) dostali kamióny a každý kamión prešiel vstupným aj výstupným pruhom', () => {
    const { inLanes, outLanes } = observed.layout;
    for (const lane of [...inLanes, ...outLanes]) expect(lane.trucksProcessed, lane.label).toBeGreaterThan(0);
    const total = (lanes: readonly { readonly trucksProcessed: number }[]): number => lanes.reduce((sum, lane) => sum + lane.trucksProcessed, 0);
    expect(total(inLanes)).toBe(PEAK_TRUCKS_PER_HOUR);
    expect(total(outLanes)).toBe(PEAK_TRUCKS_PER_HOUR);
    for (const block of [inLanes.slice(0, LANES_PER_BLOCK), inLanes.slice(LANES_PER_BLOCK)]) expect(total(block)).toBeGreaterThan(PEAK_TRUCKS_PER_HOUR / 4);
  });

  it('nič sa nestratilo ani neuviazlo: lostUnits 0, všetkých 100 jednotiek exportovaných, žiadny kamión na mape, žiadny nestál v jednom stave ≥ 1 500 tickov', () => {
    const { world } = observed.layout;
    expect(lostUnits(world)).toBe(0);
    expect(world.cargo.exportedCount).toBe(PEAK_TRUCKS_PER_HOUR);
    expect(world.cargo.liveCount).toBe(0);
    expect(world.trucks.size).toBe(0);
    expect(observed.maxDwell).toBeLessThan(STUCK_TICKS);
    expect(observed.maxTrucks).toBeGreaterThan(20);
    expect(findWorldViolation(world)).toBeUndefined();
  });

  it('deterministický: rovnaký seed dá rovnaký stav aj odtlačok udalostí; iný seed (iné losovanie portálov a problémov) iný stav', () => {
    const again = run(SEED);
    expect(stateHash(again.layout.world)).toBe(stateHash(observed.layout.world));
    expect(again.eventDigest).toBe(observed.eventDigest);
    expect(again.spawnTicks).toEqual(observed.spawnTicks);
    const other = run(SEED + 1);
    expect(stateHash(other.layout.world)).not.toBe(stateHash(observed.layout.world));
    expect(other.eventDigest).not.toBe(observed.eventDigest);
    expect(lostUnits(other.layout.world)).toBe(0);
    expect(other.layout.world.cargo.exportedCount).toBe(PEAK_TRUCKS_PER_HOUR);
  }, 300_000);

  it('save/load uprostred špičky: obnovený svet (rady plôch, kroky pruhov, kamióny) dobehne na rovnaký stav a rovnaký odtlačok udalostí ako nepretržitý beh', () => {
    const layout = gatesWorld(SEED);
    const first = newObserved(layout);
    const since = new Map<number, { state: string; tick: number }>();
    drive(layout, first, 0, SPLIT_TICK, since);
    const state = JSON.parse(JSON.stringify(layout.world.serialize())) as WorldState;
    const inFlight = [...layout.world.trucks.values()].filter((truck) => truck.state === 'pre_gate' || truck.state === 'gate_pass').length;
    expect(inFlight).toBeGreaterThan(0);

    const restored = World.deserialize(GATES_DEFS, GATES_MAP, state);
    expect(restored.serialize()).toEqual(layout.world.serialize());
    const at = (x: number, y: number) => restored.moduleAt(x, y);
    const resumed = {
      world: restored,
      buffers: layout.buffers.map((buffer) => at(buffer.origin.x, buffer.origin.y) as typeof buffer),
      yards: layout.yards.map((yard) => at(yard.origin.x, yard.origin.y) as typeof yard),
    } as unknown as GatesWorld;
    const second = newObserved(resumed);
    (second as { eventDigest: string }).eventDigest = first.eventDigest;
    second.staged = first.staged;
    drive(resumed, second, SPLIT_TICK, RUN_TICKS, new Map(since));
    expect(stateHash(restored)).toBe(stateHash(observed.layout.world));
    expect(second.eventDigest).toBe(observed.eventDigest);
    expect(lostUnits(restored)).toBe(0);
  }, 300_000);
});
