/**
 * Stavový automat kamióna (ARCHITECTURE §7.5; docs/TERMINAL_2.md §6.4, §6.5, §8; CLAUDE.md konvencia FSM; ADR-024, ADR-041): stavy, explicitná tabuľka povolených prechodov `TRUCK_TRANSITIONS`
 * a vlastnosti stavov `TRUCK_STATE_TRAITS`. Žiadne skryté prechody — stav mení výlučne `Truck.transition(to)`, ktorý prechod overí v tabuľke.
 *
 * Návšteva s lístkom (R4, ADR-041): (spawn na road portáli) buď `to_gate`, alebo `to_pre_gate` → `pre_gate` (mimo cesty v radovom pruhu plochy) → `to_gate` → `gate_queue` →
 * `gate_pass` (kroky OCR / kontrola / lístok) → buď `to_tp` (lístok mal rezervované odovzdávacie miesto), alebo `to_holding` → `holding` (odstavná plocha: kamión prišiel pred termínom
 * alebo TP je obsadené; TOS ho zavolá `holding → to_tp`, keď je kontajner pripravený a TP voľné) → `at_tp` (TP v pruhu RTG bloku, kamión stojí na ceste) alebo `at_edge_tp` (TP na hrane
 * bloku, kde obsluhuje straddle carrier; kamión je abstraktne v module, mimo cesty). Na TP prebehne v `Truck.phase`: bezpečná zóna → (unlashing) → odovzdanie (stroj / vozidlo) →
 * bezpečná zóna → (lashing). Potom buď druhá zastávka (**dual transaction**, `at_* → to_tp`, jeden lístok), alebo `to_gate_out` → `gate_queue_out` → `gate_pass_out` (váha, sken,
 * plomba) → `to_portal` → `exited` (jednotky `in_truck → exported`, kamión zmizne).
 *
 * **Doprava bez prekrývania** (ADR-037, R1): kamión drží pruhové sloty (`holdsRoad`) v jazde, vo fronte brány (`gate_queue*`), na TP v pruhu bloku (`at_tp`) a v `no_path`; mimo cesty je
 * v predbránovej ploche, počas prechodu bránou, v odstavnej ploche a na TP na hrane bloku (`at_edge_tp`) — výjazd z nich vyžaduje voľný slot výjazdovej bunky.
 * Jazdné stavy (`to_*`) prejdú do `no_path`, keď k cieľu nevedie cesta; z `no_path` sa kamión vráti presne do stavu, z ktorého vypadol (`Truck.resume`).
 *
 * **Misia kamióna** (F6a, ADR-032; F6c, ADR-034): `pickup` (príde prázdny, na TP naloží import), `delivery` (príde naložený exportom alebo prázdnym kontajnerom, na TP vyloží; po vyložení buď
 * naloží import na ďalšom TP — misia sa zmení na `pickup`, `becomePickup` — alebo odíde prázdny) a `collect` (po prázdny kontajner linky z depa). Vlastnosti stavu závisia od misie
 * (`truckStateTraits(mission, state)`).
 */
import type { TruckStateChangedEvent } from '../events/sim-event';
import type { CarrierMotion, MotionTraits } from '../movement/motion-check';
import type { Truck } from './truck';

/** Stavy kamióna v poradí životného cyklu (`exited` je prechodný — kamión v ňom zmizne v tom istom kroku). */
export const TRUCK_STATES = [
  'to_pre_gate',
  'pre_gate',
  'to_gate',
  'gate_queue',
  'gate_pass',
  'to_holding',
  'holding',
  'to_tp',
  'at_tp',
  'at_edge_tp',
  'to_gate_out',
  'gate_queue_out',
  'gate_pass_out',
  'to_portal',
  'exited',
  'no_path',
] as const;
export type TruckState = (typeof TRUCK_STATES)[number];

/** Jazdné stavy — z nich kamión môže vypadnúť do `no_path` a do nich sa vracia. */
export const TRUCK_TRAVEL_STATES = ['to_pre_gate', 'to_gate', 'to_holding', 'to_tp', 'to_gate_out', 'to_portal'] as const;
export type TruckTravelState = (typeof TRUCK_TRAVEL_STATES)[number];

/** Stavy kamióna na TP (obsluha strojom alebo vozidlom, fázy `TpPhase`). */
export const TP_STATES = ['at_tp', 'at_edge_tp'] as const;

