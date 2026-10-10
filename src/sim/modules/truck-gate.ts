/**
 * Pruh brány kamiónov (ARCHITECTURE §5.3, §7.5; ADR-022; od R4 ADR-041 bod 1: `gate_in_lane` a `gate_out_lane`) — **jednosmerný priechod** medzi cestnou sieťou pred
 * pruhom a za ním. Pruh obsluhuje 1 kamión naraz a nezávisle od susedných pruhov; susedné pruhy tvoria jednu bránu (`adjacentLaneGroups`, render: spoločná strecha).
 *
 * - **Strany:** prvý konektor defu = vonkajšia (vstupná) strana, druhý = vnútorná (výstupná); smer je pevný (`direction`, `entrySide` / `exitSide` určuje
 *   svet — cesta na vonkajšej bunke konektora; bez nej `null`). Vstupný pruh púšťa kamióny z cesty dnu, výstupný z areálu von.
 * - **Fronta:** FIFO kamiónov pruhu (`enqueue` / `peekQueue` / `dequeue`); fyzicky čaká na vonkajšej bunke konektora jediný kamión (`gate_queue`), ďalšie stoja
 *   za ním na ceste (ADR-037) alebo v predbránovej ploche. Kamión na čele, ktorý prechádza pruhom, ostáva vo fronte, kým prechod neskončí a nevyjde.
 * - **Kroky a režim** (ADR-041 bod 1): prechod je plán krokov z defu (vstup: OCR → kontrola → lístok; výstup: váha → sken → plomba), v režime `express` jediný
 *   krok `express`, v režime `trouble` jediný dlhý krok (`troubleTicks` / `inspectionTicks`); `standard` s problémom (`Rng`, rozhodne systém) pridá krok `trouble` /
 *   `inspect` navyše. Režim mení `setMode` (príkaz `SetGateLaneMode`); platí od nasledujúceho kamióna. `currentStep()` dáva krok a jeho priebeh 0…1 pre VM.
 * - **Priepustnosť:** `beginPass(plan)` začne prechod kamióna na čele fronty (`busyTicksLeft = Σ ticky + internalTicks`), `advancePass()` odpočíta tick. Kým
 *   `busyTicksLeft > 0`, ďalší kamión nesmie začať. Z fronty vypadne až po dokončení prechodu (`completePass`: `trucksProcessed += 1`); `withdraw` vyradí kamión bez
 *   prechodu (strany sa pod ním preklopili, dodatok ADR-024).
 * - **Súlad prechodu s frontou** (`gatePassProblem`, krok 12 aj obnova): `busyTicksLeft ≤ passTotalTicks`, súčet plánu = `passTotalTicks` a prebiehajúci prechod má
 *   kamión na čele fronty.
 *
 * `runtime` v save: `{ queue, busyTicksLeft, trucksProcessed, mode, passPlan, passTotalTicks }`. Súlad fronty s kamiónmi (fronta = presne kamióny
 * v `gate_queue*` / `gate_pass*` tohto pruhu) overuje svet (krok 12); strany sa neukladajú (odvodia sa z ciest a modulov).
 */
import type { EntityId } from '../core/entity-id';
import { describeValue } from '../defs/def-spec';
import { gateParams } from '../defs/module-def';
import { GATE_MODES, type GateDirection, type GateMode, type GateParams } from '../defs/types';
import { LandExportModule, type LandsideRole, type LandsideRoster } from './land-export-module';
import type { ModuleInit } from './module';
import { ModuleError, ModuleStateError } from './module-error';
import type { PlacedConnector } from './module-geometry';
import { checkRuntimeKeys, readCount } from './runtime-state';

/** Krok prechodu pruhom (id kroku je kľúč pre VM a render). */
export const GATE_STEP_IDS = ['ocr', 'check', 'issue', 'weigh', 'scan', 'seal', 'express', 'trouble', 'inspect'] as const;
export type GateStepId = (typeof GATE_STEP_IDS)[number];

