// Kontrakty (ARCHITECTURE §9.1, ADR-026): stavový automat, kontrakt, kniha kontraktov, vzorce a pool ponúk.
export {
  CONTRACT_KINDS,
  CONTRACT_STATES,
  CONTRACT_STATE_TRAITS,
  CONTRACT_TRANSITIONS,
  CONTRACT_TRANSITIONS_BY_KIND,
  EXPORT_CONTRACT_TRANSITIONS,
  isContractKind,
  isContractState,
  isContractTransitionAllowed,
} from './contract-fsm';
export type { ContractKind, ContractOutbound, ContractState, ContractStateTraits, ContractTransitions, FieldPresence } from './contract-fsm';
export { Contract, ExportContract, ImportContract, SERIALIZED_BOOKING_KEYS, SERIALIZED_CONTRACT_KEYS } from './contract';
export type { AcceptContext, ContractTerms, ExportBooking, ExportContractTerms, SerializedBooking, SerializedContract } from './contract';
export { ContractBook } from './contract-book';
export type { ContractBookEnv, ContractBookState, OfferedGroups, VoyageView } from './contract-book';
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
export { TEMPLATE_GROUP_KINDS, capacityHintFrom, capacityHintOf, drawBookingOffer, drawOffer, eligibleTemplates, offerVolumeUnits, portCapacityOf } from './contract-pool';
export type { OfferContext, PortCapacity, TemplateGroup } from './contract-pool';
