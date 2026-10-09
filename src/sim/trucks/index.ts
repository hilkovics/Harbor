// Kamióny (ARCHITECTURE §7.5; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6; ADR-024): Truck (pohyb zdieľaný s vozidlami
// cez Carrier), FSM (stavy, prechody, vlastnosti stavov), jazda po pozemnom reťazci, spawner a save záznam.
export { SERIALIZED_TRUCK_KEYS, Truck } from './truck';
export type { SerializedTruck, TruckInit } from './truck';
export {
  TRUCK_COLLECT_STATE_TRAITS,
  TRUCK_DELIVERY_STATE_TRAITS,
  TRUCK_MISSIONS,
  TRUCK_MISSION_STATE_TRAITS,
  TRUCK_STATES,
  TRUCK_STATE_TRAITS,
  TRUCK_TRANSITIONS,
  TRUCK_TRAVEL_STATES,
  TP_PHASES,
  TP_PHASE_SEQUENCE,
  TP_ROLE_OF_MISSION,
  TP_STATES,
  changeTruckState,
  isTpPhase,
  isTruckMission,
  isTruckState,
  isTruckTransitionAllowed,
  isTruckTravelState,
  truckStateTraits,
} from './truck-fsm';
export type { TpPhase, TpRole, TruckCargo, TruckGateSide, TruckMission, TruckState, TruckStateEvents, TruckStateTraits, TruckStop, TruckTravelState } from './truck-fsm';
export { TruckError } from './truck-error';
export type { TruckErrorCode } from './truck-error';
export {
  enterTruckNoPath,
  faceRoute,
  gateFarSideCell,
  gateNearSideCell,
  gateOfTruck,
  gateOutOfTruck,
  holdingOfTruck,
  pickOutLane,
  preGateOfTruck,
  isAtTravelTarget,
  isOffGateSide,
  isOffQueueSide,
  planTruckRoute,
  startTruckTrip,
  truckMotionProblem,
  truckMotionTarget,
} from './truck-trip';
export { spawnPickupTrucks, spawnTruck, truckDefFor, trySpawn } from './truck-spawner';
export { applyToken, reserveToken, tokenCell } from './destination';
export type { StallToken, Token, TpToken } from './destination';
export { chooseTp, firstFreeStall, freeStalls, hasFreeToken, hasLaneTp, isTpFree, stallHolder, tpCellsOf, tpHolder, tpHolders } from './tp-points';
export { arriveAtTp, stepTp } from './tp-service';
export { callFromHolding } from './holding';
export { planEmptyPickups, planEmptyReturn } from './empty-plan';
export { admitCollectTrucks, admitReturnTrucks } from './empty-trucks';
export { admitExportTrucks } from './export-trucks';
export { admitFromHinterland } from './hinterland-admit';
export { Hinterland, emptyHinterlandState } from './hinterland';
export type { HinterlandState, MissionWaitState, TruckTurnState, WaitingMission } from './hinterland';
