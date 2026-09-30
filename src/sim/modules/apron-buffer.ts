/**
 * ApronBuffer (ARCHITECTURE §5.4; ADR-014, ADR-017): sloty na nábreží berthu, kam žeriav odkladá jednotky a odkiaľ ich
 * vozidlá (F3) vyzdvihujú. Odpája takt žeriavu od dostupnosti vozidiel.
 *
 * Od T03-02 (review T02-13) je to len **rezervácia slotov** nad ledgerom (`SlotReservations`, druh `on_apron`):
 * obsadenie, jednotky vo FIFO (`units()`, `oldest()`) a slot jednotky (`slotOf`) číta z `CargoLedger`, takže poloha
 * nákladu nemá druhý zápis. Žeriav: `reserve()` pri `idle → grabbing`, pred presunom `assertCommittable`, po
 * `CargoLedger.move(… on_apron)` `commit`. Vozidlo jednotku len presunie `on_apron → in_vehicle` — slot sa uvoľní sám.
 * UI číta `usedCount` / `reservedCount` / `capacity` (a `freeUnreservedCount` = `freeCount`).
 */
import type { CargoReader } from '../cargo/cargo-ledger';
import type { EntityId } from '../core/entity-id';
import { SlotReservations } from './slot-reservations';

export class ApronBuffer extends SlotReservations {
  /** `capacity` = `BerthParams.apronSlots` (celé ≥ 1, inak `ModuleError('invalid_input')`), `berthId` = kotvisko. */
  constructor(capacity: number, berthId: EntityId, cargo: CargoReader, label = `apron berth #${String(berthId)}`) {
    super({ kind: 'on_apron', holderId: berthId, capacity, cargo, label });
  }

  /** Počet slotov, ktoré nie sú obsadené ani rezervované — koľko ďalších `reserve()` uspeje (= `freeCount`). */
  get freeUnreservedCount(): number {
    return this.freeCount;
  }
}
