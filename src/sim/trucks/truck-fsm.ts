/**
 * Stavový automat kamióna (ARCHITECTURE §7.5; rozhodnutie orchestrátora F4 č. 6; CLAUDE.md konvencia FSM; ADR-024):
 * stavy, explicitná tabuľka povolených prechodov `TRUCK_TRANSITIONS` a vlastnosti stavov `TRUCK_STATE_TRAITS`.
 * Žiadne skryté prechody — stav mení výlučne `Truck.transition(to)`, ktorý prechod overí v tabuľke.
 *
 * Cyklus: (spawn na road portáli) `to_gate` → (príchod na vonkajšiu bunku vstupnej strany brány) `gate_queue` →
 * (brána dokončila prechod) `to_bay` → (príchod k vstupu stojiska) `waiting` → (povel do docku) `to_dock` → (príchod
 * k docku rampy) `loading` → (naložené) `to_gate_out` → (príchod k výstupnej strane brány) `gate_queue_out` → (prechod)
 * `to_portal` → (príchod na portál) `exited` — jednotky `in_truck → exported`, kamión zmizne.
 * Povel do docku (ADR-029): po pobyte v stojisku odíde prvý pripravený kamión svojho docku (FIFO podľa id), keď je dock
 * voľný a je na ňom celý náklad kamióna; inak čaká v bayi. Dock drží až od tohto povelu, nárok na náklad od spawnu.
 * Jazdné stavy (`to_*`) prejdú do `no_path`, keď k cieľu nevedie cesta; z `no_path` sa kamión vráti presne do stavu,
 * z ktorého vypadol (`Truck.resume`).
 */
import type { TruckStateChangedEvent } from '../events/sim-event';
import type { CarrierMotion, MotionTraits } from '../movement/motion-check';
import type { Truck } from './truck';

/** Stavy kamióna v poradí životného cyklu (`exited` je prechodný — kamión v ňom zmizne v tom istom kroku). */
export const TRUCK_STATES = [
  'to_gate',
  'gate_queue',
  'to_bay',
  'waiting',
  'to_dock',
  'loading',
  'to_gate_out',
  'gate_queue_out',
  'to_portal',
  'exited',
  'no_path',
] as const;
export type TruckState = (typeof TRUCK_STATES)[number];

/** Jazdné stavy — z nich kamión môže vypadnúť do `no_path` a do nich sa vracia. */
export const TRUCK_TRAVEL_STATES = ['to_gate', 'to_bay', 'to_dock', 'to_gate_out', 'to_portal'] as const;
export type TruckTravelState = (typeof TRUCK_TRAVEL_STATES)[number];

/** Povolené prechody `from → [to…]`. */
export const TRUCK_TRANSITIONS: ReadonlyMap<TruckState, readonly TruckState[]> = new Map<TruckState, readonly TruckState[]>([
  ['to_gate', Object.freeze(['gate_queue', 'no_path'] as const)],
  ['gate_queue', Object.freeze(['to_bay'] as const)],
  ['to_bay', Object.freeze(['waiting', 'no_path'] as const)],
  ['waiting', Object.freeze(['to_dock'] as const)],
  ['to_dock', Object.freeze(['loading', 'no_path'] as const)],
  ['loading', Object.freeze(['to_gate_out'] as const)],
  ['to_gate_out', Object.freeze(['gate_queue_out', 'no_path'] as const)],
  ['gate_queue_out', Object.freeze(['to_portal'] as const)],
  ['to_portal', Object.freeze(['exited', 'no_path'] as const)],
  ['exited', Object.freeze([] as const)],
  ['no_path', Object.freeze([...TRUCK_TRAVEL_STATES])],
]);

