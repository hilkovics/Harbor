/**
 * Stavový automat vozidla (ARCHITECTURE §7.3; docs/tasks/phase-03.md rozhodnutie 7; CLAUDE.md konvencia FSM; ADR-019):
 * stavy, explicitná tabuľka povolených prechodov `VEHICLE_TRANSITIONS` a vlastnosti stavov `VEHICLE_STATE_TRAITS`.
 * Žiadne skryté prechody — stav mení výlučne `Vehicle.transition(to)`, ktorý prechod overí v tabuľke.
 *
 * Cyklus: `idle` → (dispatcher priradí job) `to_pickup` → (príchod na vonkajšiu bunku konektora zdroja) `loading` →
 * (jednotky naložené) `to_dropoff` → (príchod k cieľu) `unloading` → (jednotky uložené, job hotový) `idle`.
 * `to_* → no_path`, keď k cieľu nevedie cesta; z `no_path` sa vozidlo vráti do toho `to_*`, z ktorého vypadlo
 * (určuje ho stav jobu: `assigned` → `to_pickup`, `moving` → `to_dropoff`).
 */
import type { VehicleStateChangedEvent } from '../events/sim-event';
import type { JobState } from '../logistics/transport-job';
import type { Vehicle } from './vehicle';

/** Stavy vozidla v poradí životného cyklu. */
export const VEHICLE_STATES = ['idle', 'to_pickup', 'loading', 'to_dropoff', 'unloading', 'no_path'] as const;
export type VehicleState = (typeof VEHICLE_STATES)[number];

/** Povolené prechody `from → [to…]`. */
export const VEHICLE_TRANSITIONS: ReadonlyMap<VehicleState, readonly VehicleState[]> = new Map<VehicleState, readonly VehicleState[]>([
  ['idle', Object.freeze(['to_pickup'] as const)],
  ['to_pickup', Object.freeze(['loading', 'no_path'] as const)],
  ['loading', Object.freeze(['to_dropoff'] as const)],
  ['to_dropoff', Object.freeze(['unloading', 'no_path'] as const)],
  ['unloading', Object.freeze(['idle'] as const)],
  ['no_path', Object.freeze(['to_pickup', 'to_dropoff'] as const)],
]);

/** Je prechod `from → to` v tabuľke? */
export function isVehicleTransitionAllowed(from: VehicleState, to: VehicleState): boolean {
  return VEHICLE_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Čo platí pre vozidlo v danom stave. */
export interface VehicleStateTraits {
  /** Vozidlo má aktívny job (`jobId !== null`) — všetky stavy okrem `idle`. */
  readonly hasJob: boolean;
  /**
   * Stavy jobu, ktoré zodpovedajú stavu vozidla (ADR-018, ADR-019): job zrkadlí FSM vozidla. `no_path` má dva — pred
   * vyzdvihnutím `assigned`, s nákladom `moving`; rozhodne poloha nákladu jobu (`JOB_STATE_TRAITS.cargoAt`).
   */
  readonly jobStates: readonly JobState[];
}

export const VEHICLE_STATE_TRAITS: { readonly [S in VehicleState]: VehicleStateTraits } = Object.freeze({
  idle: Object.freeze({ hasJob: false, jobStates: Object.freeze([] as const) }),
  to_pickup: Object.freeze({ hasJob: true, jobStates: Object.freeze(['assigned'] as const) }),
  loading: Object.freeze({ hasJob: true, jobStates: Object.freeze(['picking'] as const) }),
  to_dropoff: Object.freeze({ hasJob: true, jobStates: Object.freeze(['moving'] as const) }),
  unloading: Object.freeze({ hasJob: true, jobStates: Object.freeze(['dropping'] as const) }),
  no_path: Object.freeze({ hasJob: true, jobStates: Object.freeze(['assigned', 'moving'] as const) }),
});

/** Je hodnota jeden zo stavov vozidla? */
export function isVehicleState(value: unknown): value is VehicleState {
  return (VEHICLE_STATES as readonly unknown[]).includes(value);
}

/** Cieľ udalosti prechodu (`world.events`). */
export interface VehicleStateEvents {
  emit(event: VehicleStateChangedEvent): void;
}

/**
 * Prechod stavu vozidla s udalosťou: `vehicle.transition(to)` (tabuľka, pri chybe sa nič nezmení ani neemituje)
 * a potom `VehicleStateChanged { vehicleId, from, to }`. Jediná cesta, ktorou systémy menia stav vozidla.
 */
export function changeVehicleState(events: VehicleStateEvents, vehicle: Vehicle, to: VehicleState): void {
  const from = vehicle.state;
  vehicle.transition(to);
  events.emit({ type: 'VehicleStateChanged', vehicleId: vehicle.id, from, to });
}
