// Kontrakty F6c (T6C-01, ADR-034): linka kontraktu, tabuľka druhov, `EmptyRepositioningContract` (booking prázdnych linky
// z depa na loď voyage) a `TranshipContract` (loď A privezie, loď B odvezie) — konštruktor, plán po prijatí, obnova zo save,
// háčik ledgera, polymorfné pravidlá, indexy knihy (prekládka pod voyage A aj B), skupiny ponúk a pool, ktorý šablóny F6c
// zatiaľ neponúka. Správanie krokov 2/5/8 (spawn lodí, nakládka, záchrana) dodá T6C-03.
import { describe, expect, it } from 'vitest';
import type { CargoLocation, CargoUnit } from '@sim/cargo';
import {
  CONTRACT_KINDS,
  CONTRACT_KIND_TRAITS,
  CONTRACT_STATE_TRAITS,
  CONTRACT_TRANSITIONS,
  CONTRACT_TRANSITIONS_BY_KIND,
  Contract,
  ContractBook,
  ContractError,
  EXPORT_CONTRACT_TRANSITIONS,
  EmptyRepositioningContract,
  ExportContract,
  ImportContract,
  OFFER_GROUPS,
  SERIALIZED_CONTRACT_KEYS,
  SERIALIZED_TRANSHIP_KEYS,
  TranshipContract,
  drawBookingOffer,
  drawOffer,
  lineForVoyage,
  type AcceptContext,
  type ContractState,
  type ExportContractTerms,
  type SerializedContract,
  type TranshipContractTerms,
} from '@sim/contracts';
import { Rng, type ContractId, type EntityId, type VoyageId } from '@sim/core';
import { loadBundledDefs } from '@sim/defs';
import type { SimEvent } from '@sim/events';

const DEFS = loadBundledDefs();
const TICKS_PER_DAY = 8_640;
const TICKS_PER_HOUR = 360;

const BASE: ExportContractTerms = {
  id: 5 as ContractId,
  voyageId: 3 as VoyageId,
  lineId: 'northern_star',
  templateId: 'container_feeder_repositioning',
  cargoTypeId: 'container_teu',
  volumeUnits: 12,
  slaDays: 3,
  rewardCents: 1_440_000,
  xpReward: 12,
  offeredTick: 10,
  offerExpiresTick: 17_290,
  shipClassId: 'feeder',
  destinationPort: 'Hamburg',
};
const TRANSHIP: TranshipContractTerms = { ...BASE, id: 6 as ContractId, voyageId: 4 as VoyageId, outVoyageId: 9 as VoyageId, templateId: 'container_feeder_tranship', rewardCents: 3_360_000 };

const context = (rng: AcceptContext['rng'], overrides: Partial<AcceptContext> = {}): AcceptContext => ({
  tick: 100,
  shipArrivalTick: 20_000,
  ticksPerDay: TICKS_PER_DAY,
  ticksPerHour: TICKS_PER_HOUR,
  cutoffHours: 12,
  arrivalWindowDays: 2,
  transhipGapDaysRange: [1, 2],
  rng,
  ...overrides,
});

/** `Rng`, ktorý každý ťah zapíše a vráti pevné hodnoty — dokazuje spotrebu ťahov. */
function recordingRng(range = 1.5): { readonly rng: AcceptContext['rng']; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rng: {
      int: (min: number, max: number) => {
        calls.push(`int(${String(min)},${String(max)})`);
        return min;
      },
      range: (min: number, max: number) => {
        calls.push(`range(${String(min)},${String(max)})`);
        return range;
      },
    },
  };
}

const SHIP = 40 as EntityId;
const SHIP_B = 41 as EntityId;
const unit = (unitId: number, direction: CargoUnit['direction'], location: CargoLocation, contractId: ContractId | null): CargoUnit => ({
  id: unitId as EntityId,
  typeId: 'container_teu',
  contractId,
  voyageId: contractId === null ? null : (4 as VoyageId),
  lineId: 'northern_star',
  direction,
  destinationPort: contractId === null ? null : 'Hamburg',
  weightClass: 'medium',
  hold: null,
  status: 'available',
  repairUntilTick: null,
  quantity: 1,
  location,
});
const ON_SHIP_A: CargoLocation = { kind: 'on_ship', shipId: SHIP };
const ON_SHIP_B: CargoLocation = { kind: 'on_ship', shipId: SHIP_B };
const CRANE: CargoLocation = { kind: 'in_crane', craneId: 30 as EntityId };
const EXPORTED: CargoLocation = { kind: 'exported' };

