// Moduly (ARCHITECTURE §5, §5.3, §5.4; ADR-014): Module, ModuleRegistry, BerthModule, CraneModule, BerthGroup, ApronBuffer.
export { Module } from './module';
export type { ModuleInit } from './module';
export { ModuleError, ModuleStateError } from './module-error';
export type { ModuleErrorCode } from './module-error';
export { SIDE_STEPS, connectorsOf, edgeCells, footprintOf, frontBandCells, rotateSide, waterSideOf } from './module-geometry';
export type { ModuleFootprint, PlacedConnector } from './module-geometry';
export type { JsonPrimitive, JsonValue, ModuleRuntimeState } from './runtime-state';
export { ApronBuffer } from './apron-buffer';
export { BerthModule, effectiveBerthDepth } from './berth-module';
export { CRANE_STATES, CRANE_STATE_TRAITS, CraneModule } from './crane-module';
export type { CraneCounter, CraneRuntimeState, CraneState, CraneStateTraits } from './crane-module';
export { computeBerthGroups } from './berth-group';
export type { BerthGroup } from './berth-group';
export { BUILTIN_MODULES, ModuleRegistry, moduleRegistry, registerBuiltinModules } from './module-registry';
export type { ModuleEnv, ModuleFactory } from './module-registry';
