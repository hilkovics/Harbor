/**
 * ApronBuffer (ARCHITECTURE §5.4, ADR-014): sloty na nábreží berthu, kam žeriav odkladá jednotky a odkiaľ ich
 * vozidlá (F3) vyzdvihujú. Odpája takt žeriavu od dostupnosti vozidiel.
 *
 * Cyklus slotu: voľný → `reserve()` (žeriav pri `idle → grabbing`, ADR-014 / rozhodnutie 7) → `commit(slot, unit)`
 * (jednotka odložená, rezervácia zaniká) → `take(unit)` (vozidlo) → voľný. Rezervovaný slot nemôže prebookovať
 * iný žeriav, preto sa „voľné miesto“ pýta cez `freeUnreservedCount`.
 *
 * Buffer je zrkadlo ledgera: poloha jednotky sa mení len cez `CargoLedger.move` (pravidlo 2) a volajúci po každom
 * presune `in_crane → on_apron` / `on_apron → in_vehicle` zavolá `commit` / `take`. Súlad s ledgerom (rovnaké
 * jednotky, sloty aj FIFO poradie) overuje `World.assertInvariants()`. Všetky operácie sú atomické: pri chybe
 * (`ModuleError`) sa stav nezmení.
 */
import type { EntityId } from '../core/entity-id';
import { ModuleError } from './module-error';

export class ApronBuffer {
  /** Počet slotov (`BerthParams.apronSlots`). */
  readonly capacity: number;
  /** Slot → jednotka. */
  private readonly occupant: (EntityId | null)[];
  /** Slot → rezervovaný. */
  private readonly reservedFlags: boolean[];
  /** Jednotky v poradí odloženia (FIFO). */
  private readonly order: EntityId[] = [];
  private reserved = 0;

