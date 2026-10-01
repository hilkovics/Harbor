/**
 * `ContractBook` (T05-03, ADR-026): vlastná postupnosť id, poradie, prechody s `ContractStateChanged`, zabudnutie
 * expirovaných, háčik ledgera pre počítadlá jednotiek, XP, tier a stav pre save.
 */
import { describe, expect, it } from 'vitest';
import { ContractBook, ContractError, ImportContract, type Contract, type ContractTerms } from '@sim/contracts';
import { IMPORT_LABELS, type CargoLocation, type CargoUnit } from '@sim/cargo';
import type { ContractId, EntityId, VoyageId } from '@sim/core';
import type { SimEvent } from '@sim/events';

function harness(tick = 10): { readonly book: ContractBook; readonly events: SimEvent[]; readonly clock: { tick: number } } {
  const events: SimEvent[] = [];
  const clock = { tick };
  return { book: new ContractBook({ events: { emit: (event) => events.push(event) }, clock }), events, clock };
}

function terms(id: number, volumeUnits = 3, voyageId = id): ContractTerms {
  return {
    id: id as ContractId,
    voyageId: voyageId as VoyageId,
    templateId: 'container_feeder_express',
    cargoTypeId: 'container_teu',
    volumeUnits,
    slaDays: 2,
    rewardCents: 100_000,
    xpReward: volumeUnits,
    offeredTick: 1,
    offerExpiresTick: 17_281,
    shipClassId: 'feeder',
  };
}

const SHIP = 50 as EntityId;
function unit(contractId: number | null, location: CargoLocation = { kind: 'on_ship', shipId: SHIP }): CargoUnit {
  return { id: 99 as EntityId, typeId: 'container_teu', contractId: contractId as ContractId | null, ...IMPORT_LABELS, hold: null, quantity: 1, location };
}

describe('ContractBook: id a poradie', () => {
  it('allocateId dáva 1, 2, 3 … nezávisle od world.ids; add vyžaduje rastúce id a jedinečnosť', () => {
    const { book } = harness();
    expect([book.allocateId(), book.allocateId()]).toEqual([1, 2]);
    book.add(new ImportContract(terms(1)));
    book.add(new ImportContract(terms(2)));
    expect(() => book.add(new ImportContract(terms(2)))).toThrow(ContractError);
    expect(() => book.add(new ImportContract(terms(1)))).toThrow(ContractError);
    expect([...book.contracts.keys()]).toEqual([1, 2]);
    expect(book.getState().nextContractId).toBe(3);
  });

  it('offeredCount, openContracts a get', () => {
    const { book } = harness();
    for (const id of [1, 2, 3]) book.add(new ImportContract(terms(id)));
    expect(book.offeredCount).toBe(3);
    expect(book.get(2 as ContractId)?.id).toBe(2);
    expect(book.get(9 as ContractId)).toBeUndefined();
  });
});

describe('ContractBook: prechody', () => {
  it('changeState emituje ContractStateChanged a expirovaný kontrakt zabudne (aj z prebiehajúcich)', () => {
    const { book, events } = harness(42);
    const offer = new ImportContract(terms(1));
    book.add(offer);
    book.changeState(offer, 'expired');
    expect(events).toEqual([{ type: 'ContractStateChanged', contractId: 1, from: 'offered', to: 'expired' }]);
    expect(book.contracts.size).toBe(0);
    expect(book.openContracts.size).toBe(0);
    expect(offer.closedTick).toBe(42);
    // id sa ďalej nepoužije znova
    expect(() => book.add(new ImportContract(terms(1)))).toThrow(ContractError);
  });

  it('kontrakt mimo knihy alebo nepovolený prechod → ContractError bez udalosti', () => {
    const { book, events } = harness();
    const stranger = new ImportContract(terms(5));
    expect(() => book.changeState(stranger, 'accepted')).toThrow(ContractError);
    const offer = new ImportContract(terms(6));
    book.add(offer);
    expect(() => book.changeState(offer, 'exporting')).toThrow(ContractError);
    expect(events).toEqual([]);
    expect(offer.state).toBe('offered');
  });

  it('recordCompletion: XP a počet dokončených, tier = ⌊completed / contractsPerTier⌋; neplatné XP → chyba', () => {
    const { book } = harness();
    for (let i = 0; i < 10; i++) book.recordCompletion(6);
    expect([book.xp, book.completedContracts, book.tier(10), book.tier(3)]).toEqual([60, 10, 1, 3]);
    expect(() => book.recordCompletion(-1)).toThrow(ContractError);
    expect(() => book.recordCompletion(1.5)).toThrow(ContractError);
  });
});

