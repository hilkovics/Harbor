// Kontrakty (ARCHITECTURE §9.1, ADR-026): stavový automat, kontrakt, kniha kontraktov, vzorce a pool ponúk.
export {
  CONTRACT_KINDS,
  CONTRACT_KIND_TRAITS,
  CONTRACT_STATES,
  CONTRACT_STATE_TRAITS,
  CONTRACT_TRANSITIONS,
  CONTRACT_TRANSITIONS_BY_KIND,
  EXPORT_CONTRACT_TRANSITIONS,
  isContractKind,
  isContractState,
  isContractTransitionAllowed,
  OFFER_GROUPS,
} from './contract-fsm';
export type { ContractKind, ContractKindTraits, ContractOutbound, ContractState, ContractStateTraits, ContractTransitions, FieldPresence, OfferGroup } from './contract-fsm';
export {
  Contract,
  EmptyRepositioningContract,
  ExportContract,
  ImportContract,
  SERIALIZED_BOOKING_KEYS,
  SERIALIZED_CONTRACT_KEYS,
  SERIALIZED_TRANSHIP_KEYS,
  TranshipContract,
} from './contract';
export type {
  AcceptContext,
  ContractTerms,
  ExportBooking,
  ExportContractTerms,
  SerializedBooking,
  SerializedContract,
  SerializedTranship,
  TranshipContractTerms,
  TranshipLeg,
} from './contract';
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
  lineForVoyage,
  maxSlaDaysOf,
  offerClosingTick,
  urgencyBp,
  wholePeriods,
} from './contract-terms';
export { TEMPLATE_GROUP_KINDS, capacityHintFrom, capacityHintOf, drawBookingOffer, drawOffer, eligibleTemplates, offerVolumeUnits, portCapacityOf } from './contract-pool';
export type { OfferContext, PortCapacity, TemplateGroup } from './contract-pool';
