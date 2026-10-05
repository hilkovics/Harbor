// Vozidlá (ARCHITECTURE §4.4, §5, §7.3; docs/tasks/phase-03.md rozhodnutia 1, 4, 7; ADR-019): Vehicle (stav privátny
// + getter), FSM (stavy, prechody, vlastnosti stavov), pohyb po trase, jazda k modulu jobu, save záznam, výjazd z depa.
export { PROGRESS_NOISE, SERIALIZED_VEHICLE_KEYS, Vehicle, isValidProgress, vehiclePosition } from './vehicle';
export type { SerializedVehicle, VehicleInit, VehiclePosition } from './vehicle';
export {
  RESUME_AFTER_NO_PATH,
  VEHICLE_STATES,
  VEHICLE_STATE_TRAITS,
  VEHICLE_TRANSITIONS,
  changeVehicleState,
  isVehicleState,
  isVehicleTransitionAllowed,
} from './vehicle-fsm';
export type { VehicleDestination, VehicleMotion, VehicleState, VehicleStateEvents, VehicleStateTraits } from './vehicle-fsm';
export { VehicleError } from './vehicle-error';
export type { VehicleErrorCode } from './vehicle-error';
export { depotExit } from './depot-exit';
export type { DepotExit } from './depot-exit';
export { enterNoPath, hookCellOfCrane, hookCellOfJob, jobModule, jobOfVehicle, jobTarget, planJobRoute, planRoute, startTrip, vehicleMotionProblem } from './vehicle-trip';
export type { TravelState, VehicleMotionProblem } from './vehicle-trip';
