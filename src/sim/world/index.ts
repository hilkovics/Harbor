// World — koreň simulácie (tick pipeline §6, serialize/deserialize §14, moduly a invarianty ADR-014).
export { World } from './world';
export { WORLD_STATE_VERSION, WORLD_STATE_KEYS, WorldStateError } from './world-state';
export type {
  AnyWorldState,
  SerializedModule,
  SerializedRoad,
  SerializedRoadLayer,
  SerializedShip,
  SerializedTraffic,
  WorldState,
  WorldStateV1,
} from './world-state';
export { OLDEST_WORLD_STATE_VERSION, WORLD_STATE_V1_KEYS, migrateWorldState } from './migrate';
export { WorldInvariantError, findWorldViolation } from './world-invariants';
export { CARGO_HOLDER_SOURCES, MODULE_CARGO_HOLDER_KINDS } from './cargo-holders';
export type { CargoHolderWorld } from './cargo-holders';
// Parcela patrí mriežke/mape (src/sim/grid/parcel.ts); tu len re-export pre pohodlie konzumentov `World`.
export type { Parcel, ParcelOwnership } from '../grid/parcel';
