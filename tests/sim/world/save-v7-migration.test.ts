/**
 * WorldState v8 (T6C-01, ADR-034; ARCHITECTURE §14): migrácia v7 → v8 nad natívnymi savmi v7 (`save-v7.json` — vertical slice
 * uprostred vykládky a `save-v7-export.json` — `export_roundtrip` uprostred nakládky; oba vznikli **kódom v7** pred zmenou
 * tvaru), roundtrip v8 s poľami F6c a fail-fast cesty nových polí.
 *
 * 1. Migrácia je deterministická a bez `Rng`: kontrakt `lineId` = prvá linka z `lines.json`, `tranship: null`; jednotka
 *    s kontraktom prvá linka (bez kontraktu `null`), `status: 'available'`, `repairUntilTick: null`; prázdny `emptyFlow`.
 * 2. Zhodenie späť (`toV7State`) dá z načítaného sveta **pôvodný text** natívneho v7 savu (migrácia nič nezahodila ani nepridala).
 * 3. Migrovaný svet beží ďalej rovnako ako nepretržitý beh (po zhodení liniek — svet z migrácie má všade prvú linku,
 *    referenčný svet ich rozdeľuje po voyage) a po načítaní prežije invarianty; `lostUnits` ostáva 0.
 * 4. v8 s plánom prázdnych, prázdnou jednotkou v sklade a prekládkou v ponuke sa uloží a načíta na rovnaký stav;
 *    poškodené polia F6c → `WorldStateError` s JSON pointerom.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TranshipContract } from '@sim/contracts';
import { World, WorldStateError, migrateWorldState, type AnyWorldState, type WorldState } from '@sim/world';
import { assertCargoConservation } from '../helpers/invariants';
import { toV7State } from '../helpers/legacy-save';
import { loadScenarioFile, runScenario } from '../helpers/scenario';
import { DEFS, MAP } from './world-fixtures';

type Json = Record<string, unknown>;

const FIXTURE_DIR = fileURLToPath(new URL('../__fixtures__/saves/', import.meta.url));
const read = (file: string): Json => JSON.parse(readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')) as Json;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const asState = (raw: unknown): AnyWorldState => raw as AnyWorldState;
const FIRST_LINE = DEFS.lines.items[0].id;
const CONTINUE_TICKS = 3_000;
const HEAVY_TIMEOUT_MS = 180_000;

const SLICE = read('save-v7.json');
const EXPORT = read('save-v7-export.json');
const tickOf = (save: Json): number => (save['clock'] as { tick: number }).tick;

/** Text stavu v9 bez vnútrozemia, liniek, plánu prekládky a stavu kvality (tvar v7). */
const asV7Text = (state: unknown): string => JSON.stringify(toV7State(state));

function loadError(raw: unknown): WorldStateError {
  try {
    World.deserialize(DEFS, MAP, asState(raw));
  } catch (error) {
    if (error instanceof WorldStateError) return error;
    throw new Error(`očakávaná WorldStateError, dostal ${String(error)}`, { cause: error });
  }
  throw new Error('načítanie poškodeného savu nevyhodilo chybu');
}