/** Jeden krok plánu prechodu: id a trvanie v tickoch (celé ≥ 1). */
export type GateStep = {
  readonly id: GateStepId;
  readonly ticks: number;
};

/** Krok prebiehajúceho prechodu: id a priebeh 0 … 1 (VM, render). */
export type GateStepProgress = {
  readonly id: GateStepId;
  readonly progress: number;
};

/** Dynamický stav brány v save (`WorldState.modules[i].runtime`, ADR-022). */
export type GateRuntimeState = {
  /** Kamióny vo fronte v poradí príchodu (FIFO). */
  readonly queue: readonly number[];
  /** Zostávajúce ticky prechodu práve púšťaného kamióna (0 = brána voľná). */
  readonly busyTicksLeft: number;
  /** Kumulatívny počet kamiónov, ktoré dokončili prechod bránou. */
  readonly trucksProcessed: number;
  /** Režim pruhu (`SetGateLaneMode`, R4). */
  readonly mode: GateMode;
  /** Plán krokov prebiehajúceho prechodu (prázdny, keď pruh nepúšťa). */
  readonly passPlan: readonly GateStep[];
  /** Celkové trvanie prebiehajúceho prechodu v tickoch (Σ plánu + `internalTicks`; 0 = pruh voľný). */
  readonly passTotalTicks: number;
};

const RUNTIME_KEYS: readonly (keyof GateRuntimeState)[] = ['queue', 'busyTicksLeft', 'trucksProcessed', 'mode', 'passPlan', 'passTotalTicks'];
const NO_PLAN: readonly GateStep[] = Object.freeze([]);
const NO_TRUCKS: readonly EntityId[] = Object.freeze([]);

function isTruckId(value: unknown): value is EntityId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Súlad prechodu s frontou (krok 12 aj obnova, vzor `cranePhaseProblem`): odpočet najviac `passTicks` a prebiehajúci
 * prechod má kamión na čele fronty. Problém s poľom `runtime`, alebo `undefined`. Bez alokácie v platnom stave.
 */
export function gatePassProblem(busyTicksLeft: number, passTicks: number, queueLength: number): { readonly path: string; readonly problem: string } | undefined {
  if (busyTicksLeft > passTicks) return { path: '/busyTicksLeft', problem: `odpočet prechodu ${String(busyTicksLeft)} je nad trvaním prechodu ${String(passTicks)}` };
  if (busyTicksLeft > 0 && queueLength === 0) return { path: '/busyTicksLeft', problem: `prechod beží (${String(busyTicksLeft)} tickov), ale fronta je prázdna` };
  return undefined;
}

export class TruckGate extends LandExportModule {
  /** Typované `params` defu (`gateParams`). */
  readonly params: GateParams;
  private readonly queue: EntityId[] = [];
  /** Tie isté id ako `queue` (bez poradia) — O(1) členstvo a kontrola duplicít bez alokácie. */
  private readonly members = new Set<EntityId>();
  private queueView: readonly EntityId[] = NO_TRUCKS;
  private busy = 0;
  private processed = 0;
  private currentMode: GateMode = 'standard';
  private plan: readonly GateStep[] = NO_PLAN;
  private planTotal = 0;
  private entry: PlacedConnector | null = null;
  private exit: PlacedConnector | null = null;

  /** Def iného druhu než `gate` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = gateParams(init.def);
  }

  /** Denná mzda obsluhy pruhu (`params.wagePerDayCents`, F7, ADR-044). */
  override dailyWageCents(): number {
    return this.params.wagePerDayCents ?? 0;
  }

  override get landsideRole(): LandsideRole {
    return 'gate';
  }

  override get internalTicks(): number | undefined {
    return this.params.internalTicks;
  }

  override enlist(roster: LandsideRoster): void {
    roster.gates.push(this);
  }

