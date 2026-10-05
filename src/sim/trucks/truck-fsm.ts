/**
 * Stavový automat kamióna (ARCHITECTURE §7.5; rozhodnutie orchestrátora F4 č. 6; CLAUDE.md konvencia FSM; ADR-024):
 * stavy, explicitná tabuľka povolených prechodov `TRUCK_TRANSITIONS` a vlastnosti stavov `TRUCK_STATE_TRAITS`.
 * Žiadne skryté prechody — stav mení výlučne `Truck.transition(to)`, ktorý prechod overí v tabuľke.
 *
 * Cyklus: (spawn na road portáli) `to_gate` → (príchod na vonkajšiu bunku vstupnej strany brány) `gate_queue` →
 * (brána začala prechod) `gate_pass` → (prechod skončil a výjazdová bunka je voľná) `to_bay` → (príchod k vstupu stojiska)
 * `waiting` → (povel do docku) `to_dock` → (príchod k docku rampy) `loading` → (naložené) `to_gate_out` → (príchod
 * k výstupnej strane brány) `gate_queue_out` → (brána začala prechod) `gate_pass_out` → (prechod skončil) `to_portal` →
 * (príchod na portál) `exited` — jednotky `in_truck → exported`, kamión zmizne.
 *
 * **Doprava bez prekrývania** (ADR-037, R1): kamión drží pruhové sloty (`holdsRoad`) v jazde, vo fronte brány
 * (`gate_queue*`) a v `no_path`; mimo cesty je v stojisku (`waiting`), v docku (`loading`, `unloading`) a počas prechodu
 * bránou (`gate_pass*`) — vjazd do modulu uvoľní celé telo, výjazd (zo stojiska, z docku, z brány) vyžaduje voľný slot
 * výjazdovej bunky, inak kamión čaká vnútri a bay, dock alebo brána ostávajú obsadené.
 * Povel do docku (ADR-029): po pobyte v stojisku odíde prvý pripravený kamión svojho docku (FIFO podľa id), keď je dock
 * voľný a je na ňom celý náklad kamióna; inak čaká v bayi. Dock drží až od tohto povelu, nárok na náklad od spawnu.
 * Jazdné stavy (`to_*`) prejdú do `no_path`, keď k cieľu nevedie cesta; z `no_path` sa kamión vráti presne do stavu,
 * z ktorého vypadol (`Truck.resume`).
 *
 * **Misia kamióna** (F6a, ADR-032 bod 4 a 12): `pickup` (F4 — príde prázdny, naloží import z docku) alebo `delivery`
 * (príde naložený exportom, `to_dock → unloading`: vyloží na dock rampy, `in_truck → at_ramp`). Po vykládke buď
 * naloží import na tom istom docku (**dual transaction**: misia sa zmení na `pickup`, `unloading → loading`), alebo
 * odíde prázdny (`unloading → to_gate_out`). Vlastnosti stavu závisia od misie (`truckStateTraits(mission, state)`):
 * `TRUCK_STATE_TRAITS` sú vlastnosti `pickup`, `TRUCK_DELIVERY_STATE_TRAITS` vlastnosti `delivery`.
 *
 * **Misia `collect`** (F6c, ADR-034 dodatok T6C-02): kamión exportéra po **prázdny kontajner** linky (výdaj z depa). Príde prázdny,
 * v stojisku čaká, kým mu dispatcher pridelí prázdny a ten sa objaví na jeho docku (`waiting → to_dock → loading`: nakládka
 * pridelenej jednotky `at_ramp → in_truck`), a odíde s ním (`exported`). Bez pridelenej jednotky po `emptyPickupMaxWaitHours` odíde
 * prázdny priamo zo stojiska (`waiting → to_gate_out`, bez docku). Nemá nárok na náklad docku (`claimsCargo: false`) — prázdny na docku
 * nie je „náklad na odvoz“ (`isPickupCargo`), kamión naň ukazuje poverením v `World.emptyFlow`.
 */
import type { TruckStateChangedEvent } from '../events/sim-event';
import type { CarrierMotion, MotionTraits } from '../movement/motion-check';
import type { Truck } from './truck';