  /** Kapacita musí byť celé číslo ≥ 1 (`ModuleError('invalid_input')`). */
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new ModuleError('invalid_input', `ApronBuffer: kapacita musí byť celé číslo ≥ 1, dostal ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.occupant = new Array<EntityId | null>(capacity).fill(null);
    this.reservedFlags = new Array<boolean>(capacity).fill(false);
  }

  /** Počet obsadených slotov (jednotky na aprone). */
  get usedCount(): number {
    return this.order.length;
  }

  /** Počet rezervovaných (zatiaľ prázdnych) slotov. */
  get reservedCount(): number {
    return this.reserved;
  }

  /** Počet slotov, ktoré nie sú obsadené ani rezervované — koľko ďalších `reserve()` uspeje. */
  get freeUnreservedCount(): number {
    return this.capacity - this.order.length - this.reserved;
  }

  /** Jednotka na slote; `null` = prázdny (aj rezervovaný). Slot mimo rozsahu → `ModuleError('invalid_slot')`. */
  unitAt(slot: number): EntityId | null {
    this.assertSlot(slot, 'unitAt');
    return this.occupant[slot];
  }

  /** Je slot rezervovaný? Slot mimo rozsahu → `ModuleError('invalid_slot')`. */
  isReserved(slot: number): boolean {
    this.assertSlot(slot, 'isReserved');
    return this.reservedFlags[slot];
  }

  /** Slot, na ktorom leží jednotka; `undefined`, ak na aprone nie je. */
  slotOf(unitId: EntityId): number | undefined {
    const slot = this.occupant.indexOf(unitId);
    return slot < 0 ? undefined : slot;
  }

  /** Jednotky v poradí odloženia — FIFO (kópia). */
  units(): readonly EntityId[] {
    return [...this.order];
  }

  /** Najstaršia jednotka (hlava FIFO); `undefined` pri prázdnom aprone. */
  oldest(): EntityId | undefined {
    return this.order[0];
  }

  /** Rezervované sloty vzostupne (kópia). */
  reservedSlots(): readonly number[] {
    const slots: number[] = [];
    this.reservedFlags.forEach((flag, slot) => {
      if (flag) slots.push(slot);
    });
    return slots;
  }

  /**
   * Rezervuje najnižší voľný nerezervovaný slot a vráti ho. Bez voľného slotu → `ModuleError('apron_full')`
   * (volajúci sa pýta `freeUnreservedCount` vopred).
   */
  reserve(): number {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.occupant[slot] === null && !this.reservedFlags[slot]) {
        this.reservedFlags[slot] = true;
        this.reserved += 1;
        return slot;
      }
    }
    throw new ModuleError('apron_full', `ApronBuffer.reserve: žiadny voľný nerezervovaný slot (kapacita ${String(this.capacity)})`);
  }

  /**
   * Rezervuje konkrétny slot (obnova zo save). Chyby: mimo rozsahu → `invalid_slot`, obsadený → `slot_occupied`,
   * už rezervovaný → `slot_reserved`.
   */
  reserveSlot(slot: number): void {
    this.assertSlot(slot, 'reserveSlot');
    this.assertEmpty(slot, 'reserveSlot');
    if (this.reservedFlags[slot]) throw new ModuleError('slot_reserved', `ApronBuffer.reserveSlot: slot ${String(slot)} je už rezervovaný`);
    this.reservedFlags[slot] = true;
    this.reserved += 1;
  }

  /** Zruší rezerváciu slotu (napr. zrušený cyklus). Chyby: mimo rozsahu → `invalid_slot`, bez rezervácie → `slot_not_reserved`. */
  release(slot: number): void {
    this.assertSlot(slot, 'release');
    this.assertReserved(slot, 'release');
    this.reservedFlags[slot] = false;
    this.reserved -= 1;
  }

  /**
   * Odloží jednotku na **rezervovaný** slot (rezervácia zaniká) a zaradí ju na koniec FIFO. Volá sa po
   * `CargoLedger.move(unit, on_apron(berth, slot))`. Chyby: mimo rozsahu → `invalid_slot`, slot bez rezervácie →
   * `slot_not_reserved`, jednotka už na aprone → `unit_on_apron`.
   */
  commit(slot: number, unitId: EntityId): void {
    this.assertSlot(slot, 'commit');
    this.assertReserved(slot, 'commit');
    if (this.occupant.includes(unitId)) {
      throw new ModuleError('unit_on_apron', `ApronBuffer.commit: jednotka #${String(unitId)} už leží na slote ${String(this.slotOf(unitId))}`);
    }
    this.reservedFlags[slot] = false;
    this.reserved -= 1;
    this.occupant[slot] = unitId;
    this.order.push(unitId);
  }

  /**
   * Odoberie jednotku z apronu (vozidlo ju naložilo) a vráti uvoľnený slot. Volá sa po presune z `on_apron`.
   * Jednotka na aprone nie je → `ModuleError('unit_not_on_apron')`.
   */
  take(unitId: EntityId): number {
    const slot = this.occupant.indexOf(unitId);
    if (slot < 0) throw new ModuleError('unit_not_on_apron', `ApronBuffer.take: jednotka #${String(unitId)} na aprone nie je`);
    this.occupant[slot] = null;
    this.order.splice(this.order.indexOf(unitId), 1);
    return slot;
  }

  private assertSlot(slot: number, method: string): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.capacity) {
      throw new ModuleError('invalid_slot', `ApronBuffer.${method}: slot musí byť celé číslo 0…${String(this.capacity - 1)}, dostal ${String(slot)}`);
    }
  }

  private assertEmpty(slot: number, method: string): void {
    const unit = this.occupant[slot];
    if (unit !== null) throw new ModuleError('slot_occupied', `ApronBuffer.${method}: slot ${String(slot)} obsadila jednotka #${String(unit)}`);
  }

  private assertReserved(slot: number, method: string): void {
    if (!this.reservedFlags[slot]) throw new ModuleError('slot_not_reserved', `ApronBuffer.${method}: slot ${String(slot)} nie je rezervovaný`);
  }
}
