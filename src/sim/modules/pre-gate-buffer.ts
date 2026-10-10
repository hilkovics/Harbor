/**
 * Predbránová plocha (R4, ADR-041 bod 2; GDD 2) — kamióny čakajú **vedľa seba** v radových pruhoch pred pruhmi vstupnej brány, takže front neblokuje verejnú cestu
 * ani križovatky. Plocha má jeden vjazd (prvý cestný konektor defu) a výjazd (druhý) a `params.rows` radových pruhov po `params.rowCapacity` kamiónov; kapacita
 * = `rows × rowCapacity`. Kamión dostane pri vjazde pruh s najkratšou frontou (`shortestRow`, pri zhode najnižší index — deterministicky); keď sú všetky pruhy plné,
 * ďalšie kamióny čakajú vo vnútrozemí (ADR-035), nie na ceste.
 *
 * Radový pruh `r` obsluhuje pruh brány `r mod počet pruhov` zo zoznamu pruhov dosiahnuteľných z výjazdu plochy (`LandsideNetwork.preGateLanes`); čelo pruhu (index 0)
 * vyjde na cestu k svojmu pruhu brány, keď je ten voľný (`LandsideSystem`). Modul drží len poradie kamiónov v radoch; kamión (`pre_gate`) nesie index radu.
 *
 * `runtime` v save: `{ rows }` — rady kamiónov od čela (index 0 je najbližšie pruhu). Súlad s kamiónmi overuje svet (krok 12).
 */
import type { EntityId } from '../core/entity-id';
import { describeValue } from '../defs/def-spec';
import { preGateParams } from '../defs/module-def';
import type { PreGateParams } from '../defs/types';
import { LandExportModule, type LandsideRole, type LandsideRoster } from './land-export-module';
import type { ModuleInit } from './module';
import { ModuleError, ModuleStateError } from './module-error';
import { checkRuntimeKeys } from './runtime-state';

/** Dynamický stav plochy v save: rady kamiónov od čela. */
export type PreGateRuntimeState = { readonly rows: readonly (readonly number[])[] };

const RUNTIME_KEYS: readonly (keyof PreGateRuntimeState)[] = ['rows'];

