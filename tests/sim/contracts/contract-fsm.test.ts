/**
 * Stavový automat kontraktu a trieda `Contract` (T05-03, ADR-026): tabuľka prechodov podľa rozhodnutia 4, vlastnosti
 * stavov, `transition` (povolené/nepovolené, `closedTick`), `toState` ↔ `fromState` a kontrola súladu polí so stavom.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_STATES,
  CONTRACT_STATE_TRAITS,
  CONTRACT_TRANSITIONS,
  Contract,
  ContractError,
  ImportContract,
  SERIALIZED_CONTRACT_KEYS,
  isContractState,
  isContractTransitionAllowed,
  type ContractState,
  type ContractTerms,
  type SerializedContract,
} from '@sim/contracts';
import type { ContractId, VoyageId } from '@sim/core';

const TERMS: ContractTerms = {
  id: 7 as ContractId,
  voyageId: 7 as VoyageId,
  templateId: 'container_feeder_express',
  cargoTypeId: 'container_teu',
  volumeUnits: 12,
  slaDays: 2,
  rewardCents: 783_000,
  xpReward: 12,
  offeredTick: 1,
  offerExpiresTick: 17_281,
  shipClassId: 'feeder',
};

/** Kontrakt uložený v danom stave s poliami, ktoré stav vyžaduje. */
function saved(state: ContractState, overrides: Partial<SerializedContract> = {}): SerializedContract {
  const base = new ImportContract(TERMS).toState();
  const traits = CONTRACT_STATE_TRAITS[state];
  const plan = traits.plan === 'required';
  return {
    ...base,
    state,
    acceptedTick: plan ? 100 : null,
    shipArrivalTick: plan ? 8_740 : null,
    slaDeadlineTick: plan ? 26_020 : null,
    shipId: traits.ship === 'required' ? 40 : null,
    dockedTick: traits.docked === 'required' ? 9_000 : null,
    closedTick: traits.terminal ? 12_000 : null,
    unitsUnloaded: state === 'exporting' || state === 'completed' ? 12 : 0,
    unitsExported: state === 'completed' ? 12 : 0,
    ...overrides,
  };
}

describe('CONTRACT_TRANSITIONS (rozhodnutie 4)', () => {
  it('hlavná vetva, odbočky failed a expired; completed, failed a expired sú konečné', () => {
    expect(CONTRACT_TRANSITIONS).toEqual({
      offered: ['accepted', 'expired'],
      accepted: ['ship_en_route'],
      ship_en_route: ['unloading', 'failed'],
      unloading: ['exporting', 'failed'],
      exporting: ['completed', 'failed'],
      completed: [],
      failed: [],
      expired: [],
    });
    expect(Object.keys(CONTRACT_TRANSITIONS)).toEqual([...CONTRACT_STATES]);
  });

  it('isContractTransitionAllowed a isContractState', () => {
    expect(isContractTransitionAllowed('offered', 'accepted')).toBe(true);
    expect(isContractTransitionAllowed('offered', 'completed')).toBe(false);
    expect(isContractTransitionAllowed('accepted', 'failed')).toBe(false);
    expect(isContractState('exporting')).toBe(true);
    expect(isContractState('declined')).toBe(false);
    expect(isContractState(3)).toBe(false);
  });

  it('vlastnosti stavov: konečný = bez prechodov, ponuka len offered, SLA beží len medzi loďou a koncom, demurrage len pri vykládke', () => {
    for (const state of CONTRACT_STATES) {
      const traits = CONTRACT_STATE_TRAITS[state];
      expect(traits.terminal, state).toBe(CONTRACT_TRANSITIONS[state].length === 0);
      expect(traits.offer, state).toBe(state === 'offered');
      expect(traits.slaRunning, state).toBe(['ship_en_route', 'unloading', 'exporting'].includes(state));
      expect(traits.demurrage, state).toBe(state === 'unloading');
      // každý stav s bežiacim SLA môže zlyhať
      if (traits.slaRunning) expect(CONTRACT_TRANSITIONS[state]).toContain('failed');
    }
  });
});

