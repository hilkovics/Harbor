// Moduly (ARCHITECTURE §5, §5.3, §5.4, §7.5, §7.7; ADR-014, ADR-017, ADR-022): Module, ModuleRegistry, BerthModule,
// CraneModule, BerthGroup, ApronBuffer, SlotReservations, StorageModule, ContainerYard, VehicleDepot, LandExportModule,
// TruckGate, WaitingArea, LoadingRamp (DockStaging).
export { Module } from './module';
export type { ModuleInit } from './module';
export { ModuleError, ModuleStateError } from './module-error';
export type { ModuleErrorCode } from './module-error';
export { SIDE_STEPS, connectorOutside, connectorsOf, edgeCells, footprintOf, frontBandCells, rotateSide, waterSideOf } from './module-geometry';
export type { ModuleFootprint, PlacedConnector } from './module-geometry';
export type { JsonPrimitive, JsonValue, ModuleRuntimeState } from './runtime-state';
export { ApronBuffer } from './apron-buffer';
export { SlotReservations } from './slot-reservations';
export type { CargoSlotsView, SlotHolderKind, SlotReservationsInit } from './slot-reservations';
export { StorageModule } from './storage-module';
export type { StorageRuntimeState } from './storage-module';
export { CONTAINER_YARD_CATEGORY, ContainerYard } from './container-yard';
export { VehicleDepot } from './vehicle-depot';
export { LandExportModule } from './land-export-module';
export { TruckGate } from './truck-gate';
export type { GateRuntimeState } from './truck-gate';
export { WaitingArea } from './waiting-area';
export { DockStaging } from './dock-staging';
export type { DockStagingInit } from './dock-staging';
export { LoadingRamp, RAMP_INOPERATIVE_REASONS, RAMP_OPERATIONAL } from './loading-ramp';
export type { RampInoperativeReason, RampStatus } from './loading-ramp';
export { BerthModule, effectiveBerthDepth } from './berth-module';
export type { BerthRuntimeState } from './berth-module';
export { CRANE_STATES, CRANE_STATE_TRAITS, CRANE_TRANSITIONS, CraneModule, cranePhaseProblem, isCraneTransitionAllowed } from './crane-module';
export type { CraneCounter, CranePhaseKind, CranePhaseProblem, CraneRuntimeState, CraneState, CraneStateTraits } from './crane-module';
export { computeBerthGroups } from './berth-group';
export type { BerthGroup } from './berth-group';
export { BUILTIN_MODULES, ModuleRegistry, STORAGE_MODULES, moduleRegistry, registerBuiltinModules } from './module-registry';
export type { ModuleEnv, ModuleFactory } from './module-registry';