/** Povolené prechody `from → [to…]`. */
export const TRUCK_TRANSITIONS: ReadonlyMap<TruckState, readonly TruckState[]> = new Map<TruckState, readonly TruckState[]>([
  ['to_pre_gate', Object.freeze(['pre_gate', 'no_path'] as const)],
  ['pre_gate', Object.freeze(['to_gate'] as const)],
  ['to_gate', Object.freeze(['gate_queue', 'no_path'] as const)],
  // `gate_queue → to_holding | to_tp` bez prechodu: strany brány sa pod čakajúcim kamiónom preklopili (`settleGateQueues`, dodatok ADR-024).
  ['gate_queue', Object.freeze(['gate_pass', 'to_holding', 'to_tp'] as const)],
  ['gate_pass', Object.freeze(['to_holding', 'to_tp'] as const)],
  ['to_holding', Object.freeze(['holding', 'no_path'] as const)],
  ['holding', Object.freeze(['to_tp'] as const)],
  ['to_tp', Object.freeze(['at_tp', 'at_edge_tp', 'no_path'] as const)],
  // `at_* → to_tp`: dual transaction (druhá zastávka, jeden lístok).
  ['at_tp', Object.freeze(['to_gate_out', 'to_tp'] as const)],
  ['at_edge_tp', Object.freeze(['to_gate_out', 'to_tp'] as const)],
  ['to_gate_out', Object.freeze(['gate_queue_out', 'no_path'] as const)],
  ['gate_queue_out', Object.freeze(['gate_pass_out', 'to_portal'] as const)],
  ['gate_pass_out', Object.freeze(['to_portal'] as const)],
  ['to_portal', Object.freeze(['exited', 'no_path'] as const)],
  ['exited', Object.freeze([] as const)],
  ['no_path', Object.freeze([...TRUCK_TRAVEL_STATES])],
]);

/** Fázy kamióna na TP (`Truck.phase`, R4, ADR-041 bod 4 a 7): bezpečná zóna pred zdvihom, odistenie (export, prázdny), odovzdanie, bezpečná zóna po zdvihu, zaistenie (import); `depart` = kamión skončil a čaká na voľný výjazd (alebo na rozhodnutie o druhej zastávke). */
export const TP_PHASES = ['safe_in', 'unlash', 'handling', 'safe_out', 'lash', 'depart'] as const;
export type TpPhase = (typeof TP_PHASES)[number];

/** Úloha kamióna na TP: `take` = naložiť zo skladu (import, prázdny pre exportéra), `put` = vyložiť do skladu (export, návrat prázdneho). */
export type TpRole = 'take' | 'put';

/** Úloha na TP podľa misie (tabuľka, nie switch): pickup a collect nakladajú, delivery vykladá. */
export const TP_ROLE_OF_MISSION: { readonly [M in TruckMission]: TpRole } = Object.freeze({ pickup: 'take', delivery: 'put', collect: 'take' });

/** Postupnosť fáz na TP podľa úlohy (tabuľka, nie switch): `take` = zóna → odovzdanie → zóna → lashing, `put` = zóna → unlashing → odovzdanie → zóna. */
export const TP_PHASE_SEQUENCE: { readonly [R in TpRole]: readonly TpPhase[] } = Object.freeze({
  take: Object.freeze(['safe_in', 'handling', 'safe_out', 'lash'] as const),
  put: Object.freeze(['safe_in', 'unlash', 'handling', 'safe_out'] as const),
});

/** Je hodnota fáza TP? */
export function isTpPhase(value: unknown): value is TpPhase {
  return (TP_PHASES as readonly unknown[]).includes(value);
}

/**
 * Je prechod `from → to` kamióna misie `mission` povolený? Tabuľka stavov `TRUCK_TRANSITIONS`; z `at_*` na ďalší TP (`to_tp`) smie len misia, ktorá práve vyložila (`delivery`, dual transaction —
 * volajúci ju pred prechodom zmení na `pickup`, preto sa pre `to_tp` z TP pripúšťa aj `pickup`). (Návrat z `no_path` do správneho stavu stráži `Truck.transition`.)
 */
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

/** Cieľ jazdy / miesto pobytu kamióna; cieľ trasy v kroku 12 (`truckMotionTarget`). */
export type TruckStop = 'pre_gate' | 'gate' | 'holding' | 'tp' | 'portal';

