/**
 * Kamión (ARCHITECTURE §4.2 `trucks.json`, §7.1, §7.5, §7.8 bod 3; rozhodnutia orchestrátora F4 č. 2, 3, 5, 6; ADR-024)
 * — vozidlo zvonka mapy, ktoré príde road portálom, prejde bránou, počká v stojisku, naloží jednotky z docku rampy
 * (`at_ramp → in_truck`) a odíde bránou a portálom z mapy (`in_truck → exported`). Jednotky v kamióne vedie výlučne
 * `CargoLedger` (`in_truck`, pravidlo 2); kamión si ich neeviduje.
 *
 * - **Pohyb** dedí zo zdieľaného `Carrier` (`src/sim/movement`) — ten istý kód ako interné vozidlá: trasa po cestách,
 *   jednosmerky, rýchlosť podľa typu cesty, `no_path` + preplánovanie, `PROGRESS_NOISE` (ADR-019, ADR-020, ADR-021).
 *   Prechod telom brány a stojiska je abstrahovaný (ADR-011): kamión sa po ňom objaví na výstupnej bunke (`jumpTo`).
 * - **Väzby** (nemenné od spawnu): rampa a dock, na ktorého náklad má kamión nárok (`rampId`, `dock`; ADR-029 — dock
 *   samotný drží až od povelu do docku), brána (`gateId`) a stojisko (`waitingAreaId`) trasy z `World.landsideRoutes`.
 *   `bay` = rezervovaný bay stojiska, kým ho kamión drží (`TRUCK_STATE_TRAITS.holdsBay`), inak `null`.
 * - `resume` = jazdný stav, do ktorého sa kamión vráti z `no_path` (mimo `no_path` `null`). Väzby stavu (bay, dock,
 *   náklad) sa v `no_path` riadia `resume` (`effectiveState`).
 * - `mission` (F6a, ADR-032): `pickup` (odvoz importu) alebo `delivery` (dovoz exportu); vlastnosti stavu
 *   (`bonds`, `traits`) sú podľa misie (`truckStateTraits`). Delivery kamión sa pri dual transaction zmení na pickup
 *   (`becomePickup`, len vo vykládke).
 *
 * Stav je privátny s getterom `state` a mení ho len `transition` podľa `TRUCK_TRANSITIONS`; trasu len metódy `Carrier`.
 */
import type { EntityId } from '../core/entity-id';
import type { TruckDef } from '../defs/types';
import type { Rotation } from '../grid/rotation';
import { Carrier, carrierPoseProblem, carrierRouteProblem, type CarrierInit } from '../movement/carrier';
import { TruckError } from './truck-error';
import {
  TRUCK_TRANSITIONS,
  isTruckMission,
  isTruckState,
  isTruckTransitionAllowed,
  isTruckTravelState,
  truckStateTraits,
  type TruckMission,
  type TruckState,
  type TruckStateTraits,
  type TruckTravelState,
} from './truck-fsm';

/** Kamión v save (`WorldState.trucks[i]`, WorldState v4, ADR-024) — čistý JSON; poradie v save = vzostupne podľa id. */
export interface SerializedTruck {
  readonly id: number;
  readonly defId: string;
  /** Misia kamióna (WorldState v7, ADR-032). */
  readonly mission: TruckMission;
  readonly state: TruckState;
  readonly x: number;
  readonly y: number;
  readonly heading: Rotation;
  readonly rampId: number;
  readonly dock: number;
  readonly gateId: number;
  readonly waitingAreaId: number;
  /** Rezervovaný bay stojiska (v stavoch s `holdsBay`), inak `null`. */
  readonly bay: number | null;
  /** Stav, do ktorého sa kamión vráti z `no_path`; mimo `no_path` `null`. */
  readonly resume: TruckTravelState | null;
  /** Zvyšok trasy: `[cell, …cieľové bunky]` (indexy buniek); obnova neplánuje znova (ADR-019). */
  readonly route: readonly number[];
  /** Progres úseku `route[0] → route[1]` v `[0, 1)`. */
  readonly progress: number;
  readonly waitTicks: number;
  /** Trasa čaká na preplánovanie (cesty sa zmenili po naplánovaní a kamión sa odvtedy nepohol). */
  readonly replan: boolean;
}

/** Kľúče `SerializedTruck` v poradí `toState()`. */
export const SERIALIZED_TRUCK_KEYS: readonly (keyof SerializedTruck)[] = [
  'id',
  'defId',
  'mission',
  'state',
  'x',
  'y',
  'heading',
  'rampId',
  'dock',
  'gateId',
  'waitingAreaId',
  'bay',
  'resume',
  'route',
  'progress',
  'waitTicks',
  'replan',
];