  /** Vstupná strana (konektor pred bránou, z portálu); `null` = neurčená. Zverejňuje ju svet (`setSides`). */
  get entrySide(): PlacedConnector | null {
    return this.entry;
  }

  /** Výstupná strana (konektor za bránou); `null` = neurčená. */
  get exitSide(): PlacedConnector | null {
    return this.exit;
  }

  /** Počet kamiónov vo fronte (render: `queue_badge`). */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Kamióny vo fronte v poradí príchodu — zmrazená snímka (mení sa len pri zmene fronty, čítanie nealokuje). */
  get queuedTruckIds(): readonly EntityId[] {
    return this.queueView;
  }

  /** Zostávajúce ticky prechodu práve púšťaného kamióna (0 = brána voľná). */
  get busyTicksLeft(): number {
    return this.busy;
  }

  /** Závora je hore — brána práve púšťa kamión (`busyTicksLeft > 0`). */
  get isOpen(): boolean {
    return this.busy > 0;
  }

  /** Kumulatívny počet kamiónov, ktoré dokončili prechod (`completePass`). */
  get trucksProcessed(): number {
    return this.processed;
  }

  /** Smer pruhu (`params.direction`). */
  get direction(): GateDirection {
    return this.params.direction;
  }

  /** Režim pruhu (`SetGateLaneMode`). */
  get mode(): GateMode {
    return this.currentMode;
  }

  /** Nastaví režim pruhu; platí od nasledujúceho kamióna (prebiehajúci prechod sa nemení). Neznámy režim → `ModuleError('invalid_input')`. */
  setMode(mode: GateMode): void {
    if (!GATE_MODES.includes(mode)) throw new ModuleError('invalid_input', `${this.label}.setMode: neznámy režim '${String(mode)}'`);
    this.currentMode = mode;
  }

  /** Plán krokov prebiehajúceho prechodu (prázdny, keď pruh nepúšťa). */
  get passPlan(): readonly GateStep[] {
    return this.plan;
  }

  /** Celkové trvanie prebiehajúceho prechodu (Σ plánu + `internalTicks`; 0 = voľný). */
  get passTotalTicks(): number {
    return this.planTotal;
  }

  /**
   * Plán krokov pre režim `mode`; `trouble` = kamión s problémom (len režim `standard`, rozhodne `Rng` v systéme) pridá krok `trouble` (vstup) / `inspect` (výstup)
   * navyše. `express` = jediný krok `express`, `trouble` = jediný dlhý krok. Bez alokácie mimo výsledného poľa.
   */
  planFor(mode: GateMode, trouble: boolean): readonly GateStep[] {
    const p = this.params;
    const incoming = p.direction === 'in';
    if (mode === 'express') return [{ id: 'express', ticks: p.expressTicks }];
    if (mode === 'trouble') return [incoming ? { id: 'trouble', ticks: p.troubleTicks ?? 1 } : { id: 'inspect', ticks: p.inspectionTicks ?? 1 }];
    const steps: GateStep[] = incoming
      ? [
          { id: 'ocr', ticks: p.ocrTicks ?? 1 },
          { id: 'check', ticks: p.checkTicks ?? 1 },
          { id: 'issue', ticks: p.issueTicks ?? 1 },
        ]
      : [
          { id: 'weigh', ticks: p.weighTicks ?? 1 },
          { id: 'scan', ticks: p.scanTicks ?? 1 },
          { id: 'seal', ticks: p.sealTicks ?? 1 },
        ];
    if (trouble) steps.push(incoming ? { id: 'trouble', ticks: p.troubleTicks ?? 1 } : { id: 'inspect', ticks: p.inspectionTicks ?? 1 });
    return steps;
  }

  /** Šanca na problém kamióna v režime `standard` (`gateIssueChance` / `sealIssueChance`, 0 … 1); `Rng` ju losuje systém. */
  get issueChance(): number {
    return (this.params.direction === 'in' ? this.params.gateIssueChance : this.params.sealIssueChance) ?? 0;
  }

