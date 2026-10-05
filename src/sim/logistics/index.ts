// Logistika (ARCHITECTURE §7.3, §7.4, §7.6): pathfinding (A*, cache ciest, matica vzdialeností) — T03-03; smerové
// hrany, cena a rýchlosť podľa typu cesty (RoadSpeeds) — T03-18 (ADR-020);
// TransportJob, prístup k modulom, StorageAllocator a Dispatcher — T03-05 (ADR-018); outbound joby, RampAllocator,
// zrušenie a priorita priradenia — T04-03 (ADR-023); outbound podľa kontraktu a SLA, StoredCargoIndex — T05-04 (ADR-027).
export { IndexedBinaryHeap } from './binary-heap';
export type { HeapLess } from './binary-heap';
export { BASE_CELL_COST, Pathfinder, assertCellIndex, unitCellCost } from './pathfinder';
export type { CellCostFn, PathfinderDiagnostics, QuayCells, RoadGraph } from './pathfinder';
export { QuayLanes, hasQuayLane } from './quay-lanes';
export type { QuaySource } from './quay-lanes';
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
export { EMPTY_FLOW_STATE_KEYS, ERRAND_ENTRY_KEYS, EmptyFlow, PICKUP_PLAN_ENTRY_KEYS, RETURN_PLAN_ENTRY_KEYS } from './empty-flow';
export type { EmptyFlowState, ErrandEntry, PickupPlanEntry, ReturnPlanEntry } from './empty-flow';
export { EmptyDepotService, onEmptyStored } from './empty-depot-service';
export { allocateEmptyStorage, allocateReturnStorage, emptyCargoTypeId, emptyLabels, emptyReturnRoom, findAvailableEmpty, hasEmptyDepot } from './empty-stock';
export { createEmptyIntakeJobs, createEmptyPickupJobs } from './empty-jobs';
export type { EmptyJobSpec } from './empty-jobs';
export { StoredCargoIndex } from './stored-cargo-index';
export type { StoredCargoGroup, StoredCargoSource } from './stored-cargo-index';
export { OutboundCancelGate, assignOpenJobs, cancelUnusableOutboundJobs, chooseVehicle, createEmptyJobs, createInboundJobs, createOutboundJobs, vehicleCarries } from './dispatcher';
export type { NetworkVersions } from './dispatcher';
export { chooseRehandleSlot, chooseYardSlot, rehandleRoom, reserveYardSlot, sameGroup, unitPickable } from './yard-planner';
export type { YardChoice } from './yard-planner';
export { plannedDepartureTick } from './planned-departure';
export { yardMetrics } from './yard-metrics';
export type { YardMetrics } from './yard-metrics';
