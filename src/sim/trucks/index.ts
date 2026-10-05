// Kamióny (ARCHITECTURE §7.5; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6; ADR-024): Truck (pohyb zdieľaný s vozidlami
// cez Carrier), FSM (stavy, prechody, vlastnosti stavov), jazda po pozemnom reťazci, spawner a save záznam.
export { SERIALIZED_TRUCK_KEYS, Truck } from './truck';
export type { SerializedTruck, TruckInit } from './truck';
export {
  TRUCK_COLLECT_STATE_TRAITS,
  TRUCK_DELIVERY_STATE_TRAITS,
  TRUCK_MISSIONS,
  TRUCK_MISSION_GIVES_UP,
  TRUCK_MISSION_STATE_TRAITS,
  TRUCK_STATES,
  TRUCK_STATE_TRAITS,
  TRUCK_TRANSITIONS,
  TRUCK_TRAVEL_STATES,
  changeTruckState,
  isTruckMission,
  isTruckState,
  isTruckTransitionAllowed,
  isTruckTravelState,
  truckStateTraits,
} from './truck-fsm';
export type { TruckCargo, TruckGateSide, TruckMission, TruckState, TruckStateEvents, TruckStateTraits, TruckStop, TruckTravelState } from './truck-fsm';
export { TruckError } from './truck-error';
export type { TruckErrorCode } from './truck-error';
export {
  dockAccessCell,
  dockTargetCell,
  enterTruckNoPath,
  faceRoute,
  gateFarSideCell,
  gateNearSideCell,
  gateOfTruck,
  isAtTravelTarget,
  isOffGateSide,
  isOffQueueSide,
  passageBackOf,
  planTruckRoute,
  rampOfTruck,
  startTruckTrip,
  truckCircuit,
  truckGateSides,
  truckMotionProblem,
  truckMotionTarget,
  waitingAreaOfTruck,
} from './truck-trip';
export type { PassageBack } from './truck-trip';
export { spawnTruck, spawnTrucks, truckDefFor } from './truck-spawner';
export { planEmptyPickups, planEmptyReturn } from './empty-plan';
export { admitCollectTrucks, admitReturnTrucks } from './empty-trucks';
export { admitExportTrucks } from './export-trucks';
export { admitFromHinterland } from './hinterland-admit';
export { Hinterland, emptyHinterlandState } from './hinterland';
export type { HinterlandState, MissionWaitState, WaitingMission } from './hinterland';
export { DockIntake } from './dock-intake';
export { DockSupply } from './dock-supply';
export { MIN_STAY_TICKS, truckWaitLimit, waitingStayTicks } from './truck-wait';
export type { TruckWaitWorld } from './truck-wait';
