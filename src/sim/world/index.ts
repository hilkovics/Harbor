// World — koreň simulácie (tick pipeline §6, serialize/deserialize §14, moduly a invarianty ADR-014).
export { World } from './world';
export type { WorldOptions } from './world';
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
export { OLDEST_WORLD_STATE_VERSION, WORLD_STATE_V1_KEYS, WORLD_STATE_V2, migrateWorldState } from './migrate';
export { WorldInvariantError, findWorldViolation } from './world-invariants';
export { CARGO_HOLDER_SOURCES, MODULE_CARGO_HOLDER_KINDS } from './cargo-holders';
// Pripojenie modulov k ceste (ADR-017) — World.isConnected / connectorCells a §8 bod 5 (connector_blocked).
export { connectorCellsOf, isModuleConnected, isOutsideUsable } from './connectivity';
export type { ConnectorCell } from './connectivity';
export type { CargoHolderWorld } from './cargo-holders';
// Parcela patrí mriežke/mape (src/sim/grid/parcel.ts); tu len re-export pre pohodlie konzumentov `World`.
export type { Parcel, ParcelOwnership } from '../grid/parcel';
// Pravidlá umiestnenia/odstránenia modulov (§8, ADR-015) — zdieľajú ich príkazy, World.create (starter) aj World.addModule/removeModule.
export {
  PLACEMENT_RULES,
  PLACEMENT_RULE_ERROR,
  REMOVAL_RULES,
  attachesToHost,
  findPlacementViolations,
  findRemovalViolations,
} from './module-rules';
export type {
  PlacementRule,
  PlacementScope,
  PlacementSpec,
  PlacementWorld,
  RemovalRule,
  RemovalWorld,
  RuleViolation,
} from './module-rules';