/** Je prechod `from → to` v tabuľke? (Návrat z `no_path` do správneho stavu stráži `Truck.transition`.) */
export function isTruckTransitionAllowed(from: TruckState, to: TruckState): boolean {
  return TRUCK_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Je hodnota jeden zo stavov kamióna? */
export function isTruckState(value: unknown): value is TruckState {
  return (TRUCK_STATES as readonly unknown[]).includes(value);
}

/** Je hodnota jazdný stav? */
export function isTruckTravelState(value: unknown): value is TruckTravelState {
  return (TRUCK_TRAVEL_STATES as readonly unknown[]).includes(value);
}

/** Modul (alebo portál), ku ktorému kamión ide / pri ktorom stojí; cieľ trasy v kroku 12 (`truckMotionTarget`). */
export type TruckStop = 'gate' | 'waiting_area' | 'ramp' | 'portal';

/** Náklad kamióna podľa stavu (§7.5): pred nakládkou prázdny, počas nej najviac kapacita, po nej plný. */
export type TruckCargo = 'empty' | 'loading' | 'full';

/** Strana brány: vstupná (z portálu, fronta dnu) alebo výstupná (z areálu, fronta von). */
export type TruckGateSide = 'entry' | 'exit';

/** Čo platí pre kamión v danom stave. Pre `no_path` platia väzby (bay, dock, náklad) stavu `resume`. */
export interface TruckStateTraits extends MotionTraits {
  readonly motion: CarrierMotion;
  /** Stav s odpočtom `waitTicks ≥ 1` (pobyt v stojisku, nakládka, nový pokus o cestu). */
  readonly waits: boolean;
  /** Cieľ jazdy / miesto pobytu; `null` = žiadny (`no_path`, `exited`). */
  readonly stop: TruckStop | null;
  /** Kamión drží rezervovaný bay stojiska (od spawnu, kým neodíde k docku — rozhodnutie orchestrátora F4 č. 3). */
  readonly holdsBay: boolean;
  /** Kamión v bayi stojí (inak len rezervácia). */
  readonly bayOccupied: boolean;
  /**
   * Kamión drží dock rampy (`LoadingRamp.dockTruck`) — od odchodu zo stojiska (`waiting → to_dock`), kým nedoloží; na
   * dock mieri najviac jeden kamión (ADR-029, predtým od spawnu podľa ADR-024).
   */
  readonly holdsDock: boolean;
  /**
   * Kamión má nárok na náklad svojho docku (`LoadingRamp.claimedAt`): od spawnu po koniec nakládky počíta
   * `capacityUnits − in_truck` jednotiek docku, ktoré sú pripravené alebo na ceste s vozidlom (ADR-029). Dva kamióny
   * tak nikdy nečakajú na tú istú jednotku.
   */
  readonly claimsCargo: boolean;
  readonly cargo: TruckCargo;
  /** Strana brány, ku ktorej kamión ide (`to_gate`, `to_gate_out`) alebo pri ktorej čaká vo fronte; inak `null`. */
  readonly gateSide: TruckGateSide | null;
  /** Kamión stojí vo FIFO fronte svojej brány (`gate_queue`, `gate_queue_out`). */
  readonly queued: boolean;
  /** Stav po prechode bránou (len pre stavy vo fronte). */
  readonly afterGate: TruckTravelState | null;
  /**
   * Jazda smie viesť spätne cez priechod stojiska svojej trasy (výstup → vstup, abstrahovaný prechod telom), keď k cieľu
   * nevedie cesta priamo — odchod od rampy k bráne, ak je stojisko jediné spojenie (ADR-024).
   */
  readonly passageBack: boolean;
}

function traits(spec: TruckStateTraits): TruckStateTraits {
  return Object.freeze(spec);
}

const ON_ROAD = { waits: false, bayOccupied: false, gateSide: null, queued: false, afterGate: null, passageBack: false } as const;

export const TRUCK_STATE_TRAITS: { readonly [S in TruckState]: TruckStateTraits } = Object.freeze({
  to_gate: traits({ ...ON_ROAD, motion: 'drive', stop: 'gate', holdsBay: true, holdsDock: false, claimsCargo: true, cargo: 'empty', gateSide: 'entry' }),
  gate_queue: traits({ ...ON_ROAD, motion: 'park', stop: 'gate', holdsBay: true, holdsDock: false, claimsCargo: true, cargo: 'empty', gateSide: 'entry', queued: true, afterGate: 'to_bay' }),
  to_bay: traits({ ...ON_ROAD, motion: 'drive', stop: 'waiting_area', holdsBay: true, holdsDock: false, claimsCargo: true, cargo: 'empty' }),
  waiting: traits({ ...ON_ROAD, motion: 'park', waits: true, stop: 'waiting_area', holdsBay: true, bayOccupied: true, holdsDock: false, claimsCargo: true, cargo: 'empty' }),
  to_dock: traits({ ...ON_ROAD, motion: 'drive', stop: 'ramp', holdsBay: false, holdsDock: true, claimsCargo: true, cargo: 'empty' }),
  loading: traits({ ...ON_ROAD, motion: 'park', waits: true, stop: 'ramp', holdsBay: false, holdsDock: true, claimsCargo: true, cargo: 'loading' }),
  to_gate_out: traits({ ...ON_ROAD, motion: 'drive', stop: 'gate', holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full', gateSide: 'exit', passageBack: true }),
  gate_queue_out: traits({ ...ON_ROAD, motion: 'park', stop: 'gate', holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full', gateSide: 'exit', queued: true, afterGate: 'to_portal' }),
  to_portal: traits({ ...ON_ROAD, motion: 'drive', stop: 'portal', holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full' }),
  exited: traits({ ...ON_ROAD, motion: 'park', stop: null, holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full' }),
  no_path: traits({ ...ON_ROAD, motion: 'halt', waits: true, stop: null, holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'empty' }),
} as const);

/** Cieľ udalosti prechodu (`world.events`). */
export interface TruckStateEvents {
  emit(event: TruckStateChangedEvent): void;
}

/**
 * Prechod stavu kamióna s udalosťou: `truck.transition(to)` (tabuľka, pri chybe sa nič nezmení ani neemituje) a potom
 * `TruckStateChanged { truckId, from, to }`. Jediná cesta, ktorou systémy menia stav kamióna.
 */
export function changeTruckState(events: TruckStateEvents, truck: Truck, to: TruckState): void {
  const from = truck.state;
  truck.transition(to);
  events.emit({ type: 'TruckStateChanged', truckId: truck.id, from, to });
}
