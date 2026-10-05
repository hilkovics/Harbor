/**
 * WorldState v7 (T6A-01, ADR-032; ARCHITECTURE §14): migrácia v6 → v7 nad natívnym save v6 (`save-v6.json` — vertical
 * slice uprostred vykládky, vznikol kódom v6 pred zmenou tvaru), roundtrip a fail-fast cesty nových polí. Od T6C-01
 * (ADR-034) sa save v6 migruje celou reťazou až na v8 — svet po migrácii má všade prvú linku, referenčný svet ich rozdeľuje
 * podľa voyage, preto sa stavy porovnávajú po zhodení linky (`toV7State`).
 *
 * 1. Migrácia je deterministická a bez `Rng` (rozhodnutie 14): kontrakty `kind: 'import'`, `voyageId` = id,
 *    `booking: null`, `nextVoyageId` = `nextContractId`; jednotky štítky importu (`voyageId` = `contractId`, `medium`,
 *    bez hold), `shippedCount: 0`; lode `lashingTicksLeft: 0`, kamióny `mission: 'pickup'`, žeriavy `cycle: 'unload'`.
 * 2. Migrovaný svet je **bitovo rovnaký** ako svet v7, ktorý prešiel tým istým scenárom do toho istého ticku, a ďalej
 *    beží rovnako (import-only správanie sa zmenou tvaru nezmenilo).
 * 3. v7 s export bookingom sa uloží a načíta na rovnaký stav (booking časť save); poškodené nové polia → `WorldStateError`
 *    s JSON pointerom.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExportContract } from '@sim/contracts';
import { DefRegistry } from '@sim/defs';
import { World, WorldStateError, migrateWorldState, stateHash, type AnyWorldState, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { toV6State, toV7State } from '../helpers/legacy-save';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { MAP, RAW_DEFS } from './world-fixtures';

type Json = Record<string, unknown>;

/**
 * Defy bez booking ponúk: natívny save v6 vznikol kódom bez exportu, takže jeho pool (a `Rng` prúd) nemá booking ponuky,
 * ktoré by v ticku 8 640 doplnil svet v7 (`bookingOffersPerDay` > 0, F6a). Porovnanie so svetom v7 platí pre import-only svet.
 */
const DEFS = DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, bookingOffersPerDay: 0 } });

const FIXTURE = fileURLToPath(new URL('../__fixtures__/saves/save-v6.json', import.meta.url));
const V6 = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Json;
const V6_TICK = (V6['clock'] as { tick: number }).tick;
const CONTINUE_TICKS = 3_000;
const HEAVY_TIMEOUT_MS = 120_000;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Text stavu v8 bez liniek, plánu prekládky a stavu kvality (v7 tvar): svet z migrácie má prvú linku všade, referenčný svet po voyage. */
const asV7Text = (state: unknown): string => JSON.stringify(toV7State(state));

/** `vertical_slice` (v7) v ticku save v6 — rovnaký okamih, z ktorého vznikol natívny v6 save. */
function sliceAt(tick: number): World {
  const scenario = loadScenarioFile('vertical_slice');
  const world = World.create(DEFS, MAP, scenario.seed);
  runScenario(world, scenario, tick);
  return world;
}

function loadError(raw: unknown): WorldStateError {
  try {
    World.deserialize(DEFS, MAP, raw as AnyWorldState);
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw new Error(`očakávaná WorldStateError, dostal ${String(error)}`, { cause: error });
  }
  throw new Error('načítanie poškodeného savu nevyhodilo chybu');
}

