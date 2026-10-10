/**
 * Scenár typov ciest (T03-18, ADR-020; docs/tasks/phase-03.md „Doplnok od používateľa" rozhodnutie 12): rozloženie
 * `apron_to_yard` (helpers/f3-layout.ts), v ktorom sa na ticku 0 prestavia cesty pri berthe na jednosmerný okruh
 * a chrbtica na jednopruhovú cestu. Tok nákladu ide len cez verejné API a JSON príkazy; po každom ticku
 * `assertCargoConservation` + audit ledgera a jobov (`recordRunF3`) a krok 12 (trasy vozidiel po smerových hranách).
 *
 * ```
 *   x:    41 42 43 44 45 46          ← ↓ ↑ = smer jednosmerky, ~ = jednopruhová, = dvojpruhová
 *   y=17   ↓  ←  ←  ←  ←  ←          západná noha (41, 17..21) ↓, roh (41, 22) →
 *   y=18   ↓              ↑          východná noha (46, 18..22) ↑, roh (46, 17) ←
 *   y=22   →  =  o  =  =  ↑          priečka y = 22 ostáva dvojpruhová (obojsmerná)
 *   y=23            ~                chrbtica x = 44, y 23..30 jednopruhová; vetva y = 30 dvojpruhová
 * ```
 * Očakávanie: všetky jednotky skončia v dvoroch, žiadne vozidlo neprejde bunkou proti smeru jednosmerky, obidve
 * nohy okruhu sa použijú, peniaze za prestavbu = nový typ − 50 % dvojpruhovej ceny (road_capex / road_sale) a beh je
 * deterministický aj po roundtripe save uprostred jazdy.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { EntityId } from '@sim/core';
import type { SimEvent } from '@sim/events';
import { directionOfStep, dragDirections, isRoadStepAllowed, type CellCoord } from '@sim/grid';
import { World } from '@sim/world';
import { ALL_ROAD_CELLS, ROAD_SEGMENTS, f3Scenario, segment } from '../helpers/f3-layout';
import { cellOfPosition, recordRunF3, restoreCopy, storageModulesOf, type RunLog3 } from '../helpers/f3';
import { runScenario, stateHash, type Scenario, type ScenarioEntry } from '../helpers/scenario';
import { DEFS, MAP } from '../world/world-fixtures';

const UNITS = 60;
const RUN_TICKS = 20000;
const RUN_TIMEOUT_MS = 120_000;
const KINDS = DEFS.infrastructure.roadKinds;
const REFUND_RATE = DEFS.economy.removalRefundRate;

/**
 * Okruh pri berthe v smere jazdy pruhov kotviska (zľava doprava, ADR-040 TR3-02): západná noha hore (vjazd do pruhu obchádzky), východná noha dole (výjazd z kotviska),
 * priečka y=22 ostáva dvojpruhová. Horná spojka už neexistuje (berth 8 × 4 zaberá y=17).
 */
const WEST_LEG = segment(41, 18, 41, 22).reverse();
const EAST_LEG_DOWN = segment(46, 18, 46, 22);
/** Smery: západná noha všade `N`; východná noha `S`, roh (46, 22) → západ do priečky (rozhodnutie 12: v rohu smer ďalej). */
const WEST_DIRS = dragDirections(WEST_LEG) ?? [];
const EAST_DIRS = [...(dragDirections(EAST_LEG_DOWN) ?? []).slice(0, -1), 'W'];
const SPINE = ROAD_SEGMENTS.spine;

const REBUILDS: readonly ScenarioEntry[] = [
  { atTick: 0, command: { type: 'PlaceRoad', cells: WEST_LEG, kind: 'one_way', dirs: WEST_DIRS } },
  { atTick: 0, command: { type: 'PlaceRoad', cells: EAST_LEG_DOWN, kind: 'one_way', dirs: EAST_DIRS } },
  { atTick: 0, command: { type: 'PlaceRoad', cells: SPINE, kind: 'one_lane' } },
];

const SCENARIO: Scenario = f3Scenario('road_kinds', 3018, {
  vehicles: ['straddle_carrier', 'straddle_carrier'],
  units: UNITS,
  extra: REBUILDS,
});

type TimedMoney = Extract<SimEvent, { type: 'MoneyChanged' }>;

/** Bunky, cez ktoré vozidlo prešlo (po sebe idúce vzorky s rôznou bunkou) — dvojice (odkiaľ, kam). */
function transitionsOf(log: RunLog3, vehicleId: EntityId): [CellCoord, CellCoord][] {
  const samples = log.vehicles.get(vehicleId) ?? [];
  const steps: [CellCoord, CellCoord][] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = cellOfPosition(samples[i - 1].x, samples[i - 1].y);
    const b = cellOfPosition(samples[i].x, samples[i].y);
    if (a.x !== b.x || a.y !== b.y) steps.push([a, b]);
  }
  return steps;
}