describe('druhy kontraktu F6c — tabuľky', () => {
  it('CONTRACT_KINDS a vlastnosti druhu: booking, plán lode B a skupina ponuky', () => {
    expect([...CONTRACT_KINDS]).toEqual(['import', 'export', 'empty_repositioning', 'tranship']);
    expect(CONTRACT_KIND_TRAITS).toEqual({
      import: { booking: false, tranship: false, offerGroup: 'import' },
      export: { booking: true, tranship: false, offerGroup: 'booking' },
      empty_repositioning: { booking: true, tranship: false, offerGroup: 'repositioning' },
      tranship: { booking: true, tranship: true, offerGroup: 'tranship' },
    });
    expect([...OFFER_GROUPS]).toEqual(['import', 'booking', 'repositioning', 'tranship']);
  });

  it('prechody: repositioning ako export booking (exporting), prekládka ako import (unloading → exporting)', () => {
    expect(CONTRACT_TRANSITIONS_BY_KIND.empty_repositioning).toBe(EXPORT_CONTRACT_TRANSITIONS);
    expect(CONTRACT_TRANSITIONS_BY_KIND.tranship).toBe(CONTRACT_TRANSITIONS);
    expect(CONTRACT_TRANSITIONS_BY_KIND.tranship.unloading).toEqual(['exporting', 'failed']);
  });

  it('serializovaný kontrakt: lineId za voyageId a tranship na konci; kľúče plánu lode B', () => {
    expect(SERIALIZED_CONTRACT_KEYS.slice(0, 5)).toEqual(['id', 'kind', 'voyageId', 'lineId', 'templateId']);
    expect(SERIALIZED_CONTRACT_KEYS.at(-2)).toBe('booking');
    expect(SERIALIZED_CONTRACT_KEYS.at(-1)).toBe('tranship');
    expect([...SERIALIZED_TRANSHIP_KEYS]).toEqual(['outVoyageId', 'outArrivalTick', 'outShipId', 'rescueDeadlineTick']);
    const state = new TranshipContract(TRANSHIP).toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_CONTRACT_KEYS]);
    expect(Object.keys(state.tranship ?? {})).toEqual([...SERIALIZED_TRANSHIP_KEYS]);
  });
});

describe('linka kontraktu', () => {
  it('lineForVoyage: striedanie liniek podľa voyage (1 → prvá, 2 → druhá, 3 → tretia, 4 → prvá …), bez Rng', () => {
    const lines = DEFS.lines.items;
    expect([1, 2, 3, 4, 5, 6, 7].map((voyage) => lineForVoyage(lines, voyage))).toEqual([
      'blue_anchor',
      'northern_star',
      'golden_wave',
      'blue_anchor',
      'northern_star',
      'golden_wave',
      'blue_anchor',
    ]);
    expect(lineForVoyage([{ id: 'only' }], 9)).toBe('only');
  });

  it('konštruktor odmietne prázdnu linku', () => {
    expect(() => new ImportContract({ ...BASE, lineId: '' })).toThrow(ContractError);
    expect(() => new ExportContract({ ...BASE, lineId: 3 as never })).toThrow(ContractError);
  });

  it('pool: import aj booking ponuka dostane linku podľa voyage; roundtrip má jednu linku pre oba kontrakty', () => {
    const rng = new Rng(20261004);
    let nextContract = 1;
    let nextVoyage = 1;
    const base = {
      defs: DEFS,
      rng,
      tick: 1,
      ticksPerDay: TICKS_PER_DAY,
      tier: 0,
      capacityHint: 48,
      storageCapacity: 64,
      nextId: () => (nextContract++ as ContractId),
      nextVoyageId: () => (nextVoyage++ as VoyageId),
    };
    for (let i = 0; i < 12; i++) {
      const offer = drawOffer(base);
      expect(offer?.lineId).toBe(lineForVoyage(DEFS.lines.items, offer?.voyageId ?? 0));
    }
    let roundtrips = 0;
    for (let i = 0; i < 60; i++) {
      const group = drawBookingOffer(base);
      expect(group.length).toBeGreaterThan(0);
      for (const contract of group) expect(contract.lineId).toBe(lineForVoyage(DEFS.lines.items, contract.voyageId));
      if (group.length === 2) {
        roundtrips += 1;
        expect(group[0].lineId).toBe(group[1].lineId);
      }
    }
    expect(roundtrips).toBeGreaterThan(0);
  });

  it('pool booking ponúk ťahá len export a roundtrip — šablóny repositioning a tranship sa neponúkajú (svet F6a sa nemení)', () => {
    const rng = new Rng(7);
    let id = 1;
    const kinds = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const contract of drawBookingOffer({
        defs: DEFS,
        rng,
        tick: 1,
        ticksPerDay: TICKS_PER_DAY,
        tier: 9,
        capacityHint: 48,
        storageCapacity: 64,
        nextId: () => (id++ as ContractId),
        nextVoyageId: () => (id++ as VoyageId),
      })) {
        kinds.add(contract.kind);
        expect(contract.templateId).not.toMatch(/repositioning|tranship/);
      }
    }
    expect([...kinds].sort()).toEqual(['export', 'import']);
  });
});

