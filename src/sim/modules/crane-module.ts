/**
 * Žeriav (ARCHITECTURE §5.3, §7.2; ADR-014, ADR-016). Stojí **na** bunkách jedného berthu s rovnakou rotáciou
 * (rozhodnutie 3): `berthId` je modul pod jeho ľavým horným rohom, `cell.moduleId` ostáva id berthu a berth ho
 * eviduje v `craneIds`. Tu je stav, tabuľka prechodov FSM (`CRANE_TRANSITIONS`), jeho význam a serializácia; cyklus
 * (kedy a prečo sa prechádza) riadi `CraneSystem` (krok 4) výlučne cez `transition()` / `enterPhase()`. Stav je
 * privátny s getterom `state` (ako `Ship.state`): mimo `transition` ho mení len `restoreRuntimeState` (T02-14).
 *
 * Dynamický stav v save (`CraneRuntimeState`) neobsahuje `heldUnitId` — držaná jednotka je v `CargoLedger`
 * (`in_crane`) a loader ju odtiaľ doplní.
 */
import type { EntityId } from '../core/entity-id';
import { craneParams } from '../defs/module-def';
import type { CargoCategory, CraneParams } from '../defs/types';
import type { StatResolver } from '../tech/stat-resolver';
import { Module, type ModuleInit } from './module';
import { ModuleError, ModuleStateError } from './module-error';
import { checkRuntimeKeys, readCount, readEnum, readOptionalCount } from './runtime-state';

/** Stavy žeriavu (§7.2) v poradí cyklu. */
export const CRANE_STATES = ['idle', 'grabbing', 'swinging', 'placing', 'blocked'] as const;
export type CraneState = (typeof CRANE_STATES)[number];

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
  /** Žeriav má rezervovaný slot apronu svojho berthu — `reservedSlot !== null`. */
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

/** Dynamický stav žeriavu v save (`WorldState.modules[i].runtime`). */
export type CraneRuntimeState = {
  readonly state: CraneState;
  readonly phaseTicksTotal: number;
  readonly phaseTicksLeft: number;
  readonly reservedSlot: number | null;
  readonly busyTicks: number;
  readonly idleTicks: number;
  readonly blockedTicks: number;
  readonly lastBlockedHour: number | null;
};

/**
 * Najkratšia fáza cyklu v tickoch — žeriav nemôže zdvihnúť ani položiť jednotku „za nula tickov“ (ADR-016; fázy počíta
 * `cranePhaseTicks` v `CraneSystem`, ktorý konštantu reexportuje).
 */
export const MIN_CRANE_PHASE_TICKS = 1;

const RUNTIME_KEYS: readonly (keyof CraneRuntimeState)[] = [
  'state',
  'phaseTicksTotal',
  'phaseTicksLeft',
  'reservedSlot',
  'busyTicks',
  'idleTicks',
  'blockedTicks',
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
  busyTicks = 0;
  idleTicks = 0;
  blockedTicks = 0;
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
      phaseTicksTotal: this.phaseTicksTotal,
      phaseTicksLeft: this.phaseTicksLeft,
      reservedSlot: this.reservedSlot,
      busyTicks: this.busyTicks,
      idleTicks: this.idleTicks,
      blockedTicks: this.blockedTicks,
      lastBlockedHour: this.lastBlockedHour,
    };
  }

  /**
   * Kontroly: presne kľúče `CraneRuntimeState`, `state` z `CRANE_STATES` okrem okamžitého `swinging` (neukladá sa),
   * počítadlá celé ≥ 0, `phaseTicksLeft ≤ phaseTicksTotal`, `reservedSlot` a `lastBlockedHour` null alebo celé ≥ 0,
   * rezervácia zodpovedá stavu (`CRANE_STATE_TRAITS.hasReservation`) a fáza tiež (`cranePhaseProblem`: `idle`/`blocked`
   * 0/0, `grabbing`/`placing` `phaseTicksLeft ≥ 1`), T02-14. Nekonzistentný stav je `ModuleStateError` už pri
   * `deserialize`, nie pád až v `tick()`. Súlad so slotmi berthu, s ledgerom a s loďou overí loader.
   */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, RUNTIME_KEYS);
    const state = readEnum(fields['state'], CRANE_STATES, '/state');
    // Okamžitý stav sa odmietne hneď (skôr než polia, ktoré preň nemajú zmysel).
    const instant = CRANE_STATE_TRAITS[state].phase === 'instant' ? cranePhaseProblem(state, 0, 0) : undefined;
    if (instant !== undefined) throw new ModuleStateError(instant.path, instant.problem);
    const phaseTicksTotal = readCount(fields['phaseTicksTotal'], '/phaseTicksTotal');
    const phaseTicksLeft = readCount(fields['phaseTicksLeft'], '/phaseTicksLeft');
    if (phaseTicksLeft > phaseTicksTotal) {
      throw new ModuleStateError('/phaseTicksLeft', `${String(phaseTicksLeft)} > phaseTicksTotal ${String(phaseTicksTotal)}`);
    }
    const reservedSlot = readOptionalCount(fields['reservedSlot'], '/reservedSlot');
    if (CRANE_STATE_TRAITS[state].hasReservation !== (reservedSlot !== null)) {
      throw new ModuleStateError(
        '/reservedSlot',
        CRANE_STATE_TRAITS[state].hasReservation ? `stav '${state}' vyžaduje rezervovaný slot` : `stav '${state}' nesmie mať rezervovaný slot`,
      );
    }
    const phase = cranePhaseProblem(state, phaseTicksTotal, phaseTicksLeft);
    if (phase !== undefined) throw new ModuleStateError(phase.path, phase.problem);
    const busyTicks = readCount(fields['busyTicks'], '/busyTicks');
    const idleTicks = readCount(fields['idleTicks'], '/idleTicks');
    const blockedTicks = readCount(fields['blockedTicks'], '/blockedTicks');
    const lastBlockedHour = readOptionalCount(fields['lastBlockedHour'], '/lastBlockedHour');

    // Od tohto bodu nič nevyhadzuje — obnova je atomická.
    this.current = state;
    this.phaseTicksTotal = phaseTicksTotal;
    this.phaseTicksLeft = phaseTicksLeft;
    this.reservedSlot = reservedSlot;
    this.busyTicks = busyTicks;
    this.idleTicks = idleTicks;
    this.blockedTicks = blockedTicks;
    this.lastBlockedHour = lastBlockedHour;
  }
}