describe('ContractBook: háčik ledgera (cargoMoved)', () => {
  it('opustenie lode zvýši unitsUnloaded, export unitsExported; jednotka bez kontraktu alebo s neznámym kontraktom sa ignoruje', () => {
    const { book } = harness();
    const contract = new ImportContract(terms(1, 2));
    book.add(contract);
    book.cargoMoved(unit(1), { kind: 'in_crane', craneId: 2 as EntityId });
    book.cargoMoved(unit(1, { kind: 'in_crane', craneId: 2 as EntityId }), { kind: 'on_apron', berthId: 1 as EntityId, slot: 0 });
    expect([contract.unitsUnloaded, contract.unitsExported]).toEqual([1, 0]);
    book.cargoMoved(unit(1, { kind: 'in_truck', truckId: 3 as EntityId }), { kind: 'exported' });
    expect([contract.unitsUnloaded, contract.unitsExported]).toEqual([1, 1]);
    book.cargoMoved(unit(null), { kind: 'in_crane', craneId: 2 as EntityId });
    book.cargoMoved(unit(77), { kind: 'in_crane', craneId: 2 as EntityId });
    expect([contract.unitsUnloaded, contract.unitsExported]).toEqual([1, 1]);
  });

  it('počítadlá nepresiahnu objem ani vyložené (háčik nesmie vyhodiť)', () => {
    const { book } = harness();
    const contract = new ImportContract(terms(1, 1));
    book.add(contract);
    for (let i = 0; i < 3; i++) book.cargoMoved(unit(1), { kind: 'in_crane', craneId: 2 as EntityId });
    for (let i = 0; i < 3; i++) book.cargoMoved(unit(1, { kind: 'in_truck', truckId: 3 as EntityId }), { kind: 'exported' });
    expect([contract.unitsUnloaded, contract.unitsExported]).toEqual([1, 1]);
  });
});

describe('ContractBook: stav pre save', () => {
  it('getState → fromState dá rovnakú knihu (kontrakty, XP, dokončené, ďalšie id)', () => {
    const { book } = harness();
    for (const id of [book.allocateId(), book.allocateId(), book.allocateId()]) book.add(new ImportContract(terms(id, 3, book.allocateVoyageId())));
    book.changeState(book.get(1 as ContractId) as Contract, 'expired');
    book.recordCompletion(4);
    const state = JSON.parse(JSON.stringify(book.getState())) as ReturnType<ContractBook['getState']>;
    expect(state.contracts.map((contract) => contract.id)).toEqual([2, 3]);
    const restored = ContractBook.fromState({ events: { emit: () => undefined }, clock: { tick: 0 } }, state);
    expect(restored.getState()).toEqual(state);
    expect(restored.allocateId()).toBe(4);
    expect(restored.allocateVoyageId()).toBe(4);
  });

  it('fromState odmietne kontrakt s id ≥ nextContractId', () => {
    const { book } = harness();
    book.add(new ImportContract(terms(book.allocateId(), 3, book.allocateVoyageId())));
    const state = { ...book.getState(), nextContractId: 1 };
    expect(() => ContractBook.fromState({ events: { emit: () => undefined }, clock: { tick: 0 } }, state)).toThrow(ContractError);
  });

  it('fromState odmietne kontrakt s voyage ≥ nextVoyageId (ADR-032)', () => {
    const { book } = harness();
    book.add(new ImportContract(terms(book.allocateId(), 3, book.allocateVoyageId())));
    const state = { ...book.getState(), nextVoyageId: 1 };
    expect(() => ContractBook.fromState({ events: { emit: () => undefined }, clock: { tick: 0 } }, state)).toThrow(/nextVoyageId/);
  });
});
