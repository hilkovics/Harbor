/**
 * Export booking a voyage (T6A-01, ADR-032 body 1, 6, 13): tabuľka prechodov exportu, trieda `ExportContract`
 * (booking časť save, počítadlá z háčika ledgera, `recordArrival`, polymorfné `outbound` / `carriesShipCargo` /
 * `accruesDemurrage`), obnova podľa druhu (`Contract.fromState`) a voyage v knihe (vlastná postupnosť, index, pohľad).
 */
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_KINDS,
  CONTRACT_STATES,
  CONTRACT_STATE_TRAITS,
  CONTRACT_TRANSITIONS,
  CONTRACT_TRANSITIONS_BY_KIND,
  Contract,
  ContractBook,
  ContractError,
  EXPORT_CONTRACT_TRANSITIONS,
  ExportContract,
  ImportContract,
  SERIALIZED_BOOKING_KEYS,
  SERIALIZED_CONTRACT_KEYS,
  isContractTransitionAllowed,
  type ContractState,
  type ContractTerms,
  type ExportContractTerms,
  type SerializedBooking,
  type SerializedContract,
} from '@sim/contracts';
import type { CargoLocation, CargoUnit } from '@sim/cargo';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import type { SimEvent } from '@sim/events';

const IMPORT_TERMS: ContractTerms = {
  id: 3 as ContractId,
  voyageId: 2 as VoyageId,
  templateId: 'container_feeder_standard',
  cargoTypeId: 'container_teu',
  volumeUnits: 20,
  slaDays: 3,
  rewardCents: 1_000_000,
  xpReward: 20,
  offeredTick: 1,
  offerExpiresTick: 17_281,
  shipClassId: 'feeder',
};
const EXPORT_TERMS: ExportContractTerms = { ...IMPORT_TERMS, id: 4 as ContractId, volumeUnits: 6, rewardCents: 300_000, xpReward: 6, destinationPort: 'Rotterdam' };

const SHIP = 40 as EntityId;
const unit = (unitId: number, location: CargoLocation): CargoUnit => ({
  id: unitId as EntityId,
  typeId: 'container_teu',
  contractId: EXPORT_TERMS.id,
  voyageId: EXPORT_TERMS.voyageId,
  direction: 'export',
  destinationPort: 'Rotterdam',
  weightClass: 'medium',
  hold: null,
  quantity: 1,
  location,
});
const CRANE: CargoLocation = { kind: 'in_crane', craneId: 30 as EntityId };
const ON_SHIP: CargoLocation = { kind: 'on_ship', shipId: SHIP };
const IN_TRUCK: CargoLocation = { kind: 'in_truck', truckId: 60 as EntityId };
const EXPORTED: CargoLocation = { kind: 'exported' };

/** Uložený export booking v stave `state` s poliami, ktoré stav vyžaduje. */
function savedExport(state: ContractState, booking: Partial<SerializedBooking> = {}, overrides: Partial<SerializedContract> = {}): SerializedContract {
  const base = new ExportContract(EXPORT_TERMS).toState();
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
    ...overrides,
    booking: {
      destinationPort: 'Rotterdam',
      cutoffTick: plan ? 15_680 : null,
      arrivalPlan: state === 'accepted' ? [3_000, 9_000] : [],
      arrivedUnits: plan ? 4 : 0,
      loadedUnits: state === 'completed' || state === 'exporting' ? 2 : 0,
      lastMinuteUnits: 0,
      rolledUnitIds: [],
      heldUnits: 0,
      ...booking,
    },
  };
}

