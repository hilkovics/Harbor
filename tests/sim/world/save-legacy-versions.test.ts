/**
 * Savy starších verzií a poškodené savy (T06-02; ADR-014, ADR-029, ADR-030; ARCHITECTURE §14, §16).
 *
 * 1. Zmrazené savy `WorldState` v1 … v6 z `tests/sim/__fixtures__/saves/` (malé JSON súbory, generuje ich jednorazovo
 *    `generate-saves.ts`; test číta súbory, nie generátor): `World.deserialize` ich prevedie migráciami na v7, hodnoty
 *    starej verzie ostanú (hodiny, `Rng`, hotovosť, cesty, náklad, lode, kontrakty… — porovnané po zhodení v7 → v6,
 *    `toV6State`), `serialize()` vráti v7, ktorý sa načíta
 *    znova na rovnaký hash, a svet beží 2 000 tickov bez porušenia invariantov (`assertCargoConservation` po každom ticku,
 *    `assertInvariants()` navyše každých 100 tickov; krok 12 ticku beží `assertInvariants()` aj sám) a cez prvú uzávierku
 *    dňa (pool kontraktov sa po migrácii doplní).
 * 2. Poškodený save (chýbajúce pole, zlý typ, neznámy defId, prekrývajúce sa lode, neznáma verzia…) → `WorldStateError`
 *    s JSON pointerom na chybné miesto; nevznikne polovičatý svet, zdieľaná mapa a defy ostanú nedotknuté a vstup sa nemení.
 *
 * Doplnok k `migrate.test.ts` (T02-03…T05-02: migrácie nad živo vyrobenými downgrade-mi v rámci jedného testu), tu sú
 * vstupy pevné súbory, takže sa nemenia, keď sa zmení sim.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import {
  WORLD_STATE_VERSION,
  WORLD_STATE_V1_KEYS,
  WORLD_STATE_V2_KEYS,
  WORLD_STATE_V3_KEYS,
  WORLD_STATE_V4_KEYS,
  WORLD_STATE_V5_KEYS,
  WORLD_STATE_V6_KEYS,
  World,
  WorldStateError,
  stateHash,
  type AnyWorldState,
  type WorldState,
} from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { toV6State } from '../helpers/legacy-save';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS, MAP } from './world-fixtures';

const FIXTURE_DIR = fileURLToPath(new URL('../__fixtures__/saves/', import.meta.url));
/** Počet tickov, ktoré musí svet po načítaní starého savu prežiť (zadanie T06-02). */
const RUN_TICKS = 2_000;
/** Interval explicitnej kontroly `assertInvariants()` (krok 12 ticku beží každý tick sám). */
const INVARIANT_EVERY = 100;
/** Zastavenie hľadania uzávierky dňa — jeden herný deň má 8 640 tickov. */
const DAY_SEARCH_LIMIT_TICKS = 9_000;
const HEAVY_TIMEOUT_MS = 120_000;

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const asState = (raw: unknown): AnyWorldState => raw as AnyWorldState;

function readFixture(file: string): Json {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as Json;
}

/** Tick po ticku s kontrolou konzervácie nákladu; každých `INVARIANT_EVERY` tickov aj `assertInvariants()`. */
function runChecked(world: World, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 1; i <= ticks; i++) {
    events.push(...world.tick());
    assertCargoConservation(world);
    if (i % INVARIANT_EVERY === 0) world.assertInvariants();
  }
  return events;
}

function offersOf(world: World): number {
  return [...world.contracts.values()].filter((contract) => contract.state === 'offered').length;
}

/** Chyba pri načítaní: musí to byť `WorldStateError`; inak test zlyhá (nie holý `TypeError` či `RangeError`). */
function loadError(raw: unknown): WorldStateError {
  try {
    World.deserialize(DEFS, MAP, asState(raw));
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw new Error(`očakávaná WorldStateError, dostal ${String(error)}`, { cause: error });
  }
  throw new Error('načítanie poškodeného savu nevyhodilo chybu');
}

// ---------------------------------------------------------------------------------------------------------
// 1. Savy v1 … v6
// ---------------------------------------------------------------------------------------------------------

interface LegacyFixture {
  readonly file: string;
  readonly version: 1 | 2 | 3 | 4 | 5 | 6;
  /** Presné kľúče savu v poradí (`WORLD_STATE_Vn_KEYS`). */
  readonly keys: readonly string[];
  /** Čo save obsahuje (kontrola, že fixture nie je prázdna). */
  readonly has: (state: Json) => boolean;
}