/** Stavy kamióna v poradí životného cyklu (`exited` je prechodný — kamión v ňom zmizne v tom istom kroku). */
export const TRUCK_STATES = [
  'to_gate',
  'gate_queue',
  'gate_pass',
  'to_bay',
  'waiting',
  'to_dock',
  'loading',
  'unloading',
  'to_gate_out',
  'gate_queue_out',
  'gate_pass_out',
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
  // `gate_queue → to_bay` bez prechodu: strany brány sa pod čakajúcim kamiónom preklopili (`settleGateQueues`, dodatok ADR-024).
  ['gate_queue', Object.freeze(['gate_pass', 'to_bay'] as const)],
  ['gate_pass', Object.freeze(['to_bay'] as const)],
  ['to_bay', Object.freeze(['waiting', 'no_path'] as const)],
  // `waiting → to_gate_out`: kamión misie `collect` bez prideleného prázdneho po čakaní odíde zo stojiska rovno k bráne (nikdy nie pickup / delivery —
  // to vynucuje `isTruckTransitionAllowed` podľa `TRUCK_MISSION_GIVES_UP`).
  ['waiting', Object.freeze(['to_dock', 'to_gate_out'] as const)],
  ['to_dock', Object.freeze(['loading', 'unloading', 'no_path'] as const)],
  ['loading', Object.freeze(['to_gate_out'] as const)],
  ['unloading', Object.freeze(['loading', 'to_gate_out'] as const)],
  ['to_gate_out', Object.freeze(['gate_queue_out', 'no_path'] as const)],
  ['gate_queue_out', Object.freeze(['gate_pass_out', 'to_portal'] as const)],
  ['gate_pass_out', Object.freeze(['to_portal'] as const)],
  ['to_portal', Object.freeze(['exited', 'no_path'] as const)],
  ['exited', Object.freeze([] as const)],
  ['no_path', Object.freeze([...TRUCK_TRAVEL_STATES])],
]);

/**
 * Smie sa misia vzdať čakania v stojisku (`waiting → to_gate_out`, odchod rovno k bráne von bez docku)? Tabuľka podľa misie (pravidlo 7): len
 * `collect` (výdaj prázdneho po `emptyPickupMaxWaitHours`); `pickup` a `delivery` čakajú, kým nepríde ich dock (T6C-07b, review src/sim, m2).
 */
export const TRUCK_MISSION_GIVES_UP: { readonly [M in TruckMission]: boolean } = Object.freeze({ pickup: false, delivery: false, collect: true });

/**
 * Smie misia obsadiť stojisko rezervované pre odvoz (kvóta `WaitingArea.pickupReservedBays`, F6d, ADR-035)? Tabuľka podľa misie (pravidlo 7): misie,
 * ktoré náklad z prístavu **odvážajú** (`pickup` — import, `collect` — výdaj prázdneho), áno; `delivery` (export, návrat prázdneho náklad privezie)
 * nesmie obsadiť posledné rezervované stojiská — inak by dovážajúce kamióny zaplnili stojisko a kamióny na odvoz importu by sa nedostali dnu.
 */
export const TRUCK_MISSION_USES_PICKUP_BAYS: { readonly [M in TruckMission]: boolean } = Object.freeze({ pickup: true, delivery: false, collect: true });

/**
 * Je prechod `from → to` kamióna misie `mission` povolený? Tabuľka stavov `TRUCK_TRANSITIONS` a pre vzdanie sa čakania (`waiting → to_gate_out`)
 * navyše vlastnosť misie `TRUCK_MISSION_GIVES_UP`. (Návrat z `no_path` do správneho stavu stráži `Truck.transition`.)
 */