describe('migrácia save v7 → v8 (ADR-034)', () => {
  it('fixtures sú natívne v7: verzia 7, štítky exportu, bez polí F6c; export fixture má booking v nakládke', () => {
    for (const save of [SLICE, EXPORT]) {
      expect(save['version']).toBe(7);
      expect(save).not.toHaveProperty('emptyFlow');
      for (const contract of save['contracts'] as Json[]) expect(contract).not.toHaveProperty('lineId');
      for (const unit of (save['cargo'] as { units: Json[] }).units) expect(Object.keys(unit)).not.toContain('status');
    }
    const kinds = (EXPORT['contracts'] as Json[]).filter((contract) => contract['state'] !== 'offered').map((contract) => `${String(contract['kind'])}:${String(contract['state'])}`);
    expect(kinds).toEqual(['import:exporting', 'export:exporting']);
    expect((EXPORT['cargo'] as { units: Json[] }).units.some((unit) => unit['direction'] === 'export')).toBe(true);
  });

  it.each([['vertical_slice', SLICE], ['export_roundtrip', EXPORT]] as const)('migrateWorldState (%s): prvá linka, status available, prázdny plán, Rng a vstup bez zmeny', (_name, save) => {
    const before = clone(save);
    const migrated = migrateWorldState(save, DEFS) as Json;
    expect(save).toEqual(before);
    expect(migrated['version']).toBe(9);
    expect(migrated['rng']).toEqual(save['rng']);
    expect(migrated['emptyFlow']).toEqual({ returnPlan: [], pickupPlan: [], errands: [] });
    const contracts = migrated['contracts'] as Json[];
    expect(contracts.length).toBeGreaterThan(0);
    for (const contract of contracts) expect([contract['lineId'], contract['tranship']]).toEqual([FIRST_LINE, null]);
    const units = (migrated['cargo'] as { units: Json[] }).units;
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect([unit['lineId'], unit['status'], unit['repairUntilTick']]).toEqual([unit['contractId'] === null ? null : FIRST_LINE, 'available', null]);
    }
  });

  it.each([['vertical_slice', SLICE], ['export_roundtrip', EXPORT]] as const)(
    'načítaný %s: serialize() je v9, zhodenie späť dá pôvodný text natívneho v7 a invarianty držia',
    (_name, save) => {
      const world = World.deserialize(DEFS, MAP, asState(clone(save)));
      world.assertInvariants();
      const state = world.serialize();
      expect(state.version).toBe(9);
      expect(JSON.stringify(toV7State(state))).toBe(JSON.stringify(save));
      expect(World.deserialize(DEFS, MAP, clone(state)).serialize()).toEqual(state);
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    `migrovaný v7 beží ďalej rovnako ako nepretržitý beh vo v8 (${String(CONTINUE_TICKS)} tickov, konzervácia po každom ticku, bez straty jednotiek)`,
    () => {
      for (const [scenarioId, save] of [['vertical_slice', SLICE], ['export_roundtrip', EXPORT]] as const) {
        const scenario = loadScenarioFile(scenarioId);
        const until = tickOf(save) + CONTINUE_TICKS;
        const reference = World.create(DEFS, MAP, scenario.seed);
        runScenario(reference, scenario, tickOf(save));
        const migrated = World.deserialize(DEFS, MAP, asState(clone(save)));
        expect(asV7Text(migrated.serialize()), `${scenarioId} v ticku save`).toBe(asV7Text(reference.serialize()));
        const expected = runScenario(reference, scenario, until);
        const actual = runScenario(migrated, scenario, until, { afterTick: (world) => assertCargoConservation(world) });
        expect(actual.map((event) => JSON.stringify(event))).toEqual(expected.map((event) => JSON.stringify(event)));
        expect(asV7Text(migrated.serialize()), scenarioId).toBe(asV7Text(reference.serialize()));
        const { cargo } = migrated;
        expect(cargo.createdCount - (cargo.liveCount + cargo.exportedCount + cargo.shippedCount), scenarioId).toBe(0);
      }
    },
    HEAVY_TIMEOUT_MS,
  );

  it('v7 s kľúčom v8 (emptyFlow) → WorldStateError na /emptyFlow (tvar v7)', () => {
    expect(loadError({ ...clone(SLICE), emptyFlow: { returnPlan: [], pickupPlan: [], errands: [] } }).path).toBe('/emptyFlow');
  });
});

/** Stav novej hry (v8) po niekoľkých tickoch (predvolene vertical slice, `EXPORT` = export_roundtrip s export bookingom) — základ pre ručne vložené polia F6c. */
function baseState(save: Json = SLICE): WorldState {
  const world = World.deserialize(DEFS, MAP, asState(clone(save)));
  return clone(world.serialize());
}

/** Prázdny kontajner linky v sklade `moduleId` (voľný slot 63 dvora S) — jednotka s novým id. */
function withEmptyUnit(state: WorldState, fields: Json = {}): WorldState {
  const yard = state.modules.find((entry) => DEFS.modules.get(entry.defId).kind === 'storage');
  if (yard === undefined) throw new Error('save nemá sklad');
  const unit = {
    id: state.ids.nextId,
    typeId: 'container_teu',
    contractId: null,
    voyageId: null,
    lineId: 'northern_star',
    direction: 'empty',
    destinationPort: null,
    weightClass: 'light',
    hold: null,
    status: 'damaged',
    repairUntilTick: null,
    quantity: 1,
    location: { kind: 'in_storage', moduleId: yard.id, slot: 63 },
    ...fields,
  };
  return {
    ...state,
    ids: { nextId: state.ids.nextId + 1 },
    cargo: { ...state.cargo, createdCount: state.cargo.createdCount + 1, units: [...state.cargo.units, unit as never] },
  };
}

