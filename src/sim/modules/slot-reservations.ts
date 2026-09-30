/**
 * Rezervácie slotov držiteľa nákladu s jedinečnými miestami (ARCHITECTURE §5.4, §7.7; ADR-017): apron kotviska
 * (`on_apron`) a sklad (`in_storage`). Review T02-13: modul **nedrží obsadenie** — to je výlučne v `CargoLedger`
 * (pravidlo 2, jediný zdroj polohy). Tu sú len rezervácie slotov pre prichádzajúce jednotky; obsadenie, počty,
 * jednotky vo FIFO a slot jednotky sa čítajú z ledgera (`CargoReader`).
 *
 * Cyklus slotu: voľný → `reserve()` (žeriav pri `idle → grabbing`, dispatcher pri vzniku jobu) → pred presunom
 * `assertCommittable(slot, unit)` → `CargoLedger.move(unit, …slot)` → `commit(slot, unit)` (rezervácia zaniká,
 * jednotka leží na slote podľa ledgera) → presun z ledgera preč (vozidlo) uvoľní slot bez ďalšieho kroku.
 * Rezervovaný slot nemôže prebookovať iný žeriav ani job, preto sa „voľné miesto" pýta cez `freeCount`.
 *
 * FIFO: ledger vedie jednotky držiteľa v poradí príchodu (`CARGO_HOLDER_SPECS.order = 'arrival'`) a to isté poradie
 * zachová save (`CargoLedger.getState` / `fromState`), preto vlastná fronta netreba (T03-02).
 *
 * Všetky operácie sú atomické: pri chybe (`ModuleError`) sa rezervácie nezmenia. Súlad s ledgerom (rezervovaný slot nie
 * je obsadený, `used + reserved ≤ capacity`, slot jednotky v rozsahu) overuje `findProblem()` v kroku 12.
 */
import type { CargoReader } from '../cargo/cargo-ledger';
import { holderIdOf, holderSpecOf, uniqueSlotOf } from '../cargo/cargo-location';
import type { EntityId } from '../core/entity-id';
import { ModuleError } from './module-error';

/** Druhy lokácie s jedinečným slotom u modulu (`CARGO_HOLDER_SPECS[kind].uniqueSlot`): apron a sklad. */
export type SlotHolderKind = 'on_apron' | 'in_storage';

/** Vstup `SlotReservations`. */
export interface SlotReservationsInit {
  readonly kind: SlotHolderKind;
  /** Modul, ktorý sloty drží (berth, sklad). */
  readonly holderId: EntityId;
  /** Počet slotov (celé ≥ 1). */
  readonly capacity: number;
  /** Ledger sveta — zdroj obsadenia (len čítanie). */
  readonly cargo: CargoReader;
  /** Popis do chybových správ (`apron berth_standard #1`). */
  readonly label: string;
}

/**
 * Pohľad na sloty modulu len na čítanie — generický kód (invarianty kroku 12, obnova save, pravidlo `has_cargo`) ho
 * dostane z `Module.cargoSlots()` bez znalosti triedy modulu.
 */
export interface CargoSlotsView {
  readonly kind: SlotHolderKind;
  readonly holderId: EntityId;
  readonly capacity: number;
  /** Obsadené sloty = jednotky u držiteľa v ledgeri. */
  readonly usedCount: number;
  /** Rezervované (zatiaľ prázdne) sloty. */
  readonly reservedCount: number;
  /** `capacity − usedCount − reservedCount` — koľko ďalších `reserve()` uspeje. */
  readonly freeCount: number;
  unitAt(slot: number): EntityId | null;
  isReserved(slot: number): boolean;
  reservedSlots(): readonly number[];
  units(): readonly EntityId[];
  /** Prvé porušenie súladu rezervácií s ledgerom (krok 12), alebo `undefined`. */
  findProblem(): string | undefined;
}

export class SlotReservations implements CargoSlotsView {
  readonly kind: SlotHolderKind;
  readonly holderId: EntityId;
  readonly capacity: number;
  private readonly cargo: CargoReader;
  private readonly label: string;
  /** Slot → rezervovaný. */
  private readonly reservedFlags: boolean[];
  private reserved = 0;

