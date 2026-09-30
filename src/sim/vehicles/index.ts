// Vozidlá (ARCHITECTURE §4.4, §5, §7.3; docs/tasks/phase-03.md rozhodnutia 1, 4, 7): Vehicle (stav privátny + getter),
// stavy a ich vlastnosti, save záznam, výjazd z depa. FSM prechody, pohyb a load/unload doplní T03-06.
export { SERIALIZED_VEHICLE_KEYS, VEHICLE_STATES, VEHICLE_STATE_TRAITS, Vehicle, isVehicleState } from './vehicle';
export type { SerializedVehicle, VehicleInit, VehicleState, VehicleStateTraits } from './vehicle';
export { VehicleError } from './vehicle-error';
export type { VehicleErrorCode } from './vehicle-error';
export { depotExit } from './depot-exit';
export type { DepotExit } from './depot-exit';