/** Vstup konštruktora kamióna (spawn aj obnova zo save). */
export interface TruckInit extends CarrierInit {
  readonly id: EntityId;
  readonly def: Readonly<TruckDef>;
  readonly state: TruckState;
  readonly rampId: EntityId;
  readonly dock: number;
  readonly gateId: EntityId;
  readonly waitingAreaId: EntityId;
  /** Predvolene `null`; celé ≥ 0 práve v stavoch s `holdsBay` (pri `no_path` podľa `resume`). */
  readonly bay?: number | null;
  /** Predvolene `null`; jazdný stav práve v `no_path`. */
  readonly resume?: TruckTravelState | null;
  /** Predvolene `pickup` (F4 kamión); `delivery` = dovoz exportu (ADR-032). */
  readonly mission?: TruckMission;
}

function isPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function isIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class Truck extends Carrier {
  readonly id: EntityId;
  readonly def: Readonly<TruckDef>;
  /** Id defu (`def.id`). */
  readonly defId: string;
  /** Rampa, z ktorej kamión nakladá. */
  readonly rampId: EntityId;
  /**
   * Dock rampy (`0 … docks − 1`): od spawnu má kamión nárok na jeho náklad, dock drží od povelu do docku po koniec
   * nakládky (ADR-029).
   */
  readonly dock: number;
  /** Brána, ktorou kamión prechádza dnu aj von (spoločná FIFO fronta). */
  readonly gateId: EntityId;
  /** Stojisko, v ktorom kamión drží bay. */
  readonly waitingAreaId: EntityId;
  /** Rezervovaný bay stojiska, kým ho kamión drží (`holdsBay`); inak `null`. Mení ho `landsideSystem`. */
  bay: number | null;
  private currentMission: TruckMission;
  private current: TruckState;
  private resumeState: TruckTravelState | null;

  /**
   * Chyby (`TruckError('invalid_input')`): id, `rampId`, `gateId` alebo `waitingAreaId` nie je celé ≥ 1, `dock` nie je
   * celé ≥ 0, neznámy stav, poloha nie je konečné číslo, neplatný kurz, `resume` nie je jazdný stav práve v `no_path`,
   * `bay` nie je `null` ani celé ≥ 0 alebo nezodpovedá stavu (`holdsBay` efektívneho stavu), trasa nie je neprázdny
   * zoznam indexov buniek, progres mimo `[0, 1)` alebo `> 0` bez ďalšej bunky, `waitTicks` nie je celé ≥ 0. Vzťahy k svetu
   * (moduly, bay a dock, fronta brány, náklad, súlad polohy s trasou) overuje `World` a loader save.
   */
  constructor(init: TruckInit) {
    const { id, def, state, rampId, dock, gateId, waitingAreaId } = init;
    const bay = init.bay ?? null;
    const resume = init.resume ?? null;
    const mission = init.mission ?? 'pickup';
    const label = `kamión '${def.id}' #${String(id)}`;
    if (!isPositiveId(id)) throw new TruckError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    if (!isTruckState(state)) throw new TruckError('invalid_input', `${label}: neznámy stav '${String(state)}'`);
    if (!isTruckMission(mission)) throw new TruckError('invalid_input', `${label}: neznáma misia '${String(mission)}'`);
    for (const [name, value] of [['rampId', rampId], ['gateId', gateId], ['waitingAreaId', waitingAreaId]] as const) {
      if (!isPositiveId(value)) throw new TruckError('invalid_input', `${label}: ${name} musí byť celé číslo ≥ 1, dostal ${String(value)}`);
    }
    if (!isIndex(dock)) throw new TruckError('invalid_input', `${label}: dock musí byť celé číslo ≥ 0, dostal ${String(dock)}`);
    if ((state === 'no_path') !== isTruckTravelState(resume)) {
      throw new TruckError('invalid_input', `${label}: resume ${String(resume)} ${state === 'no_path' ? 'musí byť jazdný stav' : 'musí byť null mimo no_path'}`);
    }
    const effective: TruckState = resume ?? state;
    if (bay !== null && !isIndex(bay)) throw new TruckError('invalid_input', `${label}: bay musí byť null alebo celé číslo ≥ 0, dostal ${String(bay)}`);
    const holdsBay = truckStateTraits(mission, effective).holdsBay;
    if (holdsBay !== (bay !== null)) {
      throw new TruckError('invalid_input', `${label}: v stave '${effective}' ${holdsBay ? 'musí držať bay' : 'nesmie držať bay'}`);
    }
    const pose = carrierPoseProblem(label, init);
    if (pose !== undefined) throw new TruckError('invalid_input', pose);
    const route = carrierRouteProblem(label, init);
    if (route !== undefined) throw new TruckError('invalid_input', route);
    super(init);
    this.id = id;
    this.def = def;
    this.defId = def.id;
    this.rampId = rampId;
    this.dock = dock;
    this.gateId = gateId;
    this.waitingAreaId = waitingAreaId;
    this.bay = bay;
    this.currentMission = mission;
    this.current = state;
    this.resumeState = resume;
  }

  /** Misia kamióna (ADR-032); mení ju len `becomePickup` (dual transaction). */
  get mission(): TruckMission {
    return this.currentMission;
  }

  /**
   * Dual transaction (ADR-032 bod 12): delivery kamión po vykládke zostane na docku a naloží import — misia sa zmení na
   * `pickup` (volá krok 8 tesne pred `unloading → loading`). Iná misia alebo stav → `TruckError('invalid_transition')`.
   */
  becomePickup(): void {
    if (this.currentMission !== 'delivery' || this.current !== 'unloading') {
      throw new TruckError('invalid_transition', `${this.label}: na pickup sa mení len delivery kamión vo vykládke (misia ${this.currentMission}, stav ${this.current})`);
    }
    this.currentMission = 'pickup';
  }

  /** Aktuálny stav FSM (mení ho len `transition`). */
  get state(): TruckState {
    return this.current;
  }

  /** Jazdný stav, do ktorého sa kamión vráti z `no_path`; mimo `no_path` `null`. */
  get resume(): TruckTravelState | null {
    return this.resumeState;
  }

  /** Stav, ktorého väzby (bay, dock, náklad) platia: v `no_path` `resume`, inak `state`. */
  get effectiveState(): TruckState {
    return this.resumeState ?? this.current;
  }

  /** Vlastnosti efektívneho stavu podľa misie (bay, dock, náklad, cieľ po návrate z `no_path`). */
  get bonds(): TruckStateTraits {
    return truckStateTraits(this.currentMission, this.effectiveState);
  }

  /** Vlastnosti aktuálneho stavu podľa misie (pohyb, odpočet, fronta). */
  get traits(): TruckStateTraits {
    return truckStateTraits(this.currentMission, this.current);
  }

  /** Popis do chybových správ: `truck_container #40`. */
  get label(): string {
    return `${this.defId} #${String(this.id)}`;
  }

  /**
   * Prechod podľa `TRUCK_TRANSITIONS` (`landsideSystem`); udalosť `TruckStateChanged` emituje volajúci
   * (`changeTruckState`). Do `no_path` si kamión zapamätá doterajší jazdný stav (`resume`) a z `no_path` sa smie vrátiť
   * len doň. Nepovolený prechod → `TruckError('invalid_transition')`, kamión sa nezmení.
   */
  transition(to: TruckState): void {
    const from = this.current;
    const allowed = isTruckTransitionAllowed(from, to) && (from !== 'no_path' || to === this.resumeState);
    if (!allowed) {
      const options = from === 'no_path' ? [String(this.resumeState)] : [...(TRUCK_TRANSITIONS.get(from) ?? [])];
      throw new TruckError('invalid_transition', `${this.label}: prechod ${from} → ${to} nie je povolený (povolené: ${options.join(', ') || '–'})`);
    }
    if (to === 'no_path') this.resumeState = isTruckTravelState(from) ? from : null;
    else if (from === 'no_path') this.resumeState = null;
    this.current = to;
  }

  /** Čistý JSON stav pre save (nová kópia pri každom volaní). */
  toState(): SerializedTruck {
    return {
      id: this.id,
      defId: this.defId,
      mission: this.currentMission,
      state: this.current,
      x: this.x,
      y: this.y,
      heading: this.heading,
      rampId: this.rampId,
      dock: this.dock,
      gateId: this.gateId,
      waitingAreaId: this.waitingAreaId,
      bay: this.bay,
      resume: this.resumeState,
      route: this.remainingRoute(),
      progress: this.progress,
      waitTicks: this.waitTicks,
      replan: this.replanPending,
    };
  }

  protected invalidInput(message: string): Error {
    return new TruckError('invalid_input', message);
  }
}
