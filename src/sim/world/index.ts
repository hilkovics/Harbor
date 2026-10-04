// World — koreň simulácie (tick pipeline §6, serialize/deserialize §14, moduly a invarianty ADR-014).
export { World } from './world';
export type { WorldOptions } from './world';
export { WORLD_STATE_VERSION, WORLD_STATE_KEYS, WorldStateError, serializeRoad } from './world-state';
// Odtlačok stavu (ADR-030): FNV-1a 32 nad JSON.stringify(serialize()) — testy, simrun --hash / --roundtrip-at.
export { fnv1a32Hex, hashWorldState, stateHash } from './state-hash';
export type {
  AnyWorldState,
  ParsedRoadEntry,
  SerializedJob,
  SerializedModule,
  SerializedRoad,
  SerializedRoadV1,
  SerializedRoadLayer,
  SerializedShip,
  SerializedTraffic,
  SerializedTruck,
  SerializedVehicle,
  WorldState,
  WorldStateV1,
  WorldStateV2,
  WorldStateV3,
  WorldStateV4,
  WorldStateV5,
  WorldStateV6,
  LegacyCargoUnitV6,
} from './world-state';
// Dotazy nad nákladom pre prezentáciu a metriky F6a (ADR-032): import/export na lodi a v sklade, zoskupenie exportu.
export { cargoSplitAt, exportGroupingShare, shipCargoSplit, storageCargoSplit } from './cargo-queries';
export type { CargoDirectionSplit } from './cargo-queries';
export {
  OLDEST_WORLD_STATE_VERSION,
  WORLD_STATE_V1_KEYS,
  WORLD_STATE_V2,
  WORLD_STATE_V2_KEYS,
  WORLD_STATE_V3,
  WORLD_STATE_V3_KEYS,
  WORLD_STATE_V4,
  WORLD_STATE_V4_KEYS,
  WORLD_STATE_V5,
  WORLD_STATE_V5_KEYS,
  WORLD_STATE_V6,
  WORLD_STATE_V6_KEYS,
  WORLD_STATE_V7,
  WORLD_STATE_V7_KEYS,
  migrateWorldState,
  savesShipRoutes,
} from './migrate';
export { WorldInvariantError, findWorldViolation } from './world-invariants';
export { ECONOMY_STATE_KEYS, parseEconomyState } from './economy-state';
export { CARGO_HOLDER_SOURCES, MODULE_CARGO_HOLDER_KINDS } from './cargo-holders';
// Pripojenie modulov k ceste (ADR-017) — World.isConnected / connectorCells a §8 bod 5 (connector_blocked).
export { connectorCellsOf, isModuleConnected, isOutsideUsable } from './connectivity';
export type { ConnectorCell } from './connectivity';
// Pozemný exportný reťazec (ADR-022) — strany brán, priechody stojiskami, trasy kamiónov a prevádzkovosť rámp.
export { LandsideNetwork, NO_GATE_SIDES } from './landside';
export type { GateSides, LandsideCircuit, LandsideEnv, LandsideRoute } from './landside';
export { LandsideRosterCache } from './landside-roster';
export type { LandsideModules } from './landside-roster';
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
  TruckModuleRefs,
} from './module-rules';
