import { describe, expect, it } from 'vitest';
import { World, WorldStateError, WORLD_STATE_VERSION, type WorldState } from '@sim/world';
import {
  DEFS,
  MAP,
  MAP_GRID,
  SEED,
  TestCommand,
  adjustCash,
  consumeRng,
  findCell,
  hashState,
  runTicks,
  setRoad,
} from './world-fixtures';

const create = (): World => World.create(DEFS, MAP, SEED);

const PUBLIC_LAND = findCell(MAP_GRID, (cell) => cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none');
const OTHER_PUBLIC_LAND = findCell(
  MAP_GRID,
  (cell, x, y) => cell.terrain === 'land' && cell.parcelId === null && cell.road === 'none' && (x !== PUBLIC_LAND.x || y !== PUBLIC_LAND.y),
);
const WATER_INDEX = (() => {
  const { x, y } = findCell(MAP_GRID, (cell) => cell.terrain === 'deep_water');
  return MAP_GRID.index(x, y);
})();
const STARTER_ROAD = MAP.starter.roads[0];

/** Hlboká kópia cez JSON — rovnaká cesta ako save/load. */
function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Svet s netriviálnym stavom: cesty/koľaj, odstránená starter cesta, prenájom, hotovosť, rng, ID, rýchlosť. */
function busyWorld(): World {
  const world = create();
  runTicks(world, 123);
  world.enqueue(setRoad([PUBLIC_LAND], 'road'));
  world.enqueue(setRoad([OTHER_PUBLIC_LAND], 'rail'));
  world.enqueue(setRoad([STARTER_ROAD], 'none'));
  world.enqueue(
    new TestCommand({
      apply: (w) => {
        const parcel = w.parcels.get('west_quay');
        if (parcel === undefined) throw new Error('mapa nemá west_quay');
        parcel.ownership = 'leased';
        w.clock.setSpeed(4);
      },
    }),
  );
  world.enqueue(adjustCash(-420_000));
  world.enqueue(consumeRng());
  world.enqueue(
    new TestCommand({
      apply: (w) => {
        // Heatmapa dopravy (§7.6) — vo F2 ju ešte nič nepíše, ale v2 ju ukladá (BACKLOG P1 z review T01-13).
        w.grid.at(PUBLIC_LAND.x, PUBLIC_LAND.y).traffic = 12.5;
        w.grid.at(STARTER_ROAD.x, STARTER_ROAD.y).traffic = 0.1 + 0.2;
      },
    }),
  );
  world.applyPending();
  return world;
}

describe('World.serialize — WorldState v13', () => {
  it('tvar: presne kľúče v13 (ADR-041: `hinterland.truckTurn`, nový tvar kamiónov a jobov) v pevnom poradí a hodnoty novej hry', () => {
    const world = create();
    const state = world.serialize();
    expect(Object.keys(state)).toEqual([
      'version',
      'mapId',
      'seed',
      'rng',
      'clock',
      'ids',
      'cashCents',
      'roads',
      'parcels',
      'traffic',
      'modules',
      'cargo',
      'ships',
      'vehicles',
      'jobs',
      'trucks',
      'machines',
      'trains',
      'rail',
      'economy',
      'contracts',
      'xp',
      'completedContracts',
      'nextContractId',
      'nextVoyageId',
      'emptyFlow',
      'hinterland',
    ]);
    expect(state.version).toBe(WORLD_STATE_VERSION);
    expect(state.emptyFlow).toEqual({ returnPlan: [], pickupPlan: [], errands: [] });
    // Nová hra pred prvým tickom: pool sa plní až v kroku 2 prvého ticku (ADR-026).
    expect([state.contracts, state.xp, state.completedContracts, state.nextContractId, state.nextVoyageId]).toEqual([[], 0, 0, 1, 1]);
    expect(state.cargo).toEqual({ createdCount: 0, exportedCount: 0, shippedCount: 0, units: [] });
    expect(state.hinterland).toEqual({
      delivery: { admitted: 0, waitTicksTotal: 0, waitTicksMax: 0, turnedAway: 0 },
      collect: { admitted: 0, waitTicksTotal: 0, waitTicksMax: 0, turnedAway: 0 },
      pickupBayStarvationTicks: 0,
      truckTurn: { trucks: 0, ticksTotal: 0, ticksMax: 0 },
    });
    expect(state.economy).toEqual({ entries: [], today: { incomeCents: {}, expenseCents: {} }, daily: [], monthly: [], daysNegative: 0, gameOver: false });
    expect(state.traffic).toEqual([]);
    // Starter moduly mapy (Root modul, T02-04): id 1, 2, … v poradí mapy, zaplatená cena 0, žeriav nečinný.
    expect(state.modules.map(({ id, defId, x, y, rotation, purchaseCostCents }) => ({ id, defId, x, y, rotation, purchaseCostCents }))).toEqual(
      MAP.starter.modules.map((spec, i) => ({ id: i + 1, ...spec, purchaseCostCents: 0 })),
    );
    expect(state.ships).toEqual([]);
    expect(state.vehicles).toEqual([]);
    expect(state.jobs).toEqual([]);
    expect(state.trucks).toEqual([]);
    expect(state.mapId).toBe(MAP.id);
    expect(state.seed).toBe(SEED);
    expect(state.rng).toEqual(world.rng.getState());
    expect(state.clock).toEqual({ tick: 0, speed: 1 });
    expect(state.ids).toEqual({ nextId: MAP.starter.modules.length + 1 });
    expect(state.cashCents).toBe(DEFS.economy.startingCashCents);
    expect(state.parcels).toEqual({ starter: 'owned', west_quay: 'none', east_yard: 'none' });
    expect(Object.keys(state.parcels)).toEqual(MAP.parcels.map((p) => p.id));
  });

  it('cesty = všetky bunky s road ≠ none ako [index, vrstva] vzostupne (vrátane starter ciest)', () => {
    const world = busyWorld();
    const state = world.serialize();
    const expected: [number, string][] = [];
    for (let i = 0; i < world.grid.cellCount; i++) {
      const { road } = world.grid.atIndex(i);
      if (road !== 'none') expected.push([i, road]);
    }
    expect(state.roads).toEqual(expected);
    const indexes = state.roads.map(([index]) => index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(state.roads).toContainEqual([MAP_GRID.index(PUBLIC_LAND.x, PUBLIC_LAND.y), 'road']);
    expect(state.roads).toContainEqual([MAP_GRID.index(OTHER_PUBLIC_LAND.x, OTHER_PUBLIC_LAND.y), 'rail']);
    expect(indexes).not.toContain(MAP_GRID.index(STARTER_ROAD.x, STARTER_ROAD.y));
    expect(state.roads).toContainEqual([MAP_GRID.index(MAP.starter.roads[1].x, MAP.starter.roads[1].y), 'road']);
  });

  it('traffic = bunky s nenulovým traffic ako [index, hodnota] vzostupne; roundtrip je presný', () => {
    const world = busyWorld();
    const state = world.serialize();
    const expected = [
      [MAP_GRID.index(STARTER_ROAD.x, STARTER_ROAD.y), 0.1 + 0.2],
      [MAP_GRID.index(PUBLIC_LAND.x, PUBLIC_LAND.y), 12.5],
    ].sort((a, b) => a[0] - b[0]);
    expect(state.traffic).toEqual(expected);
    const restored = World.deserialize(DEFS, MAP, viaJson(state));
    expect(restored.grid.at(STARTER_ROAD.x, STARTER_ROAD.y).traffic).toBe(0.1 + 0.2);
    expect(restored.grid.at(PUBLIC_LAND.x, PUBLIC_LAND.y).traffic).toBe(12.5);
    expect(restored.serialize().traffic).toEqual(state.traffic);
  });

  it('čistý JSON: JSON roundtrip je hlboko rovný a nie sú v ňom inštancie tried', () => {
    const state = busyWorld().serialize();
    expect(viaJson(state)).toEqual(state);
    const plain = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return ['number', 'string', 'boolean'].includes(typeof value) || value === null;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype) return false;
      return Object.values(value).every(plain);
    };
    expect(plain(state)).toBe(true);
  });

  it('vrátený stav je kópia — nezdieľa nič meniteľné so svetom', () => {
    const world = busyWorld();
    const state = world.serialize();
    const hash = hashState(state);
    // Zmena vráteného stavu svet neovplyvní…
    state.rng[0] = 0;
    (state.roads as unknown as unknown[]).length = 0;
    (state.parcels as Record<string, string>).starter = 'none';
    expect(hashState(world.serialize())).toBe(hash);

    // …a neskoršie zmeny sveta nezmenia skôr vrátený stav.
    const fresh = world.serialize();
    runTicks(world, 10);
    world.enqueue(consumeRng());
    world.enqueue(setRoad([PUBLIC_LAND], 'none'));
    world.tick();
    expect(hashState(fresh)).toBe(hash);
    expect(hashState(world.serialize())).not.toBe(hash);
  });

  it('s neaplikovanými príkazmi vo fronte vyhodí chybu (fronta sa neukladá)', () => {
    const world = create();
    world.enqueue(new TestCommand());
    expect(() => world.serialize()).toThrow(/applyPending/);
    world.applyPending();
    expect(() => world.serialize()).not.toThrow();
  });
});