  /** Kapacita musí byť celé ≥ 1 a `kind` druh s jedinečným slotom (`ModuleError('invalid_input')`). */
  constructor(init: SlotReservationsInit) {
    if (!Number.isSafeInteger(init.capacity) || init.capacity < 1) {
      throw new ModuleError('invalid_input', `${init.label}: kapacita musí byť celé číslo ≥ 1, dostal ${String(init.capacity)}`);
    }
    if (holderSpecOf(init.kind)?.uniqueSlot !== true) {
      throw new ModuleError('invalid_input', `${init.label}: druh lokácie '${String(init.kind)}' nemá jedinečné sloty`);
    }
    this.kind = init.kind;
    this.holderId = init.holderId;
    this.capacity = init.capacity;
    this.cargo = init.cargo;
    this.label = init.label;
    this.reservedFlags = new Array<boolean>(init.capacity).fill(false);
  }

  get usedCount(): number {
    return this.cargo.countAt(this.kind, this.holderId);
  }

  get reservedCount(): number {
    return this.reserved;
  }

  get freeCount(): number {
    return this.capacity - this.usedCount - this.reserved;
  }

  /** Jednotka na slote podľa ledgera; `null` = prázdny (aj rezervovaný). Slot mimo rozsahu → `ModuleError('invalid_slot')`. */
  unitAt(slot: number): EntityId | null {
    this.assertSlot(slot, 'unitAt');
    return this.cargo.unitAtSlot(this.kind, this.holderId, slot) ?? null;
  }

  /** Je slot rezervovaný? Slot mimo rozsahu → `ModuleError('invalid_slot')`. */
  isReserved(slot: number): boolean {
    this.assertSlot(slot, 'isReserved');
    return this.reservedFlags[slot];
  }

  /** Slot, na ktorom jednotka u tohto držiteľa leží (ledger); `undefined`, ak tu nie je. */
  slotOf(unitId: EntityId): number | undefined {
    const location = this.cargo.get(unitId)?.location;
    if (location?.kind !== this.kind || holderIdOf(location) !== this.holderId) return undefined;
    return uniqueSlotOf(location) ?? undefined;
  }

  /** Jednotky v poradí príchodu — FIFO (kópia z ledgera). */
  units(): readonly EntityId[] {
    return this.cargo.unitsAt(this.kind, this.holderId);
  }

  /** Najstaršia jednotka (hlava FIFO) bez alokácie; `undefined` pri prázdnom držiteľovi. */
  oldest(): EntityId | undefined {
    return this.cargo.firstUnitAt(this.kind, this.holderId);
  }