describe('druhy kontraktu a prechody exportu (ADR-032 bod 1)', () => {
  it('druhy import/export; import tabuľka sa nezmenila, export: ship_en_route → exporting (nakládka) | failed, bez unloading', () => {
    expect(CONTRACT_KINDS).toEqual(['import', 'export']);
    expect(CONTRACT_TRANSITIONS_BY_KIND.import).toBe(CONTRACT_TRANSITIONS);
    expect(CONTRACT_TRANSITIONS_BY_KIND.export).toBe(EXPORT_CONTRACT_TRANSITIONS);
    expect(EXPORT_CONTRACT_TRANSITIONS).toEqual({
      offered: ['accepted', 'expired'],
      accepted: ['ship_en_route'],
      ship_en_route: ['exporting', 'failed'],
      unloading: [],
      exporting: ['completed', 'failed'],
      completed: [],
      failed: [],
      expired: [],
    });
    expect(isContractTransitionAllowed('ship_en_route', 'exporting', 'export')).toBe(true);
    expect(isContractTransitionAllowed('ship_en_route', 'exporting')).toBe(false);
    expect(isContractTransitionAllowed('ship_en_route', 'unloading', 'export')).toBe(false);
    for (const state of CONTRACT_STATES) {
      // konečné stavy sú konečné v oboch druhoch; stavy s bežiacim SLA smú zlyhať aj pri exporte (okrem nepoužitého unloading)
      if (CONTRACT_STATE_TRAITS[state].terminal) expect(EXPORT_CONTRACT_TRANSITIONS[state], state).toEqual([]);
      if (CONTRACT_STATE_TRAITS[state].slaRunning && state !== 'unloading') expect(EXPORT_CONTRACT_TRANSITIONS[state], state).toContain('failed');
    }
  });

  it('ExportContract.transition ide po tabuľke exportu; import nie', () => {
    const booking = new ExportContract(EXPORT_TERMS);
    booking.transition('accepted', 5);
    booking.transition('ship_en_route', 6);
    expect(() => booking.transition('unloading', 7)).toThrow(/ship_en_route → unloading/);
    booking.transition('exporting', 7);
    booking.transition('completed', 8);
    expect([booking.state, booking.closedTick]).toEqual(['completed', 8]);
    const imported = new ImportContract(IMPORT_TERMS);
    imported.transition('accepted', 5);
    imported.transition('ship_en_route', 6);
    expect(() => imported.transition('exporting', 7)).toThrow(ContractError);
  });
});