  /** Trvanie plánu `plan` vrátane `internalTicks`. */
  planTicks(plan: readonly GateStep[]): number {
    let total = this.params.internalTicks ?? 0;
    for (const step of plan) total += step.ticks;
    return total;
  }

  /** Stredný čas obsluhy v režime `mode` (ETA výberu brány): plán bez problému + šanca × čas problému. Bez `Rng`. */
  meanServiceTicks(mode: GateMode): number {
    const base = this.planTicks(this.planFor(mode, false));
    if (mode !== 'standard') return base;
    const extra = this.planTicks(this.planFor(mode, true)) - base + (this.params.internalTicks ?? 0);
    return base + this.issueChance * extra;
  }

  /** Najdlhší možný prechod v ľubovoľnom režime (horná hranica `busyTicksLeft`). */
  get maxPassTicks(): number {
    let max = 0;
    for (const mode of GATE_MODES) max = Math.max(max, this.planTicks(this.planFor(mode, true)));
    return max;
  }

  /** Aktuálny krok prebiehajúceho prechodu a jeho priebeh (0 … 1); voľný pruh → `null`. */
  currentStep(): GateStepProgress | null {
    if (this.busy === 0 || this.plan.length === 0) return null;
    let elapsed = this.planTotal - this.busy - (this.params.internalTicks ?? 0);
    if (elapsed < 0) elapsed = 0;
    for (const step of this.plan) {
      if (elapsed < step.ticks) return { id: step.id, progress: elapsed / step.ticks };
      elapsed -= step.ticks;
    }
    const last = this.plan[this.plan.length - 1];
    return { id: last.id, progress: 1 };
  }

  /**
   * Zverejní strany pruhu (volá len `World` po zmene ciest alebo modulov, ADR-022): `entry` = vonkajšia strana (prvý konektor), `exit` = vnútorná (druhý);
   * každá je `null`, keď na jej vonkajšej bunke nie je cesta (od R4 sú strany nezávislé — kamión, ktorý už je za pruhom, dokončí okruh aj po prerušení vstupu).
   */
  setSides(entry: PlacedConnector | null, exit: PlacedConnector | null): void {
    this.entry = entry;
    this.exit = exit;
  }

  /** Je kamión vo fronte? O(1). */
  isQueued(truckId: EntityId): boolean {
    return this.members.has(truckId);
  }

  /** Zaradí kamión na koniec fronty; už zaradený → `ModuleError('duplicate_id')` (fronta sa nezmení). */
  enqueue(truckId: EntityId): void {
    if (!isTruckId(truckId)) throw new ModuleError('invalid_input', `${this.label}.enqueue: id kamióna musí byť celé číslo ≥ 1, dostal ${String(truckId)}`);
    if (this.members.has(truckId)) throw new ModuleError('duplicate_id', `${this.label}: kamión #${String(truckId)} je už vo fronte`);
    this.queue.push(truckId);
    this.members.add(truckId);
    this.queueView = Object.freeze([...this.queue]);
  }

  /** Kamión na čele fronty bez vybratia; prázdna fronta → `undefined`. */
  peekQueue(): EntityId | undefined {
    return this.queue[0];
  }

  /** Vyberie kamión z čela fronty; prázdna fronta → `ModuleError('queue_empty')`. */
  dequeue(): EntityId {
    const truckId = this.queue.shift();
    if (truckId === undefined) throw new ModuleError('queue_empty', `${this.label}.dequeue: fronta je prázdna`);
    this.members.delete(truckId);
    this.queueView = Object.freeze([...this.queue]);
    return truckId;
  }