describe('EmptyRepositioningContract', () => {
  it('nový kontrakt: druh, skupina repositioning, booking pohľad s prístavom a počítadlami 0, plán lode B nemá', () => {
    const contract = new EmptyRepositioningContract(BASE);
    expect(contract.kind).toBe('empty_repositioning');
    expect(contract).toBeInstanceOf(ExportContract);
    expect(contract.offerGroup).toBe('repositioning');
    expect(contract.booking).toBe(contract);
    expect(contract.tranship).toBeNull();
    expect([contract.destinationPort, contract.bookedUnits, contract.arrivedUnits, contract.loadedUnits, contract.cutoffTick]).toEqual(['Hamburg', 12, 0, 0, undefined]);
    expect(contract.lineId).toBe('northern_star');
    expect(contract.spawnUnits).toBe(0);
    expect(contract.voyageIds).toEqual([3]);
  });

  it('accept: plán lode ako pri exporte, ale bez cut-off, plánu príchodov a ťahu Rng', () => {
    const contract = new EmptyRepositioningContract(BASE);
    const { rng, calls } = recordingRng();
    contract.accept(context(rng));
    expect([contract.acceptedTick, contract.shipArrivalTick, contract.slaDeadlineTick]).toEqual([100, 20_000, 20_000 + 3 * TICKS_PER_DAY]);
    expect([contract.cutoffTick, contract.arrivalPlan, contract.nextArrivalTick]).toEqual([undefined, [], undefined]);
    expect(calls).toEqual([]);
  });

  it.each(['offered', 'accepted', 'ship_en_route', 'exporting', 'completed', 'failed'] as const)('fromState obnoví kontrakt v stave %s rovnako', (state) => {
    const saved = savedRepositioning(state);
    const restored = Contract.fromState(saved);
    expect(restored).toBeInstanceOf(EmptyRepositioningContract);
    expect(restored.toState()).toEqual(saved);
    expect(JSON.stringify(Contract.fromState(restored.toState()))).toBe(JSON.stringify(restored));
  });

  it.each<[string, (state: SerializedContract) => SerializedContract]>([
    ['bez bookingu', (s) => ({ ...s, booking: null })],
    ['s plánom prekládky', (s) => ({ ...s, tranship: { outVoyageId: 9, outArrivalTick: null, outShipId: null, rescueDeadlineTick: null } })],
    ['s cut-off', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), cutoffTick: 100 } })],
    ['s plánom príchodov', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), arrivalPlan: [200] } })],
    ['s rolled jednotkou', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), arrivedUnits: 3, rolledUnitIds: [4] } })],
    ['s last minute', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), arrivedUnits: 3, loadedUnits: 2, lastMinuteUnits: 1, rolledUnitIds: [4] } })],
    ['s hold', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), arrivedUnits: 3, heldUnits: 1 } })],
    ['naložené > pridelené', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), arrivedUnits: 2, loadedUnits: 3 } })],
  ])('fromState odmietne: repositioning %s', (_name, corrupt) => {
    expect(() => Contract.fromState(corrupt(savedRepositioning('exporting')))).toThrow(ContractError);
  });

  it('háčik ledgera: pridelené prázdne (recordArrival) a naložené na loď (→ on_ship) počíta booking ako export; nepresiahne pridelené', () => {
    const contract = new EmptyRepositioningContract(BASE);
    contract.recordArrival(11 as EntityId, false);
    contract.recordArrival(12 as EntityId, false);
    expect([contract.arrivedUnits, contract.rolledUnits]).toEqual([2, 0]);
    contract.cargoMoved(unit(11, 'empty', CRANE, null), ON_SHIP_A);
    contract.cargoMoved(unit(12, 'empty', CRANE, null), ON_SHIP_A);
    contract.cargoMoved(unit(13, 'empty', CRANE, null), ON_SHIP_A);
    expect([contract.loadedUnits, contract.lastMinuteUnits]).toEqual([2, 0]);
    expect(contract.countersProblem()).toBeUndefined();
  });

  it('polymorfné pravidlá: outbound held až do uzavretia, náklad na palube nie, transitions ako export', () => {
    const contract = new EmptyRepositioningContract(BASE);
    expect([contract.outbound, contract.carriesShipCargo]).toEqual(['held', false]);
    expect(contract.transitions).toBe(EXPORT_CONTRACT_TRANSITIONS);
    contract.transition('accepted', 2);
    contract.transition('ship_en_route', 3);
    expect(() => contract.transition('unloading', 4)).toThrow(ContractError);
    contract.transition('exporting', 4);
    expect(contract.accruesDemurrage).toBe(true);
    contract.transition('completed', 5);
    expect(contract.outbound).toBe('free');
  });
});

