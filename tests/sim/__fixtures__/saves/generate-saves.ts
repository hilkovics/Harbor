/**
 * Generátor uložených savov starších verzií `WorldState` (T06-02; ADR-014, ADR-030; ARCHITECTURE §14).
 *
 * Spustenie (z koreňa repozitára; prepíše `save-v*.json` v tomto adresári):
 *   pnpm exec tsx tests/sim/__fixtures__/saves/generate-saves.ts
 *
 * Savy sa generujú **raz** a komitujú sa — test `save-legacy-versions.test.ts` ich číta zo súborov, takže sú zmrazené:
 * keď sa zmení sim alebo balans (a generátor by dal iné ticky či hodnoty), fixtures sa nemenia a migrácie sa stále
 * overujú na tých istých vstupoch. Generátor netreba púšťať znova, kým nepribudne nová verzia `WorldState`
 * (vtedy sa pridá `save-v6.json` rovnakým postupom a starší save ostane nedotknutý).
 *
 * Postup: svet aktuálnej verzie (v6) sa v zvolenom ticku (prvý tick, v ktorom platí predikát — nie natvrdo) serializuje
 * a potom sa „zhodí“ na tvar staršej verzie presne podľa migrácií v `src/sim/world/migrate.ts`:
 *  - v5 = v6 bez `ships[i].route` (v5 trasy neukladal; ship keys pred T5B-02: `id … waypointIndex`),
 *  - v4 = v5 bez `economy`, `contracts`, `xp`, `completedContracts`, `nextContractId` (hotovosť ostáva v `cashCents`),
 *  - v3 = v4 bez `trucks` a s `runtime` rampy `{}` (bez `lastNoWaitingBayHour`),
 *  - v2 = v3 bez `vehicles`, `jobs`; `runtime` kotviska `{}` (bez `lastNoStorageHour`), sklad s `reservedSlots: []`,
 *  - v1 = len `version, mapId, seed, rng, clock, ids, cashCents, roads, parcels` (F1 nepoznal moduly, náklad, lode).
 * Svety sa vyberajú tak, aby ich obsah starší formát vedel zapísať (v2 bez vozidiel, v3 bez kamiónov, v4 bez kontraktov
 * a lodí `arriving`, ktoré pred ADR-029 neexistovali).
 *
 * Súbory: save-v1 (F1: cesty, hotovosť, rýchlosť 8×, prenájom; bez modulov), save-v2 (vykládka, žeriav spúšťa
 * kontajner), save-v3 (vozidlo vezie kontajner po ceste), save-v4 (kamión nakladá na rampe), save-v5 (kontrakt
 * `unloading`, vyložená polovica), save-v5-anchorage (jedna loď pri kotvisku, tri na anchorage).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  WORLD_STATE_V1_KEYS,
  WORLD_STATE_V2_KEYS,
  WORLD_STATE_V3_KEYS,
  WORLD_STATE_V4_KEYS,
  WORLD_STATE_V5_KEYS,
  World,
} from '@sim/world';
import { STRADDLES } from '../../helpers/f4';
import { f3Scenario } from '../../helpers/f3-layout';
import { f4Scenario } from '../../helpers/f4-layout';
import { cranesOf } from '../../helpers/harbor';
import { loadScenarioFile, runScenario, type Scenario } from '../../helpers/scenario';
import { BARE_MAP, DEFS, MAP, MAP_GRID, SEED, adjustCash, consumeRng, findCell, runTicks, setRoad } from '../../world/world-fixtures';

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Svet po `tick()` v prvom ticku, kde platí `match`; hľadá do `limit`. Vráti tick a JSON-kópiu stavu v6. */
function captureFirst(scenario: Scenario, match: (world: World) => boolean, limit: number): { readonly tick: number; readonly state: Json } {
  const world = World.create(DEFS, MAP, scenario.seed);
  const result: { value?: { tick: number; state: Json } } = {};
  runScenario(world, scenario, limit, {
    afterTick: (w) => {
      if (result.value === undefined && match(w)) result.value = { tick: w.clock.tick, state: clone(w.serialize()) as unknown as Json };
    },
  });
  if (result.value === undefined) throw new Error(`scenár '${scenario.id}': podmienka nenastala do ticku ${String(limit)}`);
  return result.value;
}

