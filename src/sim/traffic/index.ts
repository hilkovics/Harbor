// Doprava bez prekrývania (ADR-037, ADR-038): pruhové sloty, druhy buniek, pruh nosiča a TrafficSystem (krok 6a).
export { CellLanes, NO_SIDE, sideBetween } from './cell-lanes';
export type { CellLaneKind, CellLaneSource, Side } from './cell-lanes';
export { cellLaneKind, laneFor, laneOf } from './lane-for';
export type { LaneWorld } from './lane-for';
export { LANES_PER_CELL, LaneSlots, keyCell, keyLane, serializeSlots, slotKey, slotKeyOf } from './lane-slots';
export type { SerializedSlot, SlotRegistry } from './lane-slots';
export { holdsRoad, isDriving } from './holds-road';
export type { RoadCarrier } from './holds-road';
export { carrierOverlapProblem } from './overlap-check';
export type { OverlapWorld } from './overlap-check';
export { TrafficSystem } from './traffic-system';
export { trafficMetrics, type TrafficMetrics } from './traffic-metrics';
