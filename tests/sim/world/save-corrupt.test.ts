/**
 * Poškodené savy aktuálnej verzie (T06-02; ADR-014, ADR-029, ADR-030, ADR-036; ARCHITECTURE §14, §16).
 *
 * Poškodený save (chýbajúce pole, zlý typ, neznámy defId, prekrývajúce sa lode, neznáma verzia…) → `WorldStateError`
 * s JSON pointerom na chybné miesto; nevznikne polovičatý svet, zdieľaná mapa a defy ostanú nedotknuté a vstup sa nemení.
 * Základné savy vznikajú behom bundled scenárov (clean break savov, ADR-036: fixtures starších verzií už nie sú).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SimEvent } from '@sim/events';
import { World, WorldStateError, stateHash, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS, MAP } from './world-fixtures';

/** Interval explicitnej kontroly `assertInvariants()` (krok 12 ticku beží každý tick sám). */
const INVARIANT_EVERY = 100;
const HEAVY_TIMEOUT_MS = 120_000;

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const asState = (raw: unknown): WorldState => raw as WorldState;

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

/** Počet import ponúk (skupín voyage bez exportu) — booking ponuky (F6a) dopĺňa pool zvlášť, `bookingOffersPerDay`. */

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


/** Aktuálny save s loďami (`outbound` a tri čakajúce na anchorage — od T6D-03 priamo na rejde) a s vozidlami, JSON-kópia. */
function shipsState(): Json {
  const scenario = loadScenarioFile('multi_ship_queue');
  const world = World.create(DEFS, MAP, scenario.seed);
  let found: Json | undefined;
  runScenario(world, scenario, 6_000, {
    afterTick: (w) => {
      if (found !== undefined) return;
      const states = [...w.ships.values()].map((ship) => ship.state);
      if (states.includes('outbound') && states.filter((state) => state === 'waiting_anchorage').length >= 3) {
        found = clone(w.serialize()) as unknown as Json;
      }
    },
  });
  if (found === undefined) throw new Error('multi_ship_queue: loď outbound + 3× waiting_anchorage nenastali');
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
    name: 'chýbajúce pole vnorene: ships[0].route (trasa je povinná)',
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