  /**
   * Začne prechod kamióna na čele fronty podľa plánu `plan` (neprázdny, kroky celé ≥ 1, inak `invalid_input`): `busyTicksLeft = planTicks(plan)`. Pruh, ktorý ešte
   * púšťa predchádzajúci kamión → `ModuleError('busy')` (priepustnosť), prázdna fronta → `ModuleError('queue_empty')` (prechod patrí kamiónu na čele).
   */
  beginPass(plan: readonly GateStep[]): void {
    if (plan.length === 0 || plan.some((step) => !Number.isSafeInteger(step.ticks) || step.ticks < 1)) {
      throw new ModuleError('invalid_input', `${this.label}.beginPass: plán prechodu musí mať aspoň jeden krok s trvaním celé číslo ≥ 1`);
    }
    if (this.busy > 0) throw new ModuleError('busy', `${this.label}.beginPass: brána ešte púšťa kamión (${String(this.busy)} tickov)`);
    if (this.queue.length === 0) throw new ModuleError('queue_empty', `${this.label}.beginPass: vo fronte nie je kamión`);
    this.plan = Object.freeze(plan.map((step) => Object.freeze({ id: step.id, ticks: step.ticks })));
    this.planTotal = this.planTicks(this.plan);
    this.busy = this.planTotal;
  }

  /** Odpočíta tick prebiehajúceho prechodu (voľná brána sa nemení). */
  advancePass(): void {
    if (this.busy > 0) this.busy -= 1;
  }

  /**
   * Dokončí prechod: vyberie kamión z čela fronty, `trucksProcessed += 1` a vráti ho. Prechod ešte beží → `busy`,
   * prázdna fronta → `queue_empty` (nič sa nezmení).
   */
  completePass(): EntityId {
    if (this.busy > 0) throw new ModuleError('busy', `${this.label}.completePass: prechod ešte beží (${String(this.busy)} tickov)`);
    const truckId = this.dequeue();
    this.processed += 1;
    this.clearPlan();
    return truckId;
  }

  /**
   * Vyradí kamión z fronty bez prechodu (strany brány sa pod ním preklopili, dodatok ADR-024); kamión na čele počas
   * prechodu zruší aj prechod (`busyTicksLeft = 0`). Kamión nie je vo fronte → `ModuleError('invalid_input')`.
   */
  withdraw(truckId: EntityId): void {
    const index = this.queue.indexOf(truckId);
    if (index < 0) throw new ModuleError('invalid_input', `${this.label}.withdraw: kamión #${String(truckId)} nie je vo fronte`);
    if (index === 0) {
      this.busy = 0;
      this.clearPlan();
    }
    this.queue.splice(index, 1);
    this.members.delete(truckId);
    this.queueView = this.queue.length === 0 ? NO_TRUCKS : Object.freeze([...this.queue]);
  }

  private clearPlan(): void {
    this.plan = NO_PLAN;
    this.planTotal = 0;
  }

  private planProblem(): { readonly path: string; readonly problem: string } | undefined {
    if (this.busy > 0 && this.plan.length === 0) return { path: '/passPlan', problem: 'prechod beží, ale plán je prázdny' };
    return undefined;
  }

  /** Fronta bez duplicít a s platnými id, množina členov = fronta (krok 12, O(dĺžka fronty), bez alokácie). */
  override findRuntimeProblem(): string | undefined {
    const { queue } = this;
    for (let i = 0; i < queue.length; i++) {
      if (!isTruckId(queue[i])) return `${this.label}: fronta obsahuje neplatné id ${String(queue[i])}`;
      if (!this.members.has(queue[i])) return `${this.label}: kamión #${String(queue[i])} z fronty chýba v množine členov`;
    }
    if (this.members.size !== queue.length) return `${this.label}: fronta má ${String(queue.length)} položiek, ale ${String(this.members.size)} rôznych kamiónov (duplicita)`;
    const pass = gatePassProblem(this.busy, this.planTotal, queue.length) ?? this.planProblem();
    return pass === undefined ? undefined : `${this.label}: ${pass.problem}`;
  }