describe('ExportContract', () => {
  it('nový booking: offered, bez cut-off a plánu, počítadlá 0, booking pohľad = kontrakt', () => {
    const booking = new ExportContract(EXPORT_TERMS);
    expect(booking.kind).toBe('export');
    expect(booking.booking).toBe(booking);
    expect([booking.destinationPort, booking.cutoffTick, booking.bookedUnits, booking.arrivalPlan]).toEqual(['Rotterdam', undefined, 6, []]);
    expect([booking.arrivedUnits, booking.loadedUnits, booking.lastMinuteUnits, booking.rolledUnits, booking.returnedUnits, booking.heldUnits]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(new ImportContract(IMPORT_TERMS).booking).toBeNull();
    expect(() => new ExportContract({ ...EXPORT_TERMS, destinationPort: '' })).toThrow(ContractError);
  });

  it('toState: kľúče v poradí, kind a voyage, booking s kľúčmi SERIALIZED_BOOKING_KEYS; import má booking null', () => {
    const state = new ExportContract(EXPORT_TERMS).toState();
    expect(Object.keys(state)).toEqual([...SERIALIZED_CONTRACT_KEYS]);
    expect([state.kind, state.voyageId]).toEqual(['export', 2]);
    expect(Object.keys(state.booking ?? {})).toEqual([...SERIALIZED_BOOKING_KEYS]);
    expect(state.booking).toEqual({ destinationPort: 'Rotterdam', cutoffTick: null, arrivalPlan: [], arrivedUnits: 0, loadedUnits: 0, lastMinuteUnits: 0, rolledUnitIds: [], heldUnits: 0 });
    const imported = new ImportContract(IMPORT_TERMS).toState();
    expect([imported.kind, imported.voyageId, imported.booking]).toEqual(['import', 2, null]);
  });

  it.each(CONTRACT_STATES.filter((state) => state !== 'expired' && state !== 'unloading'))('fromState obnoví booking v stave %s rovnako (aj JSON tvar inštancie)', (state) => {
    const arrived = CONTRACT_STATE_TRAITS[state].plan === 'required';
    const saved = savedExport(state, { rolledUnitIds: arrived ? [11, 14] : [], lastMinuteUnits: state === 'completed' || state === 'exporting' ? 1 : 0 });
    const restored = Contract.fromState(saved);
    expect(restored).toBeInstanceOf(ExportContract);
    expect(restored.toState()).toEqual(saved);
    expect(JSON.stringify(Contract.fromState(restored.toState()))).toBe(JSON.stringify(restored));
  });

  it.each<[string, SerializedContract]>([
    ['export bez bookingu', { ...savedExport('accepted'), booking: null }],
    ['import s bookingom', { ...new ImportContract(IMPORT_TERMS).toState(), booking: savedExport('offered').booking }],
    ['neznámy druh', { ...savedExport('offered'), kind: 'tranship' as 'export' }],
    ['stav, ktorý export nepozná (unloading)', savedExport('unloading')],
    ['ponuka s cut-off', savedExport('offered', { cutoffTick: 50 })],
    ['ponuka s plánom príchodov', savedExport('offered', { arrivalPlan: [5] })],
    ['prijatý bez cut-off', savedExport('accepted', { cutoffTick: null })],
    ['cut-off po príchode lode', savedExport('accepted', { cutoffTick: 20_000 })],
    ['plán príchodov klesá', savedExport('accepted', { arrivalPlan: [9_000, 3_000] })],
    ['rolled id neusporiadané', savedExport('exporting', { rolledUnitIds: [14, 11] })],
    ['prijaté + plán > booked', savedExport('accepted', { arrivedUnits: 5 })],
    ['naložené + vrátené > prijaté', savedExport('exporting', { loadedUnits: 5 })],
    ['last minute > naložené', savedExport('exporting', { lastMinuteUnits: 3, rolledUnitIds: [1, 2, 3] })],
    ['last minute bez rolled', savedExport('exporting', { lastMinuteUnits: 1 })],
    ['hold > jednotky na termináli', savedExport('exporting', { heldUnits: 3 })],
    ['completed bez nakládky', savedExport('completed', { loadedUnits: 0 })],
    ['unitsUnloaded pri exporte', savedExport('exporting', {}, { unitsUnloaded: 1 })],
  ])('fromState odmietne nekonzistentný booking: %s', (_label, state) => {
    expect(() => Contract.fromState(state)).toThrow(ContractError);
  });

  it('háčik ledgera: in_crane → on_ship = naložená (rolled aj last minute), → exported = vrátená; nepresiahne prijaté', () => {
    const booking = new ExportContract(EXPORT_TERMS);
    booking.recordArrival(11 as EntityId, false);
    booking.recordArrival(13 as EntityId, true);
    booking.recordArrival(12 as EntityId, true);
    expect(booking.rolledUnitIds).toEqual([12, 13]);
    expect([booking.arrivedUnits, booking.rolledUnits]).toEqual([3, 2]);
    booking.cargoMoved(unit(11, CRANE), ON_SHIP);
    booking.cargoMoved(unit(13, CRANE), ON_SHIP);
    booking.cargoMoved(unit(12, IN_TRUCK), EXPORTED);
    expect([booking.loadedUnits, booking.lastMinuteUnits, booking.returnedUnits, booking.unitsExported]).toEqual([2, 1, 1, 1]);
    booking.cargoMoved(unit(14, CRANE), ON_SHIP);
    booking.cargoMoved(unit(15, IN_TRUCK), EXPORTED);
    expect([booking.loadedUnits, booking.returnedUnits]).toEqual([2, 1]);
    expect(booking.countersProblem()).toBeUndefined();
    expect(booking.unitsUnloaded).toBe(0);
  });

  it('polymorfné pravidlá: outbound (held až do uzavretia, potom free), náklad na palube, demurrage v exporting', () => {
    const booking = new ExportContract(EXPORT_TERMS);
    const imported = new ImportContract(IMPORT_TERMS);
    expect([booking.outbound, imported.outbound]).toEqual(['held', 'held']);
    for (const contract of [booking, imported]) {
      contract.transition('accepted', 2);
      contract.transition('ship_en_route', 3);
    }
    expect([booking.carriesShipCargo, imported.carriesShipCargo]).toEqual([false, true]);
    booking.transition('exporting', 4);
    imported.transition('unloading', 4);
    expect([booking.outbound, imported.outbound]).toEqual(['held', 'sla']);
    expect([booking.accruesDemurrage, imported.accruesDemurrage]).toEqual([true, true]);
    imported.transition('exporting', 5);
    expect([imported.accruesDemurrage, imported.carriesShipCargo]).toEqual([false, false]);
    booking.transition('failed', 6);
    expect(booking.outbound).toBe('free');
  });
});

describe('ContractBook: voyage (ADR-032)', () => {
  function harness(): { readonly book: ContractBook; readonly events: SimEvent[] } {
    const events: SimEvent[] = [];
    return { book: new ContractBook({ events: { emit: (event) => events.push(event) }, clock: { tick: 10 } }), events };
  }

  it('allocateVoyageId 1, 2, 3 … nezávisle od id kontraktov; getState nesie nextVoyageId', () => {
    const { book } = harness();
    expect([book.allocateVoyageId(), book.allocateVoyageId(), book.allocateId()]).toEqual([1, 2, 1]);
    expect(book.getState()).toMatchObject({ nextContractId: 2, nextVoyageId: 3 });
  });

  it('index voyage → kontrakty vzostupne podľa id; voyage() skladá pohľad; expirovaný kontrakt z indexu zmizne', () => {
    const { book } = harness();
    const imported = new ImportContract(IMPORT_TERMS);
    const booking = new ExportContract(EXPORT_TERMS);
    const other = new ImportContract({ ...IMPORT_TERMS, id: 5 as ContractId, voyageId: 9 as VoyageId });
    book.add(imported);
    book.add(booking);
    book.add(other);
    expect(book.voyageContracts(2 as VoyageId)).toEqual([imported, booking]);
    expect(book.voyageContracts(77 as VoyageId)).toEqual([]);
    for (const contract of [imported, booking]) {
      contract.acceptedTick = 10;
      contract.shipArrivalTick = 20_000;
      contract.shipId = SHIP;
    }
    booking.cutoffTick = 15_680;
    expect(book.voyage(2 as VoyageId)).toEqual({
      id: 2,
      contracts: [imported, booking],
      shipClassId: 'feeder',
      arrivalTick: 20_000,
      shipId: SHIP,
      destinationPort: 'Rotterdam',
      cutoffTick: 15_680,
    });
    expect(book.voyage(9 as VoyageId)).toMatchObject({ destinationPort: null, cutoffTick: undefined, shipId: undefined });
    expect(book.voyageIdOfShip(SHIP)).toBe(2);
    expect(book.voyageIdOfShip(41 as EntityId)).toBeUndefined();
    book.changeState(other, 'expired');
    expect(book.voyage(9 as VoyageId)).toBeUndefined();
    expect(book.voyageContracts(9 as VoyageId)).toEqual([]);
  });

  it('háčik ledgera odovzdá jednotku jej kontraktu podľa druhu', () => {
    const { book } = harness();
    const booking = new ExportContract(EXPORT_TERMS);
    book.add(booking);
    booking.recordArrival(11 as EntityId, false);
    book.cargoMoved(unit(11, CRANE), ON_SHIP);
    expect(booking.loadedUnits).toBe(1);
  });
});
