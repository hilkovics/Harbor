/**
 * Žeriav (ARCHITECTURE §5.3, §7.2; ADR-014, ADR-016). Stojí **na** bunkách jedného berthu s rovnakou rotáciou
 * (rozhodnutie 3): `berthId` je modul pod jeho ľavým horným rohom, `cell.moduleId` ostáva id berthu a berth ho
 * eviduje v `craneIds`. Tu je stav, tabuľka prechodov FSM (`CRANE_TRANSITIONS`), jeho význam a serializácia; cyklus
 * (kedy a prečo sa prechádza) riadi `CraneSystem` (krok 4) výlučne cez `transition()` / `enterPhase()`. Stav je
 * privátny s getterom `state` (ako `Ship.state`): mimo `transition` ho mení len `restoreRuntimeState` (T02-14).
 *
 * Dynamický stav v save (`CraneRuntimeState`) neobsahuje `heldUnitId` — držaná jednotka je v `CargoLedger`
 * (`in_crane`) a loader ju odtiaľ doplní.
 *
 * **Smer cyklu** (F6a, ADR-032 bod 10): `cycle` = `unload` (loď → apron, F2), `load` (apron → loď), pri dual cyklu dve
 * polovice `dual_load` a hneď po nej `dual_unload` (rovnaké fázy `grabbing` / `swinging` / `placing`, kratšie podľa
 * `dualCycleFactor`). Pri nakládke žeriav od štartu drží nárok na jednotku na aprone (`targetUnitId`), pri vykládke
 * rezervovaný slot apronu (`reservedSlot`). Mimo cyklu (`idle`, `blocked`) je `cycle` `unload` a `targetUnitId` `null`.
 */
import type { EntityId } from '../core/entity-id';
import { craneParams } from '../defs/module-def';
import type { CargoCategory, CraneParams } from '../defs/types';
import type { StatResolver } from '../tech/stat-resolver';
import type { CargoDropTarget } from './cargo-drop-target';
import { Module, type ModuleInit } from './module';
import { ModuleError, ModuleStateError } from './module-error';
import { checkRuntimeKeys, readCount, readEnum, readOptionalCount } from './runtime-state';

/** Stavy žeriavu (§7.2) v poradí cyklu. */
export const CRANE_STATES = ['idle', 'grabbing', 'swinging', 'placing', 'blocked'] as const;
export type CraneState = (typeof CRANE_STATES)[number];

/** Smer cyklu žeriavu (ADR-032 bod 10): vykládka, nakládka a dve polovice dual cyklu. */
export const CRANE_CYCLES = ['unload', 'load', 'dual_load', 'dual_unload'] as const;
export type CraneCycle = (typeof CRANE_CYCLES)[number];

/** Čo platí pre smer cyklu: odkiaľ kam ide jednotka, či je cyklus polovicou dual cyklu a od ktorého stavu drží slot apronu. */
export interface CraneCycleTraits {
  /** `unload` = loď → apron / vozidlo, `load` = apron / vozidlo → loď (nárok na jednotku `targetUnitId`). */
  readonly direction: 'unload' | 'load';
  readonly dual: boolean;
  /**
   * Od ktorého stavu cyklu drží žeriav v režime `apron` rezervovaný slot apronu (`reservedSlot`): vykládka od `grabbing`
   * (slot pre jednotku z lode), nakládka nikdy (jednotku berie z apronu), `dual_load` od `swinging` (slot uvoľnený zdvihnutou
   * jednotkou sa hneď rezervuje pre import druhej polovice), `dual_unload` od `grabbing` (slot prenesený z prvej polovice).
   * V režime `under_hook` sa slot nerezervuje nikdy (ADR-033).
   */
  readonly reservesFrom: CraneState | null;
}

export const CRANE_CYCLE_TRAITS: { readonly [C in CraneCycle]: CraneCycleTraits } = Object.freeze({
  unload: Object.freeze({ direction: 'unload', dual: false, reservesFrom: 'grabbing' }),
  load: Object.freeze({ direction: 'load', dual: false, reservesFrom: null }),
  dual_load: Object.freeze({ direction: 'load', dual: true, reservesFrom: 'swinging' }),
  dual_unload: Object.freeze({ direction: 'unload', dual: true, reservesFrom: 'grabbing' }),
});

