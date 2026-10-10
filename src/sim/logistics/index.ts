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
export { beginGangPass, endGangPass, gangFilter, gangRoster, craneGangMode, craneTractorsPerSts } from './gang-roster';
export { terminalMetrics } from './terminal-metrics';
export type { TerminalMetrics } from './terminal-metrics';
export { railMetrics } from './rail-metrics';
export { isRailBound, isRailImportUnit, railTerminalTakes } from './rail-units';
export type { RailMetrics } from './rail-metrics';
export { moduleLanes } from './module-lanes';
export type { LaneCell, LaneDirection, LaneRole } from './module-lanes';
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
export { EMPTY_FLOW_STATE_KEYS, ERRAND_ENTRY_KEYS, EmptyFlow, PICKUP_PLAN_ENTRY_KEYS, RETURN_PLAN_ENTRY_KEYS } from './empty-flow';
export type { EmptyFlowState, ErrandEntry, PickupPlanEntry, ReturnPlanEntry } from './empty-flow';
export { EmptyDepotService, onEmptyStored } from './empty-depot-service';
export { emptyCargoTypeId, emptyLabels, emptyReturnRoom, findAvailableEmpty, hasEmptyDepot } from './empty-stock';
export { StoredCargoIndex } from './stored-cargo-index';
export type { StoredCargoGroup, StoredCargoSource } from './stored-cargo-index';
export { assignOpenJobs, chooseVehicle, createInboundJobs, vehicleCarries } from './dispatcher';
export { forEachPickupCandidate } from './pickup-demand';
export { isTruckJob, openDeliverJob, openReceiveJob, truckJobBlock, truckOfJob } from './truck-jobs';
export { chooseRehandleSlot, chooseYardSlot, rehandleRoom, reserveYardSlot, sameGroup, unitPickable } from './yard-planner';
export { liftBlockedByPower, mayUnload } from './reefer-supply';
export type { YardChoice } from './yard-planner';
export { plannedDepartureTick } from './planned-departure';
export { yardMetrics } from './yard-metrics';
export type { YardMetrics } from './yard-metrics';