function isTruckId(value: unknown): value is EntityId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export class PreGateBuffer extends LandExportModule {
  /** Typované `params` defu (`preGateParams`). */
  readonly params: PreGateParams;
  private readonly rows: EntityId[][];

  /** Def iného druhu než `pre_gate` → `DefError`. */
  constructor(init: ModuleInit) {
    super(init);
    this.params = preGateParams(init.def);
    this.rows = Array.from({ length: this.params.rows }, () => []);
  }

  override get landsideRole(): LandsideRole {
    return 'pre_gate';
  }

  override get internalTicks(): number | undefined {
    return undefined;
  }

  override enlist(roster: LandsideRoster): void {
    roster.preGates.push(this);
  }

  /** Počet radových pruhov. */
  get rowCount(): number {
    return this.params.rows;
  }

  /** Kapacita radového pruhu v kamiónoch. */
  get rowCapacity(): number {
    return this.params.rowCapacity;
  }

  /** Celková kapacita plochy (`rows × rowCapacity`). */
  get capacity(): number {
    return this.params.rows * this.params.rowCapacity;
  }

  /** Počet kamiónov na ploche. */
  get occupied(): number {
    let count = 0;
    for (const row of this.rows) count += row.length;
    return count;
  }

  /** Voľné miesta na ploche. */
  get freeSlots(): number {
    return this.capacity - this.occupied;
  }

  /** Kamióny radu `row` od čela (index 0 je najbližšie pruhu brány). */
  rowTrucks(row: number): readonly EntityId[] {
    this.assertRow(row, 'rowTrucks');
    return this.rows[row];
  }

  /** Čelo radu `row`; prázdny rad → `undefined`. */
  head(row: number): EntityId | undefined {
    this.assertRow(row, 'head');
    return this.rows[row][0];
  }

  /** Rad s najkratšou frontou (pri zhode najnižší index), ktorý ešte nie je plný; všetky plné → −1. Deterministické, bez alokácie. */
  shortestRow(): number {
    let best = -1;
    for (let row = 0; row < this.rows.length; row++) {
      const length = this.rows[row].length;
      if (length >= this.params.rowCapacity) continue;
      if (best < 0 || length < this.rows[best].length) best = row;
    }
    return best;
  }

  /** Rad, v ktorom kamión stojí; nie je na ploche → −1. */
  rowOf(truckId: EntityId): number {
    for (let row = 0; row < this.rows.length; row++) if (this.rows[row].includes(truckId)) return row;
    return -1;
  }

  /** Zaradí kamión na koniec radu `row`. Plný rad → `no_free_bay`, kamión už na ploche → `duplicate_id`. */
  admit(truckId: EntityId, row: number): void {
    this.assertRow(row, 'admit');
    if (!isTruckId(truckId)) throw new ModuleError('invalid_input', `${this.label}.admit: id kamióna musí byť celé číslo ≥ 1, dostal ${String(truckId)}`);
    if (this.rowOf(truckId) >= 0) throw new ModuleError('duplicate_id', `${this.label}.admit: kamión #${String(truckId)} je už na ploche`);
    if (this.rows[row].length >= this.params.rowCapacity) throw new ModuleError('no_free_bay', `${this.label}.admit: rad ${String(row)} je plný`);
    this.rows[row].push(truckId);
  }

  /** Vyberie čelo radu `row` a vráti ho. Prázdny rad → `queue_empty`. */
  releaseHead(row: number): EntityId {
    this.assertRow(row, 'releaseHead');
    const truckId = this.rows[row].shift();
    if (truckId === undefined) throw new ModuleError('queue_empty', `${this.label}.releaseHead: rad ${String(row)} je prázdny`);
    return truckId;
  }

  /** Vyradí kamión z plochy (zrušenie); nie je na ploche → `invalid_input`. */
  remove(truckId: EntityId): void {
    const row = this.rowOf(truckId);
    if (row < 0) throw new ModuleError('invalid_input', `${this.label}.remove: kamión #${String(truckId)} nie je na ploche`);
    this.rows[row].splice(this.rows[row].indexOf(truckId), 1);
  }

  /** Rady bez duplicít, v kapacite, s platnými id (krok 12, bez alokácie v platnom stave). */
  override findRuntimeProblem(): string | undefined {
    const seen = new Set<EntityId>();
    for (let row = 0; row < this.rows.length; row++) {
      if (this.rows[row].length > this.params.rowCapacity) return `${this.label}: rad ${String(row)} má ${String(this.rows[row].length)} kamiónov nad kapacitou ${String(this.params.rowCapacity)}`;
      for (const id of this.rows[row]) {
        if (!isTruckId(id)) return `${this.label}: rad ${String(row)} obsahuje neplatné id ${String(id)}`;
        if (seen.has(id)) return `${this.label}: kamión #${String(id)} je na ploche dvakrát`;
        seen.add(id);
      }
    }
    return undefined;
  }

  override getRuntimeState(): PreGateRuntimeState {
    return { rows: this.rows.map((row) => [...row]) };
  }

  /** Kontroly: presne kľúč `rows`, pole `rowCount` radov, v nich rôzne id ≥ 1 do kapacity. Neplatný stav → `ModuleStateError`; obnova je atomická. */
  override restoreRuntimeState(raw: unknown): void {
    const fields = checkRuntimeKeys(raw, RUNTIME_KEYS);
    const rawRows = fields['rows'];
    if (!Array.isArray(rawRows) || rawRows.length !== this.params.rows) throw new ModuleStateError('/rows', `musí byť pole ${String(this.params.rows)} radov, dostal ${describeValue(rawRows)}`);
    const seen = new Set<number>();
    const rows: EntityId[][] = rawRows.map((rawRow: unknown, r) => {
      if (!Array.isArray(rawRow) || rawRow.length > this.params.rowCapacity) throw new ModuleStateError(`/rows/${String(r)}`, `rad musí byť pole najviac ${String(this.params.rowCapacity)} kamiónov, dostal ${describeValue(rawRow)}`);
      return rawRow.map((value: unknown, i) => {
        if (!isTruckId(value)) throw new ModuleStateError(`/rows/${String(r)}/${String(i)}`, `id kamióna musí byť celé číslo ≥ 1, dostal ${describeValue(value)}`);
        if (seen.has(value)) throw new ModuleStateError(`/rows/${String(r)}/${String(i)}`, `kamión #${String(value)} je na ploche dvakrát`);
        seen.add(value);
        return value;
      });
    });
    for (let r = 0; r < rows.length; r++) this.rows[r].splice(0, this.rows[r].length, ...rows[r]);
  }

  private assertRow(row: number, method: string): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.params.rows) {
      throw new ModuleError('invalid_slot', `${this.label}.${method}: rad musí byť celé číslo 0…${String(this.params.rows - 1)}, dostal ${String(row)}`);
    }
  }
}
