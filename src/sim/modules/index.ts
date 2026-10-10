// Moduly (ARCHITECTURE §5, §5.3, §5.4, §7.5, §7.7; ADR-014, ADR-017, ADR-022): Module, ModuleRegistry, BerthModule,
// CraneModule, BerthGroup, ApronBuffer, SlotReservations, StorageModule, ContainerYard, VehicleDepot, LandExportModule,
// TruckGate, PreGateBuffer, TruckHolding.
export { Module } from './module';
export type { ModuleInit } from './module';
export type { CargoDropTarget } from './cargo-drop-target';
export { ModuleError, ModuleStateError } from './module-error';
export type { ModuleErrorCode } from './module-error';
export { SIDE_STEPS, connectorAllows, connectorOutside, connectorsOf, edgeCells, footprintOf, frontBandCells, rotateSide, waterSideOf } from './module-geometry';
export type { ModuleFootprint, PlacedConnector } from './module-geometry';
export type { JsonPrimitive, JsonValue, ModuleRuntimeState } from './runtime-state';
export { ApronBuffer } from './apron-buffer';
export { SlotReservations } from './slot-reservations';
export type { CargoSlotsView, SlotHolderKind, SlotReservationsInit } from './slot-reservations';
export { StorageModule } from './storage-module';
export type { StorageRuntimeState } from './storage-module';
export { StackGrid, geometryCapacity, positionOfCell, slotOfCell } from './stack-grid';
export type { YardGeometry, YardPosition } from './stack-grid';
export { YardBlock, isYardBlock } from './yard-block';
export type { YardRuntimeState } from './yard-block';
export { CONTAINER_YARD_CATEGORY, ContainerYard } from './container-yard';
export { EMPTY_DEPOT_CATEGORY, EmptyDepot } from './empty-depot';
export { RTG_BLOCK_CATEGORY, RTG_LANE_DIRECTION, RtgBlock } from './rtg-block';
export { VehicleDepot } from './vehicle-depot';
export { LandExportModule } from './land-export-module';
export type { LandsideRole, LandsideRoster } from './land-export-module';
export { GATE_STEP_IDS, TruckGate, gatePassProblem } from './truck-gate';
export type { GateRuntimeState, GateStep, GateStepId, GateStepProgress } from './truck-gate';
export { LANE_ROOF_POSITIONS, adjacentLaneGroups } from './gate-lane-groups';
export type { LaneRoofPlacement, LaneRoofPosition } from './gate-lane-groups';
export { PreGateBuffer } from './pre-gate-buffer';
export type { PreGateRuntimeState } from './pre-gate-buffer';
export { TruckHolding } from './truck-holding';
export { BerthModule, effectiveBerthDepth } from './berth-module';
export type { BerthRuntimeState } from './berth-module';
export {
  CRANE_CYCLES,
  CRANE_CYCLE_TRAITS,
  CRANE_RUNTIME_KEYS,
  CRANE_STATES,
  CRANE_STATE_TRAITS,
  CRANE_CYCLE_TRANSITIONS,
  CRANE_TRANSITIONS,
  CraneModule,
  DEFAULT_CRANE_CYCLE,
  craneReservesApronSlot,
  cranePhaseProblem,
  isCraneCycleTransitionAllowed,
  isCraneTransitionAllowed,
} from './crane-module';
export type {
  CraneCounter,
  CraneCycle,
  CraneCycleTraits,
  CranePhaseKind,
  CranePhaseProblem,
  CraneRuntimeState,
  CraneState,
  CraneStateTraits,
} from './crane-module';
export { hookCellCoord, hookCellIndex } from './hook-cell';
export { computeBerthGroups } from './berth-group';
export type { BerthGroup } from './berth-group';
export { BUILTIN_MODULES, ModuleRegistry, STORAGE_MODULES, STORAGE_ROLE_MODULES, moduleRegistry, registerBuiltinModules } from './module-registry';
export type { ModuleEnv, ModuleFactory } from './module-registry';
export { craneCargo, craneTrolley } from './crane-pose';