describe('Contract', () => {
  it('nová ponuka: offered, voliteľné polia undefined, počítadlá 0', () => {
    const contract = new ImportContract(TERMS);
    expect(contract.state).toBe('offered');
    expect([contract.acceptedTick, contract.shipArrivalTick, contract.slaDeadlineTick, contract.shipId, contract.dockedTick, contract.closedTick]).toEqual(
      Array<undefined>(6).fill(undefined),
    );
    expect([contract.unitsUnloaded, contract.unitsExported, contract.penaltiesCents, contract.demurrageHours, contract.lateDays]).toEqual([0, 0, 0, 0, 0]);
  });

  it.each([
    ['id 0', { id: 0 as ContractId }],
    ['voyage 0', { voyageId: 0 as VoyageId }],
    ['objem 0', { volumeUnits: 0 }],
    ['objem 1,5', { volumeUnits: 1.5 }],
    ['SLA 0', { slaDays: 0 }],
    ['odmena 0', { rewardCents: 0 }],
    ['záporné XP', { xpReward: -1 }],
    ['expirácia pred vznikom', { offerExpiresTick: 1 }],
  ])('neplatné podmienky (%s) → ContractError invalid_input', (_label, overrides) => {
    expect(() => new ImportContract({ ...TERMS, ...overrides })).toThrow(ContractError);
  });

  it('transition: povolený prechod mení stav, konečný zapíše closedTick; nepovolený vyhodí bez zmeny', () => {
    const contract = new ImportContract(TERMS);
    expect(() => contract.transition('completed', 5)).toThrow(/offered → completed/);
    expect(contract.state).toBe('offered');
    contract.transition('accepted', 5);
    expect([contract.state, contract.closedTick]).toEqual(['accepted', undefined]);
    const offer = new ImportContract(TERMS);
    offer.transition('expired', 9);
    expect([offer.state, offer.closedTick]).toEqual(['expired', 9]);
  });

  it('toState má kľúče SERIALIZED_CONTRACT_KEYS v poradí, nenastavené polia sú null a fromState ho obnoví rovnako', () => {
    const state = saved('unloading', { unitsUnloaded: 5, penaltiesCents: 2_700, demurrageHours: 1 });
    expect(Object.keys(state)).toEqual([...SERIALIZED_CONTRACT_KEYS]);
    const restored = Contract.fromState(state);
    expect(restored.toState()).toEqual(state);
    expect(restored.state).toBe('unloading');
    const offer = new ImportContract(TERMS);
    expect(JSON.stringify(Contract.fromState(offer.toState()))).toBe(JSON.stringify(offer));
  });

  it.each(CONTRACT_STATES.filter((state) => state !== 'expired'))('fromState prijme konzistentný stav %s', (state) => {
    expect(Contract.fromState(saved(state)).state).toBe(state);
  });

  it.each<[string, SerializedContract]>([
    ['ponuka s plánom', saved('offered', { acceptedTick: 5 })],
    ['prijatý bez plánu', saved('accepted', { shipArrivalTick: null })],
    ['prijatý s loďou', saved('accepted', { shipId: 40 })],
    ['na ceste bez lode', saved('ship_en_route', { shipId: null })],
    ['vykládka bez začiatku státia', saved('unloading', { dockedTick: null })],
    ['prebiehajúci s closedTick', saved('exporting', { closedTick: 3 })],
    ['dokončený bez closedTick', saved('completed', { closedTick: null })],
    ['príchod pred prijatím', saved('accepted', { shipArrivalTick: 50 })],
    ['exported > unloaded', saved('unloading', { unitsUnloaded: 2, unitsExported: 3 })],
    ['unloaded > objem', saved('unloading', { unitsUnloaded: 13 })],
    ['exporting bez celého objemu', saved('exporting', { unitsUnloaded: 11 })],
    ['completed bez celého exportu', saved('completed', { unitsExported: 11 })],
    ['záporné penalizácie', saved('unloading', { penaltiesCents: -1 })],
  ])('fromState odmietne nekonzistentný kontrakt: %s', (_label, state) => {
    expect(() => Contract.fromState(state)).toThrow(ContractError);
  });

  it('zlyhaný kontrakt môže, ale nemusí mať začiatok státia (zlyhal na ceste alebo pri vykládke)', () => {
    expect(Contract.fromState(saved('failed', { dockedTick: null })).dockedTick).toBeUndefined();
    expect(Contract.fromState(saved('failed', { dockedTick: 9_000 })).dockedTick).toBe(9_000);
  });
});