describe('World.deserialize', () => {
  it('deserialize(serialize(w)) po 1 000 tickoch ≡ w po ďalších 1 000 tickoch (hash serialize)', () => {
    const original = busyWorld();
    runTicks(original, 1000);
    const saved = viaJson(original.serialize());
    const restored = World.deserialize(DEFS, MAP, saved);
    expect(hashState(restored.serialize())).toBe(hashState(saved));

    // Rovnaké príkazy vrátane spotreby Rng — rozdielny stav rng by sa prejavil v hotovosti.
    for (const world of [original, restored]) {
      runTicks(world, 500);
      world.enqueue(consumeRng());
      world.enqueue(setRoad([MAP.starter.roads[2]], 'none'));
      runTicks(world, 500);
    }
    expect(restored.clock.tick).toBe(original.clock.tick);
    expect(hashState(restored.serialize())).toBe(hashState(original.serialize()));
    expect(restored.serialize()).toEqual(original.serialize());
  });

  it('obnoví hodiny, rng, ID, hotovosť, cesty a vlastníctvo parciel', () => {
    const original = busyWorld();
    const restored = World.deserialize(DEFS, MAP, viaJson(original.serialize()));
    expect(restored.clock.getState()).toEqual(original.clock.getState());
    expect(restored.clock.speed).toBe(4);
    expect(restored.rng.getState()).toEqual(original.rng.getState());
    expect(restored.ids.getState()).toEqual(original.ids.getState());
    expect(restored.cashCents).toBe(original.cashCents);
    expect(restored.seed).toBe(SEED);
    expect(restored.parcels.get('west_quay')?.ownership).toBe('leased');
    for (let i = 0; i < MAP_GRID.cellCount; i++) {
      expect(restored.grid.atIndex(i)).toEqual(original.grid.atIndex(i));
    }
    // Odstránená starter cesta sa z mapy neobnoví.
    expect(restored.grid.at(STARTER_ROAD.x, STARTER_ROAD.y).road).toBe('none');
    expect(restored.pendingCommandCount).toBe(0);
  });

  it('nezdieľa stav so vstupom ani so šablónou mapy', () => {
    const state = busyWorld().serialize();
    const stateHash = hashState(state);
    const restored = World.deserialize(DEFS, MAP, state);
    restored.grid.at(PUBLIC_LAND.x, PUBLIC_LAND.y).road = 'none';
    restored.enqueue(consumeRng());
    restored.tick();
    const parcel = restored.parcels.get('east_yard');
    if (parcel === undefined) throw new Error('mapa nemá east_yard');
    parcel.ownership = 'owned';
    expect(hashState(state)).toBe(stateHash);
    const template = MAP.createGrid();
    expect(template.at(PUBLIC_LAND.x, PUBLIC_LAND.y).road).toBe('none');
    expect(template.at(STARTER_ROAD.x, STARTER_ROAD.y).road).toBe('road');
    expect(MAP.parcels.find((p) => p.id === 'east_yard')?.ownership).toBe('none');
    expect(MAP.parcels.find((p) => p.id === 'west_quay')?.ownership).toBe('none');

    // Zmena vstupu po načítaní svet neovplyvní.
    const again = World.deserialize(DEFS, MAP, state);
    const hash = hashState(again.serialize());
    state.rng[0] ^= 1;
    (state as { clock: unknown }).clock = { tick: 0, speed: 0 };
    (state.roads as unknown as unknown[]).length = 0;
    expect(hashState(again.serialize())).toBe(hash);
  });

  it('dva svety z jedného stavu sú nezávislé', () => {
    const state = busyWorld().serialize();
    const a = World.deserialize(DEFS, MAP, state);
    const b = World.deserialize(DEFS, MAP, state);
    a.grid.at(PUBLIC_LAND.x, PUBLIC_LAND.y).road = 'none';
    a.rng.nextU32();
    expect(hashState(b.serialize())).toBe(hashState(state));
  });

  type Mutation = (state: Record<string, unknown>) => void;
  type RawTotals = Record<string, unknown>;
  interface RawEconomy {
    entries: Record<string, unknown>[];
    today: { incomeCents: RawTotals; expenseCents: RawTotals };
  }
  const economyOf = (state: Record<string, unknown>): RawEconomy => state.economy as RawEconomy;
  const EMPTY_ECONOMY_STATE = { entries: [], today: { incomeCents: {}, expenseCents: {} }, daily: [], monthly: [], daysNegative: 0, gameOver: false };
  const set =
    (key: string, value: unknown): Mutation =>
    (state) => {
      state[key] = value;
    };
  const firstRoadIndex = (state: Record<string, unknown>): number => (state.roads as [number, string][])[0][0];

  const INVALID: readonly [string, Mutation, string][] = [
    ['neznámy kľúč', set('extra', 1), '/extra'],
    ['chýba kľúč', (s) => delete s.cashCents, '/cashCents'],
    ['neznáma budúca verzia', set('version', 16), '/version'],
    ['verzia 0', set('version', 0), '/version'],
    ['verzia ako reťazec', set('version', '3'), '/version'],
    ['starý save v1 → clean break (ADR-036), chyba verzie pred tvarom', set('version', 1), '/version'],
    ['starý save v2 → clean break (ADR-036), chyba verzie pred tvarom', set('version', 2), '/version'],
    ['iná mapa', set('mapId', 'harbor_99'), '/mapId'],
    ['záporný seed', set('seed', -1), '/seed'],
    ['seed ≥ 2^32', set('seed', 2 ** 32), '/seed'],
    ['nulový stav rng', set('rng', [0, 0, 0, 0]), '/rng'],
    ['krátky stav rng', set('rng', [1, 2, 3]), '/rng'],
    ['rng nie je pole', set('rng', 'abc'), '/rng'],
    ['clock nie je objekt', set('clock', null), '/clock'],
    ['clock bez speed', set('clock', { tick: 0 }), '/clock/speed'],
    ['clock s neznámym kľúčom', set('clock', { tick: 0, speed: 1, day: 0 }), '/clock/day'],
    ['záporný tick', set('clock', { tick: -1, speed: 1 }), '/clock'],
    ['rýchlosť mimo time.speeds', set('clock', { tick: 0, speed: 3 }), '/clock/speed'],
    ['ids.nextId 0', set('ids', { nextId: 0 }), '/ids'],
    ['ids bez nextId', set('ids', {}), '/ids/nextId'],
    ['zlomková hotovosť', set('cashCents', 1.5), '/cashCents'],
    ['hotovosť ako reťazec', set('cashCents', '100'), '/cashCents'],
    ['roads nie je pole', set('roads', {}), '/roads'],
    ['záznam cesty nie je dvojica', set('roads', [[1]]), '/roads/0'],
    ['záporný index bunky', set('roads', [[-1, 'road']]), '/roads/0/0'],
    ['index mimo mapy', set('roads', [[MAP_GRID.cellCount, 'road']]), '/roads/0/0'],
    ['vrstva none', (s) => set('roads', [[firstRoadIndex(s), 'none']])(s), '/roads/0/1'],
    ['duplicitná bunka', (s) => set('roads', [[firstRoadIndex(s), 'road'], [firstRoadIndex(s), 'rail']])(s), '/roads/1/0'],
    ['cesta na vode', set('roads', [[WATER_INDEX, 'road']]), '/roads/0/0'],
    ['parcels nie je objekt', set('parcels', []), '/parcels'],
    ['neznáma parcela', (s) => ((s.parcels as Record<string, string>).nowhere = 'none'), '/parcels/nowhere'],
    ['chýba parcela', (s) => delete (s.parcels as Record<string, string>).east_yard, '/parcels/east_yard'],
    ['neplatné vlastníctvo', (s) => ((s.parcels as Record<string, string>).west_quay = 'sold'), '/parcels/west_quay'],
    ['prenájom neprenajímateľnej parcely', (s) => ((s.parcels as Record<string, string>).starter = 'leased'), '/parcels/starter'],
    ['traffic nie je pole', set('traffic', {}), '/traffic'],
    ['záznam traffic nie je dvojica', set('traffic', [[1]]), '/traffic/0'],
    ['traffic index mimo mapy', set('traffic', [[MAP_GRID.cellCount, 1]]), '/traffic/0/0'],
    ['traffic nulový (neukladá sa)', set('traffic', [[5, 0]]), '/traffic/0/1'],
    ['traffic záporný', set('traffic', [[5, -1]]), '/traffic/0/1'],
    ['traffic ako reťazec', set('traffic', [[5, '1']]), '/traffic/0/1'],
    ['traffic duplicitná bunka', set('traffic', [[5, 1], [5, 2]]), '/traffic/1/0'],
    ['modules nie je pole', set('modules', {}), '/modules'],
    ['cargo nie je objekt', set('cargo', []), '/cargo'],
    ['cargo bez units', set('cargo', { createdCount: 0, exportedCount: 0, shippedCount: 0 }), '/cargo/units'],
    ['cargo porušená konzervácia', set('cargo', { createdCount: 1, exportedCount: 0, shippedCount: 0, units: [] }), '/cargo/createdCount'],
    ['cargo bez shippedCount (ADR-032)', set('cargo', { createdCount: 0, exportedCount: 0, units: [] }), '/cargo/shippedCount'],
    [
      'chýba nextVoyageId (ADR-032)',
      (state) => {
        delete state['nextVoyageId'];
      },
      '/nextVoyageId',
    ],
    ['nextVoyageId 0', set('nextVoyageId', 0), '/nextVoyageId'],
    ['ships nie je pole', set('ships', {}), '/ships'],
    ['loď bez povinných kľúčov (tvar SerializedShip, T02-05)', set('ships', [{ id: 1 }]), '/ships/0/classId'],
    // economy (v5, ADR-025) — busyWorld je v ticku 123 a má záznamy knihy z adjustCash a consumeRng.
    ['economy nie je objekt', set('economy', []), '/economy'],
    ['economy bez daysNegative', (s) => delete (s.economy as Record<string, unknown>).daysNegative, '/economy/daysNegative'],
    ['záznam knihy s neznámou kategóriou', (s) => (economyOf(s).entries[0].category = 'bonus'), '/economy/entries/0/category'],
    ['záznam knihy v budúcnosti', (s) => (economyOf(s).entries[0].tick = 124), '/economy/entries/0/tick'],
    ['záznamy knihy nie vzostupne podľa ticku', (s) => (economyOf(s).entries[1].tick = 122), '/economy/entries/1/tick'],
    ['zlomková suma záznamu', (s) => (economyOf(s).entries[0].amountCents = 0.5), '/economy/entries/0/amountCents'],
    ['refId nie je reťazec', (s) => (economyOf(s).entries[0].refId = 7), '/economy/entries/0/refId'],
    ['záznam s neznámym kľúčom', (s) => (economyOf(s).entries[0].note = 'x'), '/economy/entries/0/note'],
    ['súčet otvoreného dňa s neznámou kategóriou', (s) => (economyOf(s).today.incomeCents.bonus = 1), '/economy/today/incomeCents/bonus'],
    ['nulový súčet otvoreného dňa (neukladá sa)', (s) => (economyOf(s).today.expenseCents.maintenance = 0), '/economy/today/expenseCents/maintenance'],
    ['súhrn ešte neuzavretého dňa', set('economy', { ...EMPTY_ECONOMY_STATE, daily: [{ day: 0, incomeCents: {}, expenseCents: {}, cashEndCents: 0 }] }), '/economy/daily/0/day'],
    ['súhrn ešte neuzavretého mesiaca', set('economy', { ...EMPTY_ECONOMY_STATE, monthly: [{ month: 0, incomeCents: {}, expenseCents: {}, cashEndCents: 0 }] }), '/economy/monthly/0/month'],
    ['gameOver nie je boolean', set('economy', { ...EMPTY_ECONOMY_STATE, gameOver: 1 }), '/economy/gameOver'],
    ['záporné daysNegative', set('economy', { ...EMPTY_ECONOMY_STATE, daysNegative: -1 }), '/economy/daysNegative'],
  ];

  it.each(INVALID)('%s → WorldStateError na %s', (_name, mutate, path) => {
    const state = viaJson(busyWorld().serialize()) as unknown as Record<string, unknown>;
    mutate(state);
    let error: unknown;
    try {
      World.deserialize(DEFS, MAP, state as unknown as WorldState);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorldStateError);
    expect((error as WorldStateError).path).toBe(path);
    expect((error as WorldStateError).message.startsWith(`WorldState${path}: `)).toBe(true);
  });

  it('stav, ktorý nie je objekt → WorldStateError na koreni', () => {
    for (const raw of [null, 42, 'state', []]) {
      expect(() => World.deserialize(DEFS, MAP, raw as unknown as WorldState)).toThrow(WorldStateError);
    }
  });

  it('rýchlosť 0 (pauza) je platná, ak je v time.speeds', () => {
    const world = create();
    world.clock.setSpeed(0);
    expect(World.deserialize(DEFS, MAP, world.serialize()).clock.speed).toBe(0);
  });
});