  /** Rezervované sloty vzostupne (kópia). */
  reservedSlots(): readonly number[] {
    const slots: number[] = [];
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.reservedFlags[slot]) slots.push(slot);
    }
    return slots;
  }

  /**
   * Rezervuje najnižší slot, ktorý nie je obsadený (ledger) ani rezervovaný, a vráti ho. Bez neho →
   * `ModuleError('no_free_slot')` (volajúci sa pýta `freeCount` vopred).
   */
  reserve(): number {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (!this.reservedFlags[slot] && this.cargo.unitAtSlot(this.kind, this.holderId, slot) === undefined) {
        this.reservedFlags[slot] = true;
        this.reserved += 1;
        return slot;
      }
    }
    throw new ModuleError('no_free_slot', `${this.label}.reserve: žiadny voľný nerezervovaný slot (kapacita ${String(this.capacity)})`);
  }

  /**
   * Rezervuje konkrétny slot (obnova zo save). Chyby: mimo rozsahu → `invalid_slot`, obsadený (ledger) →
   * `slot_occupied`, už rezervovaný → `slot_reserved`.
   */
  reserveSlot(slot: number): void {
    this.assertSlot(slot, 'reserveSlot');
    this.assertEmpty(slot, 'reserveSlot');
    if (this.reservedFlags[slot]) throw new ModuleError('slot_reserved', `${this.label}.reserveSlot: slot ${String(slot)} je už rezervovaný`);
    this.reservedFlags[slot] = true;
    this.reserved += 1;
  }

  /** Zruší rezerváciu slotu (zrušený cyklus alebo job). Chyby: mimo rozsahu → `invalid_slot`, bez rezervácie → `slot_not_reserved`. */
  release(slot: number): void {
    this.assertSlot(slot, 'release');
    this.assertReserved(slot, 'release');
    this.reservedFlags[slot] = false;
    this.reserved -= 1;
  }

  /**
   * Overí, že presun jednotky na `slot` a následný `commit` prejdú, bez zmeny stavu. Volajúci ho zavolá **pred**
   * `CargoLedger.move(unit, …slot)`, aby sa ledger a rezervácie nemohli rozísť (T02-14). Chyby: mimo rozsahu →
   * `invalid_slot`, bez rezervácie → `slot_not_reserved`, obsadený (ledger) → `slot_occupied`.
   */
  assertCommittable(slot: number, unitId: EntityId): void {
    this.assertSlot(slot, 'commit');
    this.assertReserved(slot, 'commit');
    const occupant = this.cargo.unitAtSlot(this.kind, this.holderId, slot);
    if (occupant !== undefined && occupant !== unitId) {
      throw new ModuleError('slot_occupied', `${this.label}.commit: slot ${String(slot)} obsadila jednotka #${String(occupant)}`);
    }
  }

  /**
   * Premení rezerváciu na obsadenie: volá sa **po** `CargoLedger.move(unit, …slot)`. Chyby: mimo rozsahu →
   * `invalid_slot`, slot bez rezervácie → `slot_not_reserved`, ledger nemá jednotku na tomto slote → `unit_not_at_slot`.
   */
  commit(slot: number, unitId: EntityId): void {
    this.assertSlot(slot, 'commit');
    this.assertReserved(slot, 'commit');
    const occupant = this.cargo.unitAtSlot(this.kind, this.holderId, slot);
    if (occupant !== unitId) {
      throw new ModuleError(
        'unit_not_at_slot',
        `${this.label}.commit: jednotka #${String(unitId)} podľa ledgera neleží na slote ${String(slot)} (je tam ${occupant === undefined ? 'nič' : `#${String(occupant)}`})`,
      );
    }
    this.reservedFlags[slot] = false;
    this.reserved -= 1;
  }

  findProblem(): string | undefined {
    let flagged = 0;
    for (let slot = 0; slot < this.capacity; slot++) {
      if (!this.reservedFlags[slot]) continue;
      flagged += 1;
      const occupant = this.cargo.unitAtSlot(this.kind, this.holderId, slot);
      if (occupant !== undefined) return `${this.label}: rezervovaný slot ${String(slot)} obsadila jednotka #${String(occupant)}`;
    }
    if (flagged !== this.reserved) return `${this.label}: reservedCount ${String(this.reserved)} ≠ počet rezervovaných slotov ${String(flagged)}`;
    for (const unitId of this.cargo.unitsAt(this.kind, this.holderId)) {
      const location = this.cargo.get(unitId)?.location;
      const slot = location === undefined ? null : uniqueSlotOf(location);
      if (slot === null || slot >= this.capacity) {
        return `${this.label}: jednotka #${String(unitId)} leží na slote ${String(slot)} mimo 0…${String(this.capacity - 1)}`;
      }
    }
    const used = this.usedCount;
    if (used + this.reserved > this.capacity) {
      return `${this.label}: obsadené ${String(used)} + rezervované ${String(this.reserved)} > kapacita ${String(this.capacity)}`;
    }
    return undefined;
  }

  private assertSlot(slot: number, method: string): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.capacity) {
      throw new ModuleError('invalid_slot', `${this.label}.${method}: slot musí byť celé číslo 0…${String(this.capacity - 1)}, dostal ${String(slot)}`);
    }
  }

  private assertEmpty(slot: number, method: string): void {
    const unit = this.cargo.unitAtSlot(this.kind, this.holderId, slot);
    if (unit !== undefined) throw new ModuleError('slot_occupied', `${this.label}.${method}: slot ${String(slot)} obsadila jednotka #${String(unit)}`);
  }

  private assertReserved(slot: number, method: string): void {
    if (!this.reservedFlags[slot]) throw new ModuleError('slot_not_reserved', `${this.label}.${method}: slot ${String(slot)} nie je rezervovaný`);
  }
}