/**
 * Náklad kamióna podľa stavu (§7.5): `empty` 0, `loading` / `unloading` 0 … kapacita (na TP počas odovzdania), `full` = kapacita (pickup po nakládke), `loaded` 1 … kapacita (delivery pred vykládkou),
 * `collected` 0 … kapacita (kamión misie `collect` po nakládke).
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

/** Brána kamióna: vstupná (`gateId`, pruh dnu) alebo výstupná (`gateOutId`, pruh von); kamión vždy čaká na vonkajšej (prvý konektor) a vychádza na vnútornej strane pruhu (R4). */
export type TruckGateSide = 'entry' | 'exit';

/** Čo platí pre kamión v danom stave. Pre `no_path` platia väzby (token, náklad) stavu `resume`. */
export interface TruckStateTraits extends MotionTraits {
  readonly motion: CarrierMotion;
  /**
   * Kamión v stave drží pruhové sloty cesty (`LaneSlots`, ADR-037): v jazde (`to_*`), vo fronte brány (`gate_queue*`), na TP v pruhu bloku (`at_tp`) a bez cesty (`no_path`) —
   * stojaci kamión na ceste je prekážka. Mimo cesty je v predbránovej ploche, počas prechodu bránou, v odstavnej ploche a na TP na hrane bloku (`at_edge_tp`).
   */
  readonly holdsRoad: boolean;
  /** Stav s odpočtom `waitTicks ≥ 1` (fáza na TP, odstavná plocha, nový pokus o cestu). */
  readonly waits: boolean;
  /** Cieľ jazdy / miesto pobytu; `null` = žiadny (`no_path`, `exited`). */
  readonly stop: TruckStop | null;
  /**
   * Kamión drží **token cieľa** — rezervované TP (`Truck.tpCell`) alebo státie odstavnej plochy (`Truck.stall`): od vzniku, kým neodíde z TP (`to_gate_out`). Vďaka tomu vnútri prístavu
   * nikdy nie je viac kamiónov, než kam sa zmestia (TP + státia), a front sa netvorí na ceste (ADR-041 bod 5).
   */
  readonly holdsToken: boolean;
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
  /** Stav po prechode bránou (len pre stavy vo fronte a v prechode); po vstupnej bráne `to_tp` (TOS rozhodne `to_holding`). */
  readonly afterGate: TruckTravelState | null;
  /** Stav prechodu, do ktorého kamión na čele fronty prejde, keď brána prechod začne (len `gate_queue*`). */
  readonly passState: TruckState | null;
  /** Kamión je na TP (`at_tp`, `at_edge_tp`) — beží fáza `Truck.phase`. */
  readonly atTp: boolean;
}

function traits(spec: TruckStateTraits): TruckStateTraits {
  return Object.freeze(spec);
}

/** Základ vlastností stavu: bez čakania, bez brány; každý stav si dopíše `holdsRoad` a ostatné odchýlky. */
const BASE = { waits: false, gateSide: null, queued: false, passing: false, afterGate: null, passState: null, atTp: false } as const;

export const TRUCK_STATE_TRAITS: { readonly [S in TruckState]: TruckStateTraits } = Object.freeze({
  to_pre_gate: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'pre_gate', holdsToken: true, cargo: 'empty' }),
  pre_gate: traits({ ...BASE, motion: 'park', holdsRoad: false, stop: 'pre_gate', holdsToken: true, cargo: 'empty' }),
  to_gate: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'gate', holdsToken: true, cargo: 'empty', gateSide: 'entry' }),
  gate_queue: traits({ ...BASE, motion: 'park', holdsRoad: true, stop: 'gate', holdsToken: true, cargo: 'empty', gateSide: 'entry', queued: true, afterGate: 'to_tp', passState: 'gate_pass' }),
  gate_pass: traits({ ...BASE, motion: 'park', holdsRoad: false, stop: 'gate', holdsToken: true, cargo: 'empty', gateSide: 'entry', passing: true, afterGate: 'to_tp' }),
  to_holding: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'holding', holdsToken: true, cargo: 'empty' }),
  holding: traits({ ...BASE, motion: 'park', holdsRoad: false, waits: true, stop: 'holding', holdsToken: true, cargo: 'empty' }),
  to_tp: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'tp', holdsToken: true, cargo: 'empty' }),
  at_tp: traits({ ...BASE, motion: 'park', holdsRoad: true, waits: true, stop: 'tp', holdsToken: true, cargo: 'loading', atTp: true }),
  at_edge_tp: traits({ ...BASE, motion: 'park', holdsRoad: false, waits: true, stop: 'tp', holdsToken: true, cargo: 'loading', atTp: true }),
  to_gate_out: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'gate', holdsToken: false, cargo: 'full', gateSide: 'exit' }),
  gate_queue_out: traits({ ...BASE, motion: 'park', holdsRoad: true, stop: 'gate', holdsToken: false, cargo: 'full', gateSide: 'exit', queued: true, afterGate: 'to_portal', passState: 'gate_pass_out' }),
  gate_pass_out: traits({ ...BASE, motion: 'park', holdsRoad: false, stop: 'gate', holdsToken: false, cargo: 'full', gateSide: 'exit', passing: true, afterGate: 'to_portal' }),
  to_portal: traits({ ...BASE, motion: 'drive', holdsRoad: true, stop: 'portal', holdsToken: false, cargo: 'full' }),
  exited: traits({ ...BASE, motion: 'park', holdsRoad: false, stop: null, holdsToken: false, cargo: 'full' }),
  no_path: traits({ ...BASE, motion: 'halt', holdsRoad: true, waits: true, stop: null, holdsToken: false, cargo: 'empty' }),
} as const);