/**
 * Povolené zmeny smeru cyklu `from → to` (T6A-09b; stavové automaty majú explicitnú tabuľku, žiadne skryté prechody): žeriav mimo
 * cyklu má `DEFAULT_CRANE_CYCLE` (`unload`) a z neho začne ktorýkoľvek cyklus (`unload`, `load`, `dual_load`); dual cyklus pokračuje
 * `dual_load → dual_unload`; každý cyklus sa končí návratom na `unload` (žeriav odpočíva alebo začína nový cyklus).
 * `CraneModule.changeCycle` ju overuje; obnova zo save smer nastavuje priamo (stav v save overuje `restoreRuntimeState`).
 */
export const CRANE_CYCLE_TRANSITIONS: ReadonlyMap<CraneCycle, readonly CraneCycle[]> = new Map<CraneCycle, readonly CraneCycle[]>([
  ['unload', Object.freeze(['unload', 'load', 'dual_load'] as const)],
  ['load', Object.freeze(['unload'] as const)],
  ['dual_load', Object.freeze(['dual_unload', 'unload'] as const)],
  ['dual_unload', Object.freeze(['unload'] as const)],
]);

/** Je zmena smeru cyklu `from → to` v tabuľke `CRANE_CYCLE_TRANSITIONS`? */
export function isCraneCycleTransitionAllowed(from: CraneCycle, to: CraneCycle): boolean {
  return CRANE_CYCLE_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/** Poradie stavov v cykle (`grabbing` → `swinging` → `placing`); stavy mimo cyklu majú −1. */
const CYCLE_STATE_ORDER: { readonly [S in CraneState]: number } = Object.freeze({ idle: -1, blocked: -1, grabbing: 0, swinging: 1, placing: 2 });

/**
 * Drží žeriav v režime `apron` rezervovaný slot apronu v stave `state` cyklu `cycle`? (`CRANE_CYCLE_TRAITS.reservesFrom`);
 * mimo cyklu (`idle`, `blocked`) nikdy. Režim `under_hook` slot nerezervuje — to rozhoduje kotvisko (invarianty sveta).
 */
export function craneReservesApronSlot(cycle: CraneCycle, state: CraneState): boolean {
  const from = CRANE_CYCLE_TRAITS[cycle].reservesFrom;
  return from !== null && CYCLE_STATE_ORDER[state] >= CYCLE_STATE_ORDER[from] && CYCLE_STATE_ORDER[state] >= 0;
}

/** Smer cyklu žeriavu mimo cyklu (ADR-032). */
export const DEFAULT_CRANE_CYCLE: CraneCycle = 'unload';

/** Do ktorého počítadla utilizácie (§11) patrí tick v danom stave. */
export type CraneCounter = 'idle' | 'busy' | 'blocked';

/**
 * Vzťah stavu k fáze cyklu (`phaseTicksTotal`/`phaseTicksLeft`) na konci ticku, teda aj v save (T02-14):
 * - `none` — mimo fázy: `phaseTicksTotal = phaseTicksLeft = 0` (`enterPhase(0)`);
 * - `timed` — fáza beží: `1 ≤ phaseTicksLeft ≤ phaseTicksTotal` (fáza končí v ticku, keď `phaseTicksLeft` klesne na 0,
 *   a žeriav v tom istom ticku prejde ďalej);
 * - `instant` — okamžitý prechod v rámci jedného kroku (`swinging`: `grabbing → swinging → placing`), tick v ňom nikdy
 *   nekončí, preto sa neukladá.
 */
export type CranePhaseKind = 'none' | 'timed' | 'instant';

/** Čo platí pre žeriav v danom stave (rozhodnutie 7 v docs/tasks/phase-02.md). */
export interface CraneStateTraits {
  /** Žeriav drží jednotku (`in_crane`) — `heldUnitId !== null`. */
  readonly holdsUnit: boolean;
  /**
   * Žeriav je v stave cyklu, v ktorom smie mať rezervovaný slot apronu (`reservedSlot !== null`); či ho naozaj má, určuje smer
   * cyklu (`CRANE_CYCLE_TRAITS.reservesFrom`) a režim kotviska (`under_hook` slot nerezervuje) — kontroluje svet.
   */
  readonly hasReservation: boolean;
  readonly counter: CraneCounter;
  /** Vzťah k fáze cyklu (`CranePhaseKind`). */
  readonly phase: CranePhaseKind;
}

/**
 * Tabuľka vlastností stavov: rezervácia vzniká pri `idle → grabbing`, jednotka prejde `on_ship → in_crane` pri
 * `swinging` a `in_crane → on_apron` na konci `placing` (rezervácia zaniká). `blocked` nič nedrží ani nerezervuje.
 * Kontroluje ju `World.assertInvariants()` aj loader save.
 */
export const CRANE_STATE_TRAITS: { readonly [S in CraneState]: CraneStateTraits } = Object.freeze({
  idle: Object.freeze({ holdsUnit: false, hasReservation: false, counter: 'idle', phase: 'none' }),
  grabbing: Object.freeze({ holdsUnit: false, hasReservation: true, counter: 'busy', phase: 'timed' }),
  swinging: Object.freeze({ holdsUnit: true, hasReservation: true, counter: 'busy', phase: 'instant' }),
  placing: Object.freeze({ holdsUnit: true, hasReservation: true, counter: 'busy', phase: 'timed' }),
  blocked: Object.freeze({ holdsUnit: false, hasReservation: false, counter: 'blocked', phase: 'none' }),
});

/** Porušenie vzťahu stavu a fázy: pole runtime stavu (JSON pointer v `CraneRuntimeState`) + popis. */
export interface CranePhaseProblem {
  readonly path: '/state' | '/phaseTicksTotal' | '/phaseTicksLeft';
  readonly problem: string;
}

type PhaseRule = (state: CraneState, total: number, left: number) => CranePhaseProblem | undefined;

/** Kontrola fázy podľa `CranePhaseKind` (tabuľka, nie switch). */
const PHASE_RULES: { readonly [K in CranePhaseKind]: PhaseRule } = {
  none: (state, total, left) => {
    if (left > 0) return { path: '/phaseTicksLeft', problem: `stav '${state}' je mimo fázy, phaseTicksLeft musí byť 0, dostal ${String(left)}` };
    if (total > 0) return { path: '/phaseTicksTotal', problem: `stav '${state}' je mimo fázy, phaseTicksTotal musí byť 0, dostal ${String(total)}` };
    return undefined;
  },
  timed: (state, _total, left) =>
    left >= 1 ? undefined : { path: '/phaseTicksLeft', problem: `stav '${state}' má bežiacu fázu, phaseTicksLeft musí byť ≥ 1 (fáza pri 0 už skončila)` },
  instant: (state) => ({ path: '/state', problem: `stav '${state}' je okamžitý prechod (grabbing → placing v jednom ticku) a neukladá sa` }),
};

/**
 * Súlad stavu a fázy na konci ticku (`CRANE_STATE_TRAITS[state].phase`); `undefined` = v poriadku. Používa ho
 * `restoreRuntimeState` (fail-fast pri obnove) aj `World.assertInvariants()`. Predpokladá `phaseTicksLeft ≤ total`.
 */
export function cranePhaseProblem(state: CraneState, phaseTicksTotal: number, phaseTicksLeft: number): CranePhaseProblem | undefined {
  return PHASE_RULES[CRANE_STATE_TRAITS[state].phase](state, phaseTicksTotal, phaseTicksLeft);
}

/**
 * Povolené prechody FSM žeriavu (§7.2, ADR-016): `idle → grabbing | blocked`, `grabbing → swinging` (okamžitý:
 * `on_ship → in_crane`), `swinging → placing`, `placing → idle` (`in_crane → on_apron`), `blocked → idle | grabbing`.
 */
export const CRANE_TRANSITIONS: ReadonlyMap<CraneState, readonly CraneState[]> = new Map<CraneState, readonly CraneState[]>([
  ['idle', Object.freeze(['grabbing', 'blocked'] as const)],
  ['grabbing', Object.freeze(['swinging'] as const)],
  ['swinging', Object.freeze(['placing'] as const)],
  ['placing', Object.freeze(['idle'] as const)],
  ['blocked', Object.freeze(['idle', 'grabbing'] as const)],
]);

/** Je prechod `from → to` v tabuľke? */
export function isCraneTransitionAllowed(from: CraneState, to: CraneState): boolean {
  return CRANE_TRANSITIONS.get(from)?.includes(to) ?? false;
}

/**
 * Dynamický stav žeriavu v save (`WorldState.modules[i].runtime`; v7 + `cycle`, `targetUnitId`, ADR-032; + `dualUnitId`,
 * `waitForVehicleTicks`, `vehicleWaitTicks`, ADR-033).
 */
export type CraneRuntimeState = {
  readonly state: CraneState;
  readonly cycle: CraneCycle;
  readonly phaseTicksTotal: number;
  readonly phaseTicksLeft: number;
  readonly reservedSlot: number | null;
  readonly targetUnitId: number | null;
  /** Jednotka naložená v prvej polovici dual cyklu (`dual_load`) — v `dual_unload` pre `DualCycle`; inak `null`. */
  readonly dualUnitId: number | null;
  readonly busyTicks: number;
  readonly idleTicks: number;
  readonly blockedTicks: number;
  /** Ticky, v ktorých žeriav v režime `under_hook` čakal na vozidlo (metrika `craneWaitForVehicleTicks`). */
  readonly waitForVehicleTicks: number;
  /** Ticky vozidiel čakajúcich pod týmto žeriavom (súčet cez vozidlá; metrika `vehicleWaitUnderCraneTicks`). */
  readonly vehicleWaitTicks: number;
  readonly lastBlockedHour: number | null;
};

/**
 * Najkratšia fáza cyklu v tickoch — žeriav nemôže zdvihnúť ani položiť jednotku „za nula tickov“ (ADR-016; fázy počíta
 * `cranePhaseTicks` v `CraneSystem`, ktorý konštantu reexportuje).
 */
export const MIN_CRANE_PHASE_TICKS = 1;

/** Kľúče `CraneRuntimeState` v poradí `getRuntimeState()`. */
export const CRANE_RUNTIME_KEYS: readonly (keyof CraneRuntimeState)[] = [
  'state',
  'cycle',
  'phaseTicksTotal',
  'phaseTicksLeft',
  'reservedSlot',
  'targetUnitId',
  'dualUnitId',
  'busyTicks',
  'idleTicks',
  'blockedTicks',
  'waitForVehicleTicks',
  'vehicleWaitTicks',
  'lastBlockedHour',
];

export class CraneModule extends Module {
  /** Typované `params` defu (`craneParams`); `cycleTicks` čítaj cez `world.stats` (modifikátory, §10). */
  readonly params: CraneParams;
  /** Berth, na ktorom žeriav stojí. */
  readonly berthId: EntityId;
  /** Trvanie aktuálnej fázy v tickoch (pre progres v renderi). */
  phaseTicksTotal = 0;
  /** Zostávajúce ticky aktuálnej fázy (0 … `phaseTicksTotal`). */
  phaseTicksLeft = 0;
  /** Jednotka `in_crane` tohto žeriavu (zrkadlo ledgera). */
  heldUnitId: EntityId | null = null;
  /** Rezervovaný slot apronu berthu (zrkadlo `berth.apron`). */
  reservedSlot: number | null = null;
  /** Smer aktuálneho cyklu (ADR-032 bod 10); mimo cyklu `unload`. */
  cycle: CraneCycle = DEFAULT_CRANE_CYCLE;
  /** Jednotka na aprone, ktorú si žeriav zabral na nakládku (`load` / `dual_load` v `grabbing`), inak `null`. */
  targetUnitId: EntityId | null = null;
  /** Jednotka naložená v prvej polovici dual cyklu (`dual_load`), kým beží `dual_unload`; inak `null`. */
  dualUnitId: EntityId | null = null;
  /** Cieľ odovzdania pod hákom (`cargoDropTarget()`) — jeden objekt na žeriav. */
  private readonly drop: CargoDropTarget;
  busyTicks = 0;
  idleTicks = 0;
  blockedTicks = 0;
  /** Ticky čakania žeriava na vozidlo pod hákom (ADR-033). */
  waitForVehicleTicks = 0;
  /** Ticky vozidiel čakajúcich pod hákom tohto žeriava (ADR-033). */
  vehicleWaitTicks = 0;
  /** Index hernej hodiny (`clock.gameHour`) posledného `CraneBlocked`; `null` = ešte nebol (throttle, ADR-016). */
  lastBlockedHour: number | null = null;
  /** Stav FSM — zapisuje ho len `transition` (CraneSystem) a `restoreRuntimeState` (save), T02-14. */
  private current: CraneState = 'idle';

  /**
   * Def iného druhu než `crane` → `DefError`; pod ľavým horným rohom nie je žiadny modul → `ModuleError('no_berth')`.
   * Či je to naozaj berth a či žeriav leží celý na ňom, overí `World.addModule`.
   */
  constructor(init: ModuleInit) {
    super(init);
    this.params = craneParams(init.def);
    const hostId = init.grid.at(init.origin.x, init.origin.y).moduleId;
    if (hostId === null) {
      throw new ModuleError('no_berth', `${this.label}: na (${String(init.origin.x)}, ${String(init.origin.y)}) nie je berth, žeriav musí stáť na berthe`);
    }
    this.berthId = hostId;
    const { category } = this.params;
    // Hák žeriava ako koncový bod jobu vozidla (ADR-033): nič sa nerezervuje, vozidlo čaká pod hákom na priame odovzdanie.
    this.drop = Object.freeze({
      kind: 'in_crane',
      category,
      reserves: false,
      places: 1,
      reservationsAt: (): number => 0,
      restoreReservation: (): void => undefined,
      release: (): void => undefined,
      assertCommittable: (): void => undefined,
      commit: (): void => undefined,
    });
  }

  /** Hák žeriava ako cieľ jobu vozidla (`in_crane`, bez rezervácie — ADR-033). */
  override cargoDropTarget(): CargoDropTarget {
    return this.drop;
  }

  /** Aktuálny stav FSM (len na čítanie; mení ho `transition`, obnovuje `restoreRuntimeState`). */
  get state(): CraneState {
    return this.current;
  }

  /** Kategória nákladu, ktorú žeriav prekladá. */
  get category(): CargoCategory {
    return this.params.category;
  }

  /** Denná mzda obsluhy žeriava (`params.wagePerDayCents`, §9.2, ADR-025). */
  override dailyWageCents(): number {
    return this.params.wagePerDayCents;
  }

  /**
   * Jednotky vyložené za deň (`capacityHint`, ADR-026): `⌊ticksPerDay / c⌋`, kde `c = round(cycleTicks)` po modifikátoroch
   * (§10) ako v `cranePhaseTicks`, najmenej skutočný cyklus `2 × MIN_CRANE_PHASE_TICKS` (dve fázy `grabbing` a `placing`).
   */
  override dailyUnloadUnits(stats: Pick<StatResolver, 'resolve'>, ticksPerDay: number): number {
    const cycle = Math.max(2 * MIN_CRANE_PHASE_TICKS, Math.round(stats.resolve('module', this.def.id, 'cycleTicks')));
    return Math.floor(ticksPerDay / cycle);
  }

  /** Vlastnosti aktuálneho stavu (`CRANE_STATE_TRAITS`). */
  get traits(): CraneStateTraits {
    return CRANE_STATE_TRAITS[this.current];
  }

  /** Postup v aktuálnej fáze 0…1 (render: poloha vozíka); mimo fázy (`phaseTicksTotal = 0`) → 0. */
  get phaseProgress(): number {
    return this.phaseTicksTotal === 0 ? 0 : 1 - this.phaseTicksLeft / this.phaseTicksTotal;
  }

  /**
   * Prechod FSM podľa `CRANE_TRANSITIONS` (jediné miesto, kde `CraneSystem` mení stav). Nepovolený prechod →
   * `ModuleError('invalid_transition')`, žeriav sa nezmení. Fázu (`phaseTicks*`) nastaví `enterPhase`.
   */
  transition(to: CraneState): void {
    if (!isCraneTransitionAllowed(this.current, to)) {
      const allowed = CRANE_TRANSITIONS.get(this.current) ?? [];
      throw new ModuleError('invalid_transition', `${this.label}: prechod ${this.current} → ${to} nie je povolený (povolené: ${allowed.join(', ')})`);
    }
    this.current = to;
  }

  /**
   * Zmena smeru cyklu podľa `CRANE_CYCLE_TRANSITIONS` (jediné miesto, kde `CraneSystem` mení `cycle`). Nepovolená zmena →
   * `ModuleError('invalid_transition')`, smer sa nezmení.
   */
  changeCycle(to: CraneCycle): void {
    if (!isCraneCycleTransitionAllowed(this.cycle, to)) {
      const allowed = CRANE_CYCLE_TRANSITIONS.get(this.cycle) ?? [];
      throw new ModuleError('invalid_transition', `${this.label}: zmena smeru cyklu ${this.cycle} → ${to} nie je povolená (povolené: ${allowed.join(', ')})`);
    }
    this.cycle = to;
  }

  /** Začne fázu dlhú `ticks` tickov (`phaseTicksTotal = phaseTicksLeft = ticks`); 0 = mimo fázy (idle/blocked). */
  enterPhase(ticks: number): void {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new ModuleError('invalid_input', `${this.label}: trvanie fázy musí byť celé číslo ≥ 0, dostal ${String(ticks)}`);
    }
    this.phaseTicksTotal = ticks;
    this.phaseTicksLeft = ticks;
  }

  override getRuntimeState(): CraneRuntimeState {
    return {
      state: this.current,
      cycle: this.cycle,
      phaseTicksTotal: this.phaseTicksTotal,
      phaseTicksLeft: this.phaseTicksLeft,
      reservedSlot: this.reservedSlot,
      targetUnitId: this.targetUnitId,
      dualUnitId: this.dualUnitId,
      busyTicks: this.busyTicks,
      idleTicks: this.idleTicks,
      blockedTicks: this.blockedTicks,
      waitForVehicleTicks: this.waitForVehicleTicks,
      vehicleWaitTicks: this.vehicleWaitTicks,
      lastBlockedHour: this.lastBlockedHour,
    };
  }

  /**
   * Kontroly: presne kľúče `CraneRuntimeState`, `state` z `CRANE_STATES` okrem okamžitého `swinging` (neukladá sa),
   * počítadlá celé ≥ 0, `phaseTicksLeft ≤ phaseTicksTotal`, `reservedSlot` a `lastBlockedHour` null alebo celé ≥ 0,
   * rezervovaný slot len v stave cyklu, ktorý ho drží (`craneReservesApronSlot`), `dualUnitId` práve v `dual_unload`
   * (ADR-033) a fáza tiež (`cranePhaseProblem`: `idle`/`blocked`
   * 0/0, `grabbing`/`placing` `phaseTicksLeft ≥ 1`), T02-14; `cycle` z `CRANE_CYCLES`, `targetUnitId` null alebo celé
   * ≥ 1 a mimo cyklu (`idle`, `blocked`) `cycle` `unload` a `targetUnitId` `null` (ADR-032). Nekonzistentný stav je
   * `ModuleStateError` už pri `deserialize`, nie pád až v `tick()`. Súlad so slotmi berthu, s ledgerom a s loďou overí
   * loader.
   */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, CRANE_RUNTIME_KEYS);
    const state = readEnum(fields['state'], CRANE_STATES, '/state');
    const cycle = readEnum(fields['cycle'], CRANE_CYCLES, '/cycle');
    const targetUnitId = readOptionalCount(fields['targetUnitId'], '/targetUnitId');
    if (targetUnitId === 0) throw new ModuleStateError('/targetUnitId', 'id jednotky musí byť null alebo celé číslo ≥ 1');
    const outside = CRANE_STATE_TRAITS[state].phase === 'none';
    if (outside && (cycle !== DEFAULT_CRANE_CYCLE || targetUnitId !== null)) {
      throw new ModuleStateError(cycle !== DEFAULT_CRANE_CYCLE ? '/cycle' : '/targetUnitId', `stav '${state}' je mimo cyklu — cycle '${DEFAULT_CRANE_CYCLE}' a targetUnitId null`);
    }
    // Okamžitý stav sa odmietne hneď (skôr než polia, ktoré preň nemajú zmysel).
    const instant = CRANE_STATE_TRAITS[state].phase === 'instant' ? cranePhaseProblem(state, 0, 0) : undefined;
    if (instant !== undefined) throw new ModuleStateError(instant.path, instant.problem);
    const phaseTicksTotal = readCount(fields['phaseTicksTotal'], '/phaseTicksTotal');
    const phaseTicksLeft = readCount(fields['phaseTicksLeft'], '/phaseTicksLeft');
    if (phaseTicksLeft > phaseTicksTotal) {
      throw new ModuleStateError('/phaseTicksLeft', `${String(phaseTicksLeft)} > phaseTicksTotal ${String(phaseTicksTotal)}`);
    }
    const reservedSlot = readOptionalCount(fields['reservedSlot'], '/reservedSlot');
    // Rezervovaný slot smie mať len žeriav v stave cyklu, ktorý ho drží (`craneReservesApronSlot`); či ho v režime `apron`
    // mať musí (a v `under_hook` nesmie), overuje svet (kotvisko pozná režim).
    if (reservedSlot !== null && !craneReservesApronSlot(cycle, state)) {
      throw new ModuleStateError('/reservedSlot', `stav '${state}' cyklu '${cycle}' nesmie mať rezervovaný slot`);
    }
    const dualUnitId = readOptionalCount(fields['dualUnitId'], '/dualUnitId');
    if (dualUnitId === 0) throw new ModuleStateError('/dualUnitId', 'id jednotky musí byť null alebo celé číslo ≥ 1');
    if ((cycle === 'dual_unload') !== (dualUnitId !== null)) {
      throw new ModuleStateError('/dualUnitId', cycle === 'dual_unload' ? "cyklus 'dual_unload' vyžaduje dualUnitId (jednotka z dual_load)" : `cyklus '${cycle}' nemá dualUnitId`);
    }
    const phase = cranePhaseProblem(state, phaseTicksTotal, phaseTicksLeft);
    if (phase !== undefined) throw new ModuleStateError(phase.path, phase.problem);
    const busyTicks = readCount(fields['busyTicks'], '/busyTicks');
    const idleTicks = readCount(fields['idleTicks'], '/idleTicks');
    const blockedTicks = readCount(fields['blockedTicks'], '/blockedTicks');
    const waitForVehicleTicks = readCount(fields['waitForVehicleTicks'], '/waitForVehicleTicks');
    const vehicleWaitTicks = readCount(fields['vehicleWaitTicks'], '/vehicleWaitTicks');
    const lastBlockedHour = readOptionalCount(fields['lastBlockedHour'], '/lastBlockedHour');

    // Od tohto bodu nič nevyhadzuje — obnova je atomická.
    this.current = state;
    this.cycle = cycle;
    this.phaseTicksTotal = phaseTicksTotal;
    this.phaseTicksLeft = phaseTicksLeft;
    this.reservedSlot = reservedSlot;
    this.targetUnitId = targetUnitId as EntityId | null;
    this.dualUnitId = dualUnitId as EntityId | null;
    this.busyTicks = busyTicks;
    this.idleTicks = idleTicks;
    this.blockedTicks = blockedTicks;
    this.waitForVehicleTicks = waitForVehicleTicks;
    this.vehicleWaitTicks = vehicleWaitTicks;
    this.lastBlockedHour = lastBlockedHour;
  }
}
