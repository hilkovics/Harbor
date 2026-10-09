/**
 * Kamión (ARCHITECTURE §4.2 `trucks.json`, §7.1, §7.5, §7.8 bod 3; ADR-024; R4 ADR-041) — externá návšteva terminálu s lístkom: príde road portálom, prejde bránou, na odovzdávacom mieste (TP)
 * pri bloku ho obsluhuje stroj bloku (RTG) alebo straddle carrier a odíde výstupnou bránou a portálom z mapy (`in_truck → exported`). Jednotky v kamióne vedie výlučne `CargoLedger`
 * (`in_truck`, pravidlo 2); kamión si ich neeviduje.
 *
 * - **Pohyb** dedí zo zdieľaného `Carrier` (`src/sim/movement`) — ten istý kód ako interné vozidlá (ADR-019, ADR-020, ADR-021).
 * - **Lístok** (nemenný od spawnu až po odchod z TP): `blockId` (blok aktuálnej zastávky), `jobId` (job `in_storage ↔ in_truck`, ktorý drží rezerváciu a cieľovú jednotku zastávky; `null`, kým
 *   zastávka nie je naplánovaná alebo po nej), `tpCell` (rezervované TP — bunka pruhu RTG bloku alebo vonkajšia bunka konektora bloku) alebo `holdingId` + `stall` (rezervované státie odstavnej
 *   plochy; kamión čaká, kým ho TOS nezavolá). Práve jeden z tokenov (`tpCell`, `stall`) platí od vzniku po odchod z TP (`TRUCK_STATE_TRAITS.holdsToken`).
 * - `phase` (len na TP): `safe_in → (unlash) → handling → safe_out → (lash)`, odpočet `waitTicks` (`handling` je pripnutý na 1, kým neskončí odovzdanie).
 * - `resume` = jazdný stav, do ktorého sa kamión vráti z `no_path` (mimo `no_path` `null`).
 * - `mission` (F6a, ADR-032): `pickup` / `delivery` / `collect`; vlastnosti stavu podľa misie (`truckStateTraits`). Delivery kamión sa pri dual transaction zmení na pickup (`becomePickup`).
 * - `gateInTick`: tick príchodu k vstupnému pruhu brány (začiatok TTT, `truckTurnTimeAvgMin`); `null` pred bránou.
 *
 * Stav je privátny s getterom `state` a mení ho len `transition` podľa `TRUCK_TRANSITIONS`; trasu len metódy `Carrier`.
 */
import type { EntityId } from '../core/entity-id';
import type { TruckDef } from '../defs/types';
import type { Rotation } from '../grid/rotation';
import { Carrier, carrierPoseProblem, carrierRouteProblem, type CarrierInit } from '../movement/carrier';
import { serializeSlots, type SerializedSlot } from '../traffic/lane-slots';
import { TruckError } from './truck-error';
import {
  TRUCK_TRANSITIONS,
  isTpPhase,
  isTruckMission,
  isTruckState,
  isTruckTransitionAllowed,
  isTruckTravelState,
  truckStateTraits,
  type TpPhase,
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
  /** Blok aktuálnej zastávky (lístok, ADR-041 bod 4). */
  readonly blockId: number;
  /** Job aktuálnej zastávky (`in_storage ↔ in_truck`), alebo `null`. */
  readonly jobId: number | null;
  /** Jednotka aktuálnej zastávky (z `jobId`; ostáva po zániku jobu do odchodu z TP — `TruckUnloaded`), alebo `null`. */
  readonly unitId: number | null;
  /** Rezervované TP (bunka), alebo `null`. */
  readonly tpCell: number | null;
  /** Odstavná plocha so rezervovaným státím, alebo `null`. */
  readonly holdingId: number | null;
  /** Rezervované státie odstavnej plochy, alebo `null`. */
  readonly stall: number | null;
  /** Fáza na TP (len v `at_tp` / `at_edge_tp`), inak `null`. */
  readonly phase: TpPhase | null;
  /** Tick príchodu k vstupnému pruhu brány (začiatok TTT), alebo `null`. */
  readonly gateInTick: number | null;
  /** Vstupný pruh brány (R4: pri `to_pre_gate` / `pre_gate` predbežný — pruh radu sa určí pri vjazde na plochu). */
  readonly gateId: number;
  /** Výstupný pruh brány; `null`, kým si ho kamión nevyberie (pri odchode od rampy, ADR-041 bod 3). */
  readonly gateOutId: number | null;
  /** Predbránová plocha kamióna v stavoch `to_pre_gate` / `pre_gate`, inak `null` (ADR-041 bod 2). */
  readonly preGateId: number | null;
  /** Radový pruh predbránovej plochy v stave `pre_gate`, inak `null`. */
  readonly row: number | null;
  /** Stav, do ktorého sa kamión vráti z `no_path`; mimo `no_path` `null`. */
  readonly resume: TruckTravelState | null;
  /** Zvyšok trasy: `[cell, …cieľové bunky]` (indexy buniek); obnova neplánuje znova (ADR-019). */
  readonly route: readonly number[];
  /** Progres úseku `route[0] → route[1]` v `[0, 1)`. */
  readonly progress: number;
  readonly waitTicks: number;
  /** Trasa čaká na preplánovanie (cesty sa zmenili po naplánovaní a kamión sa odvtedy nepohol). */
  readonly replan: boolean;
  /** Sloty tela od hlavy k chvostu ako `[bunka, pruh]` (ADR-037); mimo jazdy prázdne. */
  readonly body: readonly SerializedSlot[];
  /** Sloty pred hlavou, ktoré kamión už drží (bunka, do ktorej vchádza, reťaz križovatky). */
  readonly ahead: readonly SerializedSlot[];
  /** Ticky čakania na voľný slot (0 = nečaká). */
  readonly blockedTicks: number;
  /** Zostávajúce ticky do ďalšieho preplánovania kvôli zápche. */
  readonly rerouteCooldown: number;
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
  'blockId',
  'jobId',
  'unitId',
  'tpCell',
  'holdingId',
  'stall',
  'phase',
  'gateInTick',
  'gateId',
  'gateOutId',
  'preGateId',
  'row',
  'resume',
  'route',
  'progress',
  'waitTicks',
  'replan',
  'body',
  'ahead',
  'blockedTicks',
  'rerouteCooldown',
];