/** Uložený repositioning v stave `state` s poliami, ktoré stav vyžaduje (bez cut-off a plánu príchodov). */
function savedRepositioning(state: ContractState): SerializedContract {
  const base = new EmptyRepositioningContract(BASE).toState();
  const traits = CONTRACT_STATE_TRAITS[state];
  const plan = traits.plan === 'required';
  return {
    ...base,
    state,
    acceptedTick: plan ? 100 : null,
    shipArrivalTick: plan ? 20_000 : null,
    slaDeadlineTick: plan ? 45_920 : null,
    shipId: traits.ship === 'required' ? 40 : null,
    dockedTick: traits.docked === 'required' ? 21_000 : null,
    closedTick: traits.terminal ? 30_000 : null,
    booking: {
      destinationPort: 'Hamburg',
      cutoffTick: null,
      arrivalPlan: [],
      arrivedUnits: state === 'completed' || state === 'exporting' ? 10 : 0,
      loadedUnits: state === 'completed' || state === 'exporting' ? 8 : 0,
      lastMinuteUnits: 0,
      rolledUnitIds: [],
      heldUnits: 0,
    },
  };
}

describe('TranshipContract', () => {
  it('nový kontrakt: druh, skupina tranship, plán lode B bez príchodu a lode, voyage A aj B, loď A privezie všetky jednotky', () => {
    const contract = new TranshipContract(TRANSHIP);
    expect(contract.kind).toBe('tranship');
    expect(contract.offerGroup).toBe('tranship');
    expect(contract.tranship).toBe(contract);
    expect([contract.outVoyageId, contract.outArrivalTick, contract.outShipId, contract.rescueDeadlineTick]).toEqual([9, undefined, undefined, undefined]);
    expect(contract.voyageIds).toEqual([4, 9]);
    expect(contract.spawnUnits).toBe(12);
    expect(contract.spawnLabels).toEqual({ direction: 'tranship', voyageId: 4, lineId: 'northern_star', destinationPort: 'Hamburg', weightClass: 'medium' });
    expect(new ImportContract(BASE).spawnLabels).toMatchObject({ direction: 'import', voyageId: 3, lineId: 'northern_star', destinationPort: null });
  });

  it.each([[4], [0], [1.5]])('konštruktor odmietne outVoyageId %s (rovnaká voyage ako loď A alebo neplatné id)', (outVoyageId) => {
    expect(() => new TranshipContract({ ...TRANSHIP, outVoyageId: outVoyageId as VoyageId })).toThrow(ContractError);
  });

  it('accept: jeden ťah rng.range(transhipGapDaysRange); príchod lode B = príchod A + max(1, round(gap × ticksPerDay)); bez cut-off a plánu', () => {
    const contract = new TranshipContract(TRANSHIP);
    const { rng, calls } = recordingRng(1.5);
    contract.accept(context(rng));
    expect(calls).toEqual(['range(1,2)']);
    expect(contract.outArrivalTick).toBe(20_000 + 1.5 * TICKS_PER_DAY);
    expect([contract.cutoffTick, contract.arrivalPlan]).toEqual([undefined, []]);
    expect(contract.slaDeadlineTick).toBe(20_000 + 3 * TICKS_PER_DAY);
    const tiny = new TranshipContract(TRANSHIP);
    tiny.accept(context(recordingRng(0.00001).rng));
    expect(tiny.outArrivalTick).toBe(20_001);
  });

  it('accept so skutočným Rng je deterministický (rovnaký seed = rovnaký príchod lode B) a leží v rozsahu rozstupu', () => {
    const arrivals = [1, 2].map(() => {
      const contract = new TranshipContract(TRANSHIP);
      contract.accept(context(new Rng(99)));
      return contract.outArrivalTick as number;
    });
    expect(arrivals[0]).toBe(arrivals[1]);
    expect(arrivals[0]).toBeGreaterThanOrEqual(20_000 + TICKS_PER_DAY);
    expect(arrivals[0]).toBeLessThanOrEqual(20_000 + 2 * TICKS_PER_DAY);
  });

  it.each(['offered', 'accepted', 'ship_en_route', 'unloading', 'exporting', 'completed', 'failed'] as const)('fromState obnoví prekládku v stave %s rovnako', (state) => {
    const saved = savedTranship(state);
    const restored = Contract.fromState(saved);
    expect(restored).toBeInstanceOf(TranshipContract);
    expect(restored.toState()).toEqual(saved);
    expect(JSON.stringify(Contract.fromState(restored.toState()))).toBe(JSON.stringify(restored));
  });

  it.each<[string, (state: SerializedContract) => SerializedContract]>([
    ['bez plánu lode B', (s) => ({ ...s, tranship: null })],
    ['bez bookingu', (s) => ({ ...s, booking: null })],
    ['outVoyageId = voyage lode A', (s) => ({ ...s, tranship: { ...(s.tranship as NonNullable<typeof s.tranship>), outVoyageId: s.voyageId } })],
    ['príchod lode B pred príchodom lode A', (s) => ({ ...s, tranship: { ...(s.tranship as NonNullable<typeof s.tranship>), outArrivalTick: 19_000 } })],
    ['prijatá bez príchodu lode B', (s) => ({ ...s, tranship: { ...(s.tranship as NonNullable<typeof s.tranship>), outArrivalTick: null } })],
    ['loď B bez príchodu', (s) => ({ ...s, tranship: { ...(s.tranship as NonNullable<typeof s.tranship>), outArrivalTick: null, outShipId: 5 } })],
    ['rescueDeadline bez lode B', (s) => ({ ...s, tranship: { ...(s.tranship as NonNullable<typeof s.tranship>), outShipId: null, rescueDeadlineTick: 50_000 } })],
    ['s cut-off', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), cutoffTick: 100 } })],
    ['vyložené ≠ prijaté', (s) => ({ ...s, unitsUnloaded: 3 })],
    ['exporting bez vyloženého celého objemu', (s) => ({ ...s, booking: { ...(s.booking as NonNullable<typeof s.booking>), arrivedUnits: 4 }, unitsUnloaded: 4 })],
  ])('fromState odmietne: prekládka %s', (_name, corrupt) => {
    expect(() => Contract.fromState(corrupt(savedTranship('exporting')))).toThrow(ContractError);
  });

  it('háčik ledgera: vyloženie z lode A zvýši unitsUnloaded aj arrivedUnits, nakládka na loď B loadedUnits, výjazd kamiónom vrátené; shipped nič', () => {
    const contract = new TranshipContract(TRANSHIP);
    contract.cargoMoved(unit(21, 'tranship', ON_SHIP_A, TRANSHIP.id), CRANE);
    contract.cargoMoved(unit(22, 'tranship', ON_SHIP_A, TRANSHIP.id), { kind: 'in_vehicle', vehicleId: 7 as EntityId });
    contract.cargoMoved(unit(23, 'tranship', ON_SHIP_A, TRANSHIP.id), CRANE);
    expect([contract.unitsUnloaded, contract.arrivedUnits]).toEqual([3, 3]);
    contract.cargoMoved(unit(21, 'tranship', CRANE, TRANSHIP.id), ON_SHIP_B);
    contract.cargoMoved(unit(22, 'tranship', CRANE, TRANSHIP.id), ON_SHIP_B);
    contract.cargoMoved(unit(23, 'tranship', { kind: 'in_truck', truckId: 5 as EntityId }, TRANSHIP.id), EXPORTED);
    expect([contract.loadedUnits, contract.returnedUnits, contract.unitsExported]).toEqual([2, 1, 1]);
    // Odchod lode B: naložené jednotky idú `on_ship → shipped` — nie je to vykládka.
    contract.cargoMoved(unit(21, 'tranship', ON_SHIP_B, TRANSHIP.id), { kind: 'shipped' });
    expect([contract.unitsUnloaded, contract.arrivedUnits, contract.loadedUnits]).toEqual([3, 3, 2]);
    expect(contract.countersProblem()).toBeUndefined();
  });

  it('countersProblem: vyložené nad objem, naložené nad vyložené', () => {
    const over = new TranshipContract(TRANSHIP);
    over.unitsUnloaded = 13;
    over.arrivedUnits = 13;
    expect(over.countersProblem()).toMatch(/nie viac ako 12/);
    const loaded = new TranshipContract(TRANSHIP);
    loaded.unitsUnloaded = 2;
    loaded.arrivedUnits = 2;
    loaded.loadedUnits = 3;
    expect(loaded.countersProblem()).toMatch(/naložené 3/);
  });

  it('polymorfné pravidlá: loď A je náklad kontraktu v ship_en_route a unloading, demurrage v unloading, outbound held až do uzavretia', () => {
    const contract = new TranshipContract(TRANSHIP);
    expect([contract.outbound, contract.carriesShipCargo, contract.accruesDemurrage]).toEqual(['held', false, false]);
    contract.transition('accepted', 2);
    contract.transition('ship_en_route', 3);
    expect(contract.carriesShipCargo).toBe(true);
    contract.transition('unloading', 4);
    expect([contract.carriesShipCargo, contract.accruesDemurrage, contract.outbound]).toEqual([true, true, 'held']);
    contract.transition('exporting', 5);
    expect([contract.carriesShipCargo, contract.accruesDemurrage]).toEqual([false, false]);
    contract.transition('failed', 6);
    expect(contract.outbound).toBe('free');
  });

  it('plán lode B: shipOnVoyage, arrivalOnVoyage a voyageOfShip rozlišujú loď A a loď B', () => {
    const contract = new TranshipContract(TRANSHIP);
    contract.shipId = SHIP;
    contract.shipArrivalTick = 20_000;
    contract.outShipId = SHIP_B;
    contract.outArrivalTick = 30_000;
    expect([contract.shipOnVoyage(4 as VoyageId), contract.shipOnVoyage(9 as VoyageId), contract.shipOnVoyage(1 as VoyageId)]).toEqual([SHIP, SHIP_B, undefined]);
    expect([contract.arrivalOnVoyage(4 as VoyageId), contract.arrivalOnVoyage(9 as VoyageId)]).toEqual([20_000, 30_000]);
    expect([contract.voyageOfShip(SHIP), contract.voyageOfShip(SHIP_B), contract.voyageOfShip(77 as EntityId)]).toEqual([4, 9, undefined]);
  });
});

