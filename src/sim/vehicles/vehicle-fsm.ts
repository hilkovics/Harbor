/**
 * Stavový automat vozidla (ARCHITECTURE §7.3; docs/tasks/phase-03.md rozhodnutie 7; CLAUDE.md konvencia FSM; ADR-019):
 * stavy, explicitná tabuľka povolených prechodov `VEHICLE_TRANSITIONS` a vlastnosti stavov `VEHICLE_STATE_TRAITS`.
 * Žiadne skryté prechody — stav mení výlučne `Vehicle.transition(to)`, ktorý prechod overí v tabuľke.
 *
 * Cyklus: `idle` → (dispatcher priradí job) `to_pickup` → (príchod na vonkajšiu bunku konektora zdroja) `loading` →
 * (jednotky naložené) `to_dropoff` → (príchod k cieľu) `unloading` → (jednotky uložené, job hotový) `idle`.
 * **Pod hákom** (F6a, ADR-033): ak je zdroj jobu hák žeriava (`in_crane`), vozidlo po príchode k berthu čaká v `loading`
 * („čaká pod žeriavom") a jednotku mu odovzdá žeriav (`in_crane → in_vehicle`, krok 4), čím prejde do `to_dropoff`; ak je
 * cieľom hák, čaká v `unloading`, kým ho žeriav zdvihne (`in_vehicle → in_crane`, job `done`, `idle`). Stavy ani prechody
 * sa nemenia — fáza „čaká pod žeriavom" je `HOOK_WAIT_TICKS` v `waitTicks` a koncový bod `in_crane` jobu.
 * `to_* → no_path`, keď k cieľu nevedie cesta; z `no_path` sa vozidlo vráti do toho `to_*`, z ktorého vypadlo
 * (určuje ho stav jobu: `assigned` → `to_pickup`, `moving` → `to_dropoff`).
 */
import type { VehicleStateChangedEvent } from '../events/sim-event';
import type { JobState } from '../logistics/transport-job';
import type { CarrierMotion } from '../movement/motion-check';
import type { Vehicle } from './vehicle';

/** Stavy vozidla v poradí životného cyklu. */
export const VEHICLE_STATES = ['idle', 'to_pickup', 'loading', 'to_dropoff', 'unloading', 'no_path'] as const;
export type VehicleState = (typeof VEHICLE_STATES)[number];

/**
 * Odpočet `waitTicks` vozidla, ktoré čaká **pod hákom** žeriava (ADR-033): vozidlo v `loading` (vykládka — zdroj jobu je hák) alebo
 * `unloading` (nakládka — cieľ jobu je hák) nemá pobyt na ticky, ale čaká na odovzdanie od žeriava; `waits` stavu vyžaduje
 * `waitTicks ≥ 1`, preto je odpočet pripnutý na 1 a `VehicleSystem` ho nezmenšuje. Štrukturálna hodnota, nie balans.
 */
export const HOOK_WAIT_TICKS = 1;

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

/**
 * Pohyb vozidla v stave (zdieľaný `CarrierMotion`, ADR-024): `park` — stojí v strede bunky bez ďalšej trasy
 * (`route = [cell]`, progres 0); `drive` — ide po platnej trase k prístupovej bunke modulu (aspoň jedna cieľová bunka);
 * `halt` — stojí bez cesty (`no_path`): v strede bunky (`[cell]`) alebo uprostred rozbehnutého úseku (`[cell, nextCell]`,
 * progres > 0).
 */
export type VehicleMotion = CarrierMotion;

/** Modul jobu, ku ktorému vozidlo ide alebo pri ktorom stojí: zdroj (`from`) alebo cieľ (`to`). */
export type VehicleDestination = 'source' | 'target';

/** Čo platí pre vozidlo v danom stave. */
export interface VehicleStateTraits {
  /** Vozidlo má aktívny job (`jobId !== null`) — všetky stavy okrem `idle`. */
  readonly hasJob: boolean;
  /**
   * Stavy jobu, ktoré zodpovedajú stavu vozidla (ADR-018, ADR-019): job zrkadlí FSM vozidla. `no_path` má dva — pred
   * vyzdvihnutím `assigned`, s nákladom `moving`; rozhodne poloha nákladu jobu (`JOB_STATE_TRAITS.cargoAt`).
   */
  readonly jobStates: readonly JobState[];
  readonly motion: VehicleMotion;
  /**
   * Vozidlo v stave drží pruhové sloty cesty (`LaneSlots`, ADR-037): v jazde aj stojace na ceste (`idle`, `loading`,
   * `unloading` pri prístupovej bunke modulu alebo pod hákom, `no_path`) — stojace vozidlo je prekážka. Mimo cesty bude
   * vozidlo až v depe (`parked`, TR1-04).
   */
  readonly holdsRoad: boolean;
  /** Stav s odpočtom `waitTicks ≥ 1` (pobyt v module, nový pokus o cestu); ostatné stavy majú `waitTicks = 0`. */
  readonly waits: boolean;
  /** Modul jobu, ku ktorému vozidlo ide / pri ktorom stojí; `null` = žiadny (`idle`) alebo podľa jobu (`no_path`). */
  readonly destination: VehicleDestination | null;
}

export const VEHICLE_STATE_TRAITS: { readonly [S in VehicleState]: VehicleStateTraits } = Object.freeze({
  idle: Object.freeze({ hasJob: false, jobStates: Object.freeze([] as const), motion: 'park', holdsRoad: true, waits: false, destination: null }),
  to_pickup: Object.freeze({ hasJob: true, jobStates: Object.freeze(['assigned'] as const), motion: 'drive', holdsRoad: true, waits: false, destination: 'source' }),
  loading: Object.freeze({ hasJob: true, jobStates: Object.freeze(['picking'] as const), motion: 'park', holdsRoad: true, waits: true, destination: 'source' }),
  to_dropoff: Object.freeze({ hasJob: true, jobStates: Object.freeze(['moving'] as const), motion: 'drive', holdsRoad: true, waits: false, destination: 'target' }),
  unloading: Object.freeze({ hasJob: true, jobStates: Object.freeze(['dropping'] as const), motion: 'park', holdsRoad: true, waits: true, destination: 'target' }),
  no_path: Object.freeze({ hasJob: true, jobStates: Object.freeze(['assigned', 'moving'] as const), motion: 'halt', holdsRoad: true, waits: true, destination: null }),
} as const);

/** Stav jazdy, do ktorého sa vozidlo vráti z `no_path`, podľa stavu jobu (`assigned` → k zdroju, `moving` → k cieľu). */
export const RESUME_AFTER_NO_PATH: Readonly<Partial<Record<JobState, 'to_pickup' | 'to_dropoff'>>> = Object.freeze({
  assigned: 'to_pickup',
  moving: 'to_dropoff',
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
