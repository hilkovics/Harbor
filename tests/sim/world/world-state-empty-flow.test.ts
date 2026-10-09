/**
 * WorldState: polia F6c v save (T6C-01, ADR-034; ARCHITECTURE §14) — prázdny kontajner v oprave, plán návratov a výdajov (`emptyFlow`), prekládka
 * v ponuke a poškodené polia (linka kontraktu a jednotky, plán prekládky, stav kvality, `emptyFlow`) → `WorldStateError` s JSON pointerom.
 * Základ sú svety z bundled scenárov (`vertical_slice` uprostred vykládky, `export_roundtrip` uprostred nakládky; clean break savov, ADR-036: bez fixtures).
 */
import { describe, expect, it } from 'vitest';
import { TranshipContract } from '@sim/contracts';
import { World, WorldStateError, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS, PORT_MAP } from './world-fixtures';

type Json = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const HEAVY_TIMEOUT_MS = 180_000;

/** Tick uprostred vykládky `vertical_slice` a uprostred nakládky `export_roundtrip` (export booking v stave `exporting`). */
const SLICE_TICK = 8_784;
const EXPORT_TICK = 31_000;

type BaseScenario = 'vertical_slice' | 'export_roundtrip';
const cache = new Map<BaseScenario, WorldState>();

/** Stav sveta (JSON kópia) zo scenára v danom ticku; počíta sa raz za súbor. */
function stateOf(scenarioId: BaseScenario, tick: number): WorldState {
  let state = cache.get(scenarioId);
  if (state === undefined) {
    const scenario = loadScenarioFile(scenarioId);
    const world = World.create(DEFS, PORT_MAP, scenario.seed);
    runScenario(world, scenario, tick);
    state = clone(world.serialize());
    cache.set(scenarioId, state);
  }
  return clone(state);
}

function loadError(raw: unknown): WorldStateError {
  try {
    World.deserialize(DEFS, PORT_MAP, raw as WorldState);
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw new Error(`očakávaná WorldStateError, dostal ${String(error)}`, { cause: error });
  }
  throw new Error('načítanie poškodeného savu nevyhodilo chybu');
}

/** Stav sveta po niekoľkých tickoch (predvolene vertical slice, `export_roundtrip` s export bookingom) — základ pre ručne vložené polia F6c. */
function baseState(scenarioId: BaseScenario = 'vertical_slice'): WorldState {
  return scenarioId === 'vertical_slice' ? stateOf(scenarioId, SLICE_TICK) : stateOf(scenarioId, EXPORT_TICK);
}

/** Prázdny kontajner linky v sklade `moduleId` (vrstva 0 voľného stĺpca dvora S) — jednotka s novým id. */
function withEmptyUnit(state: WorldState, fields: Json = {}): WorldState {
  // Vrstva 0 prvého prázdneho stĺpca prvého skladu, ktorý ho má (blok 4 × 4 × 3, ADR-039; 40′ zaberá aj stĺpec vedľa).
  const freeColumnOf = (moduleId: number): number | undefined => {
    const taken = new Set<number>();
    for (const other of state.cargo.units) {
      const location = other.location as { kind: string; moduleId?: number; slot?: number };
      if (location.kind !== 'in_storage' || location.moduleId !== moduleId || location.slot === undefined) continue;
      const column = Math.floor(location.slot / 3);
      taken.add(column);
      if (other.sizeFt === 40) taken.add(column + 1);
    }
    return Array.from({ length: 16 }, (_, column) => column).find((column) => !taken.has(column));
  };
  const yard = state.modules.find((entry) => DEFS.modules.get(entry.defId).kind === 'storage' && freeColumnOf(entry.id) !== undefined);
  if (yard === undefined) throw new Error('save nemá sklad s voľným stĺpcom');
  const freeColumn = freeColumnOf(yard.id) as number;
  const unit = {
    id: state.ids.nextId,
    typeId: 'container_teu',
    contractId: null,
    voyageId: null,
    lineId: 'northern_star',
    direction: 'empty',
    destinationPort: null,
    weightClass: 'light',
    sizeFt: 20,
    containerType: 'dry',
    oog: false,
    hold: null,
    status: 'damaged',
    repairUntilTick: null,
    quantity: 1,
    location: { kind: 'in_storage', moduleId: yard.id, slot: freeColumn * 3 },
    ...fields,
  };
  return {
    ...state,
    ids: { nextId: state.ids.nextId + 1 },
    cargo: { ...state.cargo, createdCount: state.cargo.createdCount + 1, units: [...state.cargo.units, unit as never] },
  };
}