/** Uložená prekládka v stave `state` s plánom lode B a počítadlami, ktoré stav vyžaduje. */
function savedTranship(state: ContractState): SerializedContract {
  const base = new TranshipContract(TRANSHIP).toState();
  const traits = CONTRACT_STATE_TRAITS[state];
  const plan = traits.plan === 'required';
  const unloaded = state === 'exporting' || state === 'completed' ? 12 : state === 'unloading' ? 5 : 0;
  const loaded = state === 'completed' ? 12 : state === 'exporting' ? 4 : 0;
  return {
    ...base,
    state,
    acceptedTick: plan ? 100 : null,
    shipArrivalTick: plan ? 20_000 : null,
    slaDeadlineTick: plan ? 45_920 : null,
    shipId: traits.ship === 'required' ? 40 : null,
    dockedTick: traits.docked === 'required' ? 21_000 : null,
    closedTick: traits.terminal ? 60_000 : null,
    unitsUnloaded: unloaded,
    booking: {
      destinationPort: 'Hamburg',
      cutoffTick: null,
      arrivalPlan: [],
      arrivedUnits: unloaded,
      loadedUnits: loaded,
      lastMinuteUnits: 0,
      rolledUnitIds: [],
      heldUnits: 0,
    },
    tranship: {
      outVoyageId: 9,
      outArrivalTick: plan ? 30_000 : null,
      outShipId: state === 'exporting' || state === 'completed' ? 41 : null,
      rescueDeadlineTick: null,
    },
  };
}

