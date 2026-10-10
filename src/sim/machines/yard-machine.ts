/**
 * Stroj bloku (`YardMachine`, ADR-040 bod 3; docs/TERMINAL_2.md §5.3) — entita viazaná na modul bloku (`blockId`), ktorá drží najviac jeden kontajner
 * (`CargoLocation in_handler { machineId }`, vždy len počas cyklu) a vedie frontu vozidiel čakajúcich na TP. Na rozdiel od vozidla nejazdí po cestách:
 * jeho poloha je abstraktná (`MachinePose`: žeriav v bays, vozík v radoch, spúšťač vo vrstvách), spojitá počas fázy (lineárna interpolácia `pose → target`).
 *
 * Trieda nesie len stav, fázový odpočet a (de)serializáciu; cykly a presuny nákladu robí `systems/yard-machine-system.ts` (jeden systém = jeden súbor, §6).
 * Stav mení len `transition` podľa `MACHINE_TRANSITIONS` (CLAUDE.md konvencia FSM). Konkrétny stroj (`RtgCrane`) dodáva časy z `equipment.json`.
 */
import type { EntityId } from '../core/entity-id';
import { YARD_PRIORITY_KINDS, type YardPriorityKind } from '../defs/types';
import { MachineError } from './machine-error';
import { MACHINE_TRANSITIONS, isMachineState, isMachineTransitionAllowed } from './machine-fsm';
import type { CycleKind, MachineCycle, MachinePose, MachineQueueEntry, MachineState } from './machine-state-types';

/** Stroj v save (`WorldState.machines[i]`, ADR-040 bod 9) — čistý JSON; poradie v save = vzostupne podľa id. */
export interface SerializedMachine {
  readonly id: number;
  readonly defId: string;
  readonly blockId: number;
  readonly state: MachineState;
  /** Poloha na začiatku aktuálnej fázy. */
  readonly pose: MachinePose;
  /** Poloha na konci aktuálnej fázy (pri `idle` rovná `pose`). */
  readonly target: MachinePose;
  /** Dĺžka aktuálnej fázy v tickoch (`idle`: 0). */
  readonly phaseTotal: number;
  /** Zostávajúce ticky fázy (`idle`: 0). */
  readonly phaseLeft: number;
  readonly cycle: MachineCycle | null;
  /** Čakajúce vozidlá v poradí vzniku; poradie obsluhy určuje systém. */
  readonly queue: readonly MachineQueueEntry[];
  /** Dokončené cykly (aj rehandling). */
  readonly moves: number;
  /** Ticky bez cieľa rehandlingu (trpezlivosť, `logistics.rehandleGiveUpTicks`). */
  readonly stallTicks: number;
  /** Druh úlohy, ktorý hráč povýšil na prvý v poradí (`SetBlockPriority`); `null` = poradie z `equipment.json`. */
  readonly firstPriority: YardPriorityKind | null;
}

/** Kľúče `SerializedMachine` v poradí `toState()`. */
export const SERIALIZED_MACHINE_KEYS: readonly (keyof SerializedMachine)[] = ['id', 'defId', 'blockId', 'state', 'pose', 'target', 'phaseTotal', 'phaseLeft', 'cycle', 'queue', 'moves', 'stallTicks', 'firstPriority'];

/** Vstup konštruktora stroja (kúpa aj obnova zo save). */
export interface YardMachineInit {
  readonly id: EntityId;
  readonly blockId: EntityId;
  /** Východisková poloha (nový stroj stojí v bayi 0 nad pruhom so spúšťačom hore). */
  readonly pose: MachinePose;
  readonly state?: MachineState;
  readonly target?: MachinePose;
  readonly phaseTotal?: number;
  readonly phaseLeft?: number;
  readonly cycle?: MachineCycle | null;
  readonly queue?: readonly MachineQueueEntry[];
  readonly moves?: number;
  readonly stallTicks?: number;
  readonly firstPriority?: YardPriorityKind | null;
}

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const isPose = (pose: MachinePose): boolean => [pose.gantry, pose.trolley, pose.hoist].every(Number.isFinite);

export abstract class YardMachine {
  readonly id: EntityId;
  readonly kind = 'machine' as const;
  abstract readonly defId: string;
  readonly blockId: EntityId;
  private current: MachineState;
  private from: MachinePose;
  private to: MachinePose;
  private total: number;
  private left: number;
  private activeCycle: MachineCycle | null;
  private readonly waiting: MachineQueueEntry[];
  private moveCount: number;
  private stall: number;
  private first: YardPriorityKind | null;

