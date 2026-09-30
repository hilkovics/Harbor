/**
 * Žeriav (ARCHITECTURE §5.3, §7.2; ADR-014, ADR-016). Stojí **na** bunkách jedného berthu s rovnakou rotáciou
 * (rozhodnutie 3): `berthId` je modul pod jeho ľavým horným rohom, `cell.moduleId` ostáva id berthu a berth ho
 * eviduje v `craneIds`. Tu je stav, tabuľka prechodov FSM (`CRANE_TRANSITIONS`), jeho význam a serializácia; cyklus
 * (kedy a prečo sa prechádza) riadi `CraneSystem` (krok 4) výlučne cez `transition()` / `enterPhase()`.
 *
 * Dynamický stav v save (`CraneRuntimeState`) neobsahuje `heldUnitId` — držaná jednotka je v `CargoLedger`
 * (`in_crane`) a loader ju odtiaľ doplní.
 */
import type { EntityId } from '../core/entity-id';
import { craneParams } from '../defs/module-def';
import type { CargoCategory, CraneParams } from '../defs/types';
import { Module, type ModuleInit } from './module';
import { ModuleError, ModuleStateError } from './module-error';
import { checkRuntimeKeys, readCount, readEnum, readOptionalCount } from './runtime-state';

/** Stavy žeriavu (§7.2) v poradí cyklu. */
export const CRANE_STATES = ['idle', 'grabbing', 'swinging', 'placing', 'blocked'] as const;
export type CraneState = (typeof CRANE_STATES)[number];

/** Do ktorého počítadla utilizácie (§11) patrí tick v danom stave. */
export type CraneCounter = 'idle' | 'busy' | 'blocked';

/** Čo platí pre žeriav v danom stave (rozhodnutie 7 v docs/tasks/phase-02.md). */
export interface CraneStateTraits {
  /** Žeriav drží jednotku (`in_crane`) — `heldUnitId !== null`. */
  readonly holdsUnit: boolean;
  /** Žeriav má rezervovaný slot apronu svojho berthu — `reservedSlot !== null`. */
  readonly hasReservation: boolean;
  readonly counter: CraneCounter;
}

/**
 * Tabuľka vlastností stavov: rezervácia vzniká pri `idle → grabbing`, jednotka prejde `on_ship → in_crane` pri
 * `swinging` a `in_crane → on_apron` na konci `placing` (rezervácia zaniká). `blocked` nič nedrží ani nerezervuje.
 * Kontroluje ju `World.assertInvariants()` aj loader save.
 */
export const CRANE_STATE_TRAITS: { readonly [S in CraneState]: CraneStateTraits } = Object.freeze({
  idle: Object.freeze({ holdsUnit: false, hasReservation: false, counter: 'idle' }),
  grabbing: Object.freeze({ holdsUnit: false, hasReservation: true, counter: 'busy' }),
  swinging: Object.freeze({ holdsUnit: true, hasReservation: true, counter: 'busy' }),
  placing: Object.freeze({ holdsUnit: true, hasReservation: true, counter: 'busy' }),
  blocked: Object.freeze({ holdsUnit: false, hasReservation: false, counter: 'blocked' }),
});

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
  state: CraneState = 'idle';
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

  /** Kategória nákladu, ktorú žeriav prekladá. */
  get category(): CargoCategory {
    return this.params.category;
  }

  /** Vlastnosti aktuálneho stavu (`CRANE_STATE_TRAITS`). */
  get traits(): CraneStateTraits {
    return CRANE_STATE_TRAITS[this.state];
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
    if (!isCraneTransitionAllowed(this.state, to)) {
      const allowed = CRANE_TRANSITIONS.get(this.state) ?? [];
      throw new ModuleError('invalid_transition', `${this.label}: prechod ${this.state} → ${to} nie je povolený (povolené: ${allowed.join(', ')})`);
    }
    this.state = to;
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
      state: this.state,
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
   * Kontroly: presne kľúče `CraneRuntimeState`, `state` z `CRANE_STATES`, počítadlá celé ≥ 0,
   * `phaseTicksLeft ≤ phaseTicksTotal`, `reservedSlot` a `lastBlockedHour` null alebo celé ≥ 0 a rezervácia
   * zodpovedá stavu (`CRANE_STATE_TRAITS.hasReservation`). Súlad so slotmi berthu a s ledgerom overí loader.
   */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, RUNTIME_KEYS);
    const state = readEnum(fields['state'], CRANE_STATES, '/state');
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
    const busyTicks = readCount(fields['busyTicks'], '/busyTicks');
    const idleTicks = readCount(fields['idleTicks'], '/idleTicks');
    const blockedTicks = readCount(fields['blockedTicks'], '/blockedTicks');
    const lastBlockedHour = readOptionalCount(fields['lastBlockedHour'], '/lastBlockedHour');

    // Od tohto bodu nič nevyhadzuje — obnova je atomická.
    this.state = state;
    this.phaseTicksTotal = phaseTicksTotal;
    this.phaseTicksLeft = phaseTicksLeft;
    this.reservedSlot = reservedSlot;
    this.busyTicks = busyTicks;
    this.idleTicks = idleTicks;
    this.blockedTicks = blockedTicks;
    this.lastBlockedHour = lastBlockedHour;
  }
}