describe('WorldState v8: polia F6c v save a roundtrip', () => {
  it('prázdny kontajner v oprave a plán návratov / výdajov sa načítajú, roundtrip dá rovnaký stav a invarianty držia', () => {
    // výdaj prázdneho ukazuje na export booking (T6C-07b, m5: obnova overuje kontrakt druhu export a jeho linku)
    const base = baseState(EXPORT);
    const booking = base.contracts.find((contract) => contract.kind === 'export' && contract.state === 'exporting');
    if (booking === undefined) throw new Error('save nemá export booking');
    const state: WorldState = {
      ...withEmptyUnit(base, { status: 'in_repair', repairUntilTick: base.clock.tick + 500 }),
      emptyFlow: {
        returnPlan: [{ dueTick: base.clock.tick + 100, lineId: 'blue_anchor' }, { dueTick: base.clock.tick + 100, lineId: 'golden_wave' }],
        pickupPlan: [{ dueTick: base.clock.tick + 50, lineId: booking.lineId, contractId: booking.id }],
        errands: [],
      },
    };
    const world = World.deserialize(DEFS, MAP, clone(state));
    world.assertInvariants();
    // poradie jednotiek v save určuje ledger (nie ručné pripojenie na koniec): plán a vložená jednotka sa zachovajú, roundtrip je idempotentný
    const saved = world.serialize();
    expect(saved.emptyFlow).toEqual(state.emptyFlow);
    expect(saved.cargo.units.find((unit) => unit.id === state.ids.nextId - 1)).toEqual(state.cargo.units[state.cargo.units.length - 1]);
    expect(JSON.stringify(World.deserialize(DEFS, MAP, clone(saved)).serialize())).toBe(JSON.stringify(saved));
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
    const world = World.deserialize(DEFS, MAP, clone(state));
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
    ['plán návratov nie je zoradený', (s) => ({ ...s, emptyFlow: { returnPlan: [{ dueTick: 9, lineId: 'blue_anchor' }, { dueTick: 3, lineId: 'blue_anchor' }], pickupPlan: [], errands: [] } }), '/emptyFlow/returnPlan/1/dueTick'],
    ['plán s neznámou linkou', (s) => ({ ...s, emptyFlow: { returnPlan: [{ dueTick: 9, lineId: 'ghost_line' }], pickupPlan: [], errands: [] } }), '/emptyFlow/returnPlan/0/lineId'],
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

describe('toV7State — pomôcka zhodenia tvaru v8 (testový helper)', () => {
  it('stav z čistého sveta sa zhodí na tvar v7 bez liniek, stavu kvality, plánu prekládky a emptyFlow', () => {
    const v7 = toV7State(baseState());
    expect(v7['version']).toBe(7);
    expect(v7).not.toHaveProperty('emptyFlow');
    for (const contract of v7['contracts'] as Json[]) expect(contract).not.toHaveProperty('lineId');
    for (const unit of (v7['cargo'] as { units: Json[] }).units) expect(Object.keys(unit)).not.toContain('status');
  });

  it.each<[string, (state: WorldState) => unknown, RegExp]>([
    ['iná verzia než 8 alebo 9', (state) => ({ ...state, version: 7 }), /čaká sa 8 alebo 9/],
    ['neprázdny plán prázdnych', (state) => ({ ...state, emptyFlow: { returnPlan: [{ dueTick: 1, lineId: 'blue_anchor' }], pickupPlan: [], errands: [] } }), /emptyFlow/],
    ['prázdna jednotka', (state) => withEmptyUnit(state), /smeru empty/],
  ])('odmietne: %s (v7 to nevie zapísať)', (_name, mutate, message) => {
    expect(() => toV7State(mutate(baseState()))).toThrow(message);
  });
});