  /** Chyby (`MachineError('invalid_input')`): id alebo `blockId` nie je celé ≥ 1, neznámy stav, neplatná poloha, fáza (`idle` ↔ odpočet 0, inak `1 ≤ left ≤ total`), počítadlá. */
  protected constructor(init: YardMachineInit, label: string) {
    const { id, blockId } = init;
    const state = init.state ?? 'idle';
    const total = init.phaseTotal ?? 0;
    const left = init.phaseLeft ?? 0;
    const target = init.target ?? init.pose;
    const bad = (problem: string): MachineError => new MachineError('invalid_input', `${label} #${String(id)}: ${problem}`);
    if (!Number.isSafeInteger(id) || id < 1) throw bad('id musí byť celé číslo ≥ 1');
    if (!Number.isSafeInteger(blockId) || blockId < 1) throw bad(`blockId musí byť celé číslo ≥ 1, dostal ${String(blockId)}`);
    if (!isMachineState(state)) throw bad(`neznámy stav '${String(state)}'`);
    if (!isPose(init.pose) || !isPose(target)) throw bad('poloha musí mať konečné súradnice');
    const phaseOk = state === 'idle' ? total === 0 && left === 0 : total >= 1 && left >= 1 && left <= total;
    if (!isCount(total) || !isCount(left) || !phaseOk) throw bad(`fáza '${state}': odpočet ${String(left)} z ${String(total)} je neplatný`);
    const moves = init.moves ?? 0;
    const stallTicks = init.stallTicks ?? 0;
    if (!isCount(moves) || !isCount(stallTicks)) throw bad('počítadlá musia byť celé čísla ≥ 0');
    this.id = id;
    this.blockId = blockId;
    this.current = state;
    this.from = init.pose;
    this.to = target;
    this.total = total;
    this.left = left;
    this.activeCycle = init.cycle ?? null;
    this.waiting = [...(init.queue ?? [])];
    this.moveCount = moves;
    this.stall = stallTicks;
    const firstPriority = init.firstPriority ?? null;
    if (firstPriority !== null && !YARD_PRIORITY_KINDS.includes(firstPriority)) throw bad(`neznáma priorita '${String(firstPriority)}'`);
    this.first = firstPriority;
  }

  /** Denná mzda obsluhy stroja v centoch (`DayClosed`, F7, ADR-044); základ 0, `RtgCrane` ju berie z defu. */
  dailyWageCents(): number {
    return 0;
  }

  /** Druh úlohy povýšený hráčom na prvý (`SetBlockPriority`), alebo `null` (poradie z defu). */
  get firstPriority(): YardPriorityKind | null {
    return this.first;
  }

  /** Nastaví druh úlohy, ktorý stroj obsluhuje ako prvý (`null` = poradie z defu); volá výlučne `SetBlockPriority`. */
  setFirstPriority(kind: YardPriorityKind | null): void {
    if (kind !== null && !YARD_PRIORITY_KINDS.includes(kind)) throw new MachineError('invalid_input', `${this.label}: neznáma priorita '${String(kind)}'`);
    this.first = kind;
  }

  get state(): MachineState {
    return this.current;
  }

  /** Popis do chybových správ: `rtg #12`. */
  get label(): string {
    return `${this.defId} #${String(this.id)}`;
  }

  /** Rozpracovaná operácia, alebo `null` v `idle`. */
  get cycle(): MachineCycle | null {
    return this.activeCycle;
  }

  /** Čakajúce vozidlá (poradie vzniku); výber podľa priority robí systém. */
  get queue(): readonly MachineQueueEntry[] {
    return this.waiting;
  }

  /** Dokončené cykly (aj rehandling). */
  get moves(): number {
    return this.moveCount;
  }

  /** Ticky bez cieľa rehandlingu. */
  get stallTicks(): number {
    return this.stall;
  }

  /** Poloha na začiatku fázy a na jej konci (render interpoluje `phaseProgress`). */
  get phase(): { readonly from: MachinePose; readonly to: MachinePose; readonly total: number; readonly left: number } {
    return { from: this.from, to: this.to, total: this.total, left: this.left };
  }

  /** Priebeh fázy `0…1` (`idle` = 1). */
  get phaseProgress(): number {
    return this.total === 0 ? 1 : (this.total - this.left) / this.total;
  }

  /** Okamžitá poloha: lineárna interpolácia `from → to` podľa priebehu fázy (spojitá poloha žeriavu, vozíka a spúšťača). */
  poseNow(): MachinePose {
    const p = this.phaseProgress;
    return { gantry: this.from.gantry + (this.to.gantry - this.from.gantry) * p, trolley: this.from.trolley + (this.to.trolley - this.from.trolley) * p, hoist: this.from.hoist + (this.to.hoist - this.from.hoist) * p };
  }

  /** Poloha po dokončení aktuálnej fázy (pri `idle` stojaca poloha). */
  get restPose(): MachinePose {
    return this.to;
  }

