// Návšteva vlaku (TR6-01, ADR-043): scenár `rail_visit` postaví na `harbor_01` železničný terminál (rmg_rail_block v starter parcele) a koľaj od koľajového portálu (95, 24) cez južný pás súše.
// Prázdny vlak príde podľa cestovného poriadku, dojde na koniec koľaje, po plánovanom pobyte odíde cez portál. RMG a nakládku prinesie TR6-02 — tu sa overuje len dráha vlaku, plán, obsadenie
// koľají (nikdy dva vlaky na bunke), konzervácia nákladu a determinizmus.
import { describe, expect, it } from 'vitest';
import { loadBundledDefs } from '@sim/defs';
import { loadMap, parseMapDef } from '@sim/grid';
import { stateHash, World } from '@sim/world';
import { findWorldViolation } from '@sim/world/world-invariants';
import { assertCargoConservation } from '../helpers/invariants';
import { eventsOfType, loadScenarioFile, readRepoJson, runScenario } from '../helpers/scenario';

const TICKS = 4000;

function run(seed?: number): { readonly world: World; readonly states: string[]; readonly events: ReturnType<typeof runScenario> } {
  const scenario = loadScenarioFile('rail_visit');
  const defs = loadBundledDefs({ startingCashCents: 400_000_000 });
  const world = World.create(defs, loadMap(parseMapDef(readRepoJson(scenario.map))), seed ?? scenario.seed, { checkInvariants: true });
  const states: string[] = [];
  const events = runScenario(world, scenario, TICKS, {
    afterTick: (w) => {
      assertCargoConservation(w);
      for (const train of w.trains.values()) {
        const key = `${String(train.id)}:${train.state}`;
        if (states.at(-1) !== key) states.push(key);
      }
    },
  });
  return { world, states, events };
}

describe('scenár rail_visit', () => {
  const result = run();

  it('terminál a koľaj sa postavia bez odmietnutia; terminál je napojený na portál', () => {
    expect(eventsOfType(result.events, 'CommandRejected')).toEqual([]);
    expect(result.world.hasRailService).toBe(true);
    expect(result.world.railRoutes.map(({ track }) => track)).toEqual([0, 1]);
  });

  it('vlaky prídu v hodine 2 a 8 (interval 6 h), každý dôjde na koniec koľaje, po pobyte odíde a zanikne', () => {
    const [first] = eventsOfType(result.events, 'TrainArrived');
    expect(first).toMatchObject({ delayTicks: 0, exportUnits: 0 });
    const departed = eventsOfType(result.events, 'TrainDeparted');
    expect(departed).toHaveLength(2);
    expect(departed.map((event) => event.units)).toEqual([0, 0]);
    expect(eventsOfType(result.events, 'TrainArrived').map((event) => event.trainId)).toHaveLength(2);
    expect(result.states.slice(0, 3)).toEqual([`${String(first.trainId)}:arriving`, `${String(first.trainId)}:dwelling`, `${String(first.trainId)}:departing`]);
    expect(result.world.rail.counters).toMatchObject({ trainsSpawned: 2, trainsDeparted: 2 });
  });

  it('obrat prvého vlaka = jazda tam + plánovaný pobyt (90 min) + jazda späť', () => {
    const [departed] = eventsOfType(result.events, 'TrainDeparted');
    const dwell = result.world.defs.rail.timetable.dwellMinutes * 6;
    expect(departed.turnaroundTicks).toBeGreaterThan(dwell);
    expect(departed.turnaroundTicks).toBeLessThan(dwell + 1000);
  });

  it('žiadne porušenie invariantov a lostUnits 0; beh je deterministický', () => {
    expect(findWorldViolation(result.world)).toBeUndefined();
    expect(result.world.cargo.createdCount - result.world.cargo.liveCount - result.world.cargo.exportedCount - result.world.cargo.shippedCount).toBe(0);
    expect(stateHash(run().world)).toBe(stateHash(result.world));
  });
});