/**
 * Vlastnosti stavov kamióna s misiou `delivery`: rovnaké väzby ako `pickup`, ale s nákladom `loaded` od vzniku po príchod na TP, `unloading` na TP a `empty` po ňom
 * (kamión odchádza prázdny; pri dual transaction sa misia zmení na `pickup` pred druhou zastávkou).
 */
export const TRUCK_DELIVERY_STATE_TRAITS: { readonly [S in TruckState]: TruckStateTraits } = Object.freeze({
  to_pre_gate: traits({ ...TRUCK_STATE_TRAITS.to_pre_gate, cargo: 'loaded' }),
  pre_gate: traits({ ...TRUCK_STATE_TRAITS.pre_gate, cargo: 'loaded' }),
  to_gate: traits({ ...TRUCK_STATE_TRAITS.to_gate, cargo: 'loaded' }),
  gate_queue: traits({ ...TRUCK_STATE_TRAITS.gate_queue, cargo: 'loaded' }),
  gate_pass: traits({ ...TRUCK_STATE_TRAITS.gate_pass, cargo: 'loaded' }),
  to_holding: traits({ ...TRUCK_STATE_TRAITS.to_holding, cargo: 'loaded' }),
  holding: traits({ ...TRUCK_STATE_TRAITS.holding, cargo: 'loaded' }),
  to_tp: traits({ ...TRUCK_STATE_TRAITS.to_tp, cargo: 'loaded' }),
  at_tp: traits({ ...TRUCK_STATE_TRAITS.at_tp, cargo: 'unloading' }),
  at_edge_tp: traits({ ...TRUCK_STATE_TRAITS.at_edge_tp, cargo: 'unloading' }),
  to_gate_out: traits({ ...TRUCK_STATE_TRAITS.to_gate_out, cargo: 'empty' }),
  gate_queue_out: traits({ ...TRUCK_STATE_TRAITS.gate_queue_out, cargo: 'empty' }),
  gate_pass_out: traits({ ...TRUCK_STATE_TRAITS.gate_pass_out, cargo: 'empty' }),
  to_portal: traits({ ...TRUCK_STATE_TRAITS.to_portal, cargo: 'empty' }),
  exited: traits({ ...TRUCK_STATE_TRAITS.exited, cargo: 'empty' }),
  no_path: traits({ ...TRUCK_STATE_TRAITS.no_path }),
} as const);

/**
 * Vlastnosti stavov kamióna s misiou `collect` (F6c, ADR-034): väzby ako `pickup`, ale s nákladom `collected` (0 … kapacita) od odchodu z TP po portál.
 */
export const TRUCK_COLLECT_STATE_TRAITS: { readonly [S in TruckState]: TruckStateTraits } = Object.freeze({
  to_pre_gate: traits({ ...TRUCK_STATE_TRAITS.to_pre_gate }),
  pre_gate: traits({ ...TRUCK_STATE_TRAITS.pre_gate }),
  to_gate: traits({ ...TRUCK_STATE_TRAITS.to_gate }),
  gate_queue: traits({ ...TRUCK_STATE_TRAITS.gate_queue }),
  gate_pass: traits({ ...TRUCK_STATE_TRAITS.gate_pass }),
  to_holding: traits({ ...TRUCK_STATE_TRAITS.to_holding }),
  holding: traits({ ...TRUCK_STATE_TRAITS.holding }),
  to_tp: traits({ ...TRUCK_STATE_TRAITS.to_tp }),
  at_tp: traits({ ...TRUCK_STATE_TRAITS.at_tp }),
  at_edge_tp: traits({ ...TRUCK_STATE_TRAITS.at_edge_tp }),
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
