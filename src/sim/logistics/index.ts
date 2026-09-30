// Logistika (ARCHITECTURE §7.3, §7.4, §7.6): pathfinding (A*, cache ciest, matica vzdialeností) — T03-03;
// TransportJob, prístup k modulom, StorageAllocator a Dispatcher — T03-05 (ADR-018).
export { IndexedBinaryHeap } from './binary-heap';
export type { HeapLess } from './binary-heap';
export { BASE_CELL_COST, Pathfinder, assertCellIndex, unitCellCost } from './pathfinder';
export type { CellCostFn, PathfinderDiagnostics, RoadGraph } from './pathfinder';
export { PathCache, RoadPairMemo } from './path-cache';
export type { CacheDiagnostics, RoadVersionSource } from './path-cache';
export { DistanceMatrix } from './distance-matrix';
export { JobError } from './job-error';
export type { JobErrorCode } from './job-error';
export {
  JOB_ROUTES,
  JOB_STATES,
  JOB_STATE_TRAITS,
  JOB_TRANSITIONS,
  SERIALIZED_JOB_KEYS,
  TransportJob,
  isJobRoute,
  isJobState,
  isJobTransitionAllowed,
} from './transport-job';
export type { JobCargoPlace, JobState, JobStateTraits, SerializedJob, TransportJobInit } from './transport-job';
export { NO_ACCESS, accessCellIndex, distanceBetweenModules, distanceToModule, isAccessCell, nearestAccessCell } from './module-access';
export type { ModuleAccessEnv } from './module-access';
export { allocateStorage } from './storage-allocator';
export type { StorageAllocatorEnv } from './storage-allocator';
export { assignOpenJobs, chooseVehicle, createInboundJobs } from './dispatcher';