describe('migrácia save v6 → v7 (rozhodnutie 14, ADR-032)', () => {
  it('migrateWorldState: polia v7 a v8 s hodnotami importu, prvá linka, Rng a vstup bez zmeny', () => {
    const before = clone(V6);
    const migrated = migrateWorldState(V6, DEFS) as Json;
    expect(V6).toEqual(before);
    expect(migrated['version']).toBe(9);
    expect(migrated['emptyFlow']).toEqual({ returnPlan: [], pickupPlan: [], errands: [] });
    expect(migrated['rng']).toEqual(V6['rng']);
    expect(migrated['nextVoyageId']).toBe(V6['nextContractId']);
    for (const contract of migrated['contracts'] as Json[]) {
      expect([contract['kind'], contract['voyageId'], contract['booking']]).toEqual(['import', contract['id'], null]);
      expect([contract['lineId'], contract['tranship']]).toEqual([DEFS.lines.items[0].id, null]);
    }
    const cargo = migrated['cargo'] as { shippedCount: number; units: Json[] };
    expect(cargo.shippedCount).toBe(0);
    expect(cargo.units.length).toBeGreaterThan(0);
    for (const unit of cargo.units) {
      expect(unit).toMatchObject({ voyageId: unit['contractId'], direction: 'import', destinationPort: null, weightClass: 'medium', hold: null, status: 'available', repairUntilTick: null });
      expect(unit['lineId']).toBe(unit['contractId'] === null ? null : DEFS.lines.items[0].id);
    }
    expect((migrated['ships'] as Json[]).map((ship) => ship['lashingTicksLeft'])).toEqual([0]);
    const cranes = (migrated['modules'] as { defId: string; runtime: Json }[]).filter((entry) => DEFS.modules.get(entry.defId).kind === 'crane');
    expect(cranes.length).toBeGreaterThan(0);
    for (const crane of cranes) expect([crane.runtime['cycle'], crane.runtime['targetUnitId']]).toEqual(['unload', null]);
  });

  it(
    'načítaný v6 = svet v8 zo scenára v tom istom ticku (rovnaký serialize po zhodení liniek) a zhodenie späť dá pôvodný v6 text',
    () => {
      const reference = sliceAt(V6_TICK);
      const migrated = World.deserialize(DEFS, MAP, clone(V6) as unknown as AnyWorldState);
      expect(asV7Text(migrated.serialize())).toBe(asV7Text(reference.serialize()));
      expect(JSON.stringify(toV6State(migrated.serialize()))).toBe(JSON.stringify(V6));
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    `migrovaný svet beží ďalej rovnako ako nepretržitý beh (${String(CONTINUE_TICKS)} tickov, konzervácia po každom ticku)`,
    () => {
      const scenario = loadScenarioFile('vertical_slice');
      const reference = sliceAt(V6_TICK);
      const migrated = World.deserialize(DEFS, MAP, clone(V6) as unknown as AnyWorldState);
      const until = V6_TICK + CONTINUE_TICKS;
      const expected = runScenario(reference, scenario, until);
      const actual = runScenario(migrated, scenario, until, { afterTick: (world) => assertCargoConservation(world) });
      expect(actual.map((event) => JSON.stringify(event))).toEqual(expected.map((event) => JSON.stringify(event)));
      expect(asV7Text(migrated.serialize())).toBe(asV7Text(reference.serialize()));
    },
    HEAVY_TIMEOUT_MS,
  );

  it('staršie savy (v4 s kamiónmi) dostanú cez reťaz migrácií misiu pickup', () => {
    const v4 = JSON.parse(readFileSync(fileURLToPath(new URL('../__fixtures__/saves/save-v4.json', import.meta.url)), 'utf8')) as AnyWorldState;
    const trucks = World.deserialize(DEFS, MAP, v4).serialize().trucks;
    expect(trucks.length).toBeGreaterThan(0);
    expect(trucks.every((truck) => truck.mission === 'pickup')).toBe(true);
  });

  it('v6 s kľúčom v7 (nextVoyageId) → WorldStateError na /nextVoyageId (tvar v6)', () => {
    expect(loadError({ ...clone(V6), nextVoyageId: 1 }).path).toBe('/nextVoyageId');
  });
});

/** v7 uprostred vykládky vertical slice s pridaným prijatým export bookingom bez nákladu (nová voyage, ADR-032). */
function stateWithBooking(): WorldState {
  const state = clone(sliceAt(V6_TICK).serialize());
  const tick = state.clock.tick;
  const arrival = tick + 20_000;
  const id = state.nextContractId;
  const voyageId = state.nextVoyageId;
  const booking = {
    ...new ExportContract({
      id: id as never,
      voyageId: voyageId as never,
      templateId: 'container_feeder_standard',
      cargoTypeId: 'container_teu',
      volumeUnits: 4,
      slaDays: 3,
      rewardCents: 120_000,
      xpReward: 4,
      offeredTick: tick - 100,
      offerExpiresTick: tick + 17_180,
      shipClassId: 'feeder',
      lineId: 'blue_anchor',
      destinationPort: 'Rotterdam',
    }).toState(),
    state: 'accepted' as const,
    acceptedTick: tick,
    shipArrivalTick: arrival,
    slaDeadlineTick: arrival + 3 * 8_640,
    booking: {
      destinationPort: 'Rotterdam',
      cutoffTick: arrival - 4_320,
      arrivalPlan: [tick + 100, tick + 900, tick + 900, tick + 4_000],
      arrivedUnits: 0,
      loadedUnits: 0,
      lastMinuteUnits: 0,
      rolledUnitIds: [],
      heldUnits: 0,
    },
  };
  return { ...state, contracts: [...state.contracts, booking], nextContractId: id + 1, nextVoyageId: voyageId + 1 };
}

describe('WorldState v7: export booking v save a roundtrip', () => {
  it(
    'prijatý booking sa načíta ako ExportContract, roundtrip cez JSON dá rovnaký stav a svet tickuje bez porušenia invariantov',
    () => {
      const state = stateWithBooking();
      const world = World.deserialize(DEFS, MAP, clone(state));
      expect(JSON.stringify(world.serialize())).toBe(JSON.stringify(state));
      const booking = world.contracts.get(state.nextContractId - 1 as never);
      expect(booking).toBeInstanceOf(ExportContract);
      expect(booking?.booking).toMatchObject({ destinationPort: 'Rotterdam', bookedUnits: 4, cutoffTick: state.clock.tick + 20_000 - 4_320 });
      expect(world.contractBook.voyage(booking?.voyageId as never)?.destinationPort).toBe('Rotterdam');
      for (let i = 0; i < 200; i++) world.tick();
      const again = World.deserialize(DEFS, MAP, clone(world.serialize()));
      expect(stateHash(again)).toBe(stateHash(world));
      expect(again.contracts.get(state.nextContractId - 1 as never)?.state).toBe('accepted');
    },
    HEAVY_TIMEOUT_MS,
  );

  const lastContract = (state: WorldState): number => state.contracts.length - 1;
  const CORRUPTIONS: readonly [string, (state: WorldState) => unknown, (state: WorldState) => string][] = [
    ['neznámy druh kontraktu', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === 0 ? { ...c, kind: 'sideways' } : c)) }), () => '/contracts/0/kind'],
    ['voyage 0', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === 0 ? { ...c, voyageId: 0 } : c)) }), () => '/contracts/0/voyageId'],
    ['voyage ≥ nextVoyageId', (s) => ({ ...s, nextVoyageId: 1 }), () => '/contracts/0/voyageId'],
    ['import s bookingom', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === 0 ? { ...c, booking: s.contracts[lastContract(s)].booking } : c)) }), () => '/contracts/0/booking'],
    ['export bez bookingu', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === lastContract(s) ? { ...c, booking: null } : c)) }), (s) => `/contracts/${String(lastContract(s))}/booking`],
    [
      'booking bez kľúča',
      (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === lastContract(s) ? { ...c, booking: { ...c.booking, heldUnits: undefined } } : c)) }),
      (s) => `/contracts/${String(lastContract(s))}/booking/heldUnits`,
    ],
    [
      'booking s prázdnym prístavom',
      (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === lastContract(s) ? { ...c, booking: { ...c.booking, destinationPort: '' } } : c)) }),
      (s) => `/contracts/${String(lastContract(s))}/booking/destinationPort`,
    ],
    [
      'jednotka s cudzou voyage',
      (s) => ({ ...s, cargo: { ...s.cargo, units: s.cargo.units.map((u, i) => (i === 0 ? { ...u, voyageId: 99 } : u)) } }),
      () => '/cargo/units/0/voyageId',
    ],
    [
      'import jednotka v hold',
      (s) => ({ ...s, cargo: { ...s.cargo, units: s.cargo.units.map((u, i) => (i === 0 ? { ...u, hold: { reason: 'vgm', untilTick: 5 } } : u)) } }),
      () => '/cargo/units/0/hold',
    ],
    [
      'jednotka importu označená ako export',
      (s) => ({ ...s, cargo: { ...s.cargo, units: s.cargo.units.map((u, i) => (i === 0 ? { ...u, direction: 'export', destinationPort: 'Rotterdam' } : u)) } }),
      () => '/cargo/units/0/direction',
    ],
    ['chýba shippedCount', (s) => ({ ...s, cargo: { createdCount: s.cargo.createdCount, exportedCount: s.cargo.exportedCount, units: s.cargo.units } }), () => '/cargo/shippedCount'],
    ['dokovaná loď s odpočtom lashingu', (s) => ({ ...s, ships: s.ships.map((ship) => ({ ...ship, lashingTicksLeft: 5 })) }), () => '/ships/0/lashingTicksLeft'],
    ['lashing bez odpočtu', (s) => ({ ...s, ships: s.ships.map((ship) => ({ ...ship, state: 'lashing' })) }), () => '/ships/0/lashingTicksLeft'],
    ['chýba nextVoyageId', (s) => ({ ...s, nextVoyageId: undefined }), () => '/nextVoyageId'],
  ];

  it.each(CORRUPTIONS)('%s → WorldStateError s cestou', (_name, corrupt, path) => {
    const state = stateWithBooking();
    const raw = JSON.parse(JSON.stringify(corrupt(clone(state)))) as unknown;
    expect(loadError(raw).path).toBe(path(state));
  });

  it('kamión s neznámou misiou a žeriav mimo cyklu s nakládkou → WorldStateError s cestou', () => {
    const scenario = loadScenarioFile('vertical_slice');
    const world = World.create(DEFS, MAP, scenario.seed);
    runScenario(world, scenario, 13_000);
    const state = clone(world.serialize());
    expect(state.trucks.length).toBeGreaterThan(0);
    expect(loadError({ ...clone(state), trucks: state.trucks.map((truck, i) => (i === 0 ? { ...truck, mission: 'drone' } : truck)) }).path).toBe('/trucks/0/mission');
    const craneIndex = state.modules.findIndex((entry) => DEFS.modules.get(entry.defId).kind === 'crane');
    const idleCrane = { ...state, modules: state.modules.map((entry, i) => (i === craneIndex ? { ...entry, runtime: { ...entry.runtime, state: 'idle', phaseTicksTotal: 0, phaseTicksLeft: 0, reservedSlot: null, cycle: 'load' } } : entry)) };
    expect(loadError(idleCrane).path).toBe(`/modules/${String(craneIndex)}/runtime/cycle`);
  });
});
