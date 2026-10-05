/**
 * WorldState: export booking v save (T6A-01, ADR-032; ARCHITECTURE §14): kontrakt `ExportContract` s bookingom sa uloží a načíta na rovnaký stav,
 * svet s ním tickuje bez porušenia invariantov a poškodené polia exportu (kontrakt, voyage, booking, štítky jednotiek, lashing, misia kamióna,
 * cyklus žeriavu) → `WorldStateError` s JSON pointerom. Základ je `vertical_slice` uprostred vykládky (clean break savov, ADR-036: bez fixtures).
 */
import { describe, expect, it } from 'vitest';
import { ExportContract } from '@sim/contracts';
import { DefRegistry } from '@sim/defs';
import { World, WorldStateError, stateHash, type WorldState } from '@sim/world';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { MAP, RAW_DEFS } from './world-fixtures';

/**
 * Defy bez booking ponúk: pool (a `Rng` prúd) nemá booking ponuky, takže kontrakt 0 je import a booking pridaný testom je jediný export.
 */
const DEFS = DefRegistry.fromRaw({ ...RAW_DEFS, economy: { ...RAW_DEFS.economy, bookingOffersPerDay: 0 } });

/** Tick uprostred vykládky vertical slice (kotva, na ktorej sa overuje export booking). */
const SLICE_TICK = 8_784;
const HEAVY_TIMEOUT_MS = 120_000;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** `vertical_slice` v ticku `tick`. */
function sliceAt(tick: number): World {
  const scenario = loadScenarioFile('vertical_slice');
  const world = World.create(DEFS, MAP, scenario.seed);
  runScenario(world, scenario, tick);
  return world;
}

function loadError(raw: unknown): WorldStateError {
  try {
    World.deserialize(DEFS, MAP, raw as WorldState);
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw new Error(`očakávaná WorldStateError, dostal ${String(error)}`, { cause: error });
  }
  throw new Error('načítanie poškodeného savu nevyhodilo chybu');
}

/** Stav uprostred vykládky vertical slice s pridaným prijatým export bookingom bez nákladu (nová voyage, ADR-032). */
function stateWithBooking(): WorldState {
  const state = clone(sliceAt(SLICE_TICK).serialize());
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
      arrivedTeu: 0,
      loadedUnits: 0,
      loadedTeu: 0,
      lastMinuteUnits: 0,
      lastMinuteTeu: 0,
      rolledUnitIds: [],
      heldUnits: 0,
    },
  };
  return { ...state, contracts: [...state.contracts, booking], nextContractId: id + 1, nextVoyageId: voyageId + 1 };
}

describe('WorldState: export booking v save a roundtrip', () => {
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
    runScenario(world, scenario, 10_500);
    const state = clone(world.serialize());
    expect(state.trucks.length).toBeGreaterThan(0);
    expect(loadError({ ...clone(state), trucks: state.trucks.map((truck, i) => (i === 0 ? { ...truck, mission: 'drone' } : truck)) }).path).toBe('/trucks/0/mission');
    const craneIndex = state.modules.findIndex((entry) => DEFS.modules.get(entry.defId).kind === 'crane');
    const idleCrane = { ...state, modules: state.modules.map((entry, i) => (i === craneIndex ? { ...entry, runtime: { ...entry.runtime, state: 'idle', phaseTicksTotal: 0, phaseTicksLeft: 0, reservedSlot: null, cycle: 'load' } } : entry)) };
    expect(loadError(idleCrane).path).toBe(`/modules/${String(craneIndex)}/runtime/cycle`);
  });
});