describe('ContractBook — voyage a skupiny ponúk F6c', () => {
  function harness(): { readonly book: ContractBook; readonly events: SimEvent[] } {
    const events: SimEvent[] = [];
    return { book: new ContractBook({ events: { emit: (event) => events.push(event) }, clock: { tick: 50 } }), events };
  }

  it('prekládka je v indexe pod voyage A aj B; voyage(B) berie loď a príchod z plánu lode B; voyageIdOfShip pozná obe lode', () => {
    const { book } = harness();
    const contract = new TranshipContract(TRANSHIP);
    book.add(contract);
    expect(book.voyageContracts(4 as VoyageId)).toEqual([contract]);
    expect(book.voyageContracts(9 as VoyageId)).toEqual([contract]);
    contract.transition('accepted', 51);
    contract.shipId = SHIP;
    contract.shipArrivalTick = 20_000;
    contract.outShipId = SHIP_B;
    contract.outArrivalTick = 30_000;
    contract.transition('ship_en_route', 52);
    expect(book.voyage(4 as VoyageId)).toMatchObject({ shipId: SHIP, arrivalTick: 20_000, destinationPort: 'Hamburg' });
    expect(book.voyage(9 as VoyageId)).toMatchObject({ shipId: SHIP_B, arrivalTick: 30_000 });
    expect([book.voyageIdOfShip(SHIP), book.voyageIdOfShip(SHIP_B), book.voyageIdOfShip(99 as EntityId)]).toEqual([4, 9, undefined]);
  });

  it('expirovaná ponuka prekládky zmizne z indexu oboch voyage', () => {
    const { book } = harness();
    const contract = new TranshipContract(TRANSHIP);
    book.add(contract);
    book.changeState(contract, 'expired');
    expect(book.voyageContracts(4 as VoyageId)).toEqual([]);
    expect(book.voyageContracts(9 as VoyageId)).toEqual([]);
    expect(book.get(contract.id)).toBeUndefined();
  });

  it('fromState odmietne prekládku s voyage lode B, ktorú kniha nepridelila (nextVoyageId)', () => {
    const { book } = harness();
    book.add(new TranshipContract(TRANSHIP));
    const state = { ...book.getState(), nextContractId: 10 };
    expect(ContractBook.fromState({ events: { emit: () => undefined }, clock: { tick: 50 } }, { ...state, nextVoyageId: 10 }).voyageContracts(9 as VoyageId)).toHaveLength(1);
    expect(() => ContractBook.fromState({ events: { emit: () => undefined }, clock: { tick: 50 } }, { ...state, nextVoyageId: 9 })).toThrow(ContractError);
  });

  it('offeredGroups: import, booking (export aj roundtrip), repositioning (aj v skupine s exportom) a tranship sa počítajú po skupinách voyage', () => {
    const { book } = harness();
    let id = 1;
    const next = (): ContractId => id++ as ContractId;
    const terms = (voyage: number, extra: Partial<ExportContractTerms> = {}): ExportContractTerms => ({ ...BASE, id: next(), voyageId: voyage as VoyageId, ...extra });
    book.add(new ImportContract({ ...terms(1), destinationPort: undefined } as never));
    // roundtrip: import + export jednej voyage
    book.add(new ImportContract(terms(2)));
    book.add(new ExportContract(terms(2)));
    // export + repositioning jednej voyage → skupina repositioning
    book.add(new ExportContract(terms(3)));
    book.add(new EmptyRepositioningContract(terms(3)));
    // samotný repositioning a samotná prekládka
    book.add(new EmptyRepositioningContract(terms(4)));
    book.add(new TranshipContract({ ...terms(5), outVoyageId: 6 as VoyageId }));
    expect(book.offeredGroups()).toEqual({ import: 1, booking: 1, repositioning: 2, tranship: 1 });
    expect(book.offeredOfVoyage(3 as VoyageId).map((contract) => contract.kind)).toEqual(['export', 'empty_repositioning']);
  });
});
