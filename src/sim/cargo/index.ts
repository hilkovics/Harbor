// Náklad (ARCHITECTURE §7.1): CargoUnit, CargoLocation + tabuľka prechodov, CargoLedger, invariant konzervácie.
export {
  CARGO_HOLDER_KINDS,
  CARGO_HOLDER_SPECS,
  CARGO_LOCATION_KINDS,
  CARGO_SPAWN_KINDS,
  CARGO_TRANSITIONS,
  formatLocation,
  holderIdOf,
  isCargoLocationKind,
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
  NormalizedLocation,
} from './cargo-location';
export type { CargoUnit } from './cargo-unit';
export { CargoConservationError, CargoError, CargoStateError, CargoTransitionError } from './cargo-error';
export type { CargoErrorCode } from './cargo-error';
export { CargoLedger } from './cargo-ledger';
export type { CargoLedgerDeps } from './cargo-ledger';
export type { CargoLedgerState } from './cargo-ledger-state';
export { findConservationViolation } from './cargo-conservation';
export type { CargoBucketView, CargoLedgerView } from './cargo-conservation';
