/**
 * Nosič na cestách = vozidlo alebo kamión (ADR-037). Tabuľka `holdsRoad` (vlastnosť stavu FSM) hovorí, či nosič v danom
 * stave drží pruhové sloty: jazdiaci aj stojaci na ceste (pobyt pri module, pod hákom, vo fronte brány, bez cesty), nie
 * nosič v module (stojisko, dock, prechod bránou). Tabuľka `motion` (`drive`) hovorí, či sa nosič v stave hýbe — hýbe ho
 * `TrafficSystem`; stojaci nosič slot len drží.
 */
import type { CarrierKind } from '../movement/carrier';
import type { Truck } from '../trucks/truck';
import type { Vehicle } from '../vehicles/vehicle';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';

export type RoadCarrier = Vehicle | Truck;

const DRIVES: { readonly [K in CarrierKind]: (carrier: RoadCarrier) => boolean } = Object.freeze({
  vehicle: (carrier: RoadCarrier) => VEHICLE_STATE_TRAITS[(carrier as Vehicle).state].motion === 'drive',
  truck: (carrier: RoadCarrier) => (carrier as Truck).traits.motion === 'drive',
});

const HOLDS_ROAD: { readonly [K in CarrierKind]: (carrier: RoadCarrier) => boolean } = Object.freeze({
  vehicle: (carrier: RoadCarrier) => VEHICLE_STATE_TRAITS[(carrier as Vehicle).state].holdsRoad,
  truck: (carrier: RoadCarrier) => (carrier as Truck).traits.holdsRoad,
});

/** Drží nosič v aktuálnom stave pruhové sloty (tabuľka `holdsRoad` stavov)? */
export function holdsRoad(carrier: RoadCarrier): boolean {
  return HOLDS_ROAD[carrier.kind](carrier);
}

/** Hýbe sa nosič v aktuálnom stave po trase (`motion: 'drive'`)? Stojaci nosič na ceste slot drží, ale nejde. */
export function isDriving(carrier: RoadCarrier): boolean {
  return DRIVES[carrier.kind](carrier);
}