const arrayLength = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
const unitsAt = (state: Json, kind: string): number =>
  ((state['cargo'] as { units: { location: { kind: string } }[] }).units).filter((unit) => unit.location.kind === kind).length;

const FIXTURES: readonly LegacyFixture[] = [
  { file: 'save-v1.json', version: 1, keys: WORLD_STATE_V1_KEYS, has: (s) => arrayLength(s['roads']) > 0 && (s['clock'] as { speed: number }).speed === 8 },
  {
    file: 'save-v2.json',
    version: 2,
    keys: WORLD_STATE_V2_KEYS,
    has: (s) => arrayLength(s['modules']) >= 3 && arrayLength(s['ships']) === 1 && unitsAt(s, 'in_crane') === 1,
  },
  {
    file: 'save-v3.json',
    version: 3,
    keys: WORLD_STATE_V3_KEYS,
    has: (s) => arrayLength(s['vehicles']) === 2 && arrayLength(s['jobs']) > 0 && unitsAt(s, 'in_vehicle') > 0,
  },
  {
    file: 'save-v4.json',
    version: 4,
    keys: WORLD_STATE_V4_KEYS,
    has: (s) => arrayLength(s['trucks']) >= 2 && (s['trucks'] as { state: string }[]).some((truck) => truck.state === 'loading'),
  },
  {
    file: 'save-v5.json',
    version: 5,
    keys: WORLD_STATE_V5_KEYS,
    has: (s) => (s['contracts'] as { state: string }[]).some((contract) => contract.state === 'unloading') && arrayLength(s['ships']) === 1,
  },
  {
    file: 'save-v5-anchorage.json',
    version: 5,
    keys: WORLD_STATE_V5_KEYS,
    has: (s) =>
      (s['ships'] as { state: string }[]).filter((ship) => ship.state === 'docked').length === 1 &&
      (s['ships'] as { state: string }[]).filter((ship) => ship.state === 'waiting_anchorage').length === 3,
  },
  {
    file: 'save-v6.json',
    version: 6,
    keys: WORLD_STATE_V6_KEYS,
    has: (s) =>
      (s['contracts'] as { state: string }[]).some((contract) => contract.state === 'unloading') &&
      (s['ships'] as { route: unknown[] }[]).length === 1 &&
      arrayLength(s['vehicles']) === 2 &&
      arrayLength(s['jobs']) > 0,
  },
];

/**
 * Kľúče, ktoré migrácia nemení — po zhodení v7 → v6 (`toV6State`, ADR-032): `modules` upraví runtime, `ships` pridá
 * trasu (save spred v6), `version` sa zvýši.
 */
const UNTOUCHED_BY_MIGRATION = (keys: readonly string[]): string[] => keys.filter((key) => key !== 'version' && key !== 'modules' && key !== 'ships');

