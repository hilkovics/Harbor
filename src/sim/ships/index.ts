// Lode (ARCHITECTURE §4.3, §5.4, §7.4; ADR-016): Ship + FSM (tabuľka prechodov), geometria a pohyb po trase,
// BerthAllocator. Systém lode (krok 3) je v src/sim/systems/ship-system.ts.
export { SHIP_STATES, SHIP_STATE_TRAITS, SHIP_TRANSITIONS, isShipTransitionAllowed } from './ship-fsm';
export type { ShipState, ShipStateTraits } from './ship-fsm';
export { SERIALIZED_SHIP_KEYS, Ship } from './ship';
export type { SerializedShip, ShipInit } from './ship';
export { ShipError } from './ship-error';
export type { ShipErrorCode } from './ship-error';
export {
  DOCKED_HEADING,
  advanceAlongRoute,
  cardinalHeading,
  cellCenter,
  dockPoint,
  firstBerthOf,
  mooringOf,
  mooringProblem,
  shipCells,
  shipRoute,
} from './ship-route';
export type { ShipDimensions, ShipMooring, ShipPoint, ShipRouteEnv } from './ship-route';
export { allocateBerths, hasCompatibleCrane } from './berth-allocator';
export type { BerthAllocationWorld, BerthRequest } from './berth-allocator';
export { spawnShip } from './spawn-ship';
export type { ShipSpawnSpec } from './spawn-ship';
