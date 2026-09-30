// Vozidlá (ARCHITECTURE §4.4, §5, §7.3; docs/tasks/phase-03.md rozhodnutia 1, 4, 7; ADR-019): Vehicle (stav privátny
// + getter), FSM (stavy, prechody, vlastnosti stavov), save záznam, výjazd z depa.
export { SERIALIZED_VEHICLE_KEYS, Vehicle } from './vehicle';
export type { SerializedVehicle, VehicleInit } from './vehicle';
export { VEHICLE_STATES, VEHICLE_STATE_TRAITS, VEHICLE_TRANSITIONS, changeVehicleState, isVehicleState, isVehicleTransitionAllowed } from './vehicle-fsm';
export type { VehicleState, VehicleStateEvents, VehicleStateTraits } from './vehicle-fsm';
export { VehicleError } from './vehicle-error';
export type { VehicleErrorCode } from './vehicle-error';
export { depotExit } from './depot-exit';
export type { DepotExit } from './depot-exit';