  override getRuntimeState(): GateRuntimeState {
    return { queue: [...this.queue], busyTicksLeft: this.busy, trucksProcessed: this.processed, mode: this.currentMode, passPlan: this.plan.map((step) => ({ id: step.id, ticks: step.ticks })), passTotalTicks: this.planTotal };
  }

  /**
   * Kontroly: presne kľúče `GateRuntimeState`, `queue` pole rôznych celých id ≥ 1, počítadlá celé ≥ 0, súlad prechodu
   * s frontou (`gatePassProblem`). Neplatný stav → `ModuleStateError`; obnova je atomická. Existenciu a stav kamiónov
   * vo fronte overí svet (T04-04).
   */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, RUNTIME_KEYS);
    const rawQueue = fields['queue'];
    if (!Array.isArray(rawQueue)) throw new ModuleStateError('/queue', `musí byť pole, dostal ${describeValue(rawQueue)}`);
    const queue: EntityId[] = [];
    rawQueue.forEach((value: unknown, index) => {
      if (!isTruckId(value)) throw new ModuleStateError(`/queue/${String(index)}`, `id kamióna musí byť celé číslo ≥ 1, dostal ${describeValue(value)}`);
      if (queue.includes(value)) throw new ModuleStateError(`/queue/${String(index)}`, `kamión #${String(value)} je vo fronte dvakrát`);
      queue.push(value);
    });
    const busyTicksLeft = readCount(fields['busyTicksLeft'], '/busyTicksLeft');
    const trucksProcessed = readCount(fields['trucksProcessed'], '/trucksProcessed');
    const mode = fields['mode'];
    if (typeof mode !== 'string' || !GATE_MODES.includes(mode as GateMode)) throw new ModuleStateError('/mode', `neznámy režim ${describeValue(mode)}`);
    const rawPlan = fields['passPlan'];
    if (!Array.isArray(rawPlan)) throw new ModuleStateError('/passPlan', `musí byť pole, dostal ${describeValue(rawPlan)}`);
    const plan: GateStep[] = rawPlan.map((value: unknown, index) => {
      const entry = value as { id?: unknown; ticks?: unknown } | null;
      const id = entry?.id;
      const ticks = entry?.ticks;
      if (typeof id !== 'string' || !GATE_STEP_IDS.includes(id as GateStepId)) throw new ModuleStateError(`/passPlan/${String(index)}/id`, `neznámy krok ${describeValue(id)}`);
      if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks) || ticks < 1) throw new ModuleStateError(`/passPlan/${String(index)}/ticks`, `trvanie musí byť celé číslo ≥ 1, dostal ${describeValue(ticks)}`);
      return { id: id as GateStepId, ticks };
    });
    const passTotalTicks = readCount(fields['passTotalTicks'], '/passTotalTicks');
    if (passTotalTicks !== (plan.length === 0 ? 0 : this.planTicks(plan))) throw new ModuleStateError('/passTotalTicks', `trvanie ${String(passTotalTicks)} nezodpovedá plánu`);
    const pass = gatePassProblem(busyTicksLeft, passTotalTicks, queue.length);
    if (pass !== undefined) throw new ModuleStateError(pass.path, pass.problem);
    if (busyTicksLeft > 0 && plan.length === 0) throw new ModuleStateError('/passPlan', 'prechod beží, ale plán je prázdny');
    this.currentMode = mode as GateMode;
    this.plan = plan.length === 0 ? NO_PLAN : Object.freeze(plan.map((step) => Object.freeze(step)));
    this.planTotal = passTotalTicks;
    this.queue.splice(0, this.queue.length, ...queue);
    this.members.clear();
    for (const truckId of queue) this.members.add(truckId);
    this.queueView = queue.length === 0 ? NO_TRUCKS : Object.freeze([...queue]);
    this.busy = busyTicksLeft;
    this.processed = trucksProcessed;
  }
}
