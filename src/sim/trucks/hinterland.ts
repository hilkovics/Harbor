/**
 * Vnútrozemie — miesto mimo mapy za road portálom, odkiaľ kamióny všetkých misií prichádzajú do prístavu (F6d, ADR-035). Kamión sa do prístavu
 * nedostane len tak: je do neho **vpustený s rezerváciou** (vjazd), a kým ju nemá, čaká vo vnútrozemí — nie na mape, nie v stojisku, takže
 * neblokuje bays, bránu ani staging rampy. Podmienky vjazdu podľa misie (`trucks/hinterland-admit.ts`):
 * - **odvoz** (`pickup` — import čakajúci na docku, `collect` — výdaj prázdneho): voľné stojisko (kamióny na odvoz smú obsadiť aj stojiská
 *   rezervované kvótou `WaitingArea.pickupReservedBays`); `collect` navyše dostupný prázdny kontajner jeho linky;
 * - **dovoz** (`delivery` — export, návrat prázdneho): voľné stojisko nad kvótou pre odvoz, zaručené miesto na vyloženie na docku
 *   (`DockIntake`) a zaručené miesto v sklade / depe po odpočítaní kontajnerov na ceste (`trucks/hinterland-room.ts`).
 *
 * **Čakajúci kamióny nie sú samostatný zoznam**, ale splatné položky plánov, ktoré už v save sú: `emptyFlow.returnPlan` (návrat prázdneho),
 * `emptyFlow.pickupPlan` (výdaj prázdneho) a `arrivalPlan` bookingov (export). Položka s `dueTick ≤ tick` je kamión, ktorý vo vnútrozemí
 * čaká od `dueTick`; vpustený je v tom ticku, keď sú splnené podmienky (plán sa spotrebuje až po vzniku kamióna). Poradie je FIFO podľa `dueTick`
 * a pri zhode podľa poradia plánu (kontrakty vzostupne podľa id) — deterministické a bez druhej kópie stavu. Pickup kamióny nečakajú v zozname:
 * vznikajú podľa dopytu (náklad na docku), a keď žiadny bay nie je voľný, dopyt sa len počíta (`pickupBayStarvationTicks`).
 *
 * Táto trieda drží len **počítadlá čakania** (v save, `WorldState.hinterland`): počet a súčet a maximum čakania vpustených kamiónov podľa misie,
 * počet tých, čo sa vzdali (`turnedAway`), a ticky, v ktorých dopyt po kamióne na odvoz nemal voľný bay. Nič z toho neovplyvňuje správanie
 * simulácie — len ich číta UI a `simrun`.
 */
import type { TruckMission } from './truck-fsm';

/** Misie, ktoré čakajú vo vnútrozemí vo fronte plánu (pickup vzniká podľa dopytu). */
export type WaitingMission = Exclude<TruckMission, 'pickup'>;

/** Počítadlá čakania jednej misie (v save). */
export interface MissionWaitState {
  /** Počet vpustených kamiónov. */
  readonly admitted: number;
  /** Súčet čakania vpustených kamiónov (ticky od `dueTick` po vjazd). */
  readonly waitTicksTotal: number;
  /** Najdlhšie čakanie vpusteného kamióna (ticky). */
  readonly waitTicksMax: number;
  /** Počet kamiónov, ktoré sa vzdali vo vnútrozemí bez vjazdu (`collect` po `emptyPickupMaxWaitHours`, návrat prázdneho bez miesta v depe). */
  readonly turnedAway: number;
}

/** Počítadlá času kamiónov v termináli — TTT (R4, ADR-041; metrika `truckTurnTimeAvgMin`): odchody výstupnou bránou, súčet a maximum ticku od vstupnej brány po výstupnú. */
export interface TruckTurnState {
  readonly trucks: number;
  readonly ticksTotal: number;
  readonly ticksMax: number;
}

/** Kľúče `TruckTurnState` v poradí `getState()`. */
export const TRUCK_TURN_KEYS: readonly (keyof TruckTurnState)[] = ['trucks', 'ticksTotal', 'ticksMax'];

/** Stav vnútrozemia v save (`WorldState.hinterland`, v9; od v13 aj TTT). */
export interface HinterlandState {
  readonly delivery: MissionWaitState;
  readonly collect: MissionWaitState;
  /** Ticky, v ktorých mal dopyt po kamióne na odvoz (náklad na docku) a žiadne stojisko nebolo voľné. */
  readonly pickupBayStarvationTicks: number;
  /** TTT kamiónov, ktoré prešli výstupnou bránou (WorldState v13). */
  readonly truckTurn: TruckTurnState;
}

/** Kľúče `HinterlandState` v poradí `getState()`. */
export const HINTERLAND_STATE_KEYS: readonly (keyof HinterlandState)[] = ['delivery', 'collect', 'pickupBayStarvationTicks', 'truckTurn'];
/** Kľúče `MissionWaitState` v poradí `getState()`. */
export const MISSION_WAIT_KEYS: readonly (keyof MissionWaitState)[] = ['admitted', 'waitTicksTotal', 'waitTicksMax', 'turnedAway'];

