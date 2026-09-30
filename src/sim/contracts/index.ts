// Kontrakty (ARCHITECTURE §9.1, ADR-026): stavový automat, kontrakt, kniha kontraktov, vzorce a pool ponúk.
export { CONTRACT_STATES, CONTRACT_STATE_TRAITS, CONTRACT_TRANSITIONS, isContractState, isContractTransitionAllowed } from './contract-fsm';
export type { ContractOutbound, ContractState, ContractStateTraits, FieldPresence } from './contract-fsm';
export { Contract, SERIALIZED_CONTRACT_KEYS } from './contract';
export type { ContractTerms, SerializedContract } from './contract';
export { ContractBook } from './contract-book';
export type { ContractBookEnv, ContractBookState } from './contract-book';
export { ContractError } from './contract-error';
export type { ContractErrorCode } from './contract-error';
export {
  contractRewardCents,
  contractXpGain,
  contractXpReward,
  demurrageStepCents,
  lateStepCents,
  maxSlaDaysOf,
  offerClosingTick,
  urgencyBp,
  wholePeriods,
} from './contract-terms';
export { capacityHintFrom, capacityHintOf, drawOffer, eligibleTemplates, offerVolumeUnits, portCapacityOf } from './contract-pool';
export type { OfferContext, PortCapacity } from './contract-pool';