  /** Prechod podľa `MACHINE_TRANSITIONS`; nepovolený → `MachineError('invalid_transition')`, stroj sa nezmení. */
  transition(to: MachineState): void {
    if (!isMachineTransitionAllowed(this.current, to)) {
      const allowed = MACHINE_TRANSITIONS.get(this.current) ?? [];
      throw new MachineError('invalid_transition', `${this.label}: prechod ${this.current} → ${to} nie je povolený (povolené: ${allowed.join(', ') || '–'})`);
    }
    this.current = to;
  }

  /** Vstup do fázy `state` (prechod + odpočet `ticks ≥ 1`) s cieľovou polohou `target`; fáza začína z doterajšej cieľovej polohy. */
  enterPhase(state: MachineState, ticks: number, target: MachinePose): void {
    if (!Number.isSafeInteger(ticks) || ticks < 1) throw new MachineError('invalid_input', `${this.label}: fáza '${state}' musí trvať aspoň tick, dostal ${String(ticks)}`);
    this.transition(state);
    this.from = this.to;
    this.to = target;
    this.total = ticks;
    this.left = ticks;
  }

  /** Jeden tick odpočtu fázy; `true`, keď fáza práve skončila (poloha je cieľová). */
  advancePhase(): boolean {
    if (this.left === 0) return false;
    this.left -= 1;
    if (this.left > 0) return false;
    this.from = this.to;
    this.total = 0;
    return true;
  }

  /** Začne cyklus (stroj v `idle` bez cyklu). */
  beginCycle(cycle: MachineCycle): void {
    if (this.activeCycle !== null || this.current !== 'idle') throw new MachineError('invalid_input', `${this.label}: cyklus ${cycle.kind} pri rozpracovanom cykle`);
    this.activeCycle = cycle;
    this.stall = 0;
  }

  /** Upraví rozpracovaný cyklus (usadenie rezervácie slotu po zdvihu, ADR-039 bod 6). */
  replaceCycle(cycle: MachineCycle): void {
    if (this.activeCycle === null) throw new MachineError('inconsistent', `${this.label}: nie je čo upraviť, stroj nemá cyklus`);
    this.activeCycle = cycle;
  }

  /** Koniec cyklu: stroj sa vráti do `idle` (z `lower`) a počíta cyklus. */
  endCycle(): void {
    this.transition('idle');
    this.activeCycle = null;
    this.moveCount += 1;
  }

  /**
   * Vzdá rozpracovaný cyklus (TR3-06b): stroj stojí na mieste (`idle`, bez odpočtu), cyklus sa nezapočíta do `moves`. Jednotku v `in_handler` musí volajúci vrátiť
   * do stohu **pred** týmto volaním (`systems/yard-machine-system.ts`).
   */
  abortCycle(): void {
    if (this.activeCycle === null) throw new MachineError('inconsistent', `${this.label}: nie je čo vzdať, stroj nemá cyklus`);
    const pose = this.poseNow();
    this.transition('idle');
    this.from = pose;
    this.to = pose;
    this.total = 0;
    this.left = 0;
    this.activeCycle = null;
    this.stall = 0;
  }

  /** Pripočíta tick bez cieľa rehandlingu; vráti nový počet. */
  addStall(): number {
    this.stall += 1;
    return this.stall;
  }

  resetStall(): void {
    this.stall = 0;
  }

  /** Zaradí vozidlo do fronty (raz; opakované volanie nič nerobí). */
  enqueue(vehicleId: EntityId, tick: number): void {
    if (!this.waiting.some((entry) => entry.vehicleId === vehicleId)) this.waiting.push({ vehicleId, createdTick: tick });
  }

  /** Vyradí vozidlo z fronty. */
  dequeue(vehicleId: EntityId): void {
    const index = this.waiting.findIndex((entry) => entry.vehicleId === vehicleId);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  /** Čaká vozidlo vo fronte, alebo ho stroj práve obsluhuje? */
  serves(vehicleId: EntityId): boolean {
    return this.activeCycle?.vehicleId === vehicleId || this.waiting.some((entry) => entry.vehicleId === vehicleId);
  }

  /** Je druh cyklu platný? (Pre obnovu zo save.) */
  static isCycleKind(value: unknown): value is CycleKind {
    return value === 'put' || value === 'take' || value === 'relocate';
  }

  /** Čistý JSON stav pre save (nová kópia pri každom volaní). */
  toState(): SerializedMachine {
    return {
      id: this.id,
      defId: this.defId,
      blockId: this.blockId,
      state: this.current,
      pose: { ...this.from },
      target: { ...this.to },
      phaseTotal: this.total,
      phaseLeft: this.left,
      cycle: this.activeCycle === null ? null : { ...this.activeCycle },
      queue: this.waiting.map((entry) => ({ ...entry })),
      moves: this.moveCount,
      stallTicks: this.stall,
      firstPriority: this.first,
    };
  }
}