describe('scenár road_kinds — jednosmerný okruh a jednopruhová chrbtica', () => {
  let world: World;
  let log: RunLog3;
  let allStoredTick: number | null = null;

  beforeAll(() => {
    world = World.create(DEFS, MAP, SCENARIO.seed);
    log = recordRunF3(world, SCENARIO, RUN_TICKS, {
      onTick: (w) => {
        if (allStoredTick === null && w.cargo.countByKind('in_storage') === UNITS) allStoredTick = w.clock.tick;
      },
    });
  }, RUN_TIMEOUT_MS);

  it('všetky príkazy prešli (prestavby na ticku 0 nie sú odmietnuté) a typy ciest sedia', () => {
    expect(log.events.filter(({ event }) => event.type === 'CommandRejected')).toEqual([]);
    for (const [i, { x, y }] of WEST_LEG.entries()) expect([world.grid.at(x, y).roadKind, world.grid.at(x, y).roadDir]).toEqual(['one_way', WEST_DIRS[i]]);
    expect([world.grid.at(41, 22).roadDir, world.grid.at(46, 22).roadDir, world.grid.at(46, 20).roadDir]).toEqual(['N', 'W', 'S']);
    for (const { x, y } of SPINE) expect(world.grid.at(x, y).roadKind).toBe('one_lane');
    for (const { x, y } of ROAD_SEGMENTS.trunk) expect(world.grid.at(x, y).roadKind).toBe('two_lane');
  });

  it(`všetkých ${String(UNITS)} jednotiek je v dvoroch, apron prázdny, konzervácia po každom ticku`, () => {
    expect(allStoredTick).not.toBeNull();
    expect(world.cargo.countByKind('in_storage')).toBe(UNITS);
    expect(world.cargo.countByKind('on_apron') + world.cargo.countByKind('in_vehicle') + world.cargo.countByKind('on_ship')).toBe(0);
    expect(log.ticksChecked).toBe(RUN_TICKS);
    expect(storageModulesOf(world).reduce((sum, yard) => sum + yard.storedCount, 0)).toBe(UNITS);
  });

  it('žiadne vozidlo neprešlo bunkou proti smeru jednosmerky; obe nohy okruhu sa použili', () => {
    const used = new Set<string>();
    for (const vehicleId of log.vehicles.keys()) {
      for (const [a, b] of transitionsOf(log, vehicleId)) {
        const direction = directionOfStep(b.x - a.x, b.y - a.y);
        expect(direction, `skok ${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBeDefined();
        const allowed = isRoadStepAllowed(world.grid.at(a.x, a.y), world.grid.at(b.x, b.y), direction ?? 'N');
        expect(allowed, `vozidlo #${String(vehicleId)} ${JSON.stringify(a)} → ${JSON.stringify(b)} proti smeru`).toBe(true);
        used.add(`${String(b.x)},${String(b.y)}`);
      }
    }
    expect(used.has('41,20')).toBe(true); // západná noha (dole)
    expect(used.has('46,19')).toBe(true); // východná noha (hore)
    expect(used.has('44,26')).toBe(true); // jednopruhová chrbtica
  });

  it('peniaze: road_capex = ALL_ROAD_CELLS dvojpruhových + nové typy, road_sale = 50 % dvojpruhovej ceny prestavaných buniek', () => {
    const money = log.events.map(({ event }) => event).filter((event): event is TimedMoney => event.type === 'MoneyChanged');
    const sum = (reason: string): number => money.filter((event) => event.reason === reason).reduce((total, event) => total + event.deltaCents, 0);
    const oneWayCells = WEST_LEG.length + EAST_LEG_DOWN.length;
    const rebuilt = oneWayCells + SPINE.length;
    expect(sum('road_capex')).toBe(
      -(ALL_ROAD_CELLS.length * KINDS.two_lane.costPerCellCents + oneWayCells * KINDS.one_way.costPerCellCents + SPINE.length * KINDS.one_lane.costPerCellCents),
    );
    expect(sum('road_sale')).toBe(rebuilt * KINDS.two_lane.costPerCellCents * REFUND_RATE);
    expect(money.filter((event) => event.reason === 'road_sale')).toHaveLength(REBUILDS.length);
  });

  it('determinizmus: druhý beh aj roundtrip save uprostred jazdy dajú rovnaký stav', () => {
    const replay = World.create(DEFS, MAP, SCENARIO.seed);
    runScenario(replay, SCENARIO, 700);
    const copy = restoreCopy(replay);
    runScenario(replay, SCENARIO, 1500);
    runScenario(copy, SCENARIO, 1500);
    expect(stateHash(copy)).toBe(stateHash(replay));
    const straight = World.create(DEFS, MAP, SCENARIO.seed);
    runScenario(straight, SCENARIO, 1500);
    expect(stateHash(straight)).toBe(stateHash(replay));
  });
});