/** Misie s počítadlami čakania v poradí save. */
export const WAITING_MISSIONS: readonly WaitingMission[] = ['delivery', 'collect'];

const EMPTY_MISSION_WAIT: MissionWaitState = Object.freeze({ admitted: 0, waitTicksTotal: 0, waitTicksMax: 0, turnedAway: 0 });

/** Prázdny stav (nová hra). */
export function emptyHinterlandState(): HinterlandState {
  return { delivery: { ...EMPTY_MISSION_WAIT }, collect: { ...EMPTY_MISSION_WAIT }, pickupBayStarvationTicks: 0, truckTurn: { trucks: 0, ticksTotal: 0, ticksMax: 0 } };
}

interface MutableMissionWait {
  admitted: number;
  waitTicksTotal: number;
  waitTicksMax: number;
  turnedAway: number;
}

export class Hinterland {
  private readonly missions: { readonly [M in WaitingMission]: MutableMissionWait };
  private starvationTicks: number;
  private turn: { trucks: number; ticksTotal: number; ticksMax: number };
  /** Tick, v ktorom sa naposledy započítal nedostatok bays (každý tick najviac raz); nie je v save — save vzniká medzi tickmi. */
  private lastStarvedTick = -1;

  constructor(state: HinterlandState = emptyHinterlandState()) {
    this.missions = { delivery: { ...state.delivery }, collect: { ...state.collect } };
    this.starvationTicks = state.pickupBayStarvationTicks;
    this.turn = { ...state.truckTurn };
  }

  /** Obnova zo save (tvar a hodnoty overil `parseHinterlandState`). */
  static fromState(state: HinterlandState): Hinterland {
    return new Hinterland(state);
  }

  /** Kamión misie `mission` bol vpustený po `waitedTicks` tickoch čakania vo vnútrozemí (0 = vpustený v tom istom ticku, keď prišiel). */
  recordAdmitted(mission: WaitingMission, waitedTicks: number): void {
    const wait = this.missions[mission];
    wait.admitted += 1;
    wait.waitTicksTotal += waitedTicks;
    if (waitedTicks > wait.waitTicksMax) wait.waitTicksMax = waitedTicks;
  }

  /** Kamión misie `mission` sa vzdal vo vnútrozemí bez vjazdu. */
  recordTurnedAway(mission: WaitingMission): void {
    this.missions[mission].turnedAway += 1;
  }

  /** Kamión prešiel výstupnou bránou po `ticks` tickoch od príchodu k vstupnej bráne (TTT). */
  recordTurn(ticks: number): void {
    this.turn.trucks += 1;
    this.turn.ticksTotal += ticks;
    if (ticks > this.turn.ticksMax) this.turn.ticksMax = ticks;
  }

  /** Počet kamiónov s odmeraným TTT. */
  get turnTrucks(): number {
    return this.turn.trucks;
  }

  /** Súčet TTT (ticky). */
  get turnTicksTotal(): number {
    return this.turn.ticksTotal;
  }

  /** Najdlhší TTT (ticky). */
  get turnTicksMax(): number {
    return this.turn.ticksMax;
  }

  /** Dopyt po kamióne na odvoz nemal v ticku `tick` voľný bay (každý tick najviac raz). */
  recordPickupStarved(tick: number): void {
    if (tick === this.lastStarvedTick) return;
    this.lastStarvedTick = tick;
    this.starvationTicks += 1;
  }

  /** Počet vpustených kamiónov misie. */
  admitted(mission: WaitingMission): number {
    return this.missions[mission].admitted;
  }

  /** Počet kamiónov misie, ktoré sa vzdali vo vnútrozemí. */
  turnedAway(mission: WaitingMission): number {
    return this.missions[mission].turnedAway;
  }

  /** Súčet čakania vpustených kamiónov misie (ticky). */
  waitTicksTotal(mission: WaitingMission): number {
    return this.missions[mission].waitTicksTotal;
  }

  /** Najdlhšie čakanie vpusteného kamióna misie (ticky). */
  waitTicksMax(mission: WaitingMission): number {
    return this.missions[mission].waitTicksMax;
  }

  /** Ticky, v ktorých dopyt po kamióne na odvoz nemal voľný bay. */
  get pickupBayStarvationTicks(): number {
    return this.starvationTicks;
  }

  /** Čistý JSON stav pre save (nová kópia). */
  getState(): HinterlandState {
    const copy = (wait: MutableMissionWait): MissionWaitState => ({
      admitted: wait.admitted,
      waitTicksTotal: wait.waitTicksTotal,
      waitTicksMax: wait.waitTicksMax,
      turnedAway: wait.turnedAway,
    });
    return { delivery: copy(this.missions.delivery), collect: copy(this.missions.collect), pickupBayStarvationTicks: this.starvationTicks, truckTurn: { ...this.turn } };
  }
}