/** Kópia `state` len s kľúčmi `keys` (v tom poradí) a `version`. */
function pick(state: Json, keys: readonly string[], version: number): Json {
  const out: Json = {};
  for (const key of keys) out[key] = clone(state[key]);
  out['version'] = version;
  return out;
}

/**
 * Index bodu trasy lode pred ADR-029: trasu odvodzovala obnova zo stavu (`legacyShipRoute`), takže `waiting_anchorage`
 * mala jediný bod (anchorage) a loď v pokoji index 1, dokovaná loď prázdnu trasu a index 0. v6 ukladá index do uloženej
 * (dlhšej) trasy, preto sa pri „zhodení“ na v5 prepíše na hodnotu, akú v5 zapisoval.
 */
const LEGACY_WAYPOINT_INDEX: Readonly<Record<string, number>> = { waiting_anchorage: 1, docked: 0 };

/** v5 a staršie neukladali trasu lode; povolené sú len stavy, ktorých v5 index poznáme (`LEGACY_WAYPOINT_INDEX`). */
function withoutShipRoutes(state: Json): Json {
  const ships = state['ships'] as Json[];
  return {
    ...state,
    ships: ships.map((ship) => {
      const shipState = ship['state'] as string;
      const waypointIndex = LEGACY_WAYPOINT_INDEX[shipState];
      if (waypointIndex === undefined) throw new Error(`loď #${String(ship['id'])} v stave '${shipState}' nemá v5 zápis indexu bodu trasy`);
      const older: Json = { ...ship, waypointIndex };
      delete older['route'];
      return older;
    }),
  };
}

/** Úprava `runtime` modulov podľa druhu (`kind` z defov). */
function mapRuntimes(state: Json, upgrades: Partial<Record<string, (runtime: Json) => Json>>): Json {
  const modules = state['modules'] as { defId: string; runtime: Json }[];
  return {
    ...state,
    modules: modules.map((entry) => {
      const upgrade = upgrades[DEFS.modules.get(entry.defId).kind];
      return upgrade === undefined ? entry : { ...entry, runtime: upgrade(entry.runtime) };
    }),
  };
}

const toV5 = (v6: Json): Json => withoutShipRoutes(pick(v6, WORLD_STATE_V5_KEYS, 5));
const toV4 = (v6: Json): Json => withoutShipRoutes(pick(v6, WORLD_STATE_V4_KEYS, 4));
const toV3 = (v6: Json): Json =>
  mapRuntimes(withoutShipRoutes(pick(v6, WORLD_STATE_V3_KEYS, 3)), {
    ramp: () => ({}),
  });
const toV2 = (v6: Json): Json =>
  mapRuntimes(withoutShipRoutes(pick(v6, WORLD_STATE_V2_KEYS, 2)), {
    berth: () => ({}),
    storage: (runtime) => ({ reservedSlots: [], ...runtime }),
  });
const toV1 = (v6: Json): Json => pick(v6, WORLD_STATE_V1_KEYS, 1);