describe.each(FIXTURES)('uložený save $file (WorldState v$version) → v7', ({ file, version, keys, has }) => {
  const raw = readFixture(file);
  const original = clone(raw);

  it('je zmrazený save svojej verzie: presné kľúče v poradí, version, lode bez trasy, obsah zodpovedá situácii', () => {
    expect(Object.keys(raw)).toEqual([...keys]);
    expect(raw['version']).toBe(version);
    expect(version).toBeLessThan(WORLD_STATE_VERSION);
    expect((raw['ships'] as Json[] | undefined)?.every((ship) => 'route' in ship === version >= 6) ?? true).toBe(true);
    expect(raw['mapId']).toBe(MAP.id);
    expect(has(raw)).toBe(true);
  });

  it('World.deserialize prejde bez zmeny vstupu; serialize() vráti v7 a zachová hodnoty starej verzie', () => {
    const world = World.deserialize(DEFS, MAP, asState(raw));
    expect(raw).toEqual(original);

    expect(world.serialize().version).toBe(WORLD_STATE_VERSION);
    // Polia v7 (ADR-032) majú pri starom save hodnoty importu, takže zhodenie na v6 sa porovná s pôvodnými hodnotami.
    const saved = toV6State(world.serialize());
    for (const key of UNTOUCHED_BY_MIGRATION(keys)) expect(saved[key], `kľúč '${key}'`).toEqual(raw[key]);

    // Moduly: rovnaké id, def, poloha a rotácia; runtime doplnia migrácie (napr. kotvisko dostane lastNoStorageHour).
    const strip = (modules: unknown): unknown[] =>
      (modules as Json[]).map(({ id, defId, x, y, rotation, purchaseCostCents }) => ({ id, defId, x, y, rotation, purchaseCostCents }));
    expect(strip(saved['modules'])).toEqual(strip(raw['modules'] ?? []));

    // Lode: rovnaký stav, poloha a kotviská; pribudla odvodená trasa (v5 ju neukladal).
    const noRoute = (ships: unknown): unknown[] =>
      (ships as Json[]).map((ship) => {
        const older = { ...ship };
        delete older['route'];
        return older;
      });
    expect(noRoute(saved['ships'])).toEqual(noRoute(raw['ships'] ?? []));
    expect((saved['ships'] as { route: unknown }[]).every((ship) => Array.isArray(ship.route))).toBe(true);
    if (version >= 6) expect(saved['ships']).toEqual(raw['ships']);

    expect(world.clock.tick).toBe((raw['clock'] as { tick: number }).tick);
    expect(world.cashCents).toBe(raw['cashCents']);
    expect(world.cargo.liveCount).toBe(arrayLength((raw['cargo'] as { units?: unknown[] } | undefined)?.units));
    expect(() => world.assertInvariants()).not.toThrow();
  });

  it('v7 vzniknuté z migrácie sa po JSON texte načíta znova na rovnaký hash (migrácia je pevný bod)', () => {
    const world = World.deserialize(DEFS, MAP, asState(raw));
    const text = JSON.stringify(world.serialize());
    const again = World.deserialize(DEFS, MAP, JSON.parse(text) as WorldState);
    expect(stateHash(again)).toBe(stateHash(world));
    expect(JSON.stringify(again.serialize())).toBe(text);
  });

  it(`po načítaní beží ${String(RUN_TICKS)} tickov bez porušenia invariantov a bez straty nákladu`, () => {
    const world = World.deserialize(DEFS, MAP, asState(raw));
    const startTick = world.clock.tick;
    const created = world.cargo.createdCount;
    runChecked(world, RUN_TICKS);
    expect(world.clock.tick).toBe(startTick + RUN_TICKS);
    // Žiadna jednotka nezmizla mimo exportu: vytvorené − exportované = živé (assertCargoConservation to stráži aj po každom ticku).
    expect(world.cargo.createdCount - world.cargo.exportedCount).toBe(world.cargo.liveCount);
    expect(world.cargo.createdCount).toBeGreaterThanOrEqual(created);
    expect(Number.isSafeInteger(world.cashCents)).toBe(true);
    // Beh z migrovaného savu zostáva deterministický: rovnaký vstup → rovnaký hash.
    const second = World.deserialize(DEFS, MAP, asState(clone(raw)));
    runChecked(second, RUN_TICKS);
    expect(stateHash(second)).toBe(stateHash(world));
  });

  it(
    'svet z migrovaného savu prejde uzávierkou dňa: pool kontraktov je doplnený na offersPerDay, invarianty držia',
    () => {
      const world = World.deserialize(DEFS, MAP, asState(raw));
      const offersBefore = offersOf(world);
      let closed = false;
      for (let i = 0; i < DAY_SEARCH_LIMIT_TICKS && !closed; i++) {
        closed = world.tick().some((event) => event.type === 'DayClosed');
        assertCargoConservation(world);
      }
      expect(closed, 'DayClosed nenastal do jedného herného dňa').toBe(true);
      expect(offersOf(world), `pool pred uzávierkou: ${String(offersBefore)} ponúk`).toBe(DEFS.economy.offersPerDay);
      world.assertInvariants();
    },
    HEAVY_TIMEOUT_MS,
  );

  it('poškodený save tejto verzie: chýba posledný kľúč verzie → WorldStateError na jeho ceste; zlý typ hotovosti → /cashCents', () => {
    const lastKey = keys.at(-1) as string;
    const missing = clone(raw);
    delete missing[lastKey];
    expect(loadError(missing).path).toBe(`/${lastKey}`);

    expect(loadError({ ...clone(raw), cashCents: '1000' }).path).toBe('/cashCents');
    expect(loadError({ ...clone(raw), bonus: 1 }).path).toBe('/bonus');
  });
});