describe('WorldState: polia F6c v save a roundtrip', () => {
  it('prázdny kontajner v oprave a plán návratov / výdajov sa načítajú, roundtrip dá rovnaký stav a invarianty držia', () => {
    // výdaj prázdneho ukazuje na export booking (T6C-07b, m5: obnova overuje kontrakt druhu export a jeho linku)
    const base = baseState('export_roundtrip');
    const booking = base.contracts.find((contract) => contract.kind === 'export' && contract.state === 'exporting');
    if (booking === undefined) throw new Error('save nemá export booking');
    const state: WorldState = {
      ...withEmptyUnit(base, { status: 'in_repair', repairUntilTick: base.clock.tick + 500 }),
      emptyFlow: {
        returnPlan: [{ dueTick: base.clock.tick + 100, lineId: 'blue_anchor', sizeFt: 20 }, { dueTick: base.clock.tick + 100, lineId: 'golden_wave', sizeFt: 40 }],
        pickupPlan: [{ dueTick: base.clock.tick + 50, lineId: booking.lineId, contractId: booking.id }],
        errands: [],
      },
    };
    const world = World.deserialize(DEFS, PORT_MAP, clone(state));
    world.assertInvariants();
    // poradie jednotiek v save určuje ledger (nie ručné pripojenie na koniec): plán a vložená jednotka sa zachovajú, roundtrip je idempotentný
    const saved = world.serialize();
    expect(saved.emptyFlow).toEqual(state.emptyFlow);
    expect(saved.cargo.units.find((unit) => unit.id === state.ids.nextId - 1)).toEqual(state.cargo.units[state.cargo.units.length - 1]);
    expect(JSON.stringify(World.deserialize(DEFS, PORT_MAP, clone(saved)).serialize())).toBe(JSON.stringify(saved));
    const empty = world.cargo.get(state.ids.nextId - 1 as never);
    expect(empty).toMatchObject({ direction: 'empty', lineId: 'northern_star', status: 'in_repair', repairUntilTick: base.clock.tick + 500 });
    expect(world.emptyFlow.returnPlan.map((entry) => entry.lineId)).toEqual(['blue_anchor', 'golden_wave']);
    expect(world.emptyFlow.pickupPlan).toEqual([{ dueTick: base.clock.tick + 50, lineId: booking.lineId, contractId: booking.id }]);
    expect(() => assertCargoConservation(world)).not.toThrow();
  });

  it('prekládka v ponuke (voyage A aj B) sa načíta ako TranshipContract, kniha ju indexuje pod oboma voyage a po expirácii zabudne obe', () => {
    const base = baseState();
    const contractId = base.nextContractId;
    const voyageA = base.nextVoyageId;
    const voyageB = voyageA + 1;
    const tick = base.clock.tick;
    const offered = new TranshipContract({
      id: contractId as never,
      voyageId: voyageA as never,
      outVoyageId: voyageB as never,
      lineId: 'golden_wave',
      templateId: 'container_feeder_tranship',
      cargoTypeId: 'container_teu',
      volumeUnits: 12,
      slaDays: 3,
      rewardCents: 3_000_000,
      xpReward: 12,
      offeredTick: tick,
      offerExpiresTick: tick + 17_280,
      shipClassId: 'feeder',
      destinationPort: 'Hamburg',
    });
    const state: WorldState = { ...base, contracts: [...base.contracts, offered.toState()], nextContractId: contractId + 1, nextVoyageId: voyageB + 1 };
    const world = World.deserialize(DEFS, PORT_MAP, clone(state));
    world.assertInvariants();
    const loaded = world.contracts.get(contractId as never);
    expect(loaded).toBeInstanceOf(TranshipContract);
    expect(loaded?.tranship).toMatchObject({ outVoyageId: voyageB, outArrivalTick: undefined, outShipId: undefined });
    expect(world.contractBook.voyageContracts(voyageA as never)).toEqual([loaded]);
    expect(world.contractBook.voyageContracts(voyageB as never)).toEqual([loaded]);
    expect(world.contractBook.offeredGroups().tranship).toBe(1);
    expect(JSON.stringify(world.serialize())).toBe(JSON.stringify(state));
    // Ponuka expiruje v uzávierke dňa po `offerExpiresTick`; kniha zabudne kontrakt aj z indexu oboch voyage.
    for (let i = 0; i < 3 * 8_640 && world.contracts.has(contractId as never); i++) world.tick();
    expect(world.contracts.has(contractId as never)).toBe(false);
    expect(world.contractBook.voyageContracts(voyageA as never)).toEqual([]);
    expect(world.contractBook.voyageContracts(voyageB as never)).toEqual([]);
  }, HEAVY_TIMEOUT_MS);

  const CORRUPTIONS: readonly [string, (state: WorldState) => WorldState, string][] = [
    ['kontrakt bez linky', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === 0 ? { ...c, lineId: undefined as never } : c)) }), '/contracts/0/lineId'],
    ['kontrakt s neznámou linkou', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === 0 ? { ...c, lineId: 'ghost_line' } : c)) }), '/contracts/0/lineId'],
    ['import s plánom prekládky', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === 0 ? { ...c, tranship: { outVoyageId: 1, outArrivalTick: null, outShipId: null, rescueDeadlineTick: null } } : c)) }), '/contracts/0/tranship'],
    ['chýba tranship', (s) => ({ ...s, contracts: s.contracts.map((c, i) => (i === 0 ? { ...c, tranship: undefined as never } : c)) }), '/contracts/0/tranship'],
    ['jednotka bez linky v poli', (s) => ({ ...s, cargo: { ...s.cargo, units: s.cargo.units.map((u, i) => (i === 0 ? { ...u, lineId: undefined as never } : u)) } }), '/cargo/units/0/lineId'],
    ['jednotka s neznámou linkou', (s) => ({ ...s, cargo: { ...s.cargo, units: s.cargo.units.map((u, i) => (i === 0 ? { ...u, lineId: 'ghost_line' } : u)) } }), '/cargo/units/0/lineId'],
    ['jednotka kontraktu s inou linkou ako kontrakt', (s) => ({ ...s, cargo: { ...s.cargo, units: s.cargo.units.map((u, i) => (i === 0 ? { ...u, lineId: 'golden_wave' } : u)) } }), '/cargo/units/0/lineId'],
    ['poškodený import', (s) => ({ ...s, cargo: { ...s.cargo, units: s.cargo.units.map((u, i) => (i === 0 ? { ...u, status: 'damaged' } : u)) } }), '/cargo/units/0/status'],
    ['chýba emptyFlow', (s) => ({ ...s, emptyFlow: undefined as never }), '/emptyFlow'],
    ['plán návratov nie je zoradený', (s) => ({ ...s, emptyFlow: { returnPlan: [{ dueTick: 9, lineId: 'blue_anchor', sizeFt: 20 }, { dueTick: 3, lineId: 'blue_anchor', sizeFt: 20 }], pickupPlan: [], errands: [] } }), '/emptyFlow/returnPlan/1/dueTick'],
    ['plán s neznámou linkou', (s) => ({ ...s, emptyFlow: { returnPlan: [{ dueTick: 9, lineId: 'ghost_line', sizeFt: 20 }], pickupPlan: [], errands: [] } }), '/emptyFlow/returnPlan/0/lineId'],
    ['výdaj s kontraktom 0', (s) => ({ ...s, emptyFlow: { returnPlan: [], pickupPlan: [{ dueTick: 9, lineId: 'blue_anchor', contractId: 0 }], errands: [] } }), '/emptyFlow/pickupPlan/0/contractId'],
    ['plán s neznámym kľúčom', (s) => ({ ...s, emptyFlow: { returnPlan: [], pickupPlan: [], errands: [], extra: [] } as never }), '/emptyFlow/extra'],
  ];

  it.each(CORRUPTIONS)('%s → WorldStateError s cestou', (_name, corrupt, path) => {
    const raw = JSON.parse(JSON.stringify(corrupt(baseState()))) as unknown;
    expect(loadError(raw).path).toBe(path);
  });

  it('prázdny kontajner s kontraktom v save → WorldStateError (prázdny nemá kontrakt)', () => {
    const raw = JSON.parse(JSON.stringify(withEmptyUnit(baseState(), { contractId: 1 }))) as unknown;
    expect(loadError(raw).path).toBe('/cargo/units/' + String(baseState().cargo.units.length) + '/direction');
  });
});
