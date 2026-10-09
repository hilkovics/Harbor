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

const QUEUES_AT_END: { readonly [K in CarrierKind]: (carrier: RoadCarrier) => boolean } = Object.freeze({
  vehicle: () => false,
  truck: (carrier: RoadCarrier) => {
    const { stop, motion } = (carrier as Truck).traits;
    return (stop === 'gate' || stop === 'pre_gate') && motion === 'drive';
  },
});

/**
 * Končí jazda nosiča vo fronte, v ktorej môže stáť neobmedzene dlho (kamión idúci do fronty brány)? Takýto nosič nesmie zastať
 * s telom v križovatke (ADR-037 dodatok R1, pravidlo „fronta nesiaha do križovatky“).
 */
export function endsInQueue(carrier: RoadCarrier): boolean {
  return QUEUES_AT_END[carrier.kind](carrier);
}
