// Logistika (ARCHITECTURE §7.3, §7.4, §7.6): pathfinding (A*, cache ciest, matica vzdialeností) — T03-03;
// TransportJob, StorageAllocator a Dispatcher pribudnú v T03-05.
export { IndexedBinaryHeap } from './binary-heap';
export type { HeapLess } from './binary-heap';
export { BASE_CELL_COST, Pathfinder, assertCellIndex, unitCellCost } from './pathfinder';
export type { CellCostFn, PathfinderDiagnostics, RoadGraph } from './pathfinder';
export { PathCache, RoadPairMemo } from './path-cache';
export type { CacheDiagnostics, RoadVersionSource } from './path-cache';
export { DistanceMatrix } from './distance-matrix';