export function isTruckTransitionAllowed(from: TruckState, to: TruckState, mission: TruckMission): boolean {
  if (!(TRUCK_TRANSITIONS.get(from)?.includes(to) ?? false)) return false;
  return from === 'waiting' && to === 'to_gate_out' ? TRUCK_MISSION_GIVES_UP[mission] : true;
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

/**
 * Náklad kamióna podľa stavu (§7.5): `empty` 0, `loading` / `unloading` 0 … kapacita (počas nakládky / vykládky),
 * `full` = kapacita (pickup po nakládke), `loaded` 1 … kapacita (delivery pred vykládkou — F6a, ADR-032), `collected` 0 … kapacita
 * (kamión misie `collect` po nakládke alebo po vzdaní sa — F6c, ADR-034).
 */
export type TruckCargo = 'empty' | 'loading' | 'unloading' | 'full' | 'loaded' | 'collected';

/**
 * Misia kamióna: odvoz importu (`pickup`, F4), dovoz exportu alebo prázdneho kontajnera (`delivery`, F6a, F6c) a výdaj prázdneho
 * kontajnera exportérovi (`collect`, F6c, ADR-034).
 */
export const TRUCK_MISSIONS = ['pickup', 'delivery', 'collect'] as const;
export type TruckMission = (typeof TRUCK_MISSIONS)[number];

/** Je hodnota misia kamióna? */
export function isTruckMission(value: unknown): value is TruckMission {
  return (TRUCK_MISSIONS as readonly unknown[]).includes(value);
}

/** Strana brány: vstupná (z portálu, fronta dnu) alebo výstupná (z areálu, fronta von). */
export type TruckGateSide = 'entry' | 'exit';

/** Čo platí pre kamión v danom stave. Pre `no_path` platia väzby (bay, dock, náklad) stavu `resume`. */
export interface TruckStateTraits extends MotionTraits {
  readonly motion: CarrierMotion;
  /**
   * Kamión v stave drží pruhové sloty cesty (`LaneSlots`, ADR-037): v jazde (`to_*`), vo fronte brány (`gate_queue*`) a bez cesty
   * (`no_path`) — stojaci kamión na ceste je prekážka. Mimo cesty je kamión v stojisku, v docku a počas prechodu bránou
   * (`waiting`, `loading`, `unloading`, `gate_pass*`) a vtedy nedrží nič.
   */
  readonly holdsRoad: boolean;
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
  /**
   * Delivery kamión drží rezerváciu staging miesta svojho docku pre každú jednotku, ktorú ešte nevyložil (F6a, ADR-032 bod
   * 13): od povelu do docku po koniec vykládky (`to_dock`, `unloading`). Kapacita docku tak nikdy nechýba, keď kamión
   * vykladá; rezervácia klesá s každou vyloženou jednotkou (`commit`). Pickup kamión nikdy.
   */
  readonly holdsIntake: boolean;
  readonly cargo: TruckCargo;
  /** Strana brány, ku ktorej kamión ide (`to_gate`, `to_gate_out`) alebo pri ktorej čaká vo fronte; inak `null`. */
  readonly gateSide: TruckGateSide | null;
  /** Kamión stojí vo FIFO fronte svojej brány na jej vonkajšej prístupovej bunke (`gate_queue`, `gate_queue_out`). */
  readonly queued: boolean;
  /**
   * Kamión prechádza bránou (`gate_pass`, `gate_pass_out`): je mimo cesty, ale ako čelo fronty ostáva v jej zozname, kým prechod
   * neskončí a výjazdová bunka nie je voľná (`TruckGate.completePass`). Členstvo vo fronte brány = `queued || passing`.
   */
  readonly passing: boolean;
  /** Stav po prechode bránou (len pre stavy vo fronte a v prechode). */
  readonly afterGate: TruckTravelState | null;
  /** Stav prechodu, do ktorého kamión na čele fronty prejde, keď brána prechod začne (len `gate_queue*`). */
  readonly passState: TruckState | null;
  /**
   * Jazda smie viesť spätne cez priechod stojiska svojej trasy (výstup → vstup, abstrahovaný prechod telom), keď k cieľu
   * nevedie cesta priamo — odchod od rampy k bráne, ak je stojisko jediné spojenie (ADR-024).
   */
  readonly passageBack: boolean;
}

function traits(spec: TruckStateTraits): TruckStateTraits {
  return Object.freeze(spec);
}

/** Základ vlastností stavu: bez čakania, bez brány; každý stav si dopíše `holdsRoad` a ostatné odchýlky. */
const BASE = { waits: false, bayOccupied: false, gateSide: null, queued: false, passing: false, afterGate: null, passState: null, passageBack: false, holdsIntake: false } as const;

export const TRUCK_STATE_TRAITS: { readonly [S in TruckState]: TruckStateTraits } = Object.freeze({
  to_gate: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'gate', holdsBay: true, holdsDock: false, claimsCargo: true, cargo: 'empty', gateSide: 'entry' }),
  gate_queue: traits({ ...BASE, motion: 'park', holdsRoad: true, stop: 'gate', holdsBay: true, holdsDock: false, claimsCargo: true, cargo: 'empty', gateSide: 'entry', queued: true, afterGate: 'to_bay', passState: 'gate_pass' }),
  gate_pass: traits({ ...BASE, motion: 'park', holdsRoad: false, stop: 'gate', holdsBay: true, holdsDock: false, claimsCargo: true, cargo: 'empty', gateSide: 'entry', passing: true, afterGate: 'to_bay' }),
  to_bay: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'waiting_area', holdsBay: true, holdsDock: false, claimsCargo: true, cargo: 'empty' }),
  waiting: traits({ ...BASE, motion: 'park', holdsRoad: false, waits: true, stop: 'waiting_area', holdsBay: true, bayOccupied: true, holdsDock: false, claimsCargo: true, cargo: 'empty' }),
  to_dock: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'ramp', holdsBay: false, holdsDock: true, claimsCargo: true, cargo: 'empty' }),
  loading: traits({ ...BASE, motion: 'park', holdsRoad: false, waits: true, stop: 'ramp', holdsBay: false, holdsDock: true, claimsCargo: true, cargo: 'loading' }),
  // Pickup kamión vo vykládke nebýva (vykladá len delivery); riadok drží úplnosť tabuľky.
  unloading: traits({ ...BASE, motion: 'park', holdsRoad: false, waits: true, stop: 'ramp', holdsBay: false, holdsDock: true, claimsCargo: false, cargo: 'unloading' }),
  to_gate_out: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'gate', holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full', gateSide: 'exit', passageBack: true }),
  gate_queue_out: traits({ ...BASE, motion: 'park', holdsRoad: true, stop: 'gate', holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full', gateSide: 'exit', queued: true, afterGate: 'to_portal', passState: 'gate_pass_out' }),
  gate_pass_out: traits({ ...BASE, motion: 'park', holdsRoad: false, stop: 'gate', holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full', gateSide: 'exit', passing: true, afterGate: 'to_portal' }),
  to_portal: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'portal', holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full' }),
  exited: traits({ ...BASE, motion: 'park', holdsRoad: false, stop: null, holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'full' }),
  no_path: traits({ ...BASE, motion: 'halt', holdsRoad: true, waits: true, stop: null, holdsBay: false, holdsDock: false, claimsCargo: false, cargo: 'empty' }),
} as const);

/**
 * Vlastnosti stavov kamióna s misiou `delivery` (ADR-032 bod 4): rovnaké väzby (bay, dock, brána, pohyb) ako `pickup`,
 * ale bez nároku na náklad docku a s nákladom `loaded` od spawnu po príchod k docku, `unloading` pri vykládke
 * a `empty` po nej (kamión odchádza prázdny; pri dual transaction sa misia zmení na `pickup` ešte pred `loading`).
 */
export const TRUCK_DELIVERY_STATE_TRAITS: { readonly [S in TruckState]: TruckStateTraits } = Object.freeze({
  to_gate: traits({ ...TRUCK_STATE_TRAITS.to_gate, claimsCargo: false, cargo: 'loaded' }),
  gate_queue: traits({ ...TRUCK_STATE_TRAITS.gate_queue, claimsCargo: false, cargo: 'loaded' }),
  gate_pass: traits({ ...TRUCK_STATE_TRAITS.gate_pass, claimsCargo: false, cargo: 'loaded' }),
  to_bay: traits({ ...TRUCK_STATE_TRAITS.to_bay, claimsCargo: false, cargo: 'loaded' }),
  waiting: traits({ ...TRUCK_STATE_TRAITS.waiting, claimsCargo: false, cargo: 'loaded' }),
  to_dock: traits({ ...TRUCK_STATE_TRAITS.to_dock, claimsCargo: false, holdsIntake: true, cargo: 'loaded' }),
  // Delivery v nakládke nebýva (misia sa pred `loading` zmení na pickup); riadok drží úplnosť tabuľky.
  loading: traits({ ...TRUCK_STATE_TRAITS.loading }),
  unloading: traits({ ...TRUCK_STATE_TRAITS.unloading, holdsIntake: true }),
  to_gate_out: traits({ ...TRUCK_STATE_TRAITS.to_gate_out, cargo: 'empty' }),
  gate_queue_out: traits({ ...TRUCK_STATE_TRAITS.gate_queue_out, cargo: 'empty' }),
  gate_pass_out: traits({ ...TRUCK_STATE_TRAITS.gate_pass_out, cargo: 'empty' }),
  to_portal: traits({ ...TRUCK_STATE_TRAITS.to_portal, cargo: 'empty' }),
  exited: traits({ ...TRUCK_STATE_TRAITS.exited, cargo: 'empty' }),
  no_path: traits({ ...TRUCK_STATE_TRAITS.no_path }),
} as const);

/**
 * Vlastnosti stavov kamióna s misiou `collect` (F6c, ADR-034): väzby (bay, dock, brána, pohyb) ako `pickup`, ale bez nároku na náklad
 * docku (prázdny, ktorý mu dispatcher pridelí, nie je náklad na odvoz) a s nákladom `collected` (0 … kapacita) od nakládky po portál —
 * kamión, ktorý sa vzdal, odchádza prázdny. Vykládku nepozná (riadok `unloading` drží úplnosť tabuľky).
 */
export const TRUCK_COLLECT_STATE_TRAITS: { readonly [S in TruckState]: TruckStateTraits } = Object.freeze({
  to_gate: traits({ ...TRUCK_STATE_TRAITS.to_gate, claimsCargo: false }),
  gate_queue: traits({ ...TRUCK_STATE_TRAITS.gate_queue, claimsCargo: false }),
  gate_pass: traits({ ...TRUCK_STATE_TRAITS.gate_pass, claimsCargo: false }),
  to_bay: traits({ ...TRUCK_STATE_TRAITS.to_bay, claimsCargo: false }),
  waiting: traits({ ...TRUCK_STATE_TRAITS.waiting, claimsCargo: false }),
  to_dock: traits({ ...TRUCK_STATE_TRAITS.to_dock, claimsCargo: false }),
  loading: traits({ ...TRUCK_STATE_TRAITS.loading, claimsCargo: false }),
  unloading: traits({ ...TRUCK_STATE_TRAITS.unloading }),
  to_gate_out: traits({ ...TRUCK_STATE_TRAITS.to_gate_out, cargo: 'collected' }),
  gate_queue_out: traits({ ...TRUCK_STATE_TRAITS.gate_queue_out, cargo: 'collected' }),
  gate_pass_out: traits({ ...TRUCK_STATE_TRAITS.gate_pass_out, cargo: 'collected' }),
  to_portal: traits({ ...TRUCK_STATE_TRAITS.to_portal, cargo: 'collected' }),
  exited: traits({ ...TRUCK_STATE_TRAITS.exited, cargo: 'collected' }),
  no_path: traits({ ...TRUCK_STATE_TRAITS.no_path }),
} as const);

/** Tabuľky vlastností podľa misie (dáta, nie switch). */
export const TRUCK_MISSION_STATE_TRAITS: { readonly [M in TruckMission]: { readonly [S in TruckState]: TruckStateTraits } } = Object.freeze({
  pickup: TRUCK_STATE_TRAITS,
  delivery: TRUCK_DELIVERY_STATE_TRAITS,
  collect: TRUCK_COLLECT_STATE_TRAITS,
});

/** Vlastnosti stavu `state` pre kamión s misiou `mission`. */
export function truckStateTraits(mission: TruckMission, state: TruckState): TruckStateTraits {
  return TRUCK_MISSION_STATE_TRAITS[mission][state];
}

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
