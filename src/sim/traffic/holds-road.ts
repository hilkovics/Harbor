/**
 * Nosič na cestách = vozidlo alebo kamión (ADR-037). Tabuľka `holdsRoad` (vlastnosť stavu FSM) hovorí, či nosič v danom
 * stave drží pruhové sloty: dočasne (R1, TR1-02) len v jazdných stavoch, TR1-03 pridá stojace nosiče pri moduloch.
 */
import type { CarrierKind } from '../movement/carrier';
import type { Truck } from '../trucks/truck';
import type { Vehicle } from '../vehicles/vehicle';
import { VEHICLE_STATE_TRAITS } from '../vehicles/vehicle-fsm';

export type RoadCarrier = Vehicle | Truck;

const HOLDS_ROAD: { readonly [K in CarrierKind]: (carrier: RoadCarrier) => boolean } = Object.freeze({
  vehicle: (carrier: RoadCarrier) => VEHICLE_STATE_TRAITS[(carrier as Vehicle).state].holdsRoad,
  truck: (carrier: RoadCarrier) => (carrier as Truck).traits.holdsRoad,
});

/** Drží nosič v aktuálnom stave pruhové sloty (tabuľka `holdsRoad` stavov)? */
export function holdsRoad(carrier: RoadCarrier): boolean {
  return HOLDS_ROAD[carrier.kind](carrier);
}
