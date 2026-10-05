// Lode (ARCHITECTURE §4.3, §5.4, §7.4; ADR-016, ADR-029): Ship + FSM (tabuľka prechodov), geometria a pohyb po trase,
// BerthAllocator, A* po vode a riadenie dopravy bez prekrývania. Systém lode (krok 3) je v src/sim/systems/ship-system.ts.
export { SHIP_STATES, SHIP_STATE_TRAITS, SHIP_TRANSITIONS, holdingAllows, isShipTransitionAllowed } from './ship-fsm';
export type { ShipHolding, ShipState, ShipStateTraits } from './ship-fsm';
export { SERIALIZED_SHIP_KEYS, Ship, serializeShipPoint } from './ship';
export type { SerializedShip, SerializedShipPoint, ShipInit } from './ship';
export { ShipError } from './ship-error';
export type { ShipErrorCode } from './ship-error';
export {
  CELL_CENTER_OFFSET,
  DOCKED_HEADING,
  advanceAlongRoute,
  anchoragePoint,
  anchoringProblem,
  approachPoint,
  cardinalHeading,
  cellCenter,
  dockPoint,
  firstBerthOf,
  laneEnd,
  laneRoute,
  laneStart,
  laneStartHeading,
  mooringOf,
  mooringProblem,
  segmentHeading,
  shipBox,
  shipCells,
  shipExtentX,
  shipExtentY,
  shipRoute,
  shipRouteProblem,
} from './ship-route';
export type { CellBox, ShipDimensions, ShipMooring, ShipPoint, ShipRouteEnv, ShipRouteProblem } from './ship-route';
export { TrafficArea, areasOverlap, boxHitsArea, boxesOverlap, spanBox, sweepRoute } from './ship-footprint';
export type { MutableShipPose, ShipPose } from './ship-footprint';
export { ShipTraffic, shipOverlapProblem } from './ship-traffic';
export { AXIS_OF_HEADING, WaterNavigator } from './water-navigator';
export type { ShipAxis, ShipManeuvers, WaterGrid } from './water-navigator';
export { allocateBerths, berthReadiness, hasCompatibleCrane } from './berth-allocator';
export type { BerthAllocationWorld, BerthReadiness, BerthRequest } from './berth-allocator';
export { spawnShip } from './spawn-ship';
export type { ShipSpawnSpec } from './spawn-ship';