/** F1 svet: cesty, hotovosť, `Rng`, rýchlosť 8×, prenajatá parcela — bez Root modulu (F1 moduly nepoznal). */
function f1State(): Json {
  const publicLand = findCell(MAP_GRID, (cell) => cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none');
  const world = World.create(DEFS, BARE_MAP, SEED);
  runTicks(world, 500);
  world.enqueue(setRoad([publicLand], 'road'));
  world.enqueue(setRoad([MAP.starter.roads[0]], 'none'));
  world.enqueue(adjustCash(-250_000));
  world.enqueue(consumeRng());
  world.applyPending();
  world.clock.setSpeed(8);
  const west = world.parcels.get('west_quay');
  if (west === undefined) throw new Error('mapa nemá west_quay');
  west.ownership = 'leased';
  return clone(world.serialize()) as unknown as Json;
}

interface Fixture {
  readonly file: string;
  readonly state: Json;
  readonly note: string;
}

function buildFixtures(): Fixture[] {
  const v2 = captureFirst(
    f3Scenario('save_v2', 7002, { yards: ['near'], units: 6 }),
    (w) => [...w.ships.values()].some((ship) => ship.state === 'docked') && cranesOf(w).some((crane) => crane.state === 'placing' && crane.heldUnitId !== null),
    3_000,
  );
  const v3 = captureFirst(
    f3Scenario('save_v3', 7003, { vehicles: ['straddle_carrier', 'straddle_carrier'], units: 8 }),
    (w) => w.cargo.countByKind('in_vehicle') > 0 && [...w.vehicles.values()].some((vehicle) => vehicle.state === 'to_dropoff' && vehicle.progress > 0),
    3_000,
  );
  const v4 = captureFirst(
    f4Scenario('save_v4', 7004, { vehicles: STRADDLES, units: 8 }),
    (w) => w.trucks.size >= 2 && [...w.trucks.values()].some((truck) => truck.state === 'loading'),
    6_000,
  );
  const v5 = captureFirst(
    loadScenarioFile('vertical_slice'),
    (w) => [...w.contracts.values()].some((contract) => contract.state === 'unloading' && contract.unitsUnloaded === Math.floor(contract.volumeUnits / 2)),
    12_000,
  );
  const v5Anchorage = captureFirst(
    f4Scenario('save_v5_anchorage', 7005, {
      vehicles: STRADDLES,
      units: 40,
      extra: [0, 0, 0].map((atTick) => ({ atTick, command: { type: 'SpawnShipDebug', shipClassId: 'feeder', cargoTypeId: 'container_teu', units: 6 } })),
    }),
    (w) => {
      // Loď na anchorage v pokoji (trasa dojazdená): v5 zapisoval index 1 len pre takú, plávajúcu nevie zapísať (`LEGACY_WAYPOINT_INDEX`).
      const ships = [...w.ships.values()];
      const resting = (ship: (typeof ships)[number]): boolean => ship.state === 'waiting_anchorage' && ship.waypointIndex >= ship.route.length;
      return ships.length === 4 && ships.filter((ship) => ship.state === 'docked').length === 1 && ships.filter(resting).length === 3;
    },
    3_000,
  );

  return [
    { file: 'save-v1.json', state: toV1(f1State()), note: 'F1: cesty, hotovosť, rýchlosť 8×, prenájom west_quay, tick 500' },
    { file: 'save-v2.json', state: toV2(v2.state), note: `F2: vykládka, žeriav spúšťa kontajner (placing), tick ${String(v2.tick)}` },
    { file: 'save-v3.json', state: toV3(v3.state), note: `F3: vozidlo vezie kontajner po ceste, tick ${String(v3.tick)}` },
    { file: 'save-v4.json', state: toV4(v4.state), note: `F4: kamión nakladá na rampe, tick ${String(v4.tick)}` },
    { file: 'save-v5.json', state: toV5(v5.state), note: `F5: kontrakt unloading, vyložená polovica, tick ${String(v5.tick)}` },
    { file: 'save-v5-anchorage.json', state: toV5(v5Anchorage.state), note: `F5: loď pri kotvisku a tri na anchorage, tick ${String(v5Anchorage.tick)}` },
  ];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = fileURLToPath(new URL('./', import.meta.url));
  for (const { file, state, note } of buildFixtures()) {
    const text = JSON.stringify(state);
    writeFileSync(`${dir}${file}`, text);
    process.stdout.write(`${file}  ${String(text.length)} B  ${note}\n`);
  }
}
