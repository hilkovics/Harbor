// Náklad (ARCHITECTURE §7.1): CargoUnit, CargoLocation + tabuľka prechodov, CargoLedger, invariant konzervácie.
export {
  CARGO_HOLDER_KINDS,
  CARGO_HOLDER_SPECS,
  CARGO_LOCATION_KINDS,
  CARGO_SPAWN_KINDS,
  CARGO_TERMINAL_KINDS,
  CARGO_TRANSITIONS,
  formatLocation,
  holderIdOf,
  isCargoLocationKind,
  isSameLocation,
  isTransitionAllowed,
  normalizeLocation,
  slotOf,
  uniqueSlotOf,
} from './cargo-location';
export type {
  CargoHolderKind,
  CargoHolderSpec,
  CargoIndexOrder,
  CargoLocation,
  CargoLocationKind,
  CargoLocationOf,
  CargoTerminalKind,
  NormalizedLocation,
} from './cargo-location';
export {
  CARGO_DIRECTIONS,
  CARGO_HOLD_REASONS,
  CARGO_STATUSES,
  CONTAINER_SIZES,
  DEFAULT_CARGO_STATUS,
  DEFAULT_CONTAINER_LABELS,
  DEFAULT_CONTAINER_TYPE,
  DEFAULT_SIZE_FT,
  DEFAULT_WEIGHT_CLASS,
  EMPTY_WEIGHT_CLASS,
  FEET_PER_TEU,
  IMPORT_LABELS,
  OUTBOUND_BY_DIRECTION,
  WEIGHT_CLASSES,
  cargoLabelsProblem,
  cargoStatusProblem,
  containerLabelsDefProblem,
  isCargoDirection,
  isCargoHoldReason,
  isCargoStatus,
  isContainerSize,
  isWeightClass,
  teuOf,
  teuOfSize,
} from './cargo-unit';
export type {
  CargoDirection,
  CargoHold,
  CargoHoldReason,
  CargoStatus,
  CargoUnit,
  CargoUnitLabels,
  CargoUnitLabelsInput,
  ContainerLabels,
  ContainerSize,
  WeightClass,
} from './cargo-unit';
export { STOWAGE_DIRECTION_RANK, STOWAGE_WEIGHT_RANK, compareStowageOrder } from './stowage';
export type { StowageKey } from './stowage';
export { CargoConservationError, CargoError, CargoStateError, CargoTransitionError } from './cargo-error';
export type { CargoErrorCode } from './cargo-error';
export { CARGO_SPAWN_KIND_BY_DIRECTION, CargoLedger } from './cargo-ledger';
export type { CargoLedgerDeps, CargoMoveObserver, CargoReader } from './cargo-ledger';
export type { CargoLedgerState } from './cargo-ledger-state';
export { findConservationViolation } from './cargo-conservation';
export type { CargoBucketView, CargoLedgerView } from './cargo-conservation';