describe('uložené savy v2 … v6 s neznámym defom modulu → WorldStateError s cestou', () => {
  it.each(FIXTURES.filter((fixture) => fixture.version >= 2))('$file: modules[0].defId neexistuje → /modules/0/defId', ({ file }) => {
    const broken = readFixture(file);
    (broken['modules'] as Json[])[0]['defId'] = 'neexistujuci_modul';
    const error = loadError(broken);
    expect(error.path).toBe('/modules/0/defId');
    expect(error.message).toContain('neexistujuci_modul');
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. Poškodené savy aktuálnej verzie
// ---------------------------------------------------------------------------------------------------------

/** Aktuálny save s loďami (`berthing`, `outbound` a tri čakajúce na anchorage) a s vozidlami, JSON-kópia. */
function shipsState(): Json {
  const scenario = loadScenarioFile('multi_ship_queue');
  const world = World.create(DEFS, MAP, scenario.seed);
  let found: Json | undefined;
  runScenario(world, scenario, 6_000, {
    afterTick: (w) => {
      if (found !== undefined) return;
      const states = [...w.ships.values()].map((ship) => ship.state);
      if (states.includes('berthing') && states.includes('outbound') && states.filter((state) => state === 'waiting_anchorage').length >= 3) {
        found = clone(w.serialize()) as unknown as Json;
      }
    },
  });
  if (found === undefined) throw new Error('multi_ship_queue: lode berthing + outbound + 3× waiting_anchorage nenastali');
  return found;
}

/** Aktuálny save s kamiónmi, vozidlami a kontraktom `exporting`, JSON-kópia. */
function landsideState(): Json {
  const scenario = loadScenarioFile('vertical_slice');
  const world = World.create(DEFS, MAP, scenario.seed);
  let found: Json | undefined;
  runScenario(world, scenario, 14_000, {
    afterTick: (w) => {
      if (found === undefined && w.trucks.size >= 2 && [...w.contracts.values()].some((contract) => contract.state === 'exporting')) {
        found = clone(w.serialize()) as unknown as Json;
      }
    },
  });
  if (found === undefined) throw new Error('vertical_slice: kamióny pri kontrakte exporting nenastali');
  return found;
}

interface Corruption {
  readonly name: string;
  /** Poškodí kópiu savu a vráti hodnotu, ktorá sa pokúsi načítať (zvyčajne ten istý objekt). */
  readonly corrupt: (state: Json) => unknown;
  /** Očakávaná cesta chyby; funkcia dostane **nepoškodený** základ (indexy lodí, ktoré poškodenie mení). */
  readonly path: string | ((pristine: Json) => string);
  /** Časť správy chyby (pomenuje problém). */
  readonly problem: string;
}

/** Poškodenie, ktoré upraví objekt na mieste (`edit`) a načíta sa ten istý objekt. */
const edit =
  (change: (state: Json) => void) =>
  (state: Json): unknown => {
    change(state);
    return state;
  };

const shipIndex = (state: Json, predicate: (ship: Json) => boolean, nth = 0): number => {
  const indexes = (state['ships'] as Json[]).flatMap((ship, i) => (predicate(ship) ? [i] : []));
  const index = indexes[nth];
  if (index === undefined) throw new Error(`loď č. ${String(nth)} podľa predikátu sa v save nenašla`);
  return index;
};

const SHIP_CORRUPTIONS: readonly Corruption[] = [
  {
    name: 'chýbajúce pole na vrchu: cashCents',
    corrupt: edit((s) => void delete s['cashCents']),
    path: '/cashCents',
    problem: 'chýba povinný kľúč',
  },
  {
    name: 'chýbajúce pole vnorene: ships[0].state',
    corrupt: edit((s) => void delete (s['ships'] as Json[])[0]['state']),
    path: '/ships/0/state',
    problem: 'chýba povinný kľúč',
  },
  {
    name: 'chýbajúce pole vnorene: ships[0].route (v6 trasu vyžaduje)',
    corrupt: edit((s) => void delete (s['ships'] as Json[])[0]['route']),
    path: '/ships/0/route',
    problem: 'chýba povinný kľúč',
  },
  {
    name: 'chýbajúce pole vnorene: modules[0].runtime',
    corrupt: edit((s) => void delete (s['modules'] as Json[])[0]['runtime']),
    path: '/modules/0/runtime',
    problem: 'chýba povinný kľúč',
  },
  {
    name: 'zlý typ: cashCents ako reťazec',
    corrupt: edit((s) => void (s['cashCents'] = '120000000')),
    path: '/cashCents',
    problem: 'bezpečné celé číslo',
  },
  {
    name: 'zlý typ: ships[1].x ako reťazec',
    corrupt: edit((s) => void ((s['ships'] as Json[])[1]['x'] = 'abc')),
    path: '/ships/1/x',
    problem: 'konečné číslo',
  },
  {
    name: 'zlý typ: roads[0] ako číslo',
    corrupt: edit((s) => void ((s['roads'] as unknown[])[0] = 5)),
    path: '/roads/0',
    problem: 'index bunky',
  },
  {
    name: 'záporný tick hodín',
    corrupt: edit((s) => void ((s['clock'] as Json)['tick'] = -1)),
    path: '/clock',
    problem: 'tick',
  },
  {
    name: 'neznámy defId modulu',
    corrupt: edit((s) => void ((s['modules'] as Json[])[0]['defId'] = 'neexistujuci_modul')),
    path: '/modules/0/defId',
    problem: 'neexistujuci_modul',
  },
  {
    name: 'neznáma trieda lode',
    corrupt: edit((s) => void ((s['ships'] as Json[])[0]['classId'] = 'neexistujuca_trieda')),
    path: '/ships/0/classId',
    problem: 'neexistujuca_trieda',
  },
  {
    name: 'neznámy defId vozidla',
    corrupt: edit((s) => void ((s['vehicles'] as Json[])[0]['defId'] = 'neexistujuce_vozidlo')),
    path: '/vehicles/0/defId',
    problem: 'neexistujuce_vozidlo',
  },
  {
    name: 'neznámy typ nákladu v ledgeri',
    corrupt: edit((s) => void (((s['cargo'] as Json)['units'] as Json[])[0]['typeId'] = 'neexistujuci_naklad')),
    path: '/cargo/units/0/typeId',
    problem: 'neexistujuci_naklad',
  },
  {
    name: 'prekrývajúce sa lode: dve lode držia tú istú anchorage',
    corrupt: edit((s) => {
      const ships = s['ships'] as Json[];
      const first = shipIndex(s, (ship) => ship['state'] === 'waiting_anchorage', 0);
      const second = shipIndex(s, (ship) => ship['state'] === 'waiting_anchorage', 1);
      Object.assign(ships[second], {
        x: ships[first]['x'],
        y: ships[first]['y'],
        heading: ships[first]['heading'],
        anchorageIndex: ships[first]['anchorageIndex'],
        waypointIndex: ships[first]['waypointIndex'],
        route: ships[first]['route'],
      });
    }),
    path: (pristine) => `/ships/${String(shipIndex(pristine, (ship) => ship['state'] === 'waiting_anchorage', 1))}/anchorageIndex`,
    problem: 'už obsadila loď',
  },
  {
    name: 'prekrývajúce sa lode: čakajúca loď preberie polohu a trasu odchádzajúcej',
    corrupt: edit((s) => {
      const ships = s['ships'] as Json[];
      const outbound = ships[shipIndex(s, (ship) => ship['state'] === 'outbound')];
      Object.assign(ships[shipIndex(s, (ship) => ship['state'] === 'waiting_anchorage')], {
        state: 'outbound',
        x: outbound['x'],
        y: outbound['y'],
        heading: outbound['heading'],
        anchorageIndex: null,
        waypointIndex: outbound['waypointIndex'],
        route: outbound['route'],
      });
    }),
    path: (pristine) => `/ships/${String(shipIndex(pristine, (ship) => ship['state'] === 'waiting_anchorage'))}/route`,
    problem: 'prekrýva',
  },
  {
    name: 'neznáma verzia 99',
    corrupt: edit((s) => void (s['version'] = 99)),
    path: '/version',
    problem: 'nepodporovaná verzia',
  },
  {
    name: 'save patrí inej mape',
    corrupt: edit((s) => void (s['mapId'] = 'ina_mapa')),
    path: '/mapId',
    problem: 'ina_mapa',
  },
  {
    name: 'neznámy kľúč navyše',
    corrupt: edit((s) => void (s['bonus'] = 1)),
    path: '/bonus',
    problem: 'neznámy kľúč',
  },
];

const LANDSIDE_CORRUPTIONS: readonly Corruption[] = [
  {
    name: 'zlý typ: trucks[0].progress ako reťazec',
    corrupt: edit((s) => void ((s['trucks'] as Json[])[0]['progress'] = 'rychlo')),
    path: '/trucks/0/progress',
    problem: 'číslo v [0, 1)',
  },
  {
    name: 'neznámy defId kamióna',
    corrupt: edit((s) => void ((s['trucks'] as Json[])[0]['defId'] = 'neexistujuci_kamion')),
    path: '/trucks/0/defId',
    problem: 'neexistujuci_kamion',
  },
  {
    name: 'chýbajúce pole kamióna: bay',
    corrupt: edit((s) => void delete (s['trucks'] as Json[])[0]['bay']),
    path: '/trucks/0/bay',
    problem: 'chýba povinný kľúč',
  },
  {
    name: 'neznámy stav kontraktu',
    corrupt: edit((s) => void ((s['contracts'] as Json[])[0]['state'] = 'neexistujuci_stav')),
    path: '/contracts/0/state',
    problem: 'neexistujuci_stav',
  },
  {
    name: 'neznáma šablóna kontraktu',
    corrupt: edit((s) => void ((s['contracts'] as Json[])[0]['templateId'] = 'neexistujuca_sablona')),
    path: '/contracts/0/templateId',
    problem: 'neexistujuca_sablona',
  },
  {
    name: 'zlý typ: economy.gameOver ako reťazec',
    corrupt: edit((s) => void ((s['economy'] as Json)['gameOver'] = 'nie')),
    path: '/economy/gameOver',
    problem: 'boolean',
  },
  {
    name: 'save nie je objekt (null)',
    corrupt: () => null,
    path: '',
    problem: 'musí byť objekt',
  },
];

type BaseName = 'ships' | 'landside';

describe('poškodený save aktuálnej verzie → WorldStateError s cestou', () => {
  const bases = {} as Record<BaseName, Json>;
  let startHash = '';

  beforeAll(() => {
    bases.ships = shipsState();
    bases.landside = landsideState();
    startHash = stateHash(World.create(DEFS, MAP, 4242));
  }, HEAVY_TIMEOUT_MS);

  const cases: readonly (readonly [name: string, base: BaseName, corruption: Corruption])[] = [
    ...SHIP_CORRUPTIONS.map((corruption) => [corruption.name, 'ships', corruption] as const),
    ...LANDSIDE_CORRUPTIONS.map((corruption) => [corruption.name, 'landside', corruption] as const),
  ];

  it('základné savy sú platné (bez poškodenia sa načítajú a pokračujú) a obsahujú entity, ktoré poškodenia menia', () => {
    for (const name of ['ships', 'landside'] as const) {
      const world = World.deserialize(DEFS, MAP, asState(clone(bases[name])));
      runChecked(world, 200);
    }
    expect((bases.ships['ships'] as Json[]).length).toBeGreaterThanOrEqual(5);
    expect((bases.ships['vehicles'] as Json[]).length).toBeGreaterThan(0);
    expect((bases.landside['trucks'] as Json[]).length).toBeGreaterThanOrEqual(2);
    expect((bases.landside['contracts'] as Json[]).some((contract) => contract['state'] === 'exporting')).toBe(true);
  });

  it.each(cases)('%s', (_name, baseName, corruption) => {
    const pristine = bases[baseName];
    const expectedPath = typeof corruption.path === 'function' ? corruption.path(pristine) : corruption.path;
    const input = corruption.corrupt(clone(pristine));
    const before = clone(input);
    const error = loadError(input);
    expect(error.path).toBe(expectedPath);
    expect(error.message).toContain(corruption.problem);
    expect(error.message.startsWith(`WorldState${expectedPath}:`)).toBe(true);
    expect(input, 'chybný vstup sa pri načítaní nemení').toEqual(before);
  });

  it('po sérii zlyhaných načítaní sú zdieľané defy a mapa nedotknuté a platný save sa načíta rovnako', () => {
    const loadedBefore = stateHash(World.deserialize(DEFS, MAP, asState(clone(bases.ships))));
    for (const [, baseName, corruption] of cases) loadError(corruption.corrupt(clone(bases[baseName])));
    expect(stateHash(World.create(DEFS, MAP, 4242))).toBe(startHash);
    expect(stateHash(World.deserialize(DEFS, MAP, asState(clone(bases.ships))))).toBe(loadedBefore);
  });
});
