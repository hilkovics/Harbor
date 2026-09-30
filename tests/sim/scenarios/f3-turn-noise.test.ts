/**
 * Scenár šumu progresu (review T03-13 MAJOR, karta T03-14, ADR-021): syntetické vozidlo s rýchlosťou 0,2 bunky/tick
 * v rozložení `apron_to_yard` (helpers/f3-layout.ts). Pri 0,2 skončí zvyšok kroku po prechode stredom bunky v double
 * rádovo 1e-17 namiesto 0; pred opravou z neho vznikol progres ďalšieho úseku a obrat `turnAround` (`1 − p`) z neho
 * spravil presne 1 — `serialize()` zapísal `progress: 1`, ktorý `deserialize` odmietol (save nešiel načítať).
 *
 * Priebeh: vozidlo ide po chrbtici x = 44 na sever k berthu. Keď práve prešlo stredom bunky (44, 24) smerom k (44, 23),
 * `RemoveRoad` odstráni križovatku (44, 22) → k berthu nevedie cesta → `no_path` (vozidlo zastane). Potom „obnova":
 * obchádzka (43, 30) + x = 42, y 23…30 napojí juh chrbtice na priečku, takže nová cesta vedie **späť** cez (44, 24) —
 * pred opravou práve tu nastal obrat so šumom. V každom ticku okna beží krok 12 (`checkInvariants`), audit ledgera
 * a jobov a `deserialize(serialize())` musí prejsť s rovnakým hashom stavu; na konci sú všetky jednotky v dvore.
 *
 * ```
 *   x:    41 42 43 44 45 46
 *   y=22   #  #  o  X  #  #      X = odstránená križovatka (44, 22)
 *   y=23      +     #            + = obchádzka x = 42 (y 23…30) a (43, 30)
 *   y=24      +     V            V = vozidlo v strede (44, 24), smer sever
 *   y=30      +  +  #  #  o      chrbtica x = 44 → vetva y = 30 → depo (47, 30)
 * ```
 */
import { describe, expect, it } from 'vitest';
import vehiclesJson from '@data/defs/vehicles.json';
import { commandFromJSON, type SerializedCommand } from '@sim/commands';
import { DefRegistry } from '@sim/defs';
import type { SimEvent } from '@sim/events';
import type { Vehicle } from '@sim/vehicles';
import { World, type WorldState } from '@sim/world';
import { f3Scenario, segment } from '../helpers/f3-layout';
import { auditJobs, auditLedgerF3, runUntilF3, vehiclesById } from '../helpers/f3';
import { assertCargoConservation } from '../helpers/invariants';
import { runScenario, stateHash } from '../helpers/scenario';
import { MAP, RAW_DEFS } from '../world/world-fixtures';

const SLOW_ID = 'straddle_slow';
const SLOW_SPEED = 0.2;
const UNITS = 4;
/** Okno od `RemoveRoad` po návrat z `no_path` a kus jazdy (repathIntervalTicks = 30). */
const WINDOW_TICKS = 80;
const RUN_TIMEOUT_MS = 60_000;

/** Bundled defy + syntetické vozidlo `straddle_slow` (rýchlosť 0,2; inak ako straddle carrier). */
const SLOW_DEFS = DefRegistry.fromRaw({
  ...RAW_DEFS,
  vehicles: { ...vehiclesJson, items: [...vehiclesJson.items, { ...vehiclesJson.items[0], id: SLOW_ID, displayName: 'Straddle (pomalý)', speedCellsPerTick: SLOW_SPEED }] },
});

const SCENARIO = f3Scenario('turn_noise', 3014, { yards: ['near'], vehicles: [SLOW_ID], units: UNITS });
const JUNCTION = { x: 44, y: 22 };
const DETOUR = [{ x: 43, y: 30 }, ...segment(42, 23, 42, 30)];

function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Príkaz do fronty — aplikuje sa pred krokom 1 najbližšieho ticku (§6). */
function enqueue(world: World, command: SerializedCommand): void {
  world.enqueue(commandFromJSON(command));
}

/** Jeden tick s krokom 12, auditom a roundtripom save; vráti udalosti ticku. */
function checkedTick(world: World): readonly SimEvent[] {
  const events = runScenario(world, SCENARIO, world.clock.tick + 1);
  assertCargoConservation(world);
  auditLedgerF3(world);
  auditJobs(world);
  const copy = World.deserialize(SLOW_DEFS, MAP, viaJson(world.serialize()) as WorldState);
  expect(stateHash(copy), `tick ${String(world.clock.tick)}`).toBe(stateHash(world));
  return events;
}

describe('scenár turn_noise — RemoveRoad pri malom progrese → no_path → obnova (vozidlo 0,2)', () => {
  it(
    'krok 12 a deserialize(serialize()) v každom ticku okna; obrat späť cez bunku bez šumu; náklad dojde do dvora',
    () => {
      const world = World.create(SLOW_DEFS, MAP, SCENARIO.seed);
      expect(world.checkInvariants).toBe(true);
      const at = (x: number, y: number): number => world.grid.index(x, y);
      const vehicleOf = (w: World): Vehicle => vehiclesById(w)[0];

      // Vozidlo práve prešlo stredom (44, 24) na sever: pred opravou progres ~5,6e-17, po oprave presne 0.
      runUntilF3(
        world,
        SCENARIO,
        (w) => {
          const vehicle = vehiclesById(w)[0] as Vehicle | undefined;
          return vehicle?.state === 'to_pickup' && vehicle.cell === at(44, 24) && vehicle.nextCell === at(44, 23) && vehicle.progress < 1e-12;
        },
        2000,
      );
      const vehicle = vehicleOf(world);
      expect(vehicle.progress === 0 || vehicle.progress > Number.EPSILON).toBe(true);

      enqueue(world, { type: 'RemoveRoad', cells: [JUNCTION] });
      const events: SimEvent[] = [...checkedTick(world)];
      expect(world.grid.at(JUNCTION.x, JUNCTION.y).road).toBe('none');
      expect(vehicle.state).toBe('no_path');

      enqueue(world, { type: 'PlaceRoad', cells: DETOUR });
      for (let t = 1; t < WINDOW_TICKS; t++) events.push(...checkedTick(world));

      expect(events.filter((event) => event.type === 'CommandRejected')).toEqual([]);
      const transitions = events.flatMap((event) => (event.type === 'VehicleStateChanged' ? [`${event.from}→${event.to}`] : []));
      expect(transitions.slice(0, 2)).toEqual(['to_pickup→no_path', 'no_path→to_pickup']);
      // Nová cesta vedie späť cez (44, 25) a obchádzkou k berthu — vozidlo už prešlo obchádzku smerom na juh.
      expect(vehicle.state).toBe('to_pickup');
      expect(vehicle.y).toBeGreaterThan(24.5);

      // Tok nákladu po obnove: všetky jednotky dôjdu do dvora (konzervácia a audit po každom ticku).
      runUntilF3(world, SCENARIO, (w) => w.cargo.countByKind('in_storage') === UNITS, 6000);
      expect(world.cargo.countByKind('on_apron') + world.cargo.countByKind('in_vehicle') + world.cargo.countByKind('on_ship')).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );
});
