// World — koreň simulácie (tick pipeline §6, serialize/deserialize §14).
export { World } from './world';
export { WORLD_STATE_VERSION, WorldStateError } from './world-state';
export type { SerializedRoad, SerializedRoadLayer, WorldState } from './world-state';
// Parcela patrí mriežke/mape (src/sim/grid/parcel.ts); tu len re-export pre pohodlie konzumentov `World`.
export type { Parcel, ParcelOwnership } from '../grid/parcel';