/** Vstup konštruktora kamióna (spawn aj obnova zo save). */
export interface TruckInit extends CarrierInit {
  readonly id: EntityId;
  readonly def: Readonly<TruckDef>;
  readonly state: TruckState;
  /** Blok prvej zastávky lístka. */
  readonly blockId: EntityId;
  /** Predvolene `null`. */
  readonly jobId?: EntityId | null;
  /** Predvolene `null`. */
  readonly unitId?: EntityId | null;
  /** Predvolene `null`; rezervované TP (viď `Truck.tpCell`). */
  readonly tpCell?: number | null;
  /** Predvolene `null`; odstavná plocha a státie (spolu, viď `Truck.stall`). */
  readonly holdingId?: EntityId | null;
  readonly stall?: number | null;
  /** Predvolene `null`; fáza na TP. */
  readonly phase?: TpPhase | null;
  /** Predvolene `null`. */
  readonly gateInTick?: number | null;
  readonly gateId: EntityId;
  /** Predvolene `null` (výstupný pruh brány sa vyberá pri odchode z TP). */
  readonly gateOutId?: EntityId | null;
  /** Predvolene `null`; predbránová plocha práve v `to_pre_gate` / `pre_gate`. */
  readonly preGateId?: EntityId | null;
  /** Predvolene `null`; radový pruh plochy práve v `pre_gate`. */
  readonly row?: number | null;
  /** Predvolene `null`; jazdný stav práve v `no_path`. */
  readonly resume?: TruckTravelState | null;
  /** Predvolene `pickup` (F4 kamión); `delivery` = dovoz exportu / prázdneho (ADR-032). */
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
  readonly kind = 'truck' as const;
  readonly def: Readonly<TruckDef>;
  /** Id defu (`def.id`). */
  readonly defId: string;
  /** Blok aktuálnej zastávky lístka; pri ďalšej zastávke (dual transaction) ho mení `World.moveTruckStop`. */
  blockId: EntityId;
  /** Job aktuálnej zastávky (`in_storage ↔ in_truck`); mení ho systém (`World.setTruckJob`). */
  jobId: EntityId | null;
  /** Jednotka aktuálnej zastávky (z `jobId`; ostáva po zániku jobu do odchodu z TP); mení ju systém (`openReceiveJob`, `openDeliverJob`). */
  unitId: EntityId | null;
  /** Rezervované TP: bunka pruhu RTG bloku, alebo vonkajšia bunka konektora bloku (TP na hrane); `null`, keď kamión drží státie alebo už z TP odišiel. */
  tpCell: number | null;
  /** Odstavná plocha, v ktorej kamión drží státie `stall`; `null` bez státia. */
  holdingId: EntityId | null;
  stall: number | null;
  /** Fáza na TP (`at_tp`, `at_edge_tp`); inak `null`. */
  phase: TpPhase | null;
  /** Tick príchodu k vstupnému pruhu brány (TTT); `null` pred bránou. */
  gateInTick: number | null;
  /**
   * Vstupný pruh brány (R4, ADR-041): kamión pred plochou má predbežný pruh (prvý z pruhov plochy), pri vjazde na plochu sa preradí na pruh svojho radu
   * (`assignLane`). Mení ho len systém pri vjazde na predbránovú plochu.
   */
  gateId: EntityId;
  /** Výstupný pruh brány (R4): `null`, kým si ho kamión nevyberie podľa odhadu času; po výbere nemenný (`assignOutLane`). */
  gateOutId: EntityId | null;
  /** Predbránová plocha v stavoch `to_pre_gate` / `pre_gate`; inak `null`. */
  preGateId: EntityId | null;
  /** Radový pruh predbránovej plochy v stave `pre_gate`; inak `null`. */
  row: number | null;
  private currentMission: TruckMission;
  private current: TruckState;
  private resumeState: TruckTravelState | null;

