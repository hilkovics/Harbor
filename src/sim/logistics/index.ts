// Logistika (ARCHITECTURE §7.3, §7.4, §7.6): pathfinding (A*, cache ciest, matica vzdialeností) — T03-03; smerové
// hrany, cena a rýchlosť podľa typu cesty (RoadSpeeds) — T03-18 (ADR-020);
// TransportJob, prístup k modulom, StorageAllocator a Dispatcher — T03-05 (ADR-018); outbound joby, RampAllocator,
// zrušenie a priorita priradenia — T04-03 (ADR-023); outbound podľa kontraktu a SLA, StoredCargoIndex — T05-04 (ADR-027).
export { IndexedBinaryHeap } from './binary-heap';
export type { HeapLess } from './binary-heap';
export { BASE_CELL_COST, Pathfinder, assertCellIndex, unitCellCost } from './pathfinder';
export type { CellCostFn, PathfinderDiagnostics, RoadGraph } from './pathfinder';
export { RoadSpeeds, UNIT_SPEED_FACTOR } from './road-speed';
export type { SpeedFactorFn } from './road-speed';
export { PathCache, RoadPairMemo } from './path-cache';
export type { CacheDiagnostics, RoadVersionSource } from './path-cache';
export { DistanceMatrix } from './distance-matrix';
export { JobError } from './job-error';
export type { JobErrorCode } from './job-error';
export {
  JOB_CANCEL_REASONS,
  JOB_PRIORITY_LEVELS,
  JOB_ROUTES,
  JOB_STATES,
  JOB_STATE_TRAITS,
  JOB_TRANSITIONS,
  SERIALIZED_JOB_KEYS,
  TransportJob,
  isJobRoute,
  isJobState,
  isJobTransitionAllowed,
  jobRouteOf,
} from './transport-job';
export type { JobCancelReason, JobCargoPlace, JobRoute, JobState, JobStateTraits, SerializedJob, TransportJobInit } from './transport-job';
export { NO_ACCESS, accessCellIndex, distanceBetweenModules, distanceToModule, isAccessCell, nearestAccessCell } from './module-access';
export type { ModuleAccessEnv } from './module-access';
export { allocateStorage } from './storage-allocator';
export type { StorageAllocatorEnv } from './storage-allocator';
export { acceptsOutbound, allocateRamp } from './ramp-allocator';
export type { RampAllocatorEnv } from './ramp-allocator';
export { StoredCargoIndex } from './stored-cargo-index';
export type { StoredCargoGroup, StoredCargoSource } from './stored-cargo-index';
export { OutboundCancelGate, assignOpenJobs, cancelUnusableOutboundJobs, chooseVehicle, createInboundJobs, createOutboundJobs } from './dispatcher';
export type { NetworkVersions } from './dispatcher';
