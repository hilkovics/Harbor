/**
 * Brána kamiónov (ARCHITECTURE §5.3 `truck_gate`, §7.5; rozhodnutie orchestrátora F4 č. 2; ADR-022) — **priechod**
 * medzi cestnou sieťou pred bránou (portál) a za ňou (stojiská, rampy).
 *
 * - **Strany:** z cestných konektorov je vstupný ten, ktorého vonkajšia bunka je z road portálu dosiahnuteľná po
 *   cestách (cesty nikdy nevedú telom modulu, takže „bez prechodu bránou" platí samo); pri viacerých ten s najnižšou
 *   cenou cesty od portálu, pri zhode prvý v poradí defu. Výstupný je prvý ďalší cestný konektor s cestou na vonkajšej
 *   bunke. Určuje ich svet (`LandsideNetwork`) a zverejní cez `setSides` — `entrySide` / `exitSide` sú `null`, kým ich
 *   svet neurčí alebo keď strana chýba. Brána bez oboch strán nie je platná a rampu za ňou neoživí.
 * - **Fronta:** spoločná FIFO fronta kamiónov oboch smerov (`enqueue` / `peekQueue` / `dequeue`); je **virtuálna** —
 *   čakajúci kamión stojí na vonkajšej bunke konektora, render ukáže `queue_badge` (§7.5, §7.8 bod 3, nikdy gridlock).
 * - **Priepustnosť:** 1 kamión za `processTicks` (tvrdý bottleneck): `beginPass(ticks)` začne prechod kamióna
 *   (`busyTicksLeft = ticks`, `trucksProcessed += 1`), `advancePass()` odpočíta tick. Kým `busyTicksLeft > 0`, závora je
 *   hore (`isOpen`) a ďalší kamión nesmie začať. Prechod trvá `passTicks` = `processTicks` + `internalTicks` (chýbajúci
 *   `internalTicks` = 0 — priepustnosť brány určuje `processTicks`, ADR-024). Púšťa sa vždy kamión na čele fronty a
 *   z fronty vypadne až po dokončení prechodu (`landsideSystem`, T04-04).
 *
 * `runtime` v save: `{ queue, busyTicksLeft, trucksProcessed }`. Súlad fronty s kamiónmi (fronta = presne kamióny
 * v `gate_queue*` tejto brány) overuje svet (krok 12, ADR-024); strany sa neukladajú (odvodia sa z ciest a modulov).
 * Členstvo vo fronte je okrem poradia (pole) vedené aj v množine — `isQueued` je O(1) a duplicita nemôže vzniknúť.
 */
import type { EntityId } from '../core/entity-id';
import { describeValue } from '../defs/def-spec';
import { gateParams } from '../defs/module-def';
import type { GateParams } from '../defs/types';
import { LandExportModule } from './land-export-module';
import type { ModuleInit } from './module';
import { ModuleError, ModuleStateError } from './module-error';
import type { PlacedConnector } from './module-geometry';
import { checkRuntimeKeys, readCount } from './runtime-state';

/** Dynamický stav brány v save (`WorldState.modules[i].runtime`, ADR-022). */
export type GateRuntimeState = {
  /** Kamióny vo fronte v poradí príchodu (FIFO). */
  readonly queue: readonly number[];
  /** Zostávajúce ticky prechodu práve púšťaného kamióna (0 = brána voľná). */
  readonly busyTicksLeft: number;
  /** Kumulatívny počet kamiónov, ktoré začali prechod bránou. */
  readonly trucksProcessed: number;
};

const RUNTIME_KEYS: readonly (keyof GateRuntimeState)[] = ['queue', 'busyTicksLeft', 'trucksProcessed'];
const NO_TRUCKS: readonly EntityId[] = Object.freeze([]);

function isTruckId(value: unknown): value is EntityId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
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
  private entry: PlacedConnector | null = null;
  private exit: PlacedConnector | null = null;

  /** Def iného druhu než `gate` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = gateParams(init.def);
  }

  override get internalTicks(): number | undefined {
    return this.params.internalTicks;
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

  /** Kumulatívny počet kamiónov, ktoré začali prechod. */
  get trucksProcessed(): number {
    return this.processed;
  }

  /** Trvanie prechodu jedného kamióna v tickoch: `processTicks` + `internalTicks` (chýbajúci = 0, ADR-024). */
  get passTicks(): number {
    return this.params.processTicks + (this.params.internalTicks ?? 0);
  }

  /**
   * Zverejní strany brány (volá len `World` po zmene ciest alebo modulov, ADR-022). `exit` bez `entry` je chyba
   * programu (`ModuleError('invalid_input')`) — výstup sa určuje až k vstupu.
   */
  setSides(entry: PlacedConnector | null, exit: PlacedConnector | null): void {
    if (entry === null && exit !== null) throw new ModuleError('invalid_input', `${this.label}.setSides: výstupná strana bez vstupnej`);
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
   * Začne prechod kamióna na `ticks` tickov (celé ≥ 1, inak `invalid_input`): `busyTicksLeft = ticks`,
   * `trucksProcessed += 1`. Brána, ktorá ešte púšťa predchádzajúci kamión → `ModuleError('busy')` (priepustnosť).
   */
  beginPass(ticks: number): void {
    if (!Number.isSafeInteger(ticks) || ticks < 1) {
      throw new ModuleError('invalid_input', `${this.label}.beginPass: trvanie musí byť celé číslo ≥ 1, dostal ${String(ticks)}`);
    }
    if (this.busy > 0) throw new ModuleError('busy', `${this.label}.beginPass: brána ešte púšťa kamión (${String(this.busy)} tickov)`);
    this.busy = ticks;
    this.processed += 1;
  }

  /** Odpočíta tick prebiehajúceho prechodu (voľná brána sa nemení). */
  advancePass(): void {
    if (this.busy > 0) this.busy -= 1;
  }

  /** Fronta bez duplicít a s platnými id, množina členov = fronta (krok 12, O(dĺžka fronty), bez alokácie). */
  override findRuntimeProblem(): string | undefined {
    const { queue } = this;
    for (let i = 0; i < queue.length; i++) {
      if (!isTruckId(queue[i])) return `${this.label}: fronta obsahuje neplatné id ${String(queue[i])}`;
      if (!this.members.has(queue[i])) return `${this.label}: kamión #${String(queue[i])} z fronty chýba v množine členov`;
    }
    if (this.members.size !== queue.length) return `${this.label}: fronta má ${String(queue.length)} položiek, ale ${String(this.members.size)} rôznych kamiónov (duplicita)`;
    return undefined;
  }

  override getRuntimeState(): GateRuntimeState {
    return { queue: [...this.queue], busyTicksLeft: this.busy, trucksProcessed: this.processed };
  }

  /**
   * Kontroly: presne kľúče `GateRuntimeState`, `queue` pole rôznych celých id ≥ 1, počítadlá celé ≥ 0. Neplatný stav
   * → `ModuleStateError`; obnova je atomická. Existenciu a stav kamiónov vo fronte overí svet (T04-04).
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
    this.queue.splice(0, this.queue.length, ...queue);
    this.members.clear();
    for (const truckId of queue) this.members.add(truckId);
    this.queueView = queue.length === 0 ? NO_TRUCKS : Object.freeze([...queue]);
    this.busy = busyTicksLeft;
    this.processed = trucksProcessed;
  }
}