  /**
   * Chyby (`TruckError('invalid_input')`): id, `blockId` alebo `gateId` nie je celé ≥ 1, neznámy stav, poloha nie je konečné číslo, neplatný kurz, `resume` nie je jazdný stav práve v `no_path`,
   * token nezodpovedá stavu (`holdsToken` efektívneho stavu: práve jeden z `tpCell`, `stall`), fáza mimo TP, trasa nie je neprázdny zoznam indexov buniek, progres mimo `[0, 1)`, `waitTicks`
   * nie je celé ≥ 0. Vzťahy k svetu (moduly, job, náklad, súlad polohy s trasou) overuje `World` a loader save.
   */
  constructor(init: TruckInit) {
    const { id, def, state, blockId, gateId } = init;
    const gateOutId = init.gateOutId ?? null;
    const preGateId = init.preGateId ?? null;
    const row = init.row ?? null;
    const jobId = init.jobId ?? null;
    const unitId = init.unitId ?? null;
    const tpCell = init.tpCell ?? null;
    const holdingId = init.holdingId ?? null;
    const stall = init.stall ?? null;
    const phase = init.phase ?? null;
    const gateInTick = init.gateInTick ?? null;
    const resume = init.resume ?? null;
    const mission = init.mission ?? 'pickup';
    const label = `kamión '${def.id}' #${String(id)}`;
    if (!isPositiveId(id)) throw new TruckError('invalid_input', `${label}: id musí byť celé číslo ≥ 1`);
    if (!isTruckState(state)) throw new TruckError('invalid_input', `${label}: neznámy stav '${String(state)}'`);
    if (!isTruckMission(mission)) throw new TruckError('invalid_input', `${label}: neznáma misia '${String(mission)}'`);
    for (const [name, value] of [['blockId', blockId], ['gateId', gateId]] as const) {
      if (!isPositiveId(value)) throw new TruckError('invalid_input', `${label}: ${name} musí byť celé číslo ≥ 1, dostal ${String(value)}`);
    }
    if ((state === 'no_path') !== isTruckTravelState(resume)) {
      throw new TruckError('invalid_input', `${label}: resume ${String(resume)} ${state === 'no_path' ? 'musí byť jazdný stav' : 'musí byť null mimo no_path'}`);
    }
    const effective: TruckState = resume ?? state;
    for (const [name, value] of [['gateOutId', gateOutId], ['preGateId', preGateId], ['jobId', jobId], ['unitId', unitId], ['holdingId', holdingId]] as const) {
      if (value !== null && !isPositiveId(value)) throw new TruckError('invalid_input', `${label}: ${name} musí byť null alebo celé číslo ≥ 1, dostal ${String(value)}`);
    }
    for (const [name, value] of [['row', row], ['tpCell', tpCell], ['stall', stall], ['gateInTick', gateInTick]] as const) {
      if (value !== null && !isIndex(value)) throw new TruckError('invalid_input', `${label}: ${name} musí byť null alebo celé číslo ≥ 0, dostal ${String(value)}`);
    }
    const onPreGate = effective === 'to_pre_gate' || effective === 'pre_gate';
    if (onPreGate !== (preGateId !== null)) throw new TruckError('invalid_input', `${label}: v stave '${effective}' ${onPreGate ? 'musí mať' : 'nesmie mať'} predbránovú plochu`);
    if ((state === 'pre_gate') !== (row !== null)) throw new TruckError('invalid_input', `${label}: rad ${String(row)} nezodpovedá stavu '${state}'`);
    if ((state === 'gate_queue_out' || state === 'gate_pass_out') && gateOutId === null) throw new TruckError('invalid_input', `${label}: v stave '${state}' musí mať výstupný pruh`);
    if ((holdingId === null) !== (stall === null)) throw new TruckError('invalid_input', `${label}: odstavná plocha ${String(holdingId)} a státie ${String(stall)} sa musia zadať spolu`);
    const holdsToken = truckStateTraits(mission, effective).holdsToken;
    if (holdsToken !== (tpCell !== null || stall !== null) || (tpCell !== null && stall !== null)) {
      throw new TruckError('invalid_input', `${label}: v stave '${effective}' ${holdsToken ? 'musí mať práve jeden token (TP alebo státie)' : 'nesmie držať token'}`);
    }
    if ((effective === 'holding' || effective === 'to_holding') && stall === null) throw new TruckError('invalid_input', `${label}: v stave '${effective}' musí mať státie`);
    if (truckStateTraits(mission, state).atTp !== (phase !== null) || (phase !== null && !isTpPhase(phase))) {
      throw new TruckError('invalid_input', `${label}: fáza ${String(phase)} nezodpovedá stavu '${state}'`);
    }
    const pose = carrierPoseProblem(label, init);
    if (pose !== undefined) throw new TruckError('invalid_input', pose);
    const route = carrierRouteProblem(label, init);
    if (route !== undefined) throw new TruckError('invalid_input', route);
    super(init);
    this.id = id;
    this.def = def;
    this.defId = def.id;
    this.blockId = blockId;
    this.jobId = jobId;
    this.unitId = unitId;
    this.tpCell = tpCell;
    this.holdingId = holdingId;
    this.stall = stall;
    this.phase = phase;
    this.gateInTick = gateInTick;
    this.gateId = gateId;
    this.gateOutId = gateOutId;
    this.preGateId = preGateId;
    this.row = row;
    this.currentMission = mission;
    this.current = state;
    this.resumeState = resume;
  }

  /** Misia kamióna (ADR-032); mení ju len `becomePickup` (dual transaction). */
  get mission(): TruckMission {
    return this.currentMission;
  }

  /**
   * Dual transaction (ADR-032 bod 13, ADR-041 bod 6): delivery kamión po vyložení na TP nakladá import — misia sa zmení na `pickup` (jeden lístok, druhá zastávka). Iná misia alebo stav mimo TP
   * → `TruckError('invalid_transition')`.
   */
  becomePickup(): void {
    if (this.currentMission !== 'delivery' || !truckStateTraits(this.currentMission, this.current).atTp) {
      throw new TruckError('invalid_transition', `${this.label}: na pickup sa mení len delivery kamión na TP (misia ${this.currentMission}, stav ${this.current})`);
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

  /** Stav, ktorého väzby (token, náklad) platia: v `no_path` `resume`, inak `state`. */
  get effectiveState(): TruckState {
    return this.resumeState ?? this.current;
  }

  /** Vlastnosti efektívneho stavu podľa misie (token, náklad, cieľ po návrate z `no_path`). */
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

  /** Dĺžka kamióna v bunkách (`def.lengthCells`, ADR-037). */
  get lengthCells(): number {
    return this.def.lengthCells;
  }

  /**
   * Prechod podľa `TRUCK_TRANSITIONS`; udalosť `TruckStateChanged` emituje volajúci (`changeTruckState`). Do `no_path` si kamión zapamätá doterajší jazdný stav (`resume`) a z `no_path` sa
   * smie vrátiť len doň. Nepovolený prechod → `TruckError('invalid_transition')`, kamión sa nezmení.
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
    // Mimo cesty (predbránová a odstavná plocha, TP na hrane bloku, prechod bránou) kamión nedrží žiadne sloty; vo fronte brány, na TP v pruhu a bez cesty ich drží ďalej (ADR-037).
    if (!this.traits.holdsRoad) this.leaveRoad();
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
      blockId: this.blockId,
      jobId: this.jobId,
      unitId: this.unitId,
      tpCell: this.tpCell,
      holdingId: this.holdingId,
      stall: this.stall,
      phase: this.phase,
      gateInTick: this.gateInTick,
      gateId: this.gateId,
      gateOutId: this.gateOutId,
      preGateId: this.preGateId,
      row: this.row,
      resume: this.resumeState,
      route: this.remainingRoute(),
      progress: this.progress,
      waitTicks: this.waitTicks,
      replan: this.replanPending,
      body: serializeSlots(this.body),
      ahead: serializeSlots(this.ahead),
      blockedTicks: this.blockedTicks,
      rerouteCooldown: this.rerouteCooldown,
    };
  }

  protected invalidInput(message: string): Error {
    return new TruckError('invalid_input', message);
  }
}
